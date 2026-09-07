import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServerClock } from './clock.js'
import { log } from './log.js'

/**
 * Las cinco operaciones del agente sobre print_jobs. Todas las escrituras
 * piden la fila de vuelta (`.select('id')`): PostgREST responde 204 sin
 * recuento y un UPDATE rechazado por RLS o por trigger sería indistinguible
 * de un éxito. Cero filas = no era mío, y se devuelve false sin lanzar.
 * Los errores de red o de servidor sí se lanzan: el worker decide.
 */

export interface ClaimableJob {
  id: string
  printer_id: string
  target: string
  status: 'queued' | 'claimed'
  attempts: number
  claimed_at: string | null
}

const CLAIMABLE_COLUMNS = 'id,printer_id,target,status,attempts,claimed_at'

export async function fetchClaimable(
  client: SupabaseClient,
  restaurantId: string,
  clock: ServerClock,
  staleClaimMs: number,
): Promise<ClaimableJob[]> {
  const cutoff = new Date(clock.now().getTime() - staleClaimMs).toISOString()
  const { data, error } = await client
    .from('print_jobs')
    .select(CLAIMABLE_COLUMNS)
    .eq('restaurant_id', restaurantId)
    .or(`status.eq.queued,and(status.eq.claimed,claimed_at.lt.${cutoff})`)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`fetchClaimable: ${error.message}`)
  return (data ?? []) as ClaimableJob[]
}

export async function claim(
  client: SupabaseClient,
  job: ClaimableJob,
  clock: ServerClock,
  staleClaimMs: number,
): Promise<boolean> {
  let query = client
    .from('print_jobs')
    .update({ status: 'claimed', claimed_at: clock.now().toISOString(), attempts: job.attempts + 1 })
    .eq('id', job.id)
  // CAS sobre lo que vio el poll: un queued solo se reclama si sigue queued;
  // un claimed solo si sigue abandonado (claimed_at anterior al umbral). Así
  // dos procesos con las mismas credenciales no imprimen los dos.
  query = job.status === 'queued'
    ? query.eq('status', 'queued')
    : query.eq('status', 'claimed').lt('claimed_at', new Date(clock.now().getTime() - staleClaimMs).toISOString())
  const { data, error } = await query.select('id')
  if (error) throw new Error(`claim ${job.id}: ${error.message}`)
  return (data ?? []).length === 1
}

export async function fetchPayload(client: SupabaseClient, jobId: string): Promise<Uint8Array> {
  const { data, error } = await client.from('print_jobs').select('payload').eq('id', jobId).single()
  if (error || !data) throw new Error(`fetchPayload ${jobId}: ${error?.message ?? 'no row'}`)
  return new Uint8Array(Buffer.from((data as { payload: string }).payload, 'base64'))
}

export function markDelivered(client: SupabaseClient, jobId: string, clock: ServerClock): Promise<boolean> {
  return transition(client, jobId, 'delivered', { status: 'delivered', delivered_at: clock.now().toISOString() })
}

/** Socket falló pero quedan intentos: de vuelta a la cola con el motivo. */
export function release(client: SupabaseClient, jobId: string, error: string): Promise<boolean> {
  return transition(client, jobId, 'release', { status: 'queued', error })
}

export function markFailed(client: SupabaseClient, jobId: string, error: string, clock: ServerClock): Promise<boolean> {
  return transition(client, jobId, 'failed', { status: 'failed', error, failed_at: clock.now().toISOString() })
}

async function transition(
  client: SupabaseClient,
  jobId: string,
  op: string,
  patch: Record<string, string>,
): Promise<boolean> {
  const { data, error } = await client
    .from('print_jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('status', 'claimed')
    .select('id')
  if (error) throw new Error(`${op} ${jobId}: ${error.message}`)
  const applied = (data ?? []).length === 1
  if (!applied) log('queue', 'update rejected', { job: jobId, op })
  return applied
}
