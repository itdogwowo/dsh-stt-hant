import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerConvertRoutes } from '../index.js'

const createScope = () => {
  const routes = []
  return {
    routes,
    scope: {
      webServer: { register(route) { routes.push(route); return () => undefined } },
      effect(run) { return run() },
    },
  }
}

const call = (route, { method = 'GET', body } = {}) => new Promise((resolve) => {
  const response = {
    headersSent: false,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(payload) { resolve({ code: this.code, body: payload }) },
  }
  const listeners = new Map()
  const request = {
    method,
    url: route.path,
    headers: { host: '127.0.0.1:3080' },
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

const fakeSettings = {
  state: { enabled: true, variant: 's2hk', protectCodeSpans: true, glossary: {} },
  async load() {},
  snapshot() { return { ...this.state, glossary: { ...this.state.glossary } } },
  async update(patch) { this.state = { ...this.state, ...patch }; return this.snapshot() },
  convert(text) { return this.state.enabled ? `轉:${text}` : text },
}

test('conversion routes expose and update the settings and convert text', async () => {
  const { scope, routes } = createScope()
  registerConvertRoutes(scope, fakeSettings, () => {})
  const byPath = (suffix) => {
    const route = routes.find((entry) => entry.path.endsWith(suffix))
    assert.ok(route, suffix)
    return route
  }
  const current = await call(byPath('/convert-settings'))
  assert.equal(current.code, 200)
  assert.equal(JSON.parse(current.body).settings.variant, 's2hk')

  const updated = await call(byPath('/convert-settings'), { method: 'POST', body: { variant: 's2twp' } })
  assert.equal(updated.code, 200)
  assert.equal(JSON.parse(updated.body).settings.variant, 's2twp')

  const converted = await call(byPath('/convert'), { method: 'POST', body: { text: '軟件' } })
  assert.equal(converted.code, 200)
  assert.equal(JSON.parse(converted.body).text, '轉:軟件')

  const wrongMethod = await call(byPath('/convert'), { method: 'GET' })
  assert.equal(wrongMethod.code, 405)

})
