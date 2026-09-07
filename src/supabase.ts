import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Config } from './config.js'
import { clockFetch, type ServerClock } from './clock.js'
import { log, logError } from './log.js'

export interface AgentRow {
  id: string
  restaurant_id: string
  name: string
  active: boolean
}

export interface Session {
  client: SupabaseClient
  agent: AgentRow
}

const LOGIN_RETRY_MS = 10_000
const AGENT_ROW_RETRY_MS = 60_000

export function createAgentClient(cfg: Config, clock: ServerClock): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: clockFetch(clock) },
    realtime: { params: { eventsPerSecond: 5 } },
  })
}

/**
 * Login con la identidad del print_agent y lectura de su fila. Nunca sale del
 * proceso por su cuenta: sin red reintenta cada 10 s; sin fila visible o con
 * el agente desactivado desde el panel, cada 60 s. Reactivarlo en el panel
 * basta para que arranque.
 */
export async function connect(
  cfg: Config,
  clock: ServerClock,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Session> {
  const client = createAgentClient(cfg, clock)

  for (;;) {
    const { error } = await client.auth.signInWithPassword({ email: cfg.agentEmail, password: cfg.agentPassword })
    if (!error) break
    logError('supabase', `login failed, retry in ${LOGIN_RETRY_MS / 1000}s`, error)
    await sleep(LOGIN_RETRY_MS)
  }
  log('supabase', 'signed in', { email: cfg.agentEmail })

  // Rotación de token: supabase-js ya reenvía el JWT a Realtime por su cuenta,
  // esto es cinturón y tirantes. Lo que NO hace solo es volver a entrar si la
  // sesión se pierde (contraseña regenerada, refresh rechazado): a partir de
  // ahí las consultas irían como anon, RLS devolvería cero filas y el agente
  // parecería sano sin imprimir nada. Salir con 1 deja que systemd reinicie
  // y connect() vuelva a hacer login con el .env.
  client.auth.onAuthStateChange((event, session) => {
    if (session?.access_token) {
      client.realtime.setAuth(session.access_token)
      return
    }
    // La versión instalada de @supabase/auth-js no tipa 'USER_DELETED' en
    // AuthChangeEvent (solo 'SIGNED_OUT' existe en el enum), pero por si una
    // versión futura la emite se comprueba igual con un cast defensivo.
    if (event === 'SIGNED_OUT' || (event as string) === 'USER_DELETED') {
      logError('supabase', `session lost (${event}), exiting so systemd restarts and re-logs in`)
      process.exit(1)
    }
  })
  const { data: { session } } = await client.auth.getSession()
  if (session?.access_token) client.realtime.setAuth(session.access_token)

  for (;;) {
    const { data, error } = await client
      .from('print_agents')
      .select('id, restaurant_id, name, active')
      .maybeSingle()
    if (error) {
      logError('supabase', `print_agents read failed, retry in ${AGENT_ROW_RETRY_MS / 1000}s`, error)
    } else if (!data) {
      log('supabase', `no print_agents row visible for this login, retry in ${AGENT_ROW_RETRY_MS / 1000}s`)
    } else if (!data.active) {
      log('supabase', `agent is deactivated in the panel, retry in ${AGENT_ROW_RETRY_MS / 1000}s`, { agent: data.name })
    } else {
      log('supabase', 'agent', { agent: data.name, restaurant: data.restaurant_id })
      return { client, agent: data as AgentRow }
    }
    await sleep(AGENT_ROW_RETRY_MS)
  }
}
