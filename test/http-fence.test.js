import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackHostname, selfRejection, trustedHostsFromEnv } from '../lib/http-fence.js'

const request = (headers = {}) => ({ headers })

test('loopback hostnames are recognised exactly', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.8.9.10'), true)
  assert.equal(isLoopbackHostname('::1'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false)
  assert.equal(isLoopbackHostname('192.168.1.5'), false)
})

test('same-origin loopback requests pass', () => {
  assert.equal(selfRejection(request({ host: '127.0.0.1:3080' })), null)
  assert.equal(selfRejection(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), null)
  assert.equal(selfRejection(request({
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'sec-fetch-site': 'same-origin',
  })), null)
})

test('non-loopback and cross-site requests are rejected', () => {
  assert.equal(selfRejection(request({ host: 'example.com' })), 403)
  assert.equal(selfRejection(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(selfRejection(request({
    host: '127.0.0.1:3080',
    origin: 'http://evil.example',
  })), 403)
  assert.equal(selfRejection(request({ host: '' })), 403)
})

test('an explicit trusted host may be proxied', () => {
  const proxied = request({ host: '192.168.1.5:3080', 'sec-fetch-site': 'same-origin' })
  assert.equal(selfRejection(proxied), 403)
  assert.equal(selfRejection(proxied, { trustedHosts: ['192.168.1.5'] }), null)
})

test('trusted hosts come from the documented environment variable', () => {
  assert.deepEqual(trustedHostsFromEnv({ DSH_STT_HANT_TRUSTED_HOSTS: 'a.example, B.example ,,' }), ['a.example', 'b.example'])
  assert.deepEqual(trustedHostsFromEnv({}), [])
})
