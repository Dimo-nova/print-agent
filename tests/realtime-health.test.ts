import { describe, it, expect } from 'vitest'
import { shouldResubscribe } from '../src/realtime-health.js'

describe('shouldResubscribe', () => {
  it('joined: nunca', () => {
    expect(shouldResubscribe('joined', 0, 1_000_000)).toBe(false)
  })

  it('joining: nunca (se esta reconectando solo, no lo interrumpas)', () => {
    expect(shouldResubscribe('joining', 0, 1_000_000)).toBe(false)
  })

  it('errored con hueco suficiente: si', () => {
    expect(shouldResubscribe('errored', 0, 60_000)).toBe(true)
  })

  it('closed con hueco suficiente: si', () => {
    expect(shouldResubscribe('closed', 0, 120_000)).toBe(true)
  })

  it('errored dentro del hueco minimo: no', () => {
    expect(shouldResubscribe('errored', 0, 30_000)).toBe(false)
  })

  it('closed justo por debajo del hueco: no', () => {
    expect(shouldResubscribe('closed', 100_000, 159_999, 60_000)).toBe(false)
  })

  it('respeta un minGapMs custom', () => {
    expect(shouldResubscribe('errored', 0, 5_000, 10_000)).toBe(false)
    expect(shouldResubscribe('errored', 0, 10_000, 10_000)).toBe(true)
  })

  it('leaving: no es un estado sano, pero tampoco joined/joining -> intenta si hay hueco', () => {
    expect(shouldResubscribe('leaving', 0, 60_000)).toBe(true)
  })
})
