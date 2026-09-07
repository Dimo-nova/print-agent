/**
 * El reloj de la Pi no es de fiar (RTC muerto, NTP aún no sincronizado al
 * arrancar). PostgREST manda una cabecera `Date` en cada respuesta: con ella
 * se calcula la deriva y todo lo que compara con tiempos del servidor (el
 * umbral de 2 min de un `claimed` abandonado, `claimed_at`) usa `now()`.
 * Resolución de un segundo, más que de sobra.
 */
export class ServerClock {
  private skew = 0

  observe(dateHeader: string | null | undefined): void {
    if (!dateHeader) return
    const serverMs = Date.parse(dateHeader)
    if (Number.isNaN(serverMs)) return
    this.skew = serverMs - Date.now()
  }

  now(): Date {
    return new Date(Date.now() + this.skew)
  }

  skewMs(): number {
    return this.skew
  }
}

/**
 * `fetch` que alimenta el reloj con cada respuesta. Se le pasa a supabase-js en
 * `global.fetch`. Lleva timeout propio: sin él, una conexión que queda a medias
 * (wifi del local que se va, NAT que corta la sesión sin FIN) deja la petición
 * colgada para siempre y con ella el `poll()` o el heartbeat, sin un solo log.
 */
export function clockFetch(clock: ServerClock, base: typeof fetch = fetch, timeoutMs = 15_000): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const res = await base(input, { ...init, signal })
    clock.observe(res.headers.get('date'))
    return res
  }
}
