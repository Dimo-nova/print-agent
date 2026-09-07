import { describe, it, expect, vi, afterEach } from 'vitest'
import { ServerClock, clockFetch } from '../src/clock.js'

afterEach(() => vi.useRealTimers())

describe('ServerClock', () => {
  it('sin observaciones, now() es el reloj local', () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T10:00:00Z') })
    const clock = new ServerClock()
    expect(clock.skewMs()).toBe(0)
    expect(clock.now().toISOString()).toBe('2026-09-05T10:00:00.000Z')
  })

  it('observe con cabecera Date ajusta la deriva, positiva o negativa', () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T10:00:00Z') })
    const clock = new ServerClock()
    clock.observe('Sat, 05 Sep 2026 10:05:00 GMT')
    expect(clock.skewMs()).toBe(300_000)
    expect(clock.now().toISOString()).toBe('2026-09-05T10:05:00.000Z')
    clock.observe('Sat, 05 Sep 2026 09:59:00 GMT')
    expect(clock.skewMs()).toBe(-60_000)
  })

  it('cabecera invalida o ausente no toca la deriva', () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T10:00:00Z') })
    const clock = new ServerClock()
    clock.observe('Sat, 05 Sep 2026 10:05:00 GMT')
    clock.observe(null)
    clock.observe(undefined)
    clock.observe('not a date')
    expect(clock.skewMs()).toBe(300_000)
  })
})

describe('clockFetch', () => {
  it('lee la cabecera Date de cada respuesta', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-05T10:00:00Z') })
    const clock = new ServerClock()
    const fake: typeof fetch = async () => new Response('{}', { headers: { date: 'Sat, 05 Sep 2026 10:00:30 GMT' } })
    const wrapped = clockFetch(clock, fake)
    const res = await wrapped('https://example.test/x')
    expect(res.status).toBe(200)
    expect(clock.skewMs()).toBe(30_000)
  })

  it('aborta la peticion que se queda colgada', async () => {
    // Una conexion que muere sin FIN (el NAT del local corta la sesion) deja
    // el fetch esperando para siempre y con el el poll entero.
    const clock = new ServerClock()
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const started = Date.now()
    await expect(clockFetch(clock, hanging, 50)('https://example.test/x')).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
