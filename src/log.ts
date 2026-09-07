/**
 * Una línea por evento, a stdout/stderr. journald pone timestamp de recepción,
 * pero se añade el ISO propio para poder cruzar con Supabase.
 */

export function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} [${scope}] ${msg}${formatExtra(extra)}\n`)
}

export function logError(scope: string, msg: string, err?: unknown): void {
  const detail = errorDetail(err)
  process.stderr.write(`${new Date().toISOString()} [${scope}] ERROR ${msg}${detail ? ': ' + detail : ''}\n`)
}

/**
 * Los errores de Supabase (PostgrestError, AuthError, ...) no son instancias
 * de Error: son objetos planos { message, code, details, hint }. `String(err)`
 * sobre esos da "[object Object]", que es lo que se veía en el journal.
 */
function errorDetail(err: unknown): string {
  if (err === undefined) return ''
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? `${message} (${code})` : message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
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
