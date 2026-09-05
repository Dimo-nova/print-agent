import http from 'node:http'

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: unknown
}

export type Handler = (req: Recorded) => { status?: number; body?: unknown } | undefined

/**
 * Lo justo de PostgREST para que supabase-js hable con él: registra cada
 * petición y responde lo que diga el handler del test. Con `Accept:
 * application/vnd.pgrst.object+json` (`.single()`/`.maybeSingle()`) devuelve
 * el primer elemento del array del handler, o 406 si está vacío (como el real).
 */
export async function startFakePostgrest() {
  const requests: Recorded[] = []
  let handler: Handler = () => ({ status: 200, body: [] })

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://fake')
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      }
      requests.push(recorded)
      const out = handler(recorded) ?? { status: 200, body: [] }
      let status = out.status ?? 200
      let body = out.body ?? []
      const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
      if (wantsObject && Array.isArray(body)) {
        if (body.length === 0) { status = 406; body = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
        else body = body[0]
      }
      res.writeHead(status, { 'content-type': 'application/json', date: new Date().toUTCString() })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    onRequest(h: Handler) { handler = h },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
