/**
 * Espera activa a que se cumpla una condición, en lugar de un `setTimeout` de
 * 50 ms al tuntún: en una Pi cargada 50 ms se quedan cortos (test intermitente)
 * y en un portátil sobran (test lento sin motivo).
 */
export async function waitFor(cond: () => boolean, timeoutMs = 2_000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: condicion no cumplida en ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}
