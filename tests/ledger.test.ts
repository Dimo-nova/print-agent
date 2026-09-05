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

  it('prune borra lo mas viejo que la retencion sin reabrir', () => {
    const ledger = new Ledger(tmpPath(), 7)
    ledger.markPrinted('old', new Date(Date.now() - 8 * 86_400_000))
    ledger.markPrinted('recent', new Date())
    ledger.prune()
    expect(ledger.wasPrinted('old')).toBe(false)
    expect(ledger.wasPrinted('recent')).toBe(true)
    ledger.close()
  })
})
