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
  private readonly keep: number

  constructor(path: string, keep = 5000) {
    this.keep = keep
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS printed (job_id TEXT PRIMARY KEY, printed_at TEXT NOT NULL)')
    this.prune()
  }

  /**
   * Deja las últimas `keep` filas y borra el resto. Se llama al abrir y a
   * diario desde index.ts, para que un proceso de larga duración no acumule
   * filas para siempre. Por cantidad y no por antigüedad a propósito: el
   * reloj de la Pi puede estar en 1970 al arrancar, y una retención por
   * fecha borraría entonces el libro entero justo cuando hace falta (es lo
   * único que impide reimprimir una comanda ya servida). `printed_at` se
   * conserva, pero solo para leerlo un humano.
   */
  prune(): void {
    this.db
      .prepare('DELETE FROM printed WHERE rowid NOT IN (SELECT rowid FROM printed ORDER BY rowid DESC LIMIT ?)')
      .run(this.keep)
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
