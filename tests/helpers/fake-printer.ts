import net from 'node:net'

/**
 * Impresora ESC/POS de mentira: acepta en un puerto efímero, acumula bytes por
 * conexión y cierra cuando el cliente cierra.
 */
export async function startFakePrinter() {
  return startOn(0)
}

/**
 * Igual que `startFakePrinter`, pero en un puerto concreto: para simular que
 * una impresora vuelve exactamente donde estaba (mismo host:puerto que el
 * worker ya tiene) tras un fallo, en vez de una nueva instancia en un puerto
 * distinto que el worker no está mirando.
 */
export async function startFakePrinterOn(port: number) {
  return startOn(port)
}

async function startOn(port: number) {
  const received: Buffer[] = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer(socket => {
    connections += 1
    sockets.add(socket)
    const chunks: Buffer[] = []
    socket.on('data', c => chunks.push(c))
    socket.on('close', () => { sockets.delete(socket); if (chunks.length) received.push(Buffer.concat(chunks)) })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const actualPort = (server.address() as net.AddressInfo).port
  return {
    port: actualPort,
    received,
    get connections() { return connections },
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
