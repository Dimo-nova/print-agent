# print-agent: el agente de impresión de la Raspberry Pi

**Fecha:** 2026-09-05
**Estado:** aprobado
**Repo:** `DIMONOVA/print-agent` (nuevo, hermano de `panel-admin`)
**Piezas anteriores (en `panel-admin`):** renderizador ESC/POS (`2026-09-04-print-escpos-renderer-design.md`), `categories.print_target` (`2026-09-04-category-edit-form-design.md`), cola `print_jobs` + `printers` + `print_agents` (`2026-09-05-print-bridge-queue-design.md`, que fija el contrato que este agente cumple).

## Contexto

Un pedido pagado deja en `print_jobs` una fila por impresora activa del local con el ticket ESC/POS ya renderizado en base64. Las impresoras están en la LAN del local con IP privada; el backend en Vercel no llega a ellas. Este agente corre en una Raspberry Pi 4 (Argon ONE, arranque automático con la alimentación) dentro de esa LAN: abre conexión saliente a Supabase, se entera de los trabajos nuevos, y escribe los bytes al puerto 9100 de cada impresora.

Lo que el agente **no** hace: renderizar (lo hace el panel al encolar), decidir destinos, tocar el TPV, ni hablar con nadie que no sea Supabase y las impresoras.

Estado verificado 2026-09-05 contra la BD real con el JWT del agente de Le Club: RLS, triggers de columnas, transiciones, heartbeats y el evento Realtime funcionan como dice el contrato. Le Club tiene flag, impresora «Barra» activa (`192.168.1.6`, PC437) y agente creado.

## Decisiones

| Tema | Decisión |
|---|---|
| Repo | Nuevo, `print-agent`. La Pi hace `git clone` + `npm ci` + `npm run build`. Sin Next.js, sin acceso a `panel-admin`. |
| Lenguaje | TypeScript compilado con `tsc` a `dist/`, Node 22 LTS (NodeSource). ESM. |
| Dependencias de runtime | Solo `@supabase/supabase-js`. Sockets con `node:net`, SQLite con `node:sqlite` (Node ≥ 22.13, sin compilar nada en ARM). |
| Identidad | Email + contraseña del `print_agents` del local (creados en `/admin/restaurants/[id]`). `restaurant_id` **no** va en config: sale de `select * from print_agents` tras el login, RLS solo devuelve su fila. |
| Transporte | Realtime es el timbre, PostgREST el cartero. El evento INSERT despierta el `poll()`; el `poll()` es quien lee. Nunca se lee `payload` del evento. Polling de respaldo cada 60 s. |
| Concurrencia | **Una cola secuencial por impresora.** La impresora solo admite una conexión y el TPV también le imprime. Una impresora caída no bloquea a las demás. |
| Libro local | **SQLite** (`node:sqlite`), tabla `printed(job_id, printed_at)`. Se escribe tras cerrar el socket sin error y **antes** del UPDATE a Supabase. Evita la comanda duplicada cuando la red cae entre imprimir y confirmar. Retención **por cantidad (las últimas 5000 filas)**, no por antigüedad: con el reloj de la Pi sin sincronizar, una poda por fecha vaciaría el libro entero justo cuando es lo único que impide reimprimir. `printed_at` se guarda solo para leerlo un humano. |
| Reloj | Deriva calculada con la cabecera `Date` de las respuestas de PostgREST. El umbral de 2 minutos y `claimed_at` usan `Date.now() + deriva`. Eso cubre lo que se compara con el servidor, **no** el refresco del token: supabase-js lo programa con el reloj local, así que `systemd-timesyncd` (activo por defecto en Raspberry Pi OS) sigue siendo requisito. Una sesión que muere sin avisar la recoge el perro guardián: 10 min sin un `fetchClaimable` correcto → `exit 1` y systemd reinicia (medido con reloj monotónico, para que un salto de NTP no lo dispare). Cada petición a Supabase lleva un timeout de 15 s (`AbortSignal.timeout` en `clockFetch`): una conexión medio abierta no bloquea el poll cinco minutos. |
| Reintentos | Backoff `5 s, 15 s, 45 s, 60 s ×7` por impresora, ~8 min en total. Al décimo fallo el job pasa a `failed` con `error`. La cola anterior (2 min, luego 5 min) se midió demasiado lenta en campo (2026-09-07): con la impresora ya recuperada, el ticket seguía esperando minutos. Por eso el heartbeat, además de marcar `printers.last_seen_at`, hace un `probe()` por impresora y en cuanto detecta que vuelve a responder llama a `PrinterWorker.wake()`, que cancela la espera pendiente y reintenta al instante — el backoff de la tabla es el techo para cuando nada más avisa, no el camino normal de recuperación. La espera vive en el worker de la impresora (`pausedUntil`) y se respeta **antes** de coger el siguiente trabajo, así que frena también al que reofrece el poll de 60 s; dormir después de procesar dejaba que el reoferto entrase en una cola vacía y quemase el intento siguiente al instante. El KDS es la red de seguridad. |
| Despliegue | `systemd`, `Restart=always`, usuario sin privilegios, `/opt/print-agent`. `install.sh` para una Pi recién flasheada, `update.sh` para actualizar. Tailscale para acceso remoto (instalado por el script, login a mano). |
| Logs | Líneas a stdout con prefijo `[módulo]`, journald las recoge. Sin ficheros de log propios. |

## Contrato con Supabase (copia literal del spec de la cola, es lo que se implementa)

1. `signInWithPassword(email, password)` con la clave publishable. `autoRefreshToken: true`, `persistSession: false`. `onAuthStateChange` → `realtime.setAuth(token)` en cada cambio.
2. `select id, name, target, host, port from printers where active` (el agente no renderiza: `code_page`, `columns` y `features` no le hacen falta) al arrancar y en cada evento `printers` (INSERT/UPDATE/DELETE, filtro `restaurant_id=eq.X`).
3. Suscripción `postgres_changes` INSERT en `print_jobs`, filtro `restaurant_id=eq.X`. Al evento y cada 60 s: `select id, printer_id, target, status, attempts, claimed_at from print_jobs where restaurant_id = X and (status = 'queued' or (status = 'claimed' and claimed_at < <ahora_servidor − 2 min>)) order by created_at` (`.or('status.eq.queued,and(status.eq.claimed,claimed_at.lt.<iso>)')`). **Sin `payload`.**
4. Por fila, un **compare-and-swap sobre el estado que vio el poll**: si lo leyó `queued`, `update set status='claimed', claimed_at=<ahora_servidor>, attempts=<attempts leído + 1> where id=… and status='queued'`; si lo leyó `claimed` (abandonado), el mismo update `where id=… and status='claimed' and claimed_at < <ahora_servidor − 2 min>`. Siempre con `.select('id')`. Cero filas = no es mío o alguien lo cogió, saltar. Luego `select payload where id=…`, socket, y `delivered` / `queued` (release) / `failed`, siempre con `.select('id')`.
5. Cada 30 s: `update print_agents set last_seen_at=<ahora>, version=<package.json version> where id=<mi id>` y, por impresora activa, `connect` + `end` al `host:port` con timeout 3 s → `update printers set last_seen_at=<ahora> where id=…`. Si el probe falla, no se toca `last_seen_at`: el panel lo pinta gris.
6. `claimed → claimed` está permitido por el trigger (mismo estado); es el re-claim de un job abandonado. `delivered → queued` no lo está: el agente nunca lo intenta.

El CAS es lo que hace seguro que dos procesos compartan credenciales (una Pi de repuesto encendida por error, un `npm run dev` contra el mismo `.env`): a lo sumo uno se lleva la fila, el otro recibe cero filas y salta. `unique (restaurant_id)` en `print_agents` limita las **filas de agente**, no los procesos que usan sus credenciales, así que no bastaba con eso. Lo que sigue sin ser atómico es el valor de `attempts` (se lee y se escribe): en la carrera puede perderse un incremento, y eso solo alarga el ciclo de reintentos, nunca duplica un ticket.

## Módulos (`src/`)

Cada módulo exporta funciones con dependencias inyectadas (el cliente Supabase, el libro, el reloj) para que los tests no toquen red.

### `config.ts`

```ts
export interface Config {
  supabaseUrl: string
  supabaseKey: string     // publishable
  agentEmail: string
  agentPassword: string
  pollIntervalMs: number  // 60_000
  heartbeatMs: number     // 30_000
  staleClaimMs: number    // 120_000
  socketTimeoutMs: number // 5_000
  probeTimeoutMs: number  // 3_000
  ledgerPath: string      // /opt/print-agent/data/ledger.sqlite (o ./data/ledger.sqlite en dev)
  version: string         // package.json
}
export function loadConfig(env = process.env): Config   // lanza con mensaje claro si falta algo
```

`.env` se carga con un parser propio de `KEY=VALUE` (sin `dotenv`). Los cuatro primeros son obligatorios; los tiempos tienen default y admiten override por env para pruebas.

### `log.ts`

```ts
export function log(scope: string, msg: string, extra?: Record<string, unknown>): void
export function logError(scope: string, msg: string, err?: unknown): void
```

Una línea por llamada: `2026-09-05T18:00:00.000Z [queue] claimed 64cc204a printer=Barra attempt=1`. Los objetos `extra` van como `k=v`. journald pone el resto.

### `clock.ts`

```ts
export class ServerClock {
  observe(dateHeader: string | null): void   // cabecera Date de una respuesta; ignora null o fechas inválidas
  now(): Date                                // Date.now() + deriva
  skewMs(): number
}
```

La deriva se actualiza con cada respuesta de PostgREST (el cliente Supabase admite un `fetch` propio: se envuelve el `fetch` global para leer `Date` de cada respuesta). Antes de la primera respuesta, deriva 0.

### `backoff.ts`

```ts
export const BACKOFF_MS = [5_000, 15_000, 45_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000] as const
export const MAX_ATTEMPTS = 10
export function backoffFor(attempt: number): number   // attempt 1..10 → BACKOFF_MS[attempt-1]; >10 → último
export function isExhausted(attempt: number): boolean // attempt >= MAX_ATTEMPTS
```

### `ledger.ts`

```ts
export class Ledger {
  constructor(path: string, keep = 5000)  // abre/crea el fichero, crea la tabla, deja las últimas `keep` filas
  markPrinted(jobId: string, at: Date): void
  wasPrinted(jobId: string): boolean
  close(): void
}
```

`node:sqlite` `DatabaseSync`, `PRAGMA journal_mode = WAL` (los ficheros `-wal`/`-shm` viven junto al `.sqlite`, dentro de `data/`, que es lo único que systemd deja escribir). `node:sqlite` emite `ExperimentalWarning` en Node 22: el `.service` arranca con `--disable-warning=ExperimentalWarning`. Tabla `printed(job_id text primary key, printed_at text not null)`.

### `printer.ts`

```ts
export interface PrinterTarget { host: string; port: number }
export function sendBytes(target: PrinterTarget, bytes: Uint8Array, timeoutMs: number): Promise<void>
export function probe(target: PrinterTarget, timeoutMs: number): Promise<boolean>
```

`sendBytes`: `net.createConnection` → `setTimeout` → `end(bytes)` esperando el callback de flush → resolve. Cualquier `error`/`timeout` → `destroy()` + reject con `Error` cuyo `message` es corto y útil (`ECONNREFUSED 192.168.1.6:9100`, `timeout 5000ms`). Nunca deja el socket abierto. `probe`: `connect` + `end` inmediato.

### `supabase.ts`

```ts
export interface Session { client: SupabaseClient; agent: { id: string; restaurant_id: string; name: string } }
export async function connect(cfg: Config, clock: ServerClock): Promise<Session>
```

Crea el cliente con `global.fetch` envuelto (para `clock.observe`), hace login con reintento (backoff fijo 10 s, sin límite, logueando), lee `print_agents` (si 0 filas: log «agente inactivo o sin fila, reintento en 60 s» y espera; nunca sale del proceso por esto), registra `onAuthStateChange` → `realtime.setAuth`.

### `printers.ts`

```ts
export interface PrinterRow { id: string; name: string; target: 'kitchen' | 'bar'; host: string; port: number }
export class PrinterCache {
  constructor(client: SupabaseClient, restaurantId: string)
  load(): Promise<void>                    // select … where active
  get(id: string): PrinterRow | undefined
  all(): PrinterRow[]
  subscribe(): void                        // canal printers, filtro restaurant_id; cualquier evento → load()
}
```

Un job cuya `printer_id` no está en la caché (impresora desactivada después de encolar) se **libera** con `error = 'printer inactive'` y no cuenta como intento; el `poll()` lo verá de nuevo tras 2 minutos por si la impresora vuelve. Si sigue sin estar, se queda ciclando cada 2 min sin coste: no se marca `failed` porque no es culpa del job.

### `queue.ts`

```ts
export interface ClaimableJob { id: string; printer_id: string; target: string; status: 'queued' | 'claimed'; attempts: number; claimed_at: string | null }
export async function fetchClaimable(client, restaurantId, clock, staleClaimMs): Promise<ClaimableJob[]>
export async function claim(client, job: ClaimableJob, clock, staleClaimMs): Promise<boolean>  // CAS sobre job.status; true = es mío
export async function fetchPayload(client, jobId): Promise<Uint8Array>                    // base64 → bytes
export async function markDelivered(client, jobId, clock): Promise<void>
export async function release(client, jobId, error: string): Promise<void>               // claimed → queued
export async function markFailed(client, jobId, error: string, clock): Promise<void>
```

Todas las escrituras con `.select('id')`; si devuelve 0 filas se loguea `[queue] update rejected job=… op=…` y se sigue. Errores de red se propagan; el worker decide.

### `worker.ts`

```ts
export class PrinterWorker {
  constructor(printer: PrinterRow, deps: { client; clock; ledger; cfg; log })
  enqueue(job: ClaimableJob): void       // dedupe por id dentro de la cola en memoria
  // bucle interno: coge el siguiente job, procesa, respeta el backoff de la impresora
}
```

Proceso de un job:

1. `claim` → si `false`, descartar.
2. `ledger.wasPrinted(id)` → sí: `markDelivered`, log `[worker] already printed, delivered without reprint`, siguiente.
3. `fetchPayload` → `sendBytes` (timeout `cfg.socketTimeoutMs`).
4. Éxito: `ledger.markPrinted` → `markDelivered` → log. Reset del backoff de la impresora.
5. Fallo de socket: si `isExhausted(attempt)` → `markFailed(error)`; si no → `release(error)`, el job **se queda en la cola local** (con `status: 'queued'` y los `attempts` ya incrementados, para que el CAS del siguiente claim vea lo mismo que el servidor) y la impresora queda en backoff hasta `Date.now() + backoffFor(attempt)`, que se respeta al principio del bucle. El reintento lo hace el propio worker al acabar la pausa, o antes si `wake()` la corta; el poll de 60 s solo lo reofrece si el `release` fue rechazado (entonces no se guarda). Antes (≤ 0.1.2) el job salía de la cola al liberarse y `wake()` no tenía nada que reintentar: en campo el ticket esperaba al poll aunque la impresora llevase 30 s viva.
6. Fallo de red con Supabase en cualquier paso: log, dejar el job (el `poll()` lo reofrecerá), dormir 10 s.

La cola en memoria es un `Map<jobId, ClaimableJob>` procesado en orden de inserción; `enqueue` de un id ya presente no hace nada.

### `heartbeat.ts`

```ts
export function startHeartbeat(deps: { client; agentId; printers: PrinterCache; clock; cfg }): () => void  // devuelve stop()
```

Cada `cfg.heartbeatMs`: `update print_agents … version` y, por impresora, `probe` → `update printers set last_seen_at`. Errores solo se loguean.

### `index.ts`

Arranque: `loadConfig` → `ServerClock` → `Ledger` → `connect` → `PrinterCache.load` + `subscribe` → un `PrinterWorker` por impresora (se crean/destruyen al cambiar la caché) → suscripción a `print_jobs` INSERT (filtro por restaurante) → `poll()` inmediato y cada 60 s → `startHeartbeat`. `SIGTERM`/`SIGINT`: parar timers, cerrar canales, cerrar el libro, salir 0. Cualquier excepción no capturada: log y `process.exit(1)` (systemd reinicia en 5 s).

`poll()`: `fetchClaimable` → por cada job, `printers.get(printer_id)` → worker de esa impresora `.enqueue(job)`; sin impresora → `release('printer inactive')`.

## Despliegue (`deploy/`)

### `print-agent.service`

```ini
[Unit]
Description=Dimonova print agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=printagent
WorkingDirectory=/opt/print-agent
EnvironmentFile=/opt/print-agent/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/print-agent/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/print-agent/data

[Install]
WantedBy=multi-user.target
```

### `install.sh`

Idempotente, se ejecuta con `sudo` en una Pi recién flasheada:

1. `apt-get update`, instala `git curl ca-certificates`.
2. Node 22 desde NodeSource (`deb.nodesource.com/setup_22.x`) si no hay `node ≥ 22.13`.
3. Tailscale desde `pkgs.tailscale.com/stable` (sin `tailscale up`: lo haces tú).
4. Usuario de sistema `printagent` sin shell.
5. `git clone` (o `git pull` si ya existe) a `/opt/print-agent`, `npm ci --omit=dev`, `npm run build`. `chown -R printagent`.
6. Si no existe `.env`: pregunta por terminal `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `AGENT_EMAIL`, `AGENT_PASSWORD` (la contraseña sin eco), lo escribe con `chmod 600` y dueño `printagent`.
7. `mkdir -p data`, journald persistente (`Storage=persistent`, `SystemMaxUse=200M`), copia el `.service`, `systemctl daemon-reload`, `enable` + `restart` (no `enable --now`: sobre un servicio ya arrancado no recargaría el código nuevo).
8. Imprime `journalctl -u print-agent -f -n 50` y el estado.

### `update.sh`

`cd /opt/print-agent && sudo -u printagent git pull && sudo -u printagent npm ci --omit=dev && sudo -u printagent npm run build && sudo systemctl restart print-agent && journalctl -u print-agent -n 20`.

## README

Secciones: qué es (tres párrafos); imagen de la Pi (Raspberry Pi Imager, Raspberry Pi OS Lite 64-bit, usuario `pi`, SSH activado, red por ethernet preferida); primer arranque (`ssh`, script del Argon ONE, `curl … | sudo bash` del `install.sh` o clonar y ejecutar); Tailscale (`sudo tailscale up`, aprobar en la consola); crear el agente en el panel y copiar credenciales; prueba con el simulador (`printers.host` = IP del portátil en la LAN, `npx tsx scripts/print-simulator.ts` en `panel-admin`, encolar desde el panel); tabla de síntomas:

| Síntoma | Mira |
|---|---|
| Panel: agente gris | `journalctl -u print-agent -n 100`. Login fallido → credenciales; sin red → `ping`, Tailscale |
| Panel: impresora gris, agente verde | La Pi no llega al `host:port`. `nc -vz host 9100` desde la Pi. IP cambiada, impresora apagada, cable |
| Job `failed` | `error` en la fila lo dice. 10 intentos sin conexión. Arreglar y volver a `queued` con un `update` desde el SQL editor de Supabase (desde el panel no: RLS y trigger lo impiden); reimpresión desde UI es pieza futura |
| Imprime dos veces | No debería: el libro local lo impide. Si pasa, `data/ledger.sqlite` se borró o la Pi es otra |
| No imprime pero el job queda `claimed` | Pi murió a medias. A los 2 min se reofrece solo |
| Tildes raras | `code_page` de esa impresora en el panel: PC437 ↔ PC858 |
| Corta encima del texto o no corta | Flag `cut` de la impresora; probar `GS V 1` si el firmware no entiende `GS V 66` (pieza futura) |

## Tests (`vitest`, sin Supabase real)

- `backoff.test.ts`: tabla completa, `isExhausted`.
- `clock.test.ts`: `observe` con cabecera válida, inválida, null; `now()` aplica la deriva; deriva negativa.
- `ledger.test.ts`: fichero temporal; `markPrinted` + `wasPrinted`; reapertura conserva; la poda deja las últimas `keep` filas sin mirar el reloj.
- `printer.test.ts`: `net.createServer` local: recibe exactamente los bytes y cierra; timeout cuando el servidor no lee; `ECONNREFUSED` en puerto cerrado; `probe` true/false.
- `queue.test.ts`: `http.createServer` que imita PostgREST (`GET /rest/v1/print_jobs?…`, `PATCH … Prefer: return=representation`) y registra las peticiones: `fetchClaimable` construye el filtro `or=` con el umbral del reloj; `claim` devuelve `false` con `[]`; `release`/`markFailed` mandan los campos correctos.
- `worker.test.ts`: con `queue` y `printer` reales contra los dos servidores falsos: job feliz → bytes en el servidor + PATCH delivered; job ya en el libro → delivered sin bytes; socket rechazado → PATCH queued con `error` y espera de backoff; un job reofrecido durante el backoff duerme antes de reclamar; décimo intento → PATCH failed.
- `config.test.ts`: falta una variable → error con su nombre; defaults.

## Fuera de alcance

- Panel de estado, reimpresión desde UI, alertas (piezas del panel).
- Más de una Pi por local.
- Impresoras serie (SAM4S Giant-100) o USB.
- Corte alternativo `GS V 1` por firmware: se decide el día de instalación viendo el papel; cambiar el renderizador es trabajo del panel.
- Barrido de pedidos pagados sin `print_jobs` (pendiente en el panel).
