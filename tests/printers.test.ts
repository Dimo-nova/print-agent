import { describe, it, expect } from 'vitest'
import { printerRowChanged } from '../src/printers.js'

const base = {
  id: 'p1', name: 'Barra', target: 'bar', host: '127.0.0.1', port: 9100, active: true,
  last_seen_at: '2026-09-07T10:00:00Z', updated_at: '2026-09-07T10:00:00Z',
}

describe('printerRowChanged', () => {
  it('mismas filas con distinto last_seen_at/updated_at (nuestro propio heartbeat): no cambia', () => {
    const heartbeatOnly = { ...base, last_seen_at: '2026-09-07T10:05:00Z', updated_at: '2026-09-07T10:05:00Z' }
    expect(printerRowChanged(base, heartbeatOnly)).toBe(false)
  })

  it('cambio de host: si cambia', () => {
    expect(printerRowChanged(base, { ...base, host: '192.168.1.50' })).toBe(true)
  })

  it('cambio de puerto: si cambia', () => {
    expect(printerRowChanged(base, { ...base, port: 9101 })).toBe(true)
  })

  it('cambio de nombre: si cambia', () => {
    expect(printerRowChanged(base, { ...base, name: 'Cocina' })).toBe(true)
  })

  it('cambio de target: si cambia', () => {
    expect(printerRowChanged(base, { ...base, target: 'kitchen' })).toBe(true)
  })

  it('activar/desactivar: si cambia', () => {
    expect(printerRowChanged(base, { ...base, active: false })).toBe(true)
  })

  it('sin fila anterior (INSERT, o UPDATE sin REPLICA IDENTITY FULL): se trata como cambio', () => {
    expect(printerRowChanged(null, base)).toBe(true)
    expect(printerRowChanged(undefined, base)).toBe(true)
  })
})
