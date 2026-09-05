import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ServerClock } from '../src/clock.js'
import { Ledger } from '../src/ledger.js'
import { PrinterWorker, type PrinterRow } from '../src/worker.js'
import type { ClaimableJob } from '../src/queue.js'
import { startFakePostgrest, type Recorded } from './helpers/fake-postgrest.js'
import { startFakePrinter } from './helpers/fake-printer.js'

let pg: Awaited<ReturnType<typeof startFakePostgrest>>
let fake: Awaited<ReturnType<typeof startFakePrinter>>
let client: SupabaseClient
let ledger: Ledger
const clock = new ServerClock()
const slept: number[] = []
const sleep = async (ms: number) => { slept.push(ms) }
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
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, sleep })
    w.enqueue(job())
    await w.drain()
    await new Promise(r => setTimeout(r, 50))
    expect(fake.received).toHaveLength(1)
    expect(Array.from(fake.received[0]!)).toEqual([0x1b, 0x40, 0x48, 0x49, 0x0a])
    expect(patches().map(p => p.status)).toEqual(['claimed', 'delivered'])
    expect(ledger.wasPrinted('j1')).toBe(true)
    expect(slept).toEqual([])
  })

  it('ya en el libro: delivered sin imprimir', async () => {
    pg.onRequest(happyHandler)
    ledger.markPrinted('j1', new Date())
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, sleep })
    w.enqueue(job(1))
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(patches().map(p => p.status)).toEqual(['claimed', 'delivered'])
  })

  it('claim rechazado: no hace nada mas', async () => {
    pg.onRequest(req => (req.method === 'PATCH' ? { body: [] } : happyHandler(req)))
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, sleep })
    w.enqueue(job())
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(patches()).toHaveLength(1)
  })

  it('impresora inaccesible con intentos restantes: release con error y backoff', async () => {
    pg.onRequest(happyHandler)
    await fake.close()
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 1_000, sleep })
    w.enqueue(job(0))
    await w.drain()
    const p = patches()
    expect(p.map(x => x.status)).toEqual(['claimed', 'queued'])
    expect(String(p[1]!.error)).toMatch(/ECONNREFUSED/)
    expect(slept).toEqual([5_000])
    expect(ledger.wasPrinted('j1')).toBe(false)
  })

  it('quinto intento fallido: failed', async () => {
    pg.onRequest(happyHandler)
    await fake.close()
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 1_000, sleep })
    w.enqueue(job(4))
    await w.drain()
    const p = patches()
    expect(p.map(x => x.status)).toEqual(['claimed', 'failed'])
    expect(p[0]!.attempts).toBe(5)
    expect(typeof p[1]!.failed_at).toBe('string')
    expect(slept).toEqual([])
  })

  it('el mismo id encolado dos veces se procesa una', async () => {
    pg.onRequest(happyHandler)
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, sleep })
    w.enqueue(job())
    w.enqueue(job())
    await w.drain()
    await new Promise(r => setTimeout(r, 50))
    expect(fake.received).toHaveLength(1)
  })

  it('error de Supabase a mitad: deja el job y duerme 10 s', async () => {
    pg.onRequest(req => (req.method === 'PATCH' ? { status: 500, body: { message: 'db down' } } : happyHandler(req)))
    const w = new PrinterWorker(printer(fake.port), { client, clock, ledger, socketTimeoutMs: 2_000, sleep })
    w.enqueue(job())
    await w.drain()
    expect(fake.connections).toBe(0)
    expect(slept).toEqual([10_000])
  })
})
