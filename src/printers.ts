import type { RealtimeChannel, RealtimePostgresChangesPayload, SupabaseClient } from '@supabase/supabase-js'
import type { PrinterRow } from './worker.js'
import { log, logError } from './log.js'

export type { PrinterRow } from './worker.js'

/**
 * Caché de las impresoras activas del local. Se recarga entera con cualquier
 * evento de `printers` (alta, baja, cambio de IP, activar/desactivar): son
 * dos o tres filas, no merece la pena aplicar deltas.
 */
export class PrinterCache {
  private rows = new Map<string, PrinterRow>()
  private channel: RealtimeChannel | null = null
  private loggedOnce = false

  constructor(private readonly client: SupabaseClient, private readonly restaurantId: string) {}

  async load(): Promise<void> {
    const { data, error } = await this.client
      .from('printers')
      .select('id, name, target, host, port')
      .eq('restaurant_id', this.restaurantId)
      .eq('active', true)
    if (error) throw new Error(`printers load: ${error.message}`)
    const next = new Map((data as PrinterRow[]).map(p => [p.id, p]))
    // El poll recarga esta tabla cada minuto (por si se pierde un evento de
    // Realtime), así que solo se loguea cuando el conjunto cambia de verdad:
    // si no, el journal serían 1440 líneas idénticas al día.
    const changed = !this.loggedOnce || !sameSet(this.rows, next)
    this.rows = next
    if (changed) {
      this.loggedOnce = true
      log('printers', 'loaded', { n: this.rows.size, names: this.all().map(p => p.name).join(',') || '-' })
    }
  }

  get(id: string): PrinterRow | undefined {
    return this.rows.get(id)
  }

  all(): PrinterRow[] {
    return [...this.rows.values()]
  }

  subscribe(onChange: () => void): void {
    this.channel = this.client
      .channel(`printers:${this.restaurantId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'printers', filter: `restaurant_id=eq.${this.restaurantId}` },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          // El propio heartbeat hace un UPDATE de last_seen_at cada
          // heartbeatMs: eso no es un cambio que le importe al agente y no
          // debe recargar la caché ni disparar un poll (era ruido y dos
          // peticiones extra por heartbeat).
          if (payload.eventType === 'UPDATE' && !printerRowChanged(payload.old, payload.new)) return
          this.load().then(onChange).catch(err => logError('printers', 'reload failed', err))
        },
      )
      .subscribe(status => log('printers', 'channel', { status }))
  }

  async unsubscribe(): Promise<void> {
    if (this.channel) await this.client.removeChannel(this.channel)
    this.channel = null
  }

  /** Estado actual del canal, para que index.ts decida si hace falta resuscribir. */
  state(): string {
    return this.channel?.state ?? 'closed'
  }

  /** Tira el canal viejo y crea uno nuevo con el mismo callback. */
  async resubscribe(onChange: () => void): Promise<void> {
    await this.unsubscribe()
    this.subscribe(onChange)
  }
}

const WATCHED_FIELDS = ['name', 'target', 'host', 'port', 'active'] as const

/**
 * ¿Cambió algo que le importe al agente? Compara solo las columnas que
 * afectan al enrutado de comandas; `last_seen_at`/`updated_at` (lo único que
 * toca nuestro propio heartbeat) se ignoran a propósito. Sin fila anterior
 * (INSERT, o un UPDATE sin REPLICA IDENTITY FULL) se trata como cambio.
 */
export function printerRowChanged(
  oldRow: Record<string, unknown> | null | undefined,
  newRow: Record<string, unknown>,
): boolean {
  if (!oldRow) return true
  return WATCHED_FIELDS.some(field => oldRow[field] !== newRow[field])
}

/** Mismo conjunto de impresoras y mismo endpoint en cada una. */
function sameSet(a: Map<string, PrinterRow>, b: Map<string, PrinterRow>): boolean {
  if (a.size !== b.size) return false
  for (const [id, row] of a) {
    const other = b.get(id)
    if (!other || other.host !== row.host || other.port !== row.port) return false
  }
  return true
}
