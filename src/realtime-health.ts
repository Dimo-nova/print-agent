/**
 * Decide si un canal de Realtime merece un intento de resuscripcion. Puro a
 * proposito (nada de red aqui) para poder probarlo sin un servidor Realtime:
 * la logica real vive en index.ts, que llama a esto en cada poll exitoso.
 */
export function shouldResubscribe(
  state: string,
  lastAttemptMs: number,
  nowMs: number,
  minGapMs = 60_000,
): boolean {
  if (state === 'joined' || state === 'joining') return false
  return nowMs - lastAttemptMs >= minGapMs
}
