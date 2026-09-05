import { describe, it, expect } from 'vitest'
import { BACKOFF_MS, MAX_ATTEMPTS, backoffFor, isExhausted } from '../src/backoff.js'

describe('backoff', () => {
  it('tabla fija de cinco escalones', () => {
    expect(BACKOFF_MS).toEqual([5_000, 15_000, 45_000, 120_000, 300_000])
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it('backoffFor devuelve el escalon del intento, y el ultimo a partir de ahi', () => {
    expect(backoffFor(1)).toBe(5_000)
    expect(backoffFor(3)).toBe(45_000)
    expect(backoffFor(5)).toBe(300_000)
    expect(backoffFor(9)).toBe(300_000)
    expect(backoffFor(0)).toBe(5_000)
  })

  it('isExhausted a partir del quinto intento', () => {
    expect(isExhausted(4)).toBe(false)
    expect(isExhausted(5)).toBe(true)
    expect(isExhausted(6)).toBe(true)
  })
})
