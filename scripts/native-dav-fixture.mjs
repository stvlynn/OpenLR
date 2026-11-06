import { once } from 'node:events'
import { createServer } from 'node:http'

export async function startDavFixture({ beforePut } = {}) {
  const objects = new Map(),
    requests = []
  let revision = 0
  async function handle(req, res) {
    const request = {
      method: req.method,
      path: req.url,
      ifMatch: req.headers['if-match'],
      ifNoneMatch: req.headers['if-none-match']
    }
    const send = (status, headers, body) => {
      requests.push({ ...request, status })
      res.writeHead(status, headers).end(body)
    }
    if (req.method === 'GET') {
      const stored = objects.get(req.url)
      if (stored) send(200, { ETag: stored.tag }, stored.bytes)
      else send(404)
      return
    }
    if (req.method !== 'PUT') {
      send(405)
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    await beforePut?.(request)
    const stored = objects.get(req.url)
    if ((request.ifNoneMatch === '*' && stored) || (request.ifMatch && request.ifMatch !== stored?.tag)) {
      send(412)
      return
    }
    const tag = '"' + ++revision + '"'
    objects.set(req.url, { tag, bytes: Buffer.concat(chunks) })
    send(201, { ETag: tag })
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('DAV fixture request failed:', error.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  return {
    endpoint: 'http://127.0.0.1:' + server.address().port + '/library/',
    objects,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
  }
}
