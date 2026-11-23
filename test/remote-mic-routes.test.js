import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerRemoteMicRoutes, HOST_VERSION } from '../index.js'

/** Collect the routes a fake web server receives. */
function createScope() {
  const routes = []
  const scope = {
    webServer: {
      register(route) { routes.push(route); return () => undefined },
    },
    effect(run) { return run() },
  }
  return { scope, routes }
}

/** Minimal node:http request/response doubles, with an optional JSON body. */
function call(route, { method = 'GET', url = route.path, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const response = {
      headersSent: false,
      writeHead(code, values) { this.code = code; this.headers = values },
      end(payload) { resolve({ code: this.code, headers: this.headers, body: payload }) },
    }
    const listeners = new Map()
    const request = {
      method,
      url,
      headers: { host: '127.0.0.1:3080', ...headers },
      resume() {},
      destroy() {},
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(listener)
        return this
      },
    }
    void route.handler(request, response)
    if (body !== undefined) {
      setTimeout(() => {
        for (const listener of listeners.get('data') ?? []) listener(Buffer.from(JSON.stringify(body)))
        for (const listener of listeners.get('end') ?? []) listener()
      }, 0)
    }
  })
}

const fakeBridge = {
  status: () => ({ platform: 'darwin', support: 'supported', phase: 'ready', utterances: [] }),
  start: async () => undefined,
  stop: () => ({ platform: 'darwin', support: 'supported', phase: 'idle', utterances: [] }),
  readUtterance: async (id) => {
    if (id !== 'utt-1700000000000-001.wav') throw new Error('missing')
    return Buffer.from('RIFFwav')
  },
  listDevices: async () => [{ name: 'Fake Remote', serial: 'SN1', vendorId: 10007, productId: 12984, model: 'RC003', supported: true }],
  bind: async (device) => ({ platform: 'darwin', support: 'supported', phase: 'idle', binding: { name: device?.name ?? 'Fake' }, utterances: [] }),
  unbind: async () => ({ platform: 'darwin', support: 'supported', phase: 'idle', binding: null, utterances: [] }),
  setMapping: async () => ({ platform: 'darwin', support: 'supported', phase: 'idle', binding: null, utterances: [] }),
  setEnabled: async (enabled) => ({ platform: 'darwin', support: 'supported', phase: enabled ? 'idle' : 'idle', enabled, binding: { name: 'Fake' }, utterances: [] }),
}

const fakeRecognize = async (id) => ({ id, text: '繁體', raw: '繁体', timings: { transcribeMs: 5, convertMs: 1, totalMs: 6 } })

const fakeModel = {
  status: () => ({ provider: 'sensevoice-local', phase: 'ready' }),
  prepare: () => undefined,
}

const byPath = (routes, suffix) => {
  const route = routes.find((entry) => entry.path.endsWith(suffix))
  assert.ok(route, `route ${suffix} registered`)
  return route
}

test('remote-mic routes are registered and answer the panel', async () => {
  const { scope, routes } = createScope()
  registerRemoteMicRoutes(scope, fakeBridge, () => {}, fakeModel, fakeRecognize)
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/stt-hant/model/prepare',
    '/stt-hant/recognize',
    '/stt-hant/remote-mic/enabled',
    '/stt-hant/remote-mic/events',
    '/stt-hant/remote-mic/next',
    '/stt-hant/remote-mic/start',
    '/stt-hant/remote-mic/status',
    '/stt-hant/remote-mic/stop',
    '/stt-hant/remote-mic/utterances',
    '/stt-hant/remote/bind',
    '/stt-hant/remote/devices',
    '/stt-hant/remote/mapping',
    '/stt-hant/remote/unbind',
  ])

  const status = await call(byPath(routes, '/status'))
  assert.equal(status.code, 200)
  assert.deepEqual(JSON.parse(status.body), { ...fakeBridge.status(), model: fakeModel.status(), hostVersion: HOST_VERSION })

  const start = await call(byPath(routes, '/start'), { method: 'POST' })
  assert.equal(start.code, 200)

  const wrongMethod = await call(byPath(routes, '/start'), { method: 'GET' })
  assert.equal(wrongMethod.code, 405)

  const stop = await call(byPath(routes, '/stop'), { method: 'POST' })
  assert.equal(stop.code, 200)
  assert.equal(JSON.parse(stop.body).phase, 'idle')
})

test('the fence rejects cross-site and non-loopback requests', async () => {
  const { scope, routes } = createScope()
  registerRemoteMicRoutes(scope, fakeBridge, () => {}, fakeModel, fakeRecognize)
  const crossSite = await call(byPath(routes, '/status'), { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.code, 403)
  const external = await call(byPath(routes, '/status'), { headers: { host: 'example.com' } })
  assert.equal(external.code, 403)
})

test('utterance bytes are served only for valid spool ids', async () => {
  const { scope, routes } = createScope()
  registerRemoteMicRoutes(scope, fakeBridge, () => {}, fakeModel, fakeRecognize)
  const route = byPath(routes, '/utterances')
  const ok = await call(route, { url: '/stt-hant/remote-mic/utterances/utt-1700000000000-001.wav' })
  assert.equal(ok.code, 200)
  assert.equal(ok.headers['content-type'], 'audio/wav')
  assert.equal(String(ok.body), 'RIFFwav')

  const missing = await call(route, { url: '/stt-hant/remote-mic/utterances/utt-1700000000000-999.wav' })
  assert.equal(missing.code, 404)

  const traversal = await call(route, { url: '/stt-hant/remote-mic/utterances/..%2Fsecret.wav' })
  assert.equal(traversal.code, 404)
})

test('device binding routes list, bind, and unbind', async () => {
  const { scope, routes } = createScope()
  registerRemoteMicRoutes(scope, fakeBridge, () => {}, fakeModel, fakeRecognize)

  const devices = await call(byPath(routes, '/devices'))
  assert.equal(devices.code, 200)
  assert.equal(JSON.parse(devices.body).devices[0].serial, 'SN1')

  const bind = await call(byPath(routes, '/bind'), {
    method: 'POST',
    body: { name: 'Fake Remote', serial: 'SN1', vendorId: 10007, productId: 12984 },
  })
  assert.equal(bind.code, 200)
  assert.equal(JSON.parse(bind.body).binding.name, 'Fake Remote')

  const unbind = await call(byPath(routes, '/unbind'), { method: 'POST' })
  assert.equal(unbind.code, 200)
  assert.equal(JSON.parse(unbind.body).binding, null)
})

test('recognize takes one utterance id and answers text plus timings', async () => {
  const { scope, routes } = createScope()
  registerRemoteMicRoutes(scope, fakeBridge, () => {}, fakeModel, fakeRecognize)
  const route = routes.find((entry) => entry.path === '/stt-hant/recognize')
  const ok = await call(route, { method: 'POST', body: { id: 'utt-1700000000000-001.wav' } })
  assert.equal(ok.code, 200)
  assert.equal(JSON.parse(ok.body).text, '繁體')

  const bad = await call(route, { method: 'POST', body: { id: '../etc/passwd' } })
  assert.equal(bad.code, 400)

  const wrong = await call(route, { method: 'GET' })
  assert.equal(wrong.code, 405)
})

/** A request/response pair with EventEmitter semantics and frame capture. */
function createStream() {
  const request = new EventEmitter()
  request.method = 'GET'
  request.url = '/stt-hant/remote-mic/events'
  request.headers = { host: '127.0.0.1:3080' }
  request.resume = () => {}
  request.destroy = () => {}

  const frames = []
  const response = new EventEmitter()
  response.headersSent = false
  response.writableEnded = false
  response.destroyed = false
  response.ended = false
  response.writeHead = (code, headers) => { response.code = code; response.headers = headers; response.headersSent = true }
  response.write = (chunk) => { frames.push(String(chunk)); return true }
  response.end = () => { response.ended = true; response.writableEnded = true }
  return { request, response, frames }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

test('the event stream outlives the request and closes only with the response', async () => {
  const { scope, routes } = createScope()
  const listeners = new Set()
  let seq = 0
  let phase = 'ready'
  const bridge = {
    ...fakeBridge,
    status: () => ({ platform: 'win32', support: 'supported', phase, seq, utterances: [] }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  registerRemoteMicRoutes(scope, bridge, () => {}, fakeModel, fakeRecognize)
  const route = byPath(routes, '/events')

  const { request, response, frames } = createStream()
  let settled = false
  const handled = route.handler(request, response).then(() => { settled = true })
  await delay(20)

  // The connect frame is written and the subscription is live.
  assert.equal(response.code, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(frames.length, 1)
  assert.equal(JSON.parse(frames[0].slice('data: '.length)).phase, 'ready')
  assert.equal(listeners.size, 1)

  // A GET request's stream is already complete: its close must not end the SSE.
  request.emit('close')
  await delay(20)
  assert.equal(settled, false, 'handler must stay pending after the request closes')
  assert.equal(response.ended, false, 'response must stay open after the request closes')
  assert.equal(listeners.size, 1, 'subscription must survive the request close')

  // A bridge change is pushed without any polling.
  phase = 'recording'
  seq = 1
  for (const listener of [...listeners]) listener()
  await delay(20)
  assert.equal(frames.length, 2)
  assert.equal(JSON.parse(frames[1].slice('data: '.length)).phase, 'recording')

  // The reader going away releases the handler and the subscription.
  response.emit('close')
  await handled
  assert.equal(settled, true)
  assert.equal(listeners.size, 0)
})
