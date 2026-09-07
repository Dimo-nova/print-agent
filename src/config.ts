import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Toda la configuración del agente. Solo cuatro valores son obligatorios:
 * URL y clave publishable de Supabase, y el email/contraseña del print_agent
 * del local. `restaurant_id` NO va aquí: sale de la fila de print_agents que
 * RLS le deja ver al agente tras el login.
 */
export interface Config {
  supabaseUrl: string
  supabaseKey: string
  agentEmail: string
  agentPassword: string
  pollIntervalMs: number
  heartbeatMs: number
  staleClaimMs: number
  socketTimeoutMs: number
  probeTimeoutMs: number
  ledgerPath: string
  version: string
}

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'AGENT_EMAIL', 'AGENT_PASSWORD'] as const

/** `KEY=VALUE` por línea. Comentarios con `#`, comillas simples o dobles opcionales. Sin dotenv. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Carga `path` en `env` sin pisar lo que ya esté definido (systemd manda). */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, 'utf8')))) {
    if (env[key] === undefined) env[key] = value
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): Config {
  const missing = REQUIRED.filter(k => !env[k]?.trim())
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(', ')} (see .env.example)`)
  }
  return {
    supabaseUrl: env.SUPABASE_URL!.trim().replace(/\/+$/, ''),
    supabaseKey: env.SUPABASE_PUBLISHABLE_KEY!.trim(),
    agentEmail: env.AGENT_EMAIL!.trim(),
    agentPassword: env.AGENT_PASSWORD!,
    pollIntervalMs: intFrom(env.POLL_INTERVAL_MS, 60_000),
    heartbeatMs: intFrom(env.HEARTBEAT_MS, 30_000),
    staleClaimMs: intFrom(env.STALE_CLAIM_MS, 120_000),
    socketTimeoutMs: intFrom(env.SOCKET_TIMEOUT_MS, 5_000),
    probeTimeoutMs: intFrom(env.PROBE_TIMEOUT_MS, 3_000),
    ledgerPath: resolve(env.LEDGER_PATH?.trim() || 'data/ledger.sqlite'),
    version,
  }
}

function intFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback
}
