import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Libro local de trabajos ya impresos. Se escribe DESPUÉS de que el socket
 * cierre sin error y ANTES del UPDATE a Supabase: si la red cae en ese hueco,
 * el servidor reofrece el trabajo a los 2 min y aquí consta que ya salió, así
 * que se manda `delivered` sin volver a imprimir. Sin esto, cada corte de red
 * entre imprimir y confirmar sería una comanda duplicada en cocina.
 *
 * `node:sqlite` (Node ≥ 22.13): sin dependencias nativas que compilar en ARM.
 */
export class Ledger {
  private readonly db: DatabaseSync

  constructor(path: string, retentionDays = 7) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS printed (job_id TEXT PRIMARY KEY, printed_at TEXT NOT NULL)')
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM printed WHERE printed_at < ?').run(cutoff)
  }

  markPrinted(jobId: string, at: Date): void {
    this.db.prepare('INSERT OR REPLACE INTO printed (job_id, printed_at) VALUES (?, ?)').run(jobId, at.toISOString())
  }

  wasPrinted(jobId: string): boolean {
    return this.db.prepare('SELECT 1 AS one FROM printed WHERE job_id = ?').get(jobId) !== undefined
  }

  close(): void {
    this.db.close()
  }
}
