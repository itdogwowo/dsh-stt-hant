import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHantProvider, UPSTREAM_ID, PROVIDER_ID, FALLBACK_LANGUAGES } from '../lib/provider.js'
import { apply, normalizeConfig } from '../index.js'

const WAV = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])

/**
 * Stand-in for the speech service. `snapshot()` asks every registered provider
 * for its preparation state exactly like the real service does, which is what
 * makes a provider that calls back into `snapshot()` recurse forever.
 */
function createService({ upstreamRegistered = true } = {}) {
  const calls = { resolve: [], transcribe: [], prepare: [], cancel: [], follow: 0, emitted: 0 }
  const listeners = new Set()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const upstream = {
    info: { id: UPSTREAM_ID, name: 'SenseVoice', location: 'host-local', languages: ['auto', 'zh', 'en'] },
    preparation: {
      phase: 'ready',
      snapshot() { return { phase: upstream.preparation.phase } },
      subscribe() { return () => {} },
      prepare() {},
      cancel() { return Promise.resolve() },
    },
  }
  const all = () => [...(service.registered ? [service.registered] : []), ...(upstreamRegistered ? [upstream] : [])]
  const service = {
    registered: undefined,
    disposed: false,
    selection: { providerId: UPSTREAM_ID, language: 'yue' },
    register(provider) {
      service.registered = provider
      // The real service subscribes with () => this.changed(), so a provider that
      // notifies unconditionally would re-enter follow() forever at registration.
      provider.preparation?.subscribe(() => { notify() })
      return async () => { service.disposed = true }
    },
    listProviders() {
      return all().map((provider) => provider.info)
    },
    snapshot() {
      return {
        providers: all().map((provider) => ({
          ...provider.info,
          preparation: provider.preparation ? provider.preparation.snapshot() : { phase: 'ready' },
        })),
        selection: service.selection,
      }
    },
    async *follow(signal) {
      calls.follow += 1
      // Mirrors the real service exactly: a change during the yield window sets
      // `changed` and the loop re-yields immediately, which is what turns an
      // unconditional notify() into an endless microtask loop.
      let wake = Promise.withResolvers()
      let changed = true
      const signalChange = () => { changed = true; wake.resolve() }
      listeners.add(signalChange)
      signal.addEventListener('abort', signalChange, { once: true })
      try {
        while (!signal.aborted) {
          if (!changed) await wake.promise
          if (signal.aborted) break
          wake = Promise.withResolvers()
          changed = false
          calls.emitted += 1
          // A real follow() re-yields after every changed(); cap it so a provider
          // that feeds its own notifications back fails loudly instead of hanging.
          if (calls.emitted > 50) throw new Error('follow() did not settle: notify/changed feedback loop')
          yield service.snapshot()
        }
      } finally {
        listeners.delete(signalChange)
      }
    },
    setPreparation(phase) {
      upstream.preparation.phase = phase
      notify()
    },
    resolve(request) {
      calls.resolve.push(request)
      if (!upstreamRegistered) throw new Error(`Speech provider is unavailable: ${UPSTREAM_ID}`)
      return { ...request, provider: upstream }
    },
    async transcribe(spec, signal) {
      calls.transcribe.push({ spec, signal })
      return { text: '软件和打印机', audioSeconds: 1.25, inferenceSeconds: 0.4 }
    },
    prepare(id, options) {
      calls.prepare.push([id, options])
    },
    async cancelPreparation(id) {
      calls.cancel.push(id)
    },
  }
  return { service, calls }
}

const convert = (text) => text.replaceAll('软件', '軟體').replaceAll('打印机', '印表機')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('delegates with the explicit upstream id and the untouched audio', async () => {
  const { service, calls } = createService()
  const provider = createHantProvider({ speechToText: service, convert })
  const controller = new AbortController()
  const transcript = await provider.transcribe({ audio: WAV, language: 'yue' }, controller.signal)

  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.resolve[0].providerId, UPSTREAM_ID)
  assert.equal(calls.resolve[0].audio, WAV, 'audio bytes are forwarded by reference')
  assert.equal(calls.resolve[0].language, 'yue')
  assert.equal(calls.transcribe[0].signal, controller.signal)
  assert.equal(transcript.text, '軟體和印表機')
  assert.equal(transcript.audioSeconds, 1.25)
  assert.equal(transcript.inferenceSeconds, 0.4)
})

test('explains a missing upstream provider instead of falling back', async () => {
  const { service } = createService({ upstreamRegistered: false })
  const provider = createHantProvider({ speechToText: service, convert })
  await assert.rejects(
    provider.transcribe({ audio: WAV, language: 'auto' }, new AbortController().signal),
    (error) => error.message.includes('找不到 sensevoice-local') && error.message.includes('請先啟用語音輸入 bundle'),
  )
  assert.equal(service.registered, undefined, 'nothing was registered as a substitute')
})

test('a service snapshot that asks this provider does not recurse', async () => {
  // Regression: preparation.snapshot() must never call speechToText.snapshot().
  const { service } = createService()
  const provider = createHantProvider({ speechToText: service, convert })
  service.register(provider)
  const snapshot = service.snapshot()
  const ours = snapshot.providers.find((entry) => entry.id === PROVIDER_ID)
  assert.ok(ours, 'the service sees this provider')
  assert.equal(typeof ours.preparation.phase, 'string')
})

test('does not feed its own notifications back into follow()', async () => {
  // Regression: the real service subscribes with () => changed(), which re-yields
  // from follow(). Unconditional notify() therefore spun the host at 100% CPU on
  // registration and DSH's profile boot never finished (no window, no error).
  const { service, calls } = createService()
  const warnings = []
  const provider = createHantProvider({ speechToText: service, convert, warn: (m) => warnings.push(m) })
  service.register(provider)
  const stop = provider.preparation.subscribe(() => {})
  await tick()
  assert.deepEqual(provider.preparation.snapshot(), { phase: 'ready' })

  service.setPreparation('downloading')
  await tick()
  assert.equal(warnings.length, 0, `unexpected warnings: ${JSON.stringify(warnings)}`)
  assert.ok(calls.emitted <= 10, `follow() emitted ${calls.emitted} snapshots; notifications are feeding back`)
  assert.deepEqual(provider.preparation.snapshot(), { phase: 'downloading' })
  stop()
})

test('mirrors upstream preparation state and forwards controls', async () => {
  const { service, calls } = createService()
  const provider = createHantProvider({ speechToText: service, convert })

  assert.deepEqual(provider.preparation.snapshot(), { phase: 'unprepared' })

  const observed = []
  const unsubscribe = provider.preparation.subscribe(() => observed.push(provider.preparation.snapshot().phase))
  await tick()
  assert.deepEqual(provider.preparation.snapshot(), { phase: 'ready' })

  service.setPreparation('downloading')
  await tick()
  assert.deepEqual(provider.preparation.snapshot(), { phase: 'downloading' })
  assert.ok(observed.includes('downloading'), `expected a downloading notification, saw ${JSON.stringify(observed)}`)

  provider.preparation.prepare({ downloadSource: 'https://example.com' })
  assert.deepEqual(calls.prepare, [[UPSTREAM_ID, { downloadSource: 'https://example.com' }]])
  await provider.preparation.cancel()
  assert.deepEqual(calls.cancel, [UPSTREAM_ID])
  unsubscribe()
})

test('language list follows the upstream provider', async () => {
  const { service } = createService()
  const provider = createHantProvider({ speechToText: service, convert })
  assert.deepEqual(provider.info.languages, FALLBACK_LANGUAGES)
  const stop = provider.preparation.subscribe(() => {})
  await tick()
  assert.deepEqual(provider.info.languages, ['auto', 'zh', 'en'])
  stop()
})

test('activation registers one provider and the effect cleanup disposes it', async () => {
  const { service } = createService()
  const cleanups = []
  const ctx = {
    speechToText: service,
    effect(execute) { const dispose = execute(); cleanups.push(dispose); return dispose },
    // No webServer in this composition: the optional remote-mic injection never fires.
    inject() { return { dispose() {} } },
  }
  apply(ctx, {})
  assert.equal(service.registered.info.id, PROVIDER_ID)
  assert.equal(service.registered.info.name, 'SenseVoice（繁體）')
  assert.notEqual(service.registered.preparation, undefined)
  // One disposer for the registered provider, one for the warm-up timer.
  assert.equal(cleanups.length, 2)
  for (const cleanup of cleanups) await cleanup?.()
  assert.equal(service.disposed, true)
})

test('invalid config degrades to defaults with warnings', () => {
  const warnings = []
  const config = normalizeConfig({ variant: 's2c', glossary: { 軟體: 1, 記憶體: '內存' }, protectCodeSpans: 'yes', keepModelWarm: 'no' }, (m) => warnings.push(m))
  assert.equal(config.variant, 's2hk')
  assert.deepEqual(config.glossary, { 記憶體: '內存' })
  assert.equal(config.protectCodeSpans, true)
  assert.equal(config.keepModelWarm, true)
  assert.equal(warnings.length, 4)

  assert.deepEqual(normalizeConfig(undefined), { variant: 's2hk', glossary: {}, protectCodeSpans: true, keepModelWarm: true })
})
