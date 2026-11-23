import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { registerRemoteMicRoutes } from '../index.js'

/**
 * One live event-stream test over a real socket. The unit test in
 * remote-mic-routes.test.js proves the handler ignores the request's close; this
 * one proves the whole loop — real HTTP server, real client, real disconnect —
 * so a regression cannot hide behind a fake.
 */

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await delay(10)
  }
  return false
}

/**
 * Start a server that behaves like the host's web server: resolve the plugin's
 * route, call its handler, and close the response when the handler resolves.
 */
function startServer(bridge) {
  const routes = []
  const scope = {
    webServer: { register(route) { routes.push(route); return () => undefined } },
    effect(run) { return run() },
  }
  const model = { status: () => ({ provider: 'sensevoice-local', phase: 'ready' }), prepare: () => undefined }
  registerRemoteMicRoutes(scope, bridge, () => {}, model, async () => ({}))

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find((entry) => (entry.kind === 'exact' ? entry.path === pathname : pathname.startsWith(entry.path)))
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    Promise.resolve(route.handler(req, res))
      .then(() => { if (!res.writableEnded) res.end() })
      .catch(() => { if (!res.writableEnded) res.end() })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** Open one GET and resolve with the raw response once headers arrive. */
function openStream(port) {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path: '/stt-hant/remote-mic/events' }, (response) => {
      resolve({ request, response })
    })
    request.on('error', reject)
  })
}

test('a live event stream stays open and pushes each bridge change', async () => {
  const listeners = new Set()
  let seq = 0
  let phase = 'ready'
  const bridge = {
    status: () => ({ platform: 'win32', support: 'supported', phase, seq, utterances: [] }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    ready: async () => undefined,
  }
  const { server, port } = await startServer(bridge)
  let request
  let response
  const frames = []
  try {
    ;({ request, response } = await openStream(port))
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      for (const part of String(chunk).split('\n\n')) {
        if (part.startsWith('data: ')) frames.push(JSON.parse(part.slice('data: '.length)))
      }
    })

    // The connect frame arrives, and the request's own stream is already done.
    assert.ok(await waitFor(() => frames.length >= 1), 'connect frame arrives')
    assert.equal(frames[0].phase, 'ready')

    // The socket must survive well past the request's close. The old handler
    // closed it in the same millisecond, so a 300 ms wait is decisive.
    await delay(300)
    assert.equal(response.destroyed, false, 'stream stays open after the request completed')
    assert.equal(listeners.size, 1, 'subscription stays live')

    // A bridge change reaches the client without polling.
    phase = 'recording'
    seq = 1
    for (const listener of [...listeners]) listener()
    assert.ok(await waitFor(() => frames.length >= 2), 'change frame arrives')
    assert.equal(frames[1].phase, 'recording')

    // Disconnecting releases the subscription.
    request.destroy()
    assert.ok(await waitFor(() => listeners.size === 0), 'subscription released on disconnect')
  } finally {
    try { request?.destroy() } catch { /* already gone */ }
    try { response?.destroy() } catch { /* already gone */ }
    await new Promise((resolve) => { server.close(resolve) })
  }
})
