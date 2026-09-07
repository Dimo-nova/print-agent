import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ServerClock } from '../src/clock.js'
import { fetchClaimable, claim, fetchPayload, markDelivered, release, markFailed, type ClaimableJob } from '../src/queue.js'
import { startFakePostgrest } from './helpers/fake-postgrest.js'

const RID = '90f965d0-05e6-4f46-a30d-527b5f4975ad'
let pg: Awaited<ReturnType<typeof startFakePostgrest>>
let client: SupabaseClient
const clock = new ServerClock()

beforeEach(async () => {
  pg = await startFakePostgrest()
  client = createClient(pg.url, 'sb_publishable_test', { auth: { persistSession: false, autoRefreshToken: false } })
})
afterEach(async () => { await pg.close() })

const job: ClaimableJob = { id: 'j1', printer_id: 'p1', target: 'bar', status: 'queued', attempts: 0, claimed_at: null }

describe('fetchClaimable', () => {
  it('pide queued o claimed viejos con el umbral del reloj del servidor, sin payload', async () => {
    pg.onRequest(() => ({ body: [job] }))
    const jobs = await fetchClaimable(client, RID, clock, 120_000)
    expect(jobs).toEqual([job])
    const req = pg.requests[0]!
    expect(req.method).toBe('GET')
    expect(req.path).toBe('/rest/v1/print_jobs')
    expect(req.query.get('select')).toBe('id,printer_id,target,status,attempts,claimed_at')
    expect(req.query.get('restaurant_id')).toBe(`eq.${RID}`)
    expect(req.query.get('or')).toMatch(/^\(status\.eq\.queued,and\(status\.eq\.claimed,claimed_at\.lt\.\d{4}-\d{2}-\d{2}T[^)]+\)\)$/)
    expect(req.query.get('order')).toBe('created_at.asc')
  })

  it('error del servidor: lanza', async () => {
    pg.onRequest(() => ({ status: 500, body: { message: 'boom' } }))
    await expect(fetchClaimable(client, RID, clock, 120_000)).rejects.toThrow(/boom/)
  })
})

describe('claim', () => {
  it('un queued se reclama solo si sigue queued: PATCH con attempts+1 y select', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    expect(await claim(client, job, clock, 120_000)).toBe(true)
    const req = pg.requests[0]!
    expect(req.method).toBe('PATCH')
    expect(req.query.get('id')).toBe('eq.j1')
    expect(req.query.get('status')).toBe('eq.queued')
    expect(req.query.get('claimed_at')).toBe(null)
    expect(req.query.get('select')).toBe('id')
    expect(req.body).toMatchObject({ status: 'claimed', attempts: 1 })
    expect(typeof (req.body as { claimed_at: string }).claimed_at).toBe('string')
    expect(String(req.headers.prefer)).toContain('return=representation')
  })

  it('un claimed abandonado se reclama solo si sigue abandonado: filtro claimed_at < umbral', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    const stale = { ...job, status: 'claimed' as const, attempts: 2, claimed_at: '2026-09-05T10:00:00.000Z' }
    expect(await claim(client, stale, clock, 120_000)).toBe(true)
    const req = pg.requests[0]!
    expect(req.query.get('status')).toBe('eq.claimed')
    expect(req.query.get('claimed_at')).toMatch(/^lt\.\d{4}-\d{2}-\d{2}T/)
    expect(req.body).toMatchObject({ status: 'claimed', attempts: 3 })
  })

  it('cero filas = no es mio', async () => {
    pg.onRequest(() => ({ body: [] }))
    expect(await claim(client, job, clock, 120_000)).toBe(false)
  })
})

describe('fetchPayload', () => {
  it('decodifica base64', async () => {
    pg.onRequest(() => ({ body: [{ payload: Buffer.from([0x1b, 0x40, 0x41]).toString('base64') }] }))
    expect(Array.from(await fetchPayload(client, 'j1'))).toEqual([0x1b, 0x40, 0x41])
    expect(pg.requests[0]!.query.get('select')).toBe('payload')
  })
})

describe('transiciones', () => {
  it('markDelivered', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    expect(await markDelivered(client, 'j1', clock)).toBe(true)
    const req = pg.requests[0]!
    expect(req.body).toMatchObject({ status: 'delivered', error: null })
    expect(typeof (req.body as { delivered_at: string }).delivered_at).toBe('string')
    expect(req.query.get('status')).toBe('eq.claimed')
  })

  it('release vuelve a queued con el error', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    expect(await release(client, 'j1', 'ECONNREFUSED 10.0.0.1:9100')).toBe(true)
    expect(pg.requests[0]!.body).toEqual({ status: 'queued', error: 'ECONNREFUSED 10.0.0.1:9100' })
  })

  it('markFailed', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    expect(await markFailed(client, 'j1', 'timeout 5000ms 10.0.0.1:9100', clock)).toBe(true)
    const body = pg.requests[0]!.body as Record<string, string>
    expect(body.status).toBe('failed')
    expect(body.error).toBe('timeout 5000ms 10.0.0.1:9100')
    expect(typeof body.failed_at).toBe('string')
  })

  it('un UPDATE rechazado devuelve false sin lanzar', async () => {
    pg.onRequest(() => ({ body: [] }))
    expect(await markDelivered(client, 'j1', clock)).toBe(false)
  })
})
