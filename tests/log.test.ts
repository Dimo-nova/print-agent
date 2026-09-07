import { describe, it, expect, vi, afterEach } from 'vitest'
import { logError } from '../src/log.js'

function captureStderr(): { text: () => string; restore: () => void } {
  let out = ''
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  return { text: () => out, restore: () => spy.mockRestore() }
}

describe('logError', () => {
  afterEach(() => vi.restoreAllMocks())

  it('Error real: usa message', () => {
    const cap = captureStderr()
    logError('heartbeat', 'agent heartbeat failed', new Error('network down'))
    expect(cap.text()).toContain('ERROR agent heartbeat failed: network down')
    cap.restore()
  })

  it('objeto tipo PostgrestError con code: message y code entre parentesis', () => {
    const cap = captureStderr()
    logError('heartbeat', 'agent heartbeat failed', { message: 'permission denied', code: '42501', details: null, hint: null })
    expect(cap.text()).toContain('ERROR agent heartbeat failed: permission denied (42501)')
    expect(cap.text()).not.toContain('[object Object]')
    cap.restore()
  })

  it('objeto con message pero sin code string: solo message', () => {
    const cap = captureStderr()
    logError('poll', 'failed', { message: 'boom', code: 42 })
    expect(cap.text()).toContain('ERROR failed: boom')
    cap.restore()
  })

  it('objeto sin message: JSON.stringify', () => {
    const cap = captureStderr()
    logError('poll', 'failed', { foo: 'bar' })
    expect(cap.text()).toContain('ERROR failed: {"foo":"bar"}')
    cap.restore()
  })

  it('undefined: sin sufijo de detalle', () => {
    const cap = captureStderr()
    logError('main', 'fatal')
    expect(cap.text()).toContain('ERROR fatal\n')
    expect(cap.text()).not.toContain('fatal:')
    cap.restore()
  })
})
