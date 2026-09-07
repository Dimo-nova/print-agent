import { describe, it, expect } from 'vitest'
import { parseEnvFile, loadConfig } from '../src/config.js'

const base = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  AGENT_EMAIL: 'agent+x@dimonova.com',
  AGENT_PASSWORD: 'secret',
}

describe('parseEnvFile', () => {
  it('lee KEY=VALUE, ignora comentarios y vacios, quita comillas', () => {
    const text = `# comentario\n\nA=1\nB="dos palabras"\nC='tres'\nD = con espacios \nMALFORMADA\n`
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'dos palabras', C: 'tres', D: 'con espacios' })
  })
})

describe('loadConfig', () => {
  it('con las cuatro obligatorias devuelve defaults', () => {
    const cfg = loadConfig(base, '1.2.3')
    expect(cfg).toMatchObject({
      supabaseUrl: 'https://x.supabase.co',
      agentEmail: 'agent+x@dimonova.com',
      pollIntervalMs: 60_000,
      heartbeatMs: 30_000,
      staleClaimMs: 120_000,
      socketTimeoutMs: 5_000,
      probeTimeoutMs: 3_000,
      version: '1.2.3',
    })
    expect(cfg.ledgerPath.endsWith('ledger.sqlite')).toBe(true)
  })

  it('falta una obligatoria: error que la nombra', () => {
    const { AGENT_PASSWORD: _omit, ...rest } = base
    expect(() => loadConfig(rest)).toThrow(/AGENT_PASSWORD/)
  })

  it('los tiempos se pueden sobreescribir y un valor no numerico cae al default', () => {
    const cfg = loadConfig({ ...base, POLL_INTERVAL_MS: '5000', HEARTBEAT_MS: 'nope' })
    expect(cfg.pollIntervalMs).toBe(5_000)
    expect(cfg.heartbeatMs).toBe(30_000)
  })
})
