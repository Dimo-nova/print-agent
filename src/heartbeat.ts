import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServerClock } from './clock.js'
import type { PrinterCache } from './printers.js'
import { probe } from './printer.js'
import { log, logError } from './log.js'

export interface HeartbeatDeps {
  client: SupabaseClient
  agentId: string
  printers: PrinterCache
  clock: ServerClock
  heartbeatMs: number
  probeTimeoutMs: number
  version: string
  /**
   * Despierta el worker de la impresora en cuanto el probe la ve responder de
   * nuevo, para no esperar el resto de su backoff (hasta 60 s por escalón).
   */
  onPrinterAlive?: (printerId: string) => void
}

/**
 * Cada `heartbeatMs`: la Pi dice que vive (print_agents.last_seen_at) y, por
 * impresora activa, un TCP connect+close. Si la impresora responde, se pone
 * su last_seen_at; si no, no se toca y el panel la pinta gris. Devuelve stop().
 */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  let stopped = false
  let running = false
  // Último estado conocido por impresora, para loguear solo la transición de
  // no-alcanzable a alcanzable (no una línea por tick mientras va bien).
  const reachable = new Map<string, boolean>()

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const now = deps.clock.now().toISOString()
      try {
        const { data, error } = await deps.client
          .from('print_agents')
          .update({ last_seen_at: now, version: deps.version })
          .eq('id', deps.agentId)
          .select('id')
        if (error) throw error
        if ((data ?? []).length !== 1) log('heartbeat', 'agent update rejected (deactivated?)')
      } catch (err) {
        logError('heartbeat', 'agent heartbeat failed', err)
      }

      for (const printer of deps.printers.all()) {
        const alive = await probe({ host: printer.host, port: printer.port }, deps.probeTimeoutMs)
        if (!alive) {
          reachable.set(printer.id, false)
          log('heartbeat', 'printer unreachable', { printer: printer.name, host: `${printer.host}:${printer.port}` })
          continue
        }
        if (reachable.get(printer.id) === false) log('heartbeat', 'printer reachable again', { printer: printer.name })
        reachable.set(printer.id, true)
        deps.onPrinterAlive?.(printer.id)
        try {
          const { error } = await deps.client.from('printers').update({ last_seen_at: now }).eq('id', printer.id).select('id')
          if (error) throw error
        } catch (err) {
          logError('heartbeat', `printer heartbeat failed printer=${printer.name}`, err)
        }
      }
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), deps.heartbeatMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
