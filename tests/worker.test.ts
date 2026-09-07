import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ServerClock } from '../src/clock.js'
import { Ledger } from '../src/ledger.js'
import { PrinterWorker, type PrinterRow } from '../src/worker.js'
import type { ClaimableJob } from '../src/queue.js'
import { startFakePostgrest, type Recorded } from './helpers/fake-postgrest.js'
import { startFakePrinter, startFakePrinterOn } from './helpers/fake-printer.js'
import { waitFor } from './helpers/wait-for.js'

let pg: Awaited<ReturnType<typeof startFakePostgrest>>
let fake: Awaited<ReturnType<typeof startFakePrinter>>
let client: SupabaseClient
let ledger: Ledger
const clock = new ServerClock()
const slept: number[] = []
const sleep = async (ms: number) => { slept.push(ms) }
/** El backoff se duerme por lo que le queda, no por el escalon exacto: se
 * compara en segundos para que unos milisegundos de proceso no rompan el test. */
const sleptSeconds = () => slept.map(ms => Math.round(ms / 1000))
const payload = Buffer.from([0x1b, 0x40, 0x48, 0x49, 0x0a]).toString('base64')

beforeEach(async () => {
  pg = await startFakePostgrest()
  fake = await startFakePrinter()
  client = createClient(pg.url, 'k', { auth: { persistSession: false, autoRefreshToken: false } })
  ledger = new Ledger(':memory:')
  slept.length = 0
})
afterEach(async () => { ledger.close(); await pg.close(); await fake.close() })

const printer = (port: number): PrinterRow => ({ id: 'p1', name: 'Barra', target: 'bar', host: '127.0.0.1', port })
const job = (attempts = 0): ClaimableJob => ({ id: 'j1', printer_id: 'p1', target: 'bar', status: 'queued', attempts, claimed_at: null })

/** Responde a todo con éxito: claim/transiciones devuelven la fila, el payload es el fijado. */
function happyHandler(req: Recorded) {
  if (req.method === 'GET' && req.query.get('select') === 'payload') return { body: [{ payload }] }
  return { body: [{ id: 'j1' }] }
}
const patches = () => pg.requests.filter(r => r.method === 'PATCH').map(r => r.body as Record<string, unknown>)

describe('PrinterWorker', () => {
  it('camino feliz: claim, payload, bytes en la impresora, delivered, libro', async () => {
    pg.onRequest(happyHandler)
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job())
    await w.drain()
    await waitFor(() => fake.received.length === 1)
    expect(Array.from(fake.received[0]!)).toEqual([0x1b, 0x40, 0x48, 0x49, 0x0a])
    expect(patches().map(p => p.status)).toEqual(['claimed', 'delivered'])
    expect(ledger.wasPrinted('j1')).toBe(true)
    expect(slept).toEqual([])
  })

  it('ya en el libro: delivered sin imprimir', async () => {
    pg.onRequest(happyHandler)
    ledger.markPrinted('j1', new Date())
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job(1))
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(patches().map(p => p.status)).toEqual(['claimed', 'delivered'])
  })

  it('claim rechazado: no hace nada mas', async () => {
    pg.onRequest(req => (req.method === 'PATCH' ? { body: [] } : happyHandler(req)))
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job())
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(patches()).toHaveLength(1)
  })

  it('impresora inaccesible con intentos restantes: release con error y backoff', async () => {
    pg.onRequest(happyHandler)
    await fake.close()
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 1_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job(0))
    await w.drain()
    const p = patches()
    expect(p.map(x => x.status)).toEqual(['claimed', 'queued'])
    expect(String(p[1]!.error)).toMatch(/ECONNREFUSED/)
    expect(sleptSeconds()).toEqual([5])
    expect(ledger.wasPrinted('j1')).toBe(false)
  })

  it('decimo intento fallido: failed', async () => {
    pg.onRequest(happyHandler)
    await fake.close()
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 1_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job(9))
    await w.drain()
    const p = patches()
    expect(p.map(x => x.status)).toEqual(['claimed', 'failed'])
    expect(p[0]!.attempts).toBe(10)
    expect(typeof p[1]!.failed_at).toBe('string')
    expect(slept).toEqual([])
  })

  it('el backoff frena un job reofrecido por el poll', async () => {
    // El fallo de socket deja la impresora en backoff. El poll reofrece el
    // job enseguida y antes se colaba directo al claim, quemando el intento
    // siguiente. Con el sleep inyectado el segundo intento sí corre: lo que
    // se comprueba es que se pidió dormir el escalón antes de reclamar.
    pg.onRequest(happyHandler)
    await fake.close()
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 1_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job(0))
    await w.drain()
    expect(sleptSeconds()).toEqual([5])
    w.enqueue(job(1))
    await w.drain()
    expect(slept.length).toBeGreaterThanOrEqual(1)
    expect(sleptSeconds()[0]).toBe(5)
    expect(patches().filter(p => p.status === 'claimed')).toHaveLength(2)
  })

  it('wake() cancela el backoff pendiente', async () => {
    // La impresora falla, se libera con backoff (5 s: pausedUntil queda ~5 s
    // en el futuro). La impresora vuelve a responder en el MISMO puerto y
    // wake() debe poner pausedUntil a 0 para que el siguiente job se procese
    // sin esperar ningún escalón extra -- es justo lo que hace el heartbeat
    // en producción en cuanto su probe() ve la impresora otra vez arriba.
    // Con el sleep inyectado no hay temporizador real que cancelar (eso lo
    // cubre pendingWake en produccion via defaultSleep); lo que se comprueba
    // aqui es la otra mitad de wake(): sin ella, encolar job(1) mientras
    // pausedUntil sigue en el futuro dormiria un escalon completo de mas
    // antes de reclamar, exactamente el caso que "el backoff frena un job
    // reofrecido por el poll" (arriba) verifica que SI debe pasar sin wake().
    pg.onRequest(happyHandler)
    const port = fake.port
    await fake.close()
    const w = new PrinterWorker(printer(port), { client, clock, ledger, socketTimeoutMs: 1_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job(0))
    await w.drain()
    expect(sleptSeconds()).toEqual([5])
    const sleptBeforeWake = slept.length

    fake = await startFakePrinterOn(port)
    w.wake()
    w.enqueue(job(1))
    await w.drain()

    await waitFor(() => fake.received.length === 1)
    expect(slept.length).toBe(sleptBeforeWake)
    expect(patches().filter(p => p.status === 'claimed')).toHaveLength(2)
  })

  it('el mismo id encolado dos veces se procesa una', async () => {
    pg.onRequest(happyHandler)
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job())
    w.enqueue(job())
    await w.drain()
    await waitFor(() => fake.received.length === 1)
    expect(patches()).toHaveLength(2)
  })

  it('error de Supabase a mitad: deja el job y duerme 10 s', async () => {
    pg.onRequest(req => (req.method === 'PATCH' ? { status: 500, body: { message: 'db down' } } : happyHandler(req)))
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job())
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(sleptSeconds()).toEqual([10])
  })

  it('Supabase falla despues de imprimir: no reimprime al reintentar', async () => {
    // Primer pase: todo bien salvo el PATCH delivered, que da 500. Segundo pase
    // (el poll reofrece el job): el libro dice impreso, delivered sin socket.
    let deliveredFails = true
    pg.onRequest(req => {
      if (req.method === 'PATCH' && (req.body as { status?: string }).status === 'delivered' && deliveredFails) {
        return { status: 500, body: { message: 'db down' } }
      }
      return happyHandler(req)
    })
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    w.enqueue(job())
    await w.drain()
    expect(ledger.wasPrinted('j1')).toBe(true)
    expect(sleptSeconds()).toEqual([10])

    deliveredFails = false
    w.enqueue(job(1))
    await w.drain()
    await waitFor(() => patches().length === 4)
    expect(fake.received).toHaveLength(1)
    expect(patches().map(p => p.status)).toEqual(['claimed', 'delivered', 'claimed', 'delivered'])
  })

  it('markDelivered rechazado: se loguea y tras tres rechazos deja de reclamar', async () => {
    pg.onRequest(req => {
      if (req.method === 'PATCH' && (req.body as { status?: string }).status === 'delivered') return { body: [] }
      return happyHandler(req)
    })
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, staleClaimMs: 120_000, sleep })
    for (let i = 0; i < 4; i++) { w.enqueue(job(i)); await w.drain() }
    await waitFor(() => fake.received.length === 1)
    // Tres pases reclaman e intentan delivered; el cuarto ya no reclama: lo
    // deja `failed` una sola vez para que el servidor deje de reofrecerlo.
    expect(patches().filter(p => p.status === 'claimed')).toHaveLength(3)
    expect(patches().filter(p => p.status === 'failed')).toHaveLength(1)
    expect(fake.received).toHaveLength(1) // el libro evita reimprimir en los pases 2 y 3
  })
})
