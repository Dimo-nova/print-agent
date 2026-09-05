/**
 * Una línea por evento, a stdout/stderr. journald pone timestamp de recepción,
 * pero se añade el ISO propio para poder cruzar con Supabase.
 */

export function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} [${scope}] ${msg}${formatExtra(extra)}\n`)
}

export function logError(scope: string, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? '' : String(err)
  process.stderr.write(`${new Date().toISOString()} [${scope}] ERROR ${msg}${detail ? ': ' + detail : ''}\n`)
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra) return ''
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${formatValue(v)}`)
  return parts.length ? ' ' + parts.join(' ') : ''
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}
