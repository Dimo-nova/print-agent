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
