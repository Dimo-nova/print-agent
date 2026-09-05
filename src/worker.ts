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
  private pendingWake: (() => void) | null = null

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

  /** Para tests: espera a que la cola esté vacía y el bucle parado. */
  async drain(): Promise<void> {
    while (this.running || this.queue.size > 0) await new Promise(resolve => setTimeout(resolve, 5))
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped) {
        const next = this.queue.values().next()
        if (next.done) break
        const job = next.value
        this.queue.delete(job.id)
        this.current = job.id
        const pauseMs = await this.process(job)
        this.current = null
        if (this.stopped) break
        if (pauseMs > 0) await this.sleep(pauseMs)
      }
    } finally {
      this.running = false
    }
  }

  /** Devuelve los ms a dormir antes del siguiente trabajo de esta impresora. */
  private async process(job: ClaimableJob): Promise<number> {
    const { client, clock, ledger } = this.deps
    const scope = 'worker'
    const tag = { job: job.id, printer: this.printer.name }
    try {
      if ((this.rejected.get(job.id) ?? 0) >= 3) {
        logError(scope, `giving up locally after 3 rejected updates job=${job.id}`)
        return 0
      }
      if (!(await claim(client, job, clock))) {
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
        log(scope, 'socket error, released', { ...tag, attempt, error: message, backoffMs: pause })
        return pause
      }

      // Primero el libro, luego Supabase: si la red cae entre los dos, el
      // reoferto de dentro de 2 min encuentra el job en el libro y no reimprime.
      try {
        ledger.markPrinted(job.id, clock.now())
      } catch (err) {
        logError(scope, `ledger write failed job=${job.id}: duplicate ticket possible if delivery is not confirmed`, err)
      }
      const delivered = await markDelivered(client, job.id, clock)
      this.recordTransition(job.id, 'delivered', delivered)
      log(scope, 'delivered', { ...tag, bytes: bytes.length })
      return 0
    } catch (err) {
      logError(scope, `supabase error, job left for next poll job=${job.id}`, err)
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
