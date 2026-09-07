import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServerClock } from './clock.js'
import type { Ledger } from './ledger.js'
import { backoffFor, isExhausted } from './backoff.js'
import { sendBytes } from './printer.js'
import { claim, fetchPayload, markDelivered, markFailed, release, type ClaimableJob } from './queue.js'
import { log, logError } from './log.js'

export interface PrinterRow {
  id: string
  name: string
  target: 'kitchen' | 'bar'
  host: string
  port: number
}

export interface WorkerDeps {
  client: SupabaseClient
  clock: ServerClock
  ledger: Ledger
  socketTimeoutMs: number
  /** Umbral de un `claimed` abandonado; el claim lo usa como CAS. */
  staleClaimMs: number
  /** Inyectable para tests. */
  sleep?: (ms: number) => Promise<void>
}

const SUPABASE_ERROR_PAUSE_MS = 10_000

/**
 * Una cola secuencial por impresora. La impresora solo admite una conexión y
 * el TPV también le imprime, así que aquí nunca hay dos sockets a la vez. Una
 * impresora caída duerme su backoff sin bloquear a las demás.
 */
export class PrinterWorker {
  private readonly queue = new Map<string, ClaimableJob>()
  private running = false
  private stopped = false
  private readonly sleep: (ms: number) => Promise<void>
  /** Id del job que el bucle tiene entre manos ahora mismo (fuera del Map). */
  private current: string | null = null
  /** Rechazos consecutivos de una transición para un job, para no reclamarlo para siempre. */
  private readonly rejected = new Map<string, number>()
  /** Jobs a los que ya se renunció: se loguean y se marcan `failed` una sola vez. */
  private readonly gaveUp = new Set<string>()
  private pendingWake: (() => void) | null = null
  /** Instante local (ms) hasta el que esta impresora está en backoff. */
  private pausedUntil = 0

  constructor(readonly printer: PrinterRow, private readonly deps: WorkerDeps) {
    this.sleep = deps.sleep ?? (ms => this.defaultSleep(ms))
  }

  private defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pendingWake = null; resolve() }, ms)
      this.pendingWake = () => { clearTimeout(timer); this.pendingWake = null; resolve() }
    })
  }

  /** Idempotente por id: el poll y el timbre pueden traer el mismo job. */
  enqueue(job: ClaimableJob): void {
    if (this.stopped || this.queue.has(job.id) || job.id === this.current) return
    this.queue.set(job.id, job)
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.queue.clear()
    this.pendingWake?.()
  }

  /**
   * Corta el backoff en curso: lo llama el heartbeat en cuanto su `probe()`
   * ve que la impresora vuelve a aceptar conexiones, para no esperar el resto
   * de un escalón de hasta 60 s cuando ya se sabe que va a funcionar.
   */
  wake(): void {
    this.pausedUntil = 0
    this.pendingWake?.()
  }

  /** Para tests: espera a que la cola esté vacía y el bucle parado. */
  async drain(): Promise<void> {
    while (this.running || this.queue.size > 0) await new Promise(resolve => setTimeout(resolve, 5))
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped) {
        // El backoff se respeta ANTES de coger el siguiente trabajo, no
        // después del anterior: así frena también al job que el poll de 60 s
        // reofrece. Dormir después solo retrasaba el bucle, y el reoferto
        // entraba por una cola vacía quemando el intento siguiente al
        // instante: cinco intentos se agotaban en cuatro minutos.
        const wait = this.pausedUntil - Date.now()
        if (wait > 0) await this.sleep(wait)
        if (this.stopped) break
        const next = this.queue.values().next()
        if (next.done) break
        const job = next.value
        this.queue.delete(job.id)
        this.current = job.id
        await this.process(job)
        this.current = null
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Procesa un trabajo. Cuando toca esperar, deja la pausa en `pausedUntil`
   * (es de la impresora, no de este job) y devuelve esos ms solo para el log.
   */
  private async process(job: ClaimableJob): Promise<number> {
    const { client, clock, ledger } = this.deps
    const scope = 'worker'
    const tag = { job: job.id, printer: this.printer.name }
    try {
      if ((this.rejected.get(job.id) ?? 0) >= 3) {
        // Una vez por job, no una línea de error por minuto: se deja `failed`
        // en el servidor para que el trabajo deje de reofrecerse y se vea en
        // el panel por qué. Si el UPDATE también se rechaza, da igual: aquí
        // ya no se vuelve a intentar.
        if (!this.gaveUp.has(job.id)) {
          this.gaveUp.add(job.id)
          logError(scope, `giving up locally after 3 rejected updates job=${job.id}`)
          await markFailed(client, job.id, 'updates rejected 3 times', clock)
          if (this.gaveUp.size > 1000) this.gaveUp.clear()
        }
        return 0
      }
      if (!(await claim(client, job, clock, this.deps.staleClaimMs))) {
        log(scope, 'claim rejected, skipping', tag)
        return 0
      }
      const attempt = job.attempts + 1
      log(scope, 'claimed', { ...tag, attempt })

      if (ledger.wasPrinted(job.id)) {
        const delivered = await markDelivered(client, job.id, clock)
        this.recordTransition(job.id, 'delivered', delivered)
        log(scope, 'already printed, delivered without reprint', tag)
        return 0
      }

      const bytes = await fetchPayload(client, job.id)
      try {
        await sendBytes({ host: this.printer.host, port: this.printer.port }, bytes, this.deps.socketTimeoutMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isExhausted(attempt)) {
          const failed = await markFailed(client, job.id, message, clock)
          this.recordTransition(job.id, 'failed', failed)
          logError(scope, `failed after ${attempt} attempts job=${job.id} printer=${this.printer.name}`, message)
          return 0
        }
        const released = await release(client, job.id, message)
        this.recordTransition(job.id, 'release', released)
        const pause = backoffFor(attempt)
        this.pausedUntil = Date.now() + pause
        log(scope, 'socket error, released', { ...tag, attempt, error: message, backoffMs: pause })
        return pause
      }
      // El socket ha ido bien: la impresora está viva, se levanta el backoff.
      this.pausedUntil = 0

      // Primero el libro, luego Supabase: si la red cae entre los dos, el
      // reoferto de dentro de 2 min encuentra el job en el libro y no reimprime.
      try {
        ledger.markPrinted(job.id, clock.now())
      } catch (err) {
        logError(scope, `ledger write failed job=${job.id}: duplicate ticket possible if delivery is not confirmed`, err)
      }
      const delivered = await markDelivered(client, job.id, clock)
      this.recordTransition(job.id, 'delivered', delivered)
      // Solo si el servidor aceptó la transición: `recordTransition` ya
      // registra el rechazo, y un «delivered» en el log cuando la fila sigue
      // en `claimed` es exactamente lo que despista al depurar.
      if (delivered) log(scope, 'delivered', { ...tag, bytes: bytes.length })
      return 0
    } catch (err) {
      logError(scope, `supabase error, job left for next poll job=${job.id}`, err)
      this.pausedUntil = Date.now() + SUPABASE_ERROR_PAUSE_MS
      return SUPABASE_ERROR_PAUSE_MS
    }
  }

  /** Registra el resultado de una transición; acota reintentos cuando el servidor la rechaza. */
  private recordTransition(jobId: string, op: 'delivered' | 'release' | 'failed', ok: boolean): void {
    if (!ok) {
      logError('worker', `${op} rejected by server job=${jobId} printer=${this.printer.name}`)
      this.rejected.set(jobId, (this.rejected.get(jobId) ?? 0) + 1)
      return
    }
    if (op === 'delivered' || op === 'failed') this.rejected.delete(jobId)
  }
}
