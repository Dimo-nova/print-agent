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

  it('al abrir deja solo las ultimas filas', () => {
    const path = tmpPath()
    const first = new Ledger(path, 2)
    first.markPrinted('a', new Date())
    first.markPrinted('b', new Date())
    first.markPrinted('c', new Date())
    first.close()
    const second = new Ledger(path, 2)
    expect(second.wasPrinted('a')).toBe(false)
    expect(second.wasPrinted('b')).toBe(true)
    expect(second.wasPrinted('c')).toBe(true)
    second.close()
  })

  it('prune deja solo las ultimas filas sin reabrir, sin mirar el reloj', () => {
    // Fechas del futuro y del pasado a la vez: la retencion es por cantidad,
    // asi que un reloj de la Pi sin NTP no borra nada que haga falta.
    const ledger = new Ledger(tmpPath(), 2)
    ledger.markPrinted('a', new Date(Date.now() + 86_400_000))
    ledger.markPrinted('b', new Date(Date.now() - 30 * 86_400_000))
    ledger.markPrinted('c', new Date(0))
    ledger.prune()
    expect(ledger.wasPrinted('a')).toBe(false)
    expect(ledger.wasPrinted('b')).toBe(true)
    expect(ledger.wasPrinted('c')).toBe(true)
    ledger.close()
  })
})
