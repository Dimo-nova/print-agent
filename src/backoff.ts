/** Espera entre intentos contra una impresora que no responde. Por intento, no global. */
export const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const

/** Al quinto intento fallido el trabajo pasa a `failed`. El KDS sigue mostrando el pedido. */
export const MAX_ATTEMPTS = 5

export function backoffFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
}

export function isExhausted(attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS
}
