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

  constructor(readonly printer: PrinterRow, private readonly deps: WorkerDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Idempotente por id: el poll y el timbre pueden traer el mismo job. */
  enqueue(job: ClaimableJob): void {
    if (this.stopped || this.queue.has(job.id)) return
    this.queue.set(job.id, job)
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.queue.clear()
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
        const pauseMs = await this.process(job)
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
      if (!(await claim(client, job, clock))) {
        log(scope, 'claim rejected, skipping', tag)
        return 0
      }
      const attempt = job.attempts + 1
      log(scope, 'claimed', { ...tag, attempt })

      if (ledger.wasPrinted(job.id)) {
        await markDelivered(client, job.id, clock)
        log(scope, 'already printed, delivered without reprint', tag)
        return 0
      }

      const bytes = await fetchPayload(client, job.id)
      try {
        await sendBytes({ host: this.printer.host, port: this.printer.port }, bytes, this.deps.socketTimeoutMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isExhausted(attempt)) {
          await markFailed(client, job.id, message, clock)
          logError(scope, `failed after ${attempt} attempts job=${job.id} printer=${this.printer.name}`, message)
          return 0
        }
        await release(client, job.id, message)
        const pause = backoffFor(attempt)
        log(scope, 'socket error, released', { ...tag, attempt, error: message, backoffMs: pause })
        return pause
      }

      // Primero el libro, luego Supabase: si la red cae entre los dos, el
      // reoferto de dentro de 2 min encuentra el job en el libro y no reimprime.
      ledger.markPrinted(job.id, clock.now())
      await markDelivered(client, job.id, clock)
      log(scope, 'delivered', { ...tag, bytes: bytes.length })
      return 0
    } catch (err) {
      logError(scope, `supabase error, job left for next poll job=${job.id}`, err)
      return SUPABASE_ERROR_PAUSE_MS
    }
  }
}
