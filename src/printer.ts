import net from 'node:net'

export interface PrinterTarget {
  host: string
  port: number
}

/** Inyectable en tests: un socket que nunca conecta hace saltar el timeout de forma determinista. */
export type Connect = (options: { host: string; port: number }) => net.Socket

/**
 * Abrir, escribir, cerrar. Nunca se deja el socket abierto: las impresoras
 * confirmadas admiten UNA conexión y el TPV del local imprime contra la misma.
 * Cualquier error o timeout destruye el socket y rechaza con un mensaje corto
 * (`ECONNREFUSED 192.168.1.6:9100`, `timeout 5000ms 192.168.1.6:9100`) que va
 * tal cual a `print_jobs.error`.
 */
export function sendBytes(target: PrinterTarget, bytes: Uint8Array, timeoutMs: number, connect: Connect = net.createConnection): Promise<void> {
  const where = `${target.host}:${target.port}`
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port })
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
export function probe(target: PrinterTarget, timeoutMs: number, connect: Connect = net.createConnection): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: target.host, port: target.port })
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
