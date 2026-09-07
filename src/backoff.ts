/** Espera entre intentos contra una impresora que no responde. Por intento, no global. */
export const BACKOFF_MS = [5_000, 15_000, 45_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000] as const

/**
 * Al décimo intento fallido el trabajo pasa a `failed`: 5 s, 15 s, 45 s y
 * luego 60 s x7, unos 8 min 5 s de reintentos en total. La cola anterior (2
 * min y luego 5 min) medida en campo el 2026-09-07 era demasiado lenta para
 * un bar: la impresora volvía y el ticket tardaba minutos en salir. Ahora el
 * probe del heartbeat (`heartbeat.ts`, `onPrinterAlive`) despierta al worker
 * en cuanto la impresora vuelve a responder, así que este backoff es solo el
 * techo para cuando nadie más avisa. El KDS sigue mostrando el pedido mientras tanto.
 */
export const MAX_ATTEMPTS = 10

export function backoffFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
}

export function isExhausted(attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS
}
