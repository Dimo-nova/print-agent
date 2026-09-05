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
