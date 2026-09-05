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

  constructor(private readonly client: SupabaseClient, private readonly restaurantId: string) {}

  async load(): Promise<void> {
    const { data, error } = await this.client
      .from('printers')
      .select('id, name, target, host, port')
      .eq('restaurant_id', this.restaurantId)
      .eq('active', true)
    if (error) throw new Error(`printers load: ${error.message}`)
    this.rows = new Map((data as PrinterRow[]).map(p => [p.id, p]))
    log('printers', 'loaded', { n: this.rows.size, names: this.all().map(p => p.name).join(',') || '-' })
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
}
