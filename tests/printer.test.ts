import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { sendBytes, probe, type Connect } from '../src/printer.js'
import { startFakePrinter } from './helpers/fake-printer.js'
import { waitFor } from './helpers/wait-for.js'

const bytes = Uint8Array.from([0x1b, 0x40, 0x48, 0x4f, 0x4c, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00])

describe('sendBytes', () => {
  it('entrega exactamente los bytes y cierra el socket', async () => {
    const printer = await startFakePrinter()
    await sendBytes({ host: '127.0.0.1', port: printer.port }, bytes, 2_000)
    await waitFor(() => printer.received.length === 1)
    expect(Array.from(printer.received[0]!)).toEqual(Array.from(bytes))
    expect(printer.connections).toBe(1)
    await printer.close()
  })

  it('puerto cerrado: rechaza con ECONNREFUSED y host:puerto', async () => {
    const free = await freePort()
    await expect(sendBytes({ host: '127.0.0.1', port: free }, bytes, 2_000)).rejects.toThrow(/ECONNREFUSED 127\.0\.0\.1:\d+/)
  })

  it('sin respuesta del host: timeout', async () => {
    // Un socket creado pero nunca conectado: ni 'connect' ni 'error' llegan,
    // solo puede salvarnos el timeout. Es lo que pasa con una impresora
    // apagada cuya IP sigue en la tabla ARP: los SYN se pierden en silencio.
    const never: Connect = () => new net.Socket()
    await expect(sendBytes({ host: '10.0.0.1', port: 9100 }, bytes, 300, never)).rejects.toThrow(/timeout 300ms 10\.0\.0\.1:9100/)
  })
})

describe('probe', () => {
  it('true si acepta la conexion, false si no', async () => {
    const printer = await startFakePrinter()
    expect(await probe({ host: '127.0.0.1', port: printer.port }, 1_000)).toBe(true)
    await printer.close()
    expect(await probe({ host: '127.0.0.1', port: printer.port }, 1_000)).toBe(false)
  })

  it('sin respuesta del host: false por timeout', async () => {
    const never: Connect = () => new net.Socket()
    expect(await probe({ host: '10.0.0.1', port: 9100 }, 300, never)).toBe(false)
  })
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(r => server.close(() => r()))
  return port
}
