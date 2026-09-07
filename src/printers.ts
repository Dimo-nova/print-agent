import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
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
        () => {
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

/** Mismo conjunto de impresoras y mismo endpoint en cada una. */
function sameSet(a: Map<string, PrinterRow>, b: Map<string, PrinterRow>): boolean {
  if (a.size !== b.size) return false
  for (const [id, row] of a) {
    const other = b.get(id)
    if (!other || other.host !== row.host || other.port !== row.port) return false
  }
  return true
}
