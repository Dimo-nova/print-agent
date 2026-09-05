# print-agent: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un proceso Node en la Raspberry Pi de cada local que, con las credenciales de su `print_agents`, escucha `print_jobs` por Realtime, reclama cada trabajo por PostgREST, escribe los bytes ESC/POS en la impresora por TCP y marca el resultado, sin imprimir nunca dos veces; más el instalador y la guía para dejar la Pi lista antes del viaje.

**Architecture:** Módulos pequeños con dependencias inyectadas (`clock`, `ledger`, `printer`, `queue`, `worker`) testeados contra un PostgREST falso (`http.createServer`) y una impresora falsa (`net.createServer`); `supabase.ts`, `printers.ts`, `heartbeat.ts` e `index.ts` son la capa de integración con Supabase real. Una cola secuencial por impresora. Libro local en SQLite (`node:sqlite`) para no repetir sin ACK. Deriva de reloj por la cabecera `Date` de PostgREST. `systemd` + `install.sh`.

**Tech Stack:** TypeScript 5 (ESM, `NodeNext`), Node 22 LTS ≥ 22.13, `@supabase/supabase-js` ^2.93, `node:net`, `node:sqlite`, Vitest 4, `tsx` para desarrollo.

## Global Constraints

- Repo `print-agent` (`C:\Users\Pablo Lopez\projects\DIMONOVA\print-agent`), rama `main`, spec en `docs/superpowers/specs/2026-09-05-print-agent-design.md` (commiteado en `67ebaf1`).
- **Dependencia de runtime única:** `@supabase/supabase-js`. Dev: `typescript`, `vitest`, `tsx`, `@types/node`. Nada más.
- ESM: `"type": "module"`, `tsconfig` con `module: NodeNext`; **los imports relativos llevan extensión `.js`** (`import { x } from './backoff.js'`), también en tests.
- Tests en `tests/`, Vitest, **sin Supabase real y sin red externa**: PostgREST falso en `tests/helpers/fake-postgrest.ts`, impresora falsa en `tests/helpers/fake-printer.ts`. Puertos efímeros (`listen(0)`).
- Toda escritura a `print_jobs` lleva `.select('id')`; 0 filas = rechazada, se loguea, no se lanza.
- El agente **nunca lee `payload` del evento Realtime**; siempre con `select` tras el claim.
- Logs solo por `log()` / `logError()` de `src/log.ts` (una línea, prefijo `[módulo]`). Sin `console.log` suelto en `src/`.
- Comentarios y README en español; mensajes de log en inglés corto (van a journald). Sin guiones largos ni punto y coma en prosa española.
- Verificación por task: `npm test`, `npm run typecheck`. Al final: `npm run build` y arranque real contra Le Club (el controlador tiene las credenciales).
- Commits en español sin tildes, prefijo `feat:`, `fix:`, `docs:`, `chore:`, última línea `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Esqueleto del repo, `log`, `backoff`, `config`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `README.md` (mínimo, se completa en la Task 7)
- Create: `src/log.ts`, `src/backoff.ts`, `src/config.ts`
- Test: `tests/backoff.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `log(scope: string, msg: string, extra?: Record<string, unknown>): void`, `logError(scope: string, msg: string, err?: unknown): void`
  - `BACKOFF_MS`, `MAX_ATTEMPTS = 5`, `backoffFor(attempt: number): number`, `isExhausted(attempt: number): boolean`
  - `interface Config { supabaseUrl; supabaseKey; agentEmail; agentPassword; pollIntervalMs; heartbeatMs; staleClaimMs; socketTimeoutMs; probeTimeoutMs; ledgerPath; version }`
  - `parseEnvFile(text: string): Record<string, string>`, `loadEnvFile(path: string, env?: NodeJS.ProcessEnv): void`, `loadConfig(env?: NodeJS.ProcessEnv, version?: string): Config`

- [ ] **Step 1: Ficheros base**

`package.json`:

```json
{
  "name": "print-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Dimonova print agent: Raspberry Pi bridge between print_jobs and ESC/POS printers",
  "type": "module",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node --disable-warning=ExperimentalWarning dist/index.js",
    "dev": "tsx --disable-warning=ExperimentalWarning src/index.ts"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.93.3"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5",
    "vitest": "^4.1.9"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
```

`.env.example`:

```env
SUPABASE_URL=https://dfulbdzlkaubgdksalnp.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
AGENT_EMAIL=agent+carta-leclubtenerife-com@dimonova.com
AGENT_PASSWORD=...
# Opcionales, en ms:
# POLL_INTERVAL_MS=60000
# HEARTBEAT_MS=30000
# STALE_CLAIM_MS=120000
# SOCKET_TIMEOUT_MS=5000
# PROBE_TIMEOUT_MS=3000
# LEDGER_PATH=./data/ledger.sqlite
```

`README.md` (provisional, una línea): `# print-agent\n\nAgente de impresión de Dimonova para la Raspberry Pi. Spec: docs/superpowers/specs/2026-09-05-print-agent-design.md. README completo en la Task 7.`

Run: `npm install`
Expected: `node_modules/` creado, sin errores. (`package-lock.json` se commitea.)

- [ ] **Step 2: `src/log.ts`**

```ts
/**
 * Una línea por evento, a stdout/stderr. journald pone timestamp de recepción,
 * pero se añade el ISO propio para poder cruzar con Supabase.
 */

export function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} [${scope}] ${msg}${formatExtra(extra)}\n`)
}

export function logError(scope: string, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? '' : String(err)
  process.stderr.write(`${new Date().toISOString()} [${scope}] ERROR ${msg}${detail ? ': ' + detail : ''}\n`)
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra) return ''
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${formatValue(v)}`)
  return parts.length ? ' ' + parts.join(' ') : ''
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}
```

- [ ] **Step 3: Tests de `backoff` y `config` (fallan)**

`tests/backoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BACKOFF_MS, MAX_ATTEMPTS, backoffFor, isExhausted } from '../src/backoff.js'

describe('backoff', () => {
  it('tabla fija de cinco escalones', () => {
    expect(BACKOFF_MS).toEqual([5_000, 15_000, 45_000, 120_000, 300_000])
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it('backoffFor devuelve el escalon del intento, y el ultimo a partir de ahi', () => {
    expect(backoffFor(1)).toBe(5_000)
    expect(backoffFor(3)).toBe(45_000)
    expect(backoffFor(5)).toBe(300_000)
    expect(backoffFor(9)).toBe(300_000)
    expect(backoffFor(0)).toBe(5_000)
  })

  it('isExhausted a partir del quinto intento', () => {
    expect(isExhausted(4)).toBe(false)
    expect(isExhausted(5)).toBe(true)
    expect(isExhausted(6)).toBe(true)
  })
})
```

`tests/config.test.ts`:

```ts
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
```

Run: `npx vitest run tests/backoff.test.ts tests/config.test.ts`
Expected: FAIL, imports sin resolver.

- [ ] **Step 4: `src/backoff.ts` y `src/config.ts`**

`src/backoff.ts`:

```ts
/** Espera entre intentos contra una impresora que no responde. Por intento, no global. */
export const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const

/** Al quinto intento fallido el trabajo pasa a `failed`. El KDS sigue mostrando el pedido. */
export const MAX_ATTEMPTS = 5

export function backoffFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
}

export function isExhausted(attempt: number): boolean {
  return attempt >= MAX_ATTEMPTS
}
```

`src/config.ts`:

```ts
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
```

- [ ] **Step 5: Tests pasan, typecheck**

Run: `npx vitest run tests/backoff.test.ts tests/config.test.ts && npm run typecheck`
Expected: PASS (3 + 3), typecheck limpio.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example README.md src/log.ts src/backoff.ts src/config.ts tests/backoff.test.ts tests/config.test.ts
git commit -m "chore: esqueleto del agente con log, backoff y config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `clock` y `ledger`

**Files:**
- Create: `src/clock.ts`, `src/ledger.ts`
- Test: `tests/clock.test.ts`, `tests/ledger.test.ts`

**Interfaces:**
- Produces:
  - `class ServerClock { observe(dateHeader: string | null | undefined): void; now(): Date; skewMs(): number }`
  - `clockFetch(clock: ServerClock, base?: typeof fetch): typeof fetch`
  - `class Ledger { constructor(path: string, retentionDays?: number); markPrinted(jobId: string, at: Date): void; wasPrinted(jobId: string): boolean; close(): void }`

- [ ] **Step 1: Tests (fallan)**

`tests/clock.test.ts`:

```ts
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
})
```

`tests/ledger.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/ledger.js'

const dirs: string[] = []
const tmpPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'print-agent-ledger-'))
  dirs.push(dir)
  return join(dir, 'sub', 'ledger.sqlite') // subdirectorio inexistente: debe crearlo
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('Ledger', () => {
  it('marca y consulta', () => {
    const ledger = new Ledger(tmpPath())
    expect(ledger.wasPrinted('a')).toBe(false)
    ledger.markPrinted('a', new Date())
    expect(ledger.wasPrinted('a')).toBe(true)
    ledger.markPrinted('a', new Date()) // idempotente
    expect(ledger.wasPrinted('a')).toBe(true)
    ledger.close()
  })

  it('sobrevive a reabrir el fichero', () => {
    const path = tmpPath()
    const first = new Ledger(path)
    first.markPrinted('job-1', new Date())
    first.close()
    const second = new Ledger(path)
    expect(second.wasPrinted('job-1')).toBe(true)
    second.close()
  })

  it('al abrir borra lo mas viejo que la retencion', () => {
    const path = tmpPath()
    const first = new Ledger(path, 7)
    first.markPrinted('old', new Date(Date.now() - 8 * 86_400_000))
    first.markPrinted('recent', new Date(Date.now() - 1 * 86_400_000))
    first.close()
    const second = new Ledger(path, 7)
    expect(second.wasPrinted('old')).toBe(false)
    expect(second.wasPrinted('recent')).toBe(true)
    second.close()
  })
})
```

Run: `npx vitest run tests/clock.test.ts tests/ledger.test.ts`
Expected: FAIL, imports sin resolver.

- [ ] **Step 2: `src/clock.ts`**

```ts
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

/** `fetch` que alimenta el reloj con cada respuesta. Se le pasa a supabase-js en `global.fetch`. */
export function clockFetch(clock: ServerClock, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init)
    clock.observe(res.headers.get('date'))
    return res
  }
}
```

- [ ] **Step 3: `src/ledger.ts`**

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Libro local de trabajos ya impresos. Se escribe DESPUÉS de que el socket
 * cierre sin error y ANTES del UPDATE a Supabase: si la red cae en ese hueco,
 * el servidor reofrece el trabajo a los 2 min y aquí consta que ya salió, así
 * que se manda `delivered` sin volver a imprimir. Sin esto, cada corte de red
 * entre imprimir y confirmar sería una comanda duplicada en cocina.
 *
 * `node:sqlite` (Node ≥ 22.13): sin dependencias nativas que compilar en ARM.
 */
export class Ledger {
  private readonly db: DatabaseSync

  constructor(path: string, retentionDays = 7) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS printed (job_id TEXT PRIMARY KEY, printed_at TEXT NOT NULL)')
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM printed WHERE printed_at < ?').run(cutoff)
  }

  markPrinted(jobId: string, at: Date): void {
    this.db.prepare('INSERT OR REPLACE INTO printed (job_id, printed_at) VALUES (?, ?)').run(jobId, at.toISOString())
  }

  wasPrinted(jobId: string): boolean {
    return this.db.prepare('SELECT 1 AS one FROM printed WHERE job_id = ?').get(jobId) !== undefined
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 4: Tests pasan, typecheck**

Run: `npx vitest run tests/clock.test.ts tests/ledger.test.ts && npm run typecheck`
Expected: PASS (4 + 3). Si `node:sqlite` no está en los tipos de `@types/node`, subir `@types/node` a la última 22.x (`npm i -D @types/node@^22`); si Node local es < 22.13, el test de ledger fallará con `ERR_UNKNOWN_BUILTIN_MODULE`: instalar Node 22 LTS actual. Vitest imprime `ExperimentalWarning` una vez; aceptable en tests.

- [ ] **Step 5: Commit**

```bash
git add src/clock.ts src/ledger.ts tests/clock.test.ts tests/ledger.test.ts
git commit -m "feat: reloj por cabecera Date y libro local en SQLite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `printer` (socket) e impresora falsa de tests

**Files:**
- Create: `src/printer.ts`, `tests/helpers/fake-printer.ts`
- Test: `tests/printer.test.ts`

**Interfaces:**
- Produces:
  - `interface PrinterTarget { host: string; port: number }`
  - `sendBytes(target: PrinterTarget, bytes: Uint8Array, timeoutMs: number): Promise<void>`
  - `probe(target: PrinterTarget, timeoutMs: number): Promise<boolean>`
  - helper `startFakePrinter(opts?: { swallow?: boolean }): Promise<{ port: number; received: Buffer[]; connections: number; close(): Promise<void> }>` (`swallow: true` = acepta y no cierra nunca, para provocar timeout)

- [ ] **Step 1: Helper**

`tests/helpers/fake-printer.ts`:

```ts
import net from 'node:net'

/**
 * Impresora ESC/POS de mentira: acepta en un puerto efímero, acumula bytes por
 * conexión y cierra cuando el cliente cierra. Con `swallow` acepta y no
 * responde ni cierra: sirve para provocar el timeout del agente.
 */
export async function startFakePrinter(opts: { swallow?: boolean } = {}) {
  const received: Buffer[] = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer(socket => {
    connections += 1
    sockets.add(socket)
    const chunks: Buffer[] = []
    socket.on('data', c => chunks.push(c))
    socket.on('close', () => { sockets.delete(socket); if (chunks.length) received.push(Buffer.concat(chunks)) })
    if (opts.swallow) socket.pause()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    received,
    get connections() { return connections },
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
```

- [ ] **Step 2: Test (falla)**

`tests/printer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { sendBytes, probe } from '../src/printer.js'
import { startFakePrinter } from './helpers/fake-printer.js'

const bytes = Uint8Array.from([0x1b, 0x40, 0x48, 0x4f, 0x4c, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00])

describe('sendBytes', () => {
  it('entrega exactamente los bytes y cierra el socket', async () => {
    const printer = await startFakePrinter()
    await sendBytes({ host: '127.0.0.1', port: printer.port }, bytes, 2_000)
    await new Promise(r => setTimeout(r, 50))
    expect(printer.received).toHaveLength(1)
    expect(Array.from(printer.received[0]!)).toEqual(Array.from(bytes))
    expect(printer.connections).toBe(1)
    await printer.close()
  })

  it('puerto cerrado: rechaza con ECONNREFUSED y host:puerto', async () => {
    const free = await freePort()
    await expect(sendBytes({ host: '127.0.0.1', port: free }, bytes, 2_000)).rejects.toThrow(/ECONNREFUSED 127\.0\.0\.1:\d+/)
  })

  it('impresora que acepta pero no lee: timeout', async () => {
    const printer = await startFakePrinter({ swallow: true })
    // Un payload grande no cabe en el buffer del kernel de golpe, así que el
    // flush nunca termina y salta el timeout.
    const big = new Uint8Array(8 * 1024 * 1024)
    await expect(sendBytes({ host: '127.0.0.1', port: printer.port }, big, 500)).rejects.toThrow(/timeout 500ms/)
    await printer.close()
  })
})

describe('probe', () => {
  it('true si acepta la conexion, false si no', async () => {
    const printer = await startFakePrinter()
    expect(await probe({ host: '127.0.0.1', port: printer.port }, 1_000)).toBe(true)
    await printer.close()
    expect(await probe({ host: '127.0.0.1', port: printer.port }, 1_000)).toBe(false)
  })
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(r => server.close(() => r()))
  return port
}
```

Run: `npx vitest run tests/printer.test.ts`
Expected: FAIL, `../src/printer.js` sin resolver.

- [ ] **Step 3: `src/printer.ts`**

```ts
import net from 'node:net'

export interface PrinterTarget {
  host: string
  port: number
}

/**
 * Abrir, escribir, cerrar. Nunca se deja el socket abierto: las impresoras
 * confirmadas admiten UNA conexión y el TPV del local imprime contra la misma.
 * Cualquier error o timeout destruye el socket y rechaza con un mensaje corto
 * (`ECONNREFUSED 192.168.1.6:9100`, `timeout 5000ms 192.168.1.6:9100`) que va
 * tal cual a `print_jobs.error`.
 */
export function sendBytes(target: PrinterTarget, bytes: Uint8Array, timeoutMs: number): Promise<void> {
  const where = `${target.host}:${target.port}`
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port })
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`timeout ${timeoutMs}ms ${where}`)))
    socket.once('error', err => fail(new Error(`${(err as NodeJS.ErrnoException).code ?? err.message} ${where}`)))
    socket.once('connect', () => {
      // `end(data, cb)`: cb salta cuando todo se ha volcado al kernel y se ha
      // mandado FIN. No esperamos respuesta: una impresora no responde.
      socket.end(bytes, () => {
        if (settled) return
        settled = true
        resolve()
      })
    })
  })
}

/** ¿Acepta conexiones? Para el heartbeat de `printers.last_seen_at`. */
export function probe(target: PrinterTarget, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: target.host, port: target.port })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.once('connect', () => done(true))
  })
}
```

- [ ] **Step 4: Tests pasan, typecheck**

Run: `npx vitest run tests/printer.test.ts && npm run typecheck`
Expected: PASS (4). Si el test de timeout pasa demasiado rápido o no salta (kernel con buffer enorme), subir `big` a 32 MB.

- [ ] **Step 5: Commit**

```bash
git add src/printer.ts tests/printer.test.ts tests/helpers/fake-printer.ts
git commit -m "feat: socket abrir-escribir-cerrar con timeout y probe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `queue` y PostgREST falso

**Files:**
- Create: `src/queue.ts`, `tests/helpers/fake-postgrest.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `ServerClock` de `./clock.js`; `log` de `./log.js`.
- Produces:
  - `interface ClaimableJob { id: string; printer_id: string; target: string; status: 'queued' | 'claimed'; attempts: number; claimed_at: string | null }`
  - `fetchClaimable(client: SupabaseClient, restaurantId: string, clock: ServerClock, staleClaimMs: number): Promise<ClaimableJob[]>`
  - `claim(client, job: ClaimableJob, clock): Promise<boolean>`
  - `fetchPayload(client, jobId: string): Promise<Uint8Array>`
  - `markDelivered(client, jobId, clock): Promise<boolean>`
  - `release(client, jobId, error: string): Promise<boolean>`
  - `markFailed(client, jobId, error: string, clock): Promise<boolean>`
  - helper `startFakePostgrest(): Promise<{ url: string; requests: Recorded[]; onRequest(handler): void; close(): Promise<void> }>` con `Recorded = { method; path; query: URLSearchParams; headers; body: unknown }` y `handler: (req: Recorded) => { status?: number; body?: unknown }`.

- [ ] **Step 1: Helper**

`tests/helpers/fake-postgrest.ts`:

```ts
import http from 'node:http'

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: unknown
}

export type Handler = (req: Recorded) => { status?: number; body?: unknown } | undefined

/**
 * Lo justo de PostgREST para que supabase-js hable con él: registra cada
 * petición y responde lo que diga el handler del test. Con `Accept:
 * application/vnd.pgrst.object+json` (`.single()`/`.maybeSingle()`) devuelve
 * el primer elemento del array del handler, o 406 si está vacío (como el real).
 */
export async function startFakePostgrest() {
  const requests: Recorded[] = []
  let handler: Handler = () => ({ status: 200, body: [] })

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://fake')
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      }
      requests.push(recorded)
      const out = handler(recorded) ?? { status: 200, body: [] }
      let status = out.status ?? 200
      let body = out.body ?? []
      const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
      if (wantsObject && Array.isArray(body)) {
        if (body.length === 0) { status = 406; body = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
        else body = body[0]
      }
      res.writeHead(status, { 'content-type': 'application/json', date: new Date().toUTCString() })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    onRequest(h: Handler) { handler = h },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
```

- [ ] **Step 2: Test (falla)**

`tests/queue.test.ts`:

```ts
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
  it('PATCH con claimed, claimed_at, attempts+1, filtro de estado y select', async () => {
    pg.onRequest(() => ({ body: [{ id: 'j1' }] }))
    expect(await claim(client, job, clock)).toBe(true)
    const req = pg.requests[0]!
    expect(req.method).toBe('PATCH')
    expect(req.query.get('id')).toBe('eq.j1')
    expect(req.query.get('status')).toBe('in.(queued,claimed)')
    expect(req.query.get('select')).toBe('id')
    expect(req.body).toMatchObject({ status: 'claimed', attempts: 1 })
    expect(typeof (req.body as { claimed_at: string }).claimed_at).toBe('string')
    expect(String(req.headers.prefer)).toContain('return=representation')
  })

  it('cero filas = no es mio', async () => {
    pg.onRequest(() => ({ body: [] }))
    expect(await claim(client, job, clock)).toBe(false)
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
    expect(req.body).toMatchObject({ status: 'delivered' })
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
```

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL, `../src/queue.js` sin resolver.

- [ ] **Step 3: `src/queue.ts`**

```ts
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

export async function claim(client: SupabaseClient, job: ClaimableJob, clock: ServerClock): Promise<boolean> {
  const { data, error } = await client
    .from('print_jobs')
    .update({ status: 'claimed', claimed_at: clock.now().toISOString(), attempts: job.attempts + 1 })
    .eq('id', job.id)
    .in('status', ['queued', 'claimed'])
    .select('id')
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
```

- [ ] **Step 4: Tests pasan, typecheck**

Run: `npx vitest run tests/queue.test.ts && npm run typecheck`
Expected: PASS (8). Si supabase-js codifica el `or=` con paréntesis distintos, ajustar la regex del test a lo que realmente manda (el contrato es el contenido, no el escape).

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts tests/queue.test.ts tests/helpers/fake-postgrest.ts
git commit -m "feat: operaciones de cola con select en cada update y PostgREST falso de tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `worker` (una cola por impresora)

**Files:**
- Create: `src/worker.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: `queue.ts` (todas), `printer.ts` (`sendBytes`), `Ledger`, `ServerClock`, `backoffFor`/`isExhausted`, `log`/`logError`.
- Produces:
  - `interface PrinterRow { id: string; name: string; target: 'kitchen' | 'bar'; host: string; port: number }` (definido aquí, lo reexporta `printers.ts` en la Task 6)
  - `interface WorkerDeps { client: SupabaseClient; clock: ServerClock; ledger: Ledger; socketTimeoutMs: number; sleep?: (ms: number) => Promise<void> }`
  - `class PrinterWorker { constructor(printer: PrinterRow, deps: WorkerDeps); enqueue(job: ClaimableJob): void; stop(): void; drain(): Promise<void>; readonly printer: PrinterRow }`

- [ ] **Step 1: Test (falla)**

`tests/worker.test.ts`:

```ts
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
```

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL, `../src/worker.js` sin resolver.

- [ ] **Step 2: `src/worker.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServerClock } from './clock.js'
import type { Ledger } from './ledger.js'
import { backoffFor, isExhausted } from './backoff.js'
import { sendBytes } from './printer.js'
import { claim, fetchPayload, markDelivered, markFailed, release, type ClaimableJob } from './queue.js'
import { log, logError } from './log.js'

export interface PrinterRow {
  id: string
  name: string
  target: 'kitchen' | 'bar'
  host: string
  port: number
}

export interface WorkerDeps {
  client: SupabaseClient
  clock: ServerClock
  ledger: Ledger
  socketTimeoutMs: number
  /** Inyectable para tests. */
  sleep?: (ms: number) => Promise<void>
}

const SUPABASE_ERROR_PAUSE_MS = 10_000

/**
 * Una cola secuencial por impresora. La impresora solo admite una conexión y
 * el TPV también le imprime, así que aquí nunca hay dos sockets a la vez. Una
 * impresora caída duerme su backoff sin bloquear a las demás.
 */
export class PrinterWorker {
  private readonly queue = new Map<string, ClaimableJob>()
  private running = false
  private stopped = false
  private readonly sleep: (ms: number) => Promise<void>

  constructor(readonly printer: PrinterRow, private readonly deps: WorkerDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Idempotente por id: el poll y el timbre pueden traer el mismo job. */
  enqueue(job: ClaimableJob): void {
    if (this.stopped || this.queue.has(job.id)) return
    this.queue.set(job.id, job)
    void this.run()
  }

  stop(): void {
    this.stopped = true
    this.queue.clear()
  }

  /** Para tests: espera a que la cola esté vacía y el bucle parado. */
  async drain(): Promise<void> {
    while (this.running || this.queue.size > 0) await new Promise(resolve => setTimeout(resolve, 5))
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped) {
        const next = this.queue.values().next()
        if (next.done) break
        const job = next.value
        this.queue.delete(job.id)
        const pauseMs = await this.process(job)
        if (pauseMs > 0) await this.sleep(pauseMs)
      }
    } finally {
      this.running = false
    }
  }

  /** Devuelve los ms a dormir antes del siguiente trabajo de esta impresora. */
  private async process(job: ClaimableJob): Promise<number> {
    const { client, clock, ledger } = this.deps
    const scope = 'worker'
    const tag = { job: job.id, printer: this.printer.name }
    try {
      if (!(await claim(client, job, clock))) {
        log(scope, 'claim rejected, skipping', tag)
        return 0
      }
      const attempt = job.attempts + 1
      log(scope, 'claimed', { ...tag, attempt })

      if (ledger.wasPrinted(job.id)) {
        await markDelivered(client, job.id, clock)
        log(scope, 'already printed, delivered without reprint', tag)
        return 0
      }

      const bytes = await fetchPayload(client, job.id)
      try {
        await sendBytes({ host: this.printer.host, port: this.printer.port }, bytes, this.deps.socketTimeoutMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isExhausted(attempt)) {
          await markFailed(client, job.id, message, clock)
          logError(scope, `failed after ${attempt} attempts job=${job.id} printer=${this.printer.name}`, message)
          return 0
        }
        await release(client, job.id, message)
        const pause = backoffFor(attempt)
        log(scope, 'socket error, released', { ...tag, attempt, error: message, backoffMs: pause })
        return pause
      }

      // Primero el libro, luego Supabase: si la red cae entre los dos, el
      // reoferto de dentro de 2 min encuentra el job en el libro y no reimprime.
      ledger.markPrinted(job.id, clock.now())
      await markDelivered(client, job.id, clock)
      log(scope, 'delivered', { ...tag, bytes: bytes.length })
      return 0
    } catch (err) {
      logError(scope, `supabase error, job left for next poll job=${job.id}`, err)
      return SUPABASE_ERROR_PAUSE_MS
    }
  }
}
```

- [ ] **Step 3: Tests pasan, typecheck, suite completa**

Run: `npx vitest run tests/worker.test.ts && npm test && npm run typecheck`
Expected: PASS (7 en worker; suite completa 3+3+4+3+4+8+7 = 32).

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts tests/worker.test.ts
git commit -m "feat: worker con cola secuencial por impresora, libro local y backoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Integración con Supabase: `supabase`, `printers`, `heartbeat`, `index`

**Files:**
- Create: `src/supabase.ts`, `src/printers.ts`, `src/heartbeat.ts`, `src/index.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `interface AgentRow { id: string; restaurant_id: string; name: string; active: boolean }`, `interface Session { client: SupabaseClient; agent: AgentRow }`
  - `createAgentClient(cfg: Config, clock: ServerClock): SupabaseClient`, `connect(cfg, clock, sleep?): Promise<Session>`
  - `class PrinterCache { constructor(client, restaurantId); load(): Promise<void>; get(id): PrinterRow | undefined; all(): PrinterRow[]; subscribe(onChange: () => void): void; unsubscribe(): Promise<void> }`
  - `startHeartbeat(deps: { client; agentId; printers: PrinterCache; clock; heartbeatMs; probeTimeoutMs; version }): () => void`

Sin tests unitarios (hablan con Supabase real y Realtime). Verificación: `npm run typecheck`, `npm run build`, y **arranque real contra el agente de Le Club** (el controlador tiene el `.env`): el log debe mostrar login, `agent=Pi LeClub Tenerife restaurant=90f965d0`, `printers loaded n=1`, suscripciones `SUBSCRIBED`, un `poll` que encuentra 0 o más jobs, y un heartbeat que actualiza `print_agents.last_seen_at` (comprobable en el panel: punto verde).

- [ ] **Step 1: `src/supabase.ts`**

```ts
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

  // Patrón del KDS: cada rotación de token (más o menos cada hora) se
  // reenvía al socket de Realtime, o la suscripción muere en silencio.
  client.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token) client.realtime.setAuth(session.access_token)
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
```

- [ ] **Step 2: `src/printers.ts`**

```ts
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { PrinterRow } from './worker.js'
import { log, logError } from './log.js'

export type { PrinterRow } from './worker.js'

/**
 * Caché de las impresoras activas del local. Se recarga entera con cualquier
 * evento de `printers` (alta, baja, cambio de IP, activar/desactivar): son
 * dos o tres filas, no merece la pena aplicar deltas.
 */
export class PrinterCache {
  private rows = new Map<string, PrinterRow>()
  private channel: RealtimeChannel | null = null

  constructor(private readonly client: SupabaseClient, private readonly restaurantId: string) {}

  async load(): Promise<void> {
    const { data, error } = await this.client
      .from('printers')
      .select('id, name, target, host, port')
      .eq('restaurant_id', this.restaurantId)
      .eq('active', true)
    if (error) throw new Error(`printers load: ${error.message}`)
    this.rows = new Map((data as PrinterRow[]).map(p => [p.id, p]))
    log('printers', 'loaded', { n: this.rows.size, names: this.all().map(p => p.name).join(',') || '-' })
  }

  get(id: string): PrinterRow | undefined {
    return this.rows.get(id)
  }

  all(): PrinterRow[] {
    return [...this.rows.values()]
  }

  subscribe(onChange: () => void): void {
    this.channel = this.client
      .channel(`printers:${this.restaurantId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'printers', filter: `restaurant_id=eq.${this.restaurantId}` },
        () => {
          this.load().then(onChange).catch(err => logError('printers', 'reload failed', err))
        },
      )
      .subscribe(status => log('printers', 'channel', { status }))
  }

  async unsubscribe(): Promise<void> {
    if (this.channel) await this.client.removeChannel(this.channel)
    this.channel = null
  }
}
```

- [ ] **Step 3: `src/heartbeat.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServerClock } from './clock.js'
import type { PrinterCache } from './printers.js'
import { probe } from './printer.js'
import { log, logError } from './log.js'

export interface HeartbeatDeps {
  client: SupabaseClient
  agentId: string
  printers: PrinterCache
  clock: ServerClock
  heartbeatMs: number
  probeTimeoutMs: number
  version: string
}

/**
 * Cada `heartbeatMs`: la Pi dice que vive (print_agents.last_seen_at) y, por
 * impresora activa, un TCP connect+close. Si la impresora responde, se pone
 * su last_seen_at; si no, no se toca y el panel la pinta gris. Devuelve stop().
 */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const now = deps.clock.now().toISOString()
    try {
      const { data, error } = await deps.client
        .from('print_agents')
        .update({ last_seen_at: now, version: deps.version })
        .eq('id', deps.agentId)
        .select('id')
      if (error) throw error
      if ((data ?? []).length !== 1) log('heartbeat', 'agent update rejected (deactivated?)')
    } catch (err) {
      logError('heartbeat', 'agent heartbeat failed', err)
    }

    for (const printer of deps.printers.all()) {
      const alive = await probe({ host: printer.host, port: printer.port }, deps.probeTimeoutMs)
      if (!alive) {
        log('heartbeat', 'printer unreachable', { printer: printer.name, host: `${printer.host}:${printer.port}` })
        continue
      }
      try {
        const { error } = await deps.client.from('printers').update({ last_seen_at: now }).eq('id', printer.id).select('id')
        if (error) throw error
      } catch (err) {
        logError('heartbeat', `printer heartbeat failed printer=${printer.name}`, err)
      }
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), deps.heartbeatMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
```

- [ ] **Step 4: `src/index.ts`**

```ts
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { loadConfig, loadEnvFile } from './config.js'
import { ServerClock } from './clock.js'
import { Ledger } from './ledger.js'
import { connect } from './supabase.js'
import { PrinterCache } from './printers.js'
import { PrinterWorker } from './worker.js'
import { fetchClaimable, release, type ClaimableJob } from './queue.js'
import { startHeartbeat } from './heartbeat.js'
import { log, logError } from './log.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

/**
 * Arranque y bucle principal. Todo lo que puede fallar por red se reintenta;
 * lo que no puede fallar (config mal) sale con código 1 y systemd lo reinicia
 * a los 5 s, que es la forma de que el error se vea en journalctl cada vez.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env'))
  const cfg = loadConfig(process.env, version)
  log('main', 'print-agent starting', { version, node: process.version })

  const clock = new ServerClock()
  const ledger = new Ledger(cfg.ledgerPath)
  const { client, agent } = await connect(cfg, clock)
  const restaurantId = agent.restaurant_id

  const printers = new PrinterCache(client, restaurantId)
  await printers.load()

  const workers = new Map<string, PrinterWorker>()
  const syncWorkers = () => {
    const wanted = new Set(printers.all().map(p => p.id))
    for (const [id, worker] of workers) {
      if (!wanted.has(id)) { worker.stop(); workers.delete(id); log('main', 'worker stopped', { printer: worker.printer.name }) }
    }
    for (const printer of printers.all()) {
      if (!workers.has(printer.id)) {
        workers.set(printer.id, new PrinterWorker(printer, { client, clock, ledger, socketTimeoutMs: cfg.socketTimeoutMs }))
        log('main', 'worker started', { printer: printer.name, host: `${printer.host}:${printer.port}` })
      }
    }
  }
  syncWorkers()
  printers.subscribe(() => { syncWorkers(); void poll('printers changed') })

  let polling = false
  let pollAgain = false
  const skippedNoPrinter = new Set<string>()
  async function poll(reason: string): Promise<void> {
    if (polling) { pollAgain = true; return }
    polling = true
    try {
      do {
        pollAgain = false
        const jobs = await fetchClaimable(client, restaurantId, clock, cfg.staleClaimMs)
        if (jobs.length > 0) log('poll', 'claimable', { reason, n: jobs.length })
        for (const job of jobs) await dispatch(job)
      } while (pollAgain)
    } catch (err) {
      logError('poll', `failed (${reason})`, err)
    } finally {
      polling = false
    }
  }

  async function dispatch(job: ClaimableJob): Promise<void> {
    const worker = workers.get(job.printer_id)
    if (worker) { skippedNoPrinter.delete(job.id); worker.enqueue(job); return }
    // Impresora desactivada después de encolar. No es culpa del job: se
    // libera si estaba reclamado y se deja en la cola por si la impresora vuelve.
    if (job.status === 'claimed') await release(client, job.id, 'printer inactive').catch(err => logError('poll', 'release failed', err))
    if (!skippedNoPrinter.has(job.id)) {
      skippedNoPrinter.add(job.id)
      log('poll', 'no active printer for job, left in queue', { job: job.id, printer_id: job.printer_id })
    }
  }

  const jobsChannel: RealtimeChannel = client
    .channel(`print_jobs:${restaurantId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: `restaurant_id=eq.${restaurantId}` },
      // Timbre. El payload viene en el evento y se ignora a propósito: se lee tras el claim.
      () => void poll('realtime'),
    )
    .subscribe(status => log('main', 'print_jobs channel', { status }))

  await poll('startup')
  const pollTimer = setInterval(() => void poll('interval'), cfg.pollIntervalMs)
  const stopHeartbeat = startHeartbeat({
    client, agentId: agent.id, printers, clock, version,
    heartbeatMs: cfg.heartbeatMs, probeTimeoutMs: cfg.probeTimeoutMs,
  })
  log('main', 'running', { restaurant: restaurantId, pollMs: cfg.pollIntervalMs, heartbeatMs: cfg.heartbeatMs })

  const shutdown = async (signal: string) => {
    log('main', 'shutting down', { signal })
    clearInterval(pollTimer)
    stopHeartbeat()
    for (const worker of workers.values()) worker.stop()
    await client.removeChannel(jobsChannel)
    await printers.unsubscribe()
    ledger.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  logError('main', 'fatal', err)
  process.exit(1)
})
```

- [ ] **Step 5: Typecheck, build, arranque real**

Run: `npm run typecheck && npm run build && npm test`
Expected: limpio, `dist/index.js` existe, 32 tests.

Arranque real (controlador, con un `.env` local que **no se commitea**; `.gitignore` ya lo excluye):

```bash
npm run dev
```

Expected en el log, en este orden aproximado:

```
[main] print-agent starting version=0.1.0 node=v22.x
[supabase] signed in email=agent+carta-leclubtenerife-com@dimonova.com
[supabase] agent agent="Pi LeClub Tenerife" restaurant=90f965d0-…
[printers] loaded n=1 names=Barra
[main] worker started printer=Barra host=192.168.1.6:9100
[printers] channel status=SUBSCRIBED
[main] print_jobs channel status=SUBSCRIBED
[poll] claimable reason=startup n=1          (si hay un queued)
[worker] claimed job=… printer=Barra attempt=1
[worker] socket error, released job=… error="ECONNREFUSED 192.168.1.6:9100" backoffMs=5000   (desde fuera del local es lo esperado)
[main] running restaurant=… pollMs=60000 heartbeatMs=30000
[heartbeat] printer unreachable printer=Barra host=192.168.1.6:9100
```

En el panel, `/admin/restaurants/[id]` de Le Club: el agente pasa a punto verde con `version=0.1.0`; la impresora sigue gris (no hay ruta a 192.168.1.6 desde aquí). `Ctrl+C` → `[main] shutting down signal=SIGINT` y sale 0. Anotar en el informe qué se vio; si el job real quedó `queued` con `error=ECONNREFUSED…` es correcto.

Para ver un ticket de verdad sin estar en el local: cambiar en el panel el `host` de Barra a la IP del portátil en la LAN (o `127.0.0.1` si el agente corre en el mismo portátil), arrancar `npx tsx scripts/print-simulator.ts --codepage PC437` en `panel-admin`, y el agente imprime el `queued` en el simulador y lo marca `delivered`. Volver a poner `192.168.1.6` después.

- [ ] **Step 6: Commit**

```bash
git add src/supabase.ts src/printers.ts src/heartbeat.ts src/index.ts
git commit -m "feat: login, cache de impresoras, heartbeat y bucle principal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Despliegue y README

**Files:**
- Create: `deploy/print-agent.service`, `deploy/install.sh`, `deploy/update.sh`
- Modify: `README.md` (reemplazar el provisional)

- [ ] **Step 1: `deploy/print-agent.service`**

```ini
[Unit]
Description=Dimonova print agent (print_jobs -> ESC/POS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=printagent
Group=printagent
WorkingDirectory=/opt/print-agent
EnvironmentFile=/opt/print-agent/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/print-agent/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/print-agent/data

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: `deploy/install.sh`**

```bash
#!/usr/bin/env bash
# Deja una Raspberry Pi recién flasheada (Raspberry Pi OS Lite 64-bit) con el
# agente instalado como servicio. Idempotente: se puede volver a ejecutar.
#
#   sudo bash install.sh [URL-del-repo]
#
set -euo pipefail

REPO_URL="${1:-https://github.com/Dimo-nova/print-agent.git}"
APP_DIR=/opt/print-agent
APP_USER=printagent
NODE_MAJOR=22

if [ "$(id -u)" -ne 0 ]; then echo "ejecutar con sudo" >&2; exit 1; fi

echo "== paquetes base"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg

echo "== Node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".").map(Number)[0]*1000+process.versions.node.split(".").map(Number)[1]')" -lt "$((NODE_MAJOR * 1000 + 13))" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "== Tailscale (sin login: haz 'sudo tailscale up' después)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "== usuario de servicio"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "== código en ${APP_DIR}"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
mkdir -p data

echo "== .env"
if [ ! -f .env ]; then
  read -rp "SUPABASE_URL: " SUPABASE_URL
  read -rp "SUPABASE_PUBLISHABLE_KEY: " SUPABASE_PUBLISHABLE_KEY
  read -rp "AGENT_EMAIL: " AGENT_EMAIL
  read -rsp "AGENT_PASSWORD (no se muestra): " AGENT_PASSWORD; echo
  umask 077
  cat > .env <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY}
AGENT_EMAIL=${AGENT_EMAIL}
AGENT_PASSWORD=${AGENT_PASSWORD}
EOF
  umask 022
fi
chmod 600 .env
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "== systemd"
install -m 644 deploy/print-agent.service /etc/systemd/system/print-agent.service
systemctl daemon-reload
systemctl enable --now print-agent
sleep 3
systemctl --no-pager --lines=0 status print-agent || true

echo
echo "Listo. Log en vivo:  journalctl -u print-agent -f"
echo "Acceso remoto:       sudo tailscale up"
```

- [ ] **Step 3: `deploy/update.sh`**

```bash
#!/usr/bin/env bash
# Actualiza el agente en una Pi ya instalada.  sudo bash /opt/print-agent/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/print-agent
APP_USER=printagent
cd "$APP_DIR"
sudo -u "$APP_USER" git pull --ff-only
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
sudo -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
install -m 644 deploy/print-agent.service /etc/systemd/system/print-agent.service
systemctl daemon-reload
systemctl restart print-agent
sleep 2
journalctl -u print-agent -n 20 --no-pager
```

Hacer ejecutables: `git update-index --chmod=+x deploy/install.sh deploy/update.sh` (en Windows el bit no se conserva de otra forma).

`npm ci` instala también dev (hace falta `typescript` para `build`) y luego `npm prune --omit=dev` deja solo runtime. En `install.sh` `npm ci` corre como root antes del `chown`: aceptable en una Pi dedicada.

- [ ] **Step 4: README**

Reemplazar `README.md` por:

````markdown
# print-agent

Agente de impresión de Dimonova. Corre en una Raspberry Pi dentro de la LAN del
restaurante y hace de puente entre la cola `print_jobs` de Supabase y las
impresoras ESC/POS del local (puerto 9100). No renderiza nada: el panel deja
cada ticket ya renderizado en base64, el agente lo reclama y escupe los bytes.

Spec y contrato con la base de datos:
`docs/superpowers/specs/2026-09-05-print-agent-design.md` (y, en `panel-admin`,
`docs/superpowers/specs/2026-09-05-print-bridge-queue-design.md`).

## Cómo funciona, en tres párrafos

Al arrancar entra en Supabase con el email y contraseña del **agente** del
local (se crean en el panel, `/admin/restaurants/[id]` → «Agente de
impresión»). Esa identidad solo ve las impresoras y los trabajos de su
restaurante. Lee las impresoras activas y abre una cola por cada una.

Se suscribe a los INSERT de `print_jobs` por Realtime como un timbre, y cada
60 segundos consulta igualmente por si algún evento se perdió. Por cada
trabajo: lo reclama (`claimed`), lee el `payload`, abre un socket a la
impresora, escribe, cierra, y marca `delivered`. Si la impresora no responde,
lo suelta (`queued`) y espera 5 s, 15 s, 45 s, 2 min, 5 min; al quinto fallo,
`failed`. Un trabajo reclamado por una Pi que murió a medias se reofrece solo
a los 2 minutos.

Guarda en SQLite local qué trabajos ya salieron por papel, para que un corte
de red entre imprimir y confirmar no acabe en dos comandas. Cada 30 s dice
que vive (`print_agents.last_seen_at`) y comprueba cada impresora con un TCP
connect (`printers.last_seen_at`): el panel pinta los puntos verdes con eso.

## Preparar la Pi

1. **Imagen.** Raspberry Pi Imager → Raspberry Pi OS Lite (64-bit). En los
   ajustes del Imager: usuario `pi` con contraseña, SSH activado, hostname
   `print-leclub` (o el local que sea). Ethernet si es posible; wifi solo si
   no queda otra.
2. **Argon ONE.** Tras el primer arranque, el script del fabricante para el
   ventilador y el botón:
   `curl https://download.argon40.com/argon1.sh | bash`
3. **Instalar el agente.** Por SSH:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Dimo-nova/print-agent/main/deploy/install.sh -o install.sh
   sudo bash install.sh
   ```
   Pide URL y clave publishable de Supabase (las de `.env.example`) y el
   email y contraseña del agente. Al terminar, el servicio está arrancado.
4. **Tailscale.** `sudo tailscale up`, abrir el enlace, aprobar el nodo. A
   partir de ahí `ssh pi@print-leclub` desde cualquier sitio.
5. **Comprobar.** `journalctl -u print-agent -f`. En el panel, el agente del
   restaurante debe estar en verde en menos de un minuto.

Actualizar: `sudo bash /opt/print-agent/deploy/update.sh`.

## Probar sin impresora

En `panel-admin`, `npx tsx scripts/print-simulator.ts --codepage PC437` en un
portátil de la misma LAN. En el panel, poner como `host` de una impresora la
IP de ese portátil. Encolar un pedido (o `scripts/print-sample.ts --job`). El
agente lo imprime en el simulador y lo marca `delivered`. Devolver el `host`
real después.

En el local, antes de tocar el agente: `nc -vz 192.168.1.6 9100` desde la Pi.
Si no conecta, el problema es de red, no del agente.

## Cuando algo falla

| Síntoma | Mira |
|---|---|
| Panel: agente gris | `journalctl -u print-agent -n 100`. `login failed` → credenciales del `.env`. Sin red → `ping`, cable, Tailscale. `agent is deactivated` → activarlo en el panel. |
| Panel: impresora gris, agente verde | La Pi no llega a `host:port`. `nc -vz host 9100` desde la Pi. IP cambiada (reservarla en el router), impresora apagada, cable. |
| Trabajo `failed` | `print_jobs.error` dice por qué (`ECONNREFUSED`, `timeout`). Cinco intentos sin conexión. Arreglar la impresora y reimprimir desde el panel (pendiente) o poner la fila en `queued` a mano. |
| Trabajo `queued` con `error` | Está en backoff. Se reintenta solo. |
| Imprime dos veces | No debería: el libro local lo impide. Si pasa, se borró `data/ledger.sqlite` o es otra Pi. |
| No imprime y el trabajo queda `claimed` | La Pi murió a medias. A los 2 min se reofrece solo. |
| Tildes raras o `EUR` en vez de `€` | `code_page` de esa impresora en el panel (PC437 no tiene €; PC858 sí). |
| Corta encima del texto o no corta | Flag `cut` de la impresora en el panel. |
| `ExperimentalWarning: SQLite` en el log | Normal en Node 22 si se arranca sin `--disable-warning`. El `.service` ya lo lleva. |

## Desarrollo

```bash
npm install
npm test            # vitest, sin Supabase ni red: PostgREST e impresora falsos
npm run typecheck
cp .env.example .env   # rellenar
npm run dev         # arranca contra Supabase real con el .env
```

Variables opcionales en `.env.example` (tiempos en ms) para acortar esperas
en pruebas.
````

- [ ] **Step 5: Commit**

```bash
git add deploy/print-agent.service deploy/install.sh deploy/update.sh README.md
git update-index --chmod=+x deploy/install.sh deploy/update.sh
git commit -m "docs: instalador, servicio systemd y README de la Pi

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Verificación final

```bash
npm test && npm run typecheck && npm run build
```

32 tests, `dist/` generado. Arranque real (`npm run dev`) con el `.env` de Le Club: login, agente verde en el panel. Después, crear el repo en GitHub (`Dimo-nova/print-agent`), `git remote add origin`, push, y comprobar que la URL del `install.sh` en el README resuelve.

Prueba con impresora simulada en la misma máquina: `host` de Barra a `127.0.0.1`, simulador en `panel-admin`, un job `queued` → aparece en el simulador y pasa a `delivered`. Volver a `192.168.1.6`.
