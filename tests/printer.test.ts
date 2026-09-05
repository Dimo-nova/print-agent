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
    const big = new Uint8Array(32 * 1024 * 1024)
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
