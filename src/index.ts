import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { loadConfig, loadEnvFile } from './config.js'
import { ServerClock } from './clock.js'
import { Ledger } from './ledger.js'
import { connect } from './supabase.js'
import { PrinterCache } from './printers.js'
import { PrinterWorker } from './worker.js'
import { fetchClaimable, release, type ClaimableJob } from './queue.js'
import { startHeartbeat } from './heartbeat.js'
import { log, logError } from './log.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

/**
 * Arranque y bucle principal. Todo lo que puede fallar por red se reintenta;
 * lo que no puede fallar (config mal) sale con código 1 y systemd lo reinicia
 * a los 5 s, que es la forma de que el error se vea en journalctl cada vez.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env'))
  const cfg = loadConfig(process.env, version)
  log('main', 'print-agent starting', { version, node: process.version })

  const clock = new ServerClock()
  const ledger = new Ledger(cfg.ledgerPath)
  const { client, agent } = await connect(cfg, clock)
  const restaurantId = agent.restaurant_id

  const printers = new PrinterCache(client, restaurantId)
  await printers.load()

  const workers = new Map<string, PrinterWorker>()
  const syncWorkers = () => {
    const printersMap = new Map(printers.all().map(p => [p.id, p]))
    // El remedio del panel para una impresora gris es editar su IP: eso tiene
    // que llegar al worker vivo sin reiniciar el proceso, así que un cambio de
    // host/puerto se trata igual que si la impresora hubiera desaparecido.
    for (const [id, worker] of workers) {
      const row = printersMap.get(id)
      if (!row || row.host !== worker.printer.host || row.port !== worker.printer.port) {
        worker.stop()
        workers.delete(id)
        log('main', 'worker stopped', { printer: worker.printer.name, reason: row ? 'endpoint changed' : 'printer gone' })
      }
    }
    for (const printer of printers.all()) {
      if (!workers.has(printer.id)) {
        workers.set(printer.id, new PrinterWorker(printer, { client, clock, ledger, socketTimeoutMs: cfg.socketTimeoutMs }))
        log('main', 'worker started', { printer: printer.name, host: `${printer.host}:${printer.port}` })
      }
    }
  }
  syncWorkers()
  printers.subscribe(() => { syncWorkers(); void poll('printers changed') })

  let polling = false
  let pollAgain = false
  const skippedNoPrinter = new Set<string>()
  async function poll(reason: string): Promise<void> {
    if (polling) { pollAgain = true; return }
    polling = true
    try {
      do {
        pollAgain = false
        const jobs = await fetchClaimable(client, restaurantId, clock, cfg.staleClaimMs)
        if (jobs.length > 0) log('poll', 'claimable', { reason, n: jobs.length })
        for (const job of jobs) await dispatch(job)
      } while (pollAgain)
    } catch (err) {
      logError('poll', `failed (${reason})`, err)
    } finally {
      polling = false
    }
  }

  async function dispatch(job: ClaimableJob): Promise<void> {
    const worker = workers.get(job.printer_id)
    if (worker) { skippedNoPrinter.delete(job.id); worker.enqueue(job); return }
    // Impresora desactivada después de encolar. No es culpa del job: se
    // libera si estaba reclamado y se deja en la cola por si la impresora vuelve.
    if (job.status === 'claimed') await release(client, job.id, 'printer inactive').catch(err => logError('poll', 'release failed', err))
    if (!skippedNoPrinter.has(job.id)) {
      skippedNoPrinter.add(job.id)
      log('poll', 'no active printer for job, left in queue', { job: job.id, printer_id: job.printer_id })
    }
    // Tope de memoria: en el peor caso esto repite una línea de log una vez
    // cada 1000 huérfanos, que es un precio aceptable por no crecer sin fin.
    if (skippedNoPrinter.size > 1000) skippedNoPrinter.clear()
  }

  const jobsChannel: RealtimeChannel = client
    .channel(`print_jobs:${restaurantId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'print_jobs', filter: `restaurant_id=eq.${restaurantId}` },
      // Timbre. El payload viene en el evento y se ignora a propósito: se lee tras el claim.
      () => void poll('realtime'),
    )
    .subscribe(status => log('main', 'print_jobs channel', { status }))

  await poll('startup')
  const pollTimer = setInterval(() => void poll('interval'), cfg.pollIntervalMs)
  const pruneTimer = setInterval(() => ledger.prune(), 24 * 60 * 60 * 1000)
  const stopHeartbeat = startHeartbeat({
    client, agentId: agent.id, printers, clock, version,
    heartbeatMs: cfg.heartbeatMs, probeTimeoutMs: cfg.probeTimeoutMs,
  })
  log('main', 'running', { restaurant: restaurantId, pollMs: cfg.pollIntervalMs, heartbeatMs: cfg.heartbeatMs })

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log('main', 'shutting down', { signal })
    clearInterval(pollTimer)
    clearInterval(pruneTimer)
    stopHeartbeat()
    for (const worker of workers.values()) worker.stop()
    await client.removeChannel(jobsChannel)
    await printers.unsubscribe()
    ledger.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  logError('main', 'fatal', err)
  process.exit(1)
})
