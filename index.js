/**
 * Host half of dsh-stt-hant: registers one more speech provider that returns
 * Traditional Chinese, delegating recognition to the shipped local model, and
 * manages the bundled ATVV capture helper that turns the remote's own
 * microphone into WAV utterances for the sidebar console. The helper is Swift
 * on macOS and C# on Windows; the bridge picks the source per platform.
 *
 * No UI is created here. The speech UI that already lists providers picks this
 * entry up as soon as it is registered; the console talks to the remote-mic
 * routes below.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveVariant } from './lib/hant.js'
import { createConvertSettings } from './lib/convert-settings.js'
import { createHantProvider } from './lib/provider.js'
import { selfRejection } from './lib/http-fence.js'
import { createRemoteMicBridge, defaultCacheDir } from './lib/native-bridge.js'

/** Host-half version; the panel compares it to its own bundle version. */
export const HOST_VERSION = '0.12.0'

/** The speech service must exist before this plugin activates. */
export const inject = ['speechToText']

/** Route prefix owned by this plugin (no trailing slash). */
const REMOTE_MIC_PREFIX = '/stt-hant/remote-mic'

/**
 * Log through the host logger when the context has one.
 * @param ctx - plugin context.
 * @returns a message sink that never throws.
 */
function createWarn(ctx) {
  return (message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-stt-hant') : undefined
      const sink = logger ?? console
      const write = sink.warn ?? sink.info ?? console.warn
      write.call(sink, message)
    } catch {
      console.warn(message)
    }
  }
}

/**
 * Validate one raw config value and fall back instead of failing activation.
 * @param raw - the plugin row's `config`.
 * @param warn - receives one message per dropped or invalid field.
 * @returns settings the converter can use.
 */
export function normalizeConfig(raw, warn) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const variant = resolveVariant(config.variant, warn)

  const glossary = {}
  if (config.glossary !== undefined && config.glossary !== null) {
    if (typeof config.glossary !== 'object' || Array.isArray(config.glossary)) {
      warn('[dsh-stt-hant] glossary 必須是 { 詞: 譯法 } 物件，已忽略')
    } else {
      for (const [key, value] of Object.entries(config.glossary)) {
        if (typeof value === 'string' && key !== '') glossary[key] = value
        else warn(`[dsh-stt-hant] glossary 的 ${JSON.stringify(key)} 不是字串，已忽略`)
      }
    }
  }

  const protectCodeSpans = config.protectCodeSpans === undefined ? true : config.protectCodeSpans
  if (typeof protectCodeSpans !== 'boolean') {
    warn('[dsh-stt-hant] protectCodeSpans 必須是布林值，改用 true')
  }

  const keepModelWarm = config.keepModelWarm === undefined ? true : config.keepModelWarm
  if (typeof keepModelWarm !== 'boolean') {
    warn('[dsh-stt-hant] keepModelWarm 必須是布林值，改用 true')
  }

  return {
    variant,
    glossary,
    protectCodeSpans: typeof protectCodeSpans === 'boolean' ? protectCodeSpans : true,
    keepModelWarm: typeof keepModelWarm === 'boolean' ? keepModelWarm : true,
  }
}

/** Write one JSON response with no caching. */
function sendJson(res, code, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}

/** Write raw bytes with the given content type. */
function sendBytes(res, code, bytes, contentType) {
  res.writeHead(code, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
  })
  res.end(bytes)
}

/** Read a small JSON request body; larger bodies are refused. */
function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Wrap one route handler with the plugin's own fence and an error boundary, so a
 * throwing bridge call answers with JSON instead of dropping the socket.
 * @param warn - diagnostics sink.
 * @param handler - the route body.
 * @returns a node:http handler.
 */
function guarded(warn, handler) {
  return async (req, res) => {
    const rejection = selfRejection(req)
    if (rejection !== null) {
      sendJson(res, rejection, { error: 'forbidden' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`[dsh-stt-hant] 遙控器麥克風路由失敗：${message}`)
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    }
  }
}

/**
 * Register the remote-mic routes against the host web server.
 * @param scope - context with `webServer` injected.
 * @param bridge - the capture-helper manager.
 * @param warn - diagnostics sink.
 */
export function registerRemoteMicRoutes(scope, bridge, warn, model, recognize, trace = () => {}) {
  const route = (kind, path, handler) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({ kind, path, handler: guarded(warn, handler) })
      return () => {
        try {
          dispose()
        } catch { /* already disposed during unload */ }
      }
    }, `dsh-stt-hant: route ${path}`)
  }

  // Server-sent events: the panel and composer get each state change (including
  // a finished utterance) immediately instead of waiting for the next poll.
  route('exact', `${REMOTE_MIC_PREFIX}/events`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const push = () => {
      try {
        const snapshot = bridge.status()
        res.write(`data: ${JSON.stringify({ ...snapshot, model: model.status(), hostVersion: HOST_VERSION })}\n\n`)
        trace({ event: 'sse-push', phase: snapshot.phase, utterance: snapshot.utterances?.at(-1)?.id ?? null })
      } catch { /* client went away */ }
    }
    trace({ event: 'sse-connect' })
    push()
    const unsubscribe = typeof bridge.subscribe === 'function' ? bridge.subscribe(push) : () => {}
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* client went away */ }
    }, 15_000)
    keepAlive.unref?.()
    // A GET request's own stream is already complete when the handler runs, so
    // `req.on('close')` fires within a millisecond of the handler starting. If
    // the stream were tied to it, the response would be closed before the first
    // state change and the client would only ever see the frame written on
    // connect — the classic "sometimes it reacts, sometimes it waits" symptom.
    // Only the response tells us when the reader actually goes away.
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(keepAlive)
      unsubscribe()
      trace({ event: 'sse-close' })
    }
    res.on('close', cleanup)
    res.on('finish', cleanup)
    // The route framework closes a response when its handler resolves, so keep
    // the handler pending for the lifetime of the stream.
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      res.on('close', finish)
      res.on('finish', finish)
    })
  })

  route('exact', `${REMOTE_MIC_PREFIX}/status`, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    if (typeof bridge.ready === 'function') await bridge.ready()
    sendJson(res, 200, { ...bridge.status(), model: model.status(), hostVersion: HOST_VERSION })
  })

  // The client posts the utterance id right after the helper reports it; the
  // host reads the WAV, transcribes once and converts once, then answers. This
  // mirrors the built-in voice input's single round trip, just with the remote's
  // audio instead of the browser microphone.
  // Event delivery without sampling: the response stays pending until the
  // bridge state changes (or 15 s), so the client reacts to button/voice events
  // immediately, like an event listener rather than a timer.
  route('exact', `${REMOTE_MIC_PREFIX}/next`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    const since = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')) || 0
    const snapshot = () => ({ ...bridge.status(), model: model.status(), hostVersion: HOST_VERSION })
    if ((bridge.status().seq ?? 0) > since) {
      sendJson(res, 200, snapshot())
      return
    }
    const pollStart = Date.now()
    await new Promise((resolve) => {
      let done = false
      let timer = 0
      const unsubscribe = typeof bridge.subscribe === 'function' ? bridge.subscribe(() => {
        if (done || (bridge.status().seq ?? 0) <= since) return
        done = true
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }) : () => {}
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      timer = setTimeout(finish, 15_000)
      timer.unref?.()
      // Same trap as the event stream: a GET's request stream closes at once, so
      // only the response reports a real disconnect.
      res.on('close', finish)
      res.on('finish', finish)
    })
    trace({ event: 'next-poll', since, seq: bridge.status().seq ?? 0, waitedMs: Date.now() - pollStart })
    if (!res.writableEnded && !res.destroyed) sendJson(res, 200, snapshot())
  })

  route('exact', '/stt-hant/recognize', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!/^utt-\d{13}-\d{3}\.wav$/.test(id)) {
      sendJson(res, 400, { error: 'invalid utterance id' })
      return
    }
    const result = await recognize(id, {
      providerId: typeof body?.providerId === 'string' ? body.providerId : undefined,
      language: typeof body?.language === 'string' ? body.language : undefined,
    })
    sendJson(res, 200, result)
  })

  route('exact', '/stt-hant/model/prepare', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    model.prepare()
    sendJson(res, 200, { ...bridge.status(), model: model.status(), hostVersion: HOST_VERSION })
  })

  route('exact', `${REMOTE_MIC_PREFIX}/start`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    // Compiling the helper can take a few seconds; answer with the state the
    // panel should render while it happens, and surface failures through status.
    void bridge.start().catch((error) => warn(`[dsh-stt-hant] 啟動遙控器麥克風失敗：${error instanceof Error ? error.message : String(error)}`))
    sendJson(res, 200, bridge.status())
  })

  route('exact', `${REMOTE_MIC_PREFIX}/enabled`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const status = await bridge.setEnabled(body?.enabled !== false)
    if (status.enabled && status.binding) void bridge.start().catch(() => {})
    sendJson(res, 200, { ...status, model: model.status(), hostVersion: HOST_VERSION })
  })

  route('exact', `${REMOTE_MIC_PREFIX}/stop`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    sendJson(res, 200, bridge.stop())
  })

  route('exact', '/stt-hant/remote/devices', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    const devices = await bridge.listDevices()
    sendJson(res, 200, { devices })
  })

  route('exact', '/stt-hant/remote/bind', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const status = await bridge.bind(body)
    if (status.enabled && status.binding) void bridge.start().catch(() => {})
    sendJson(res, 200, status)
  })

  route('exact', '/stt-hant/remote/mapping', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    sendJson(res, 200, await bridge.setMapping(body?.mapping))
  })

  route('exact', '/stt-hant/remote/unbind', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    const status = await bridge.unbind()
    sendJson(res, 200, status)
  })

  route('prefix', `${REMOTE_MIC_PREFIX}/utterances`, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    req.resume()
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const raw = pathname.slice(`${REMOTE_MIC_PREFIX}/utterances/`.length)
    let id
    try {
      id = decodeURIComponent(raw)
    } catch {
      sendJson(res, 400, { error: 'bad id' })
      return
    }
    if (id === '' || id.includes('/')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    try {
      const bytes = await bridge.readUtterance(id)
      sendBytes(res, 200, bytes, 'audio/wav')
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
  })
}

/**
 * Accept one client-side timing report and append it to a JSONL file. Kept
 * separate from the bridge so a slow UI can never block recognition.
 * @param scope - context with `webServer` injected.
 * @param filePath - JSONL destination.
 * @param warn - diagnostics sink.
 */
export function registerClientTelemetryRoute(scope, filePath, warn) {
  scope.effect(() => {
    const dispose = scope.webServer.register({
      kind: 'exact',
      path: '/stt-hant/telemetry',
      handler: guarded(warn, async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req, 16 * 1024)
        void appendFile(filePath, `${JSON.stringify({ at: Date.now(), ...body })}\n`).catch(() => {})
        sendJson(res, 200, { ok: true })
      }),
    })
    return () => {
      try { dispose() } catch { /* already disposed */ }
    }
  }, 'dsh-stt-hant: client telemetry')
}

/**
 * Register the runtime conversion settings and the convert-on-demand route.
 * Recognition always produces plain text first; this is the separate step that
 * turns it into Traditional Chinese, and it can be changed without a restart.
 * @param scope - context with `webServer` injected.
 * @param settings - live conversion settings manager.
 * @param warn - diagnostics sink.
 */
export function registerConvertRoutes(scope, settings, warn) {
  const route = (path, handler) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({ kind: 'exact', path, handler: guarded(warn, handler) })
      return () => {
        try {
          dispose()
        } catch { /* already disposed during unload */ }
      }
    }, `dsh-stt-hant: route ${path}`)
  }

  route('/stt-hant/convert-settings', async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.resume()
      await settings.load()
      sendJson(res, 200, { settings: settings.snapshot() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    const next = await settings.update(body)
    sendJson(res, 200, { settings: next })
  })

  route('/stt-hant/convert', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    const text = typeof body?.text === 'string' ? body.text : ''
    await settings.load()
    sendJson(res, 200, { text: settings.convert(text) })
  })
}

/**
 * Register the provider for the lifetime of this plugin, plus the optional
 * remote-microphone routes when this composition has a web server.
 * @param ctx - plugin context with the speech service injected.
 * @param config - validated-or-not row config.
 */
export function apply(ctx, config) {
  const warn = createWarn(ctx)
  const settings = normalizeConfig(config, warn)
  // Row config supplies the defaults; the panel edits runtime overrides.
  const convertSettings = createConvertSettings({
    defaults: {
      enabled: true,
      variant: settings.variant,
      protectCodeSpans: settings.protectCodeSpans,
      glossary: settings.glossary,
    },
    warn,
  })
  void convertSettings.load()
  const provider = createHantProvider({
    speechToText: ctx.speechToText,
    convert: (text) => convertSettings.convert(text),
    warn,
  })
  ctx.effect(() => ctx.speechToText.register(provider), 'dsh-stt-hant: speech provider')

  // Keep the shipped local model loaded: after the provider's idle timeout it
  // drops to `standby`, and the next recording would pay the wake-up cost. A
  // periodic nudge re-loads it only when it is already downloaded (`standby`);
  // an unprepared provider is never downloaded behind the user's back.
  if (settings.keepModelWarm) {
    let lastWarning = 0
    const warmUpstream = () => {
      try {
        const snapshot = ctx.speechToText.snapshot()
        const upstream = snapshot.providers.find((entry) => entry.id === 'sensevoice-local')
        if (upstream?.preparation?.phase === 'standby') ctx.speechToText.prepare('sensevoice-local')
      } catch (error) {
        const now = Date.now()
        if (now - lastWarning > 60_000) {
          lastWarning = now
          warn(`[dsh-stt-hant] 預熱語音模型失敗：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    ctx.effect(() => {
      // Warm immediately, then every 2 s for the first half minute: a fresh
      // boot often lands while the provider is still inspecting its caches, so a
      // single check at activation would miss the `standby` phase.
      warmUpstream()
      let fastChecks = 0
      const fast = setInterval(() => {
        fastChecks += 1
        warmUpstream()
        if (fastChecks >= 15) clearInterval(fast)
      }, 2_000)
      const slow = setInterval(warmUpstream, 15_000)
      fast.unref?.()
      slow.unref?.()
      return () => {
        clearInterval(fast)
        clearInterval(slow)
      }
    }, 'dsh-stt-hant: keep speech model warm')
  }

  // Remote microphone: a plugin-owned native helper, no installed application.
  // The web server exists in the desktop and web compositions; without it the
  // speech provider still works and the console simply has no mic card.
  ctx.inject(['webServer'], (scope) => {
    const cacheDir = defaultCacheDir()
    const telemetryPath = join(cacheDir, 'telemetry.jsonl')
    const trace = (step, error) => {
      try {
        void appendFile(join(cacheDir, 'inject.log'), `${JSON.stringify({ at: new Date().toISOString(), step, error: error instanceof Error ? error.message : error ? String(error) : undefined })}\n`).catch(() => {})
      } catch { /* diagnostics are best effort */ }
    }
    trace('webServer injected')
    let bridge
    bridge = createRemoteMicBridge({
      log: (line) => warn(`[dsh-stt-hant] ${line}`),
      // Do not wait for the client to ask: the helper's release event starts
      // recognition here, so the text is ready before the UI even notices.
      onUtterance: async ({ id, at, path }) => {
        const voiceStopAt = typeof at === 'number' ? at : Date.now()
        try {
          const audio = await readFile(path)
          let language = 'auto'
          let providerId = 'sensevoice-local'
          try {
            const snapshot = ctx.speechToText.snapshot()
            language = snapshot?.selection?.language ?? language
            const selected = snapshot?.selection?.providerId
            if (typeof selected === 'string' && selected !== '') {
              providerId = selected === 'sensevoice-hant' ? 'sensevoice-local' : selected
            }
          } catch { /* keep defaults */ }
          let spec
          try {
            spec = ctx.speechToText.resolve({ audio, providerId, language })
          } catch {
            spec = ctx.speechToText.resolve({ audio, providerId: 'sensevoice-local', language })
          }
          const inferStarted = Date.now()
          const transcript = await ctx.speechToText.transcribe(spec, AbortSignal.timeout(120_000))
          const transcribeMs = Date.now() - inferStarted
          const convertStarted = Date.now()
          const converted = convertSettings.convert(transcript.text)
          const convertMs = Date.now() - convertStarted
          const payload = {
            id,
            text: converted,
            raw: transcript.text,
            audioSeconds: transcript.audioSeconds,
            inferenceSeconds: transcript.inferenceSeconds,
            timings: { voiceStopAt, transcribeMs, convertMs, totalMs: Date.now() - voiceStopAt },
          }
          bridge.setTranscript(payload)
          void appendFile(telemetryPath, `${JSON.stringify({ ...payload, at: Date.now() })}\n`).catch(() => {})
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          bridge.setTranscript({ id, error: message, timings: { voiceStopAt, totalMs: Date.now() - voiceStopAt } })
          warn(`[dsh-stt-hant] 遙控器語音辨識失敗：${message}`)
        }
      },
    })
    // One call for the client: read the spooled WAV, recognise once with the
    // selected DSH provider, convert once, answer with text and timings.
    const recognize = async (id, options = {}) => {
      const startedAt = Date.now()
      const audio = await readFile(join(cacheDir, 'utterances', id))
      let language = options.language ?? 'auto'
      let providerId = options.providerId ?? 'sensevoice-local'
      if (options.providerId === undefined) {
        try {
          const snapshot = ctx.speechToText.snapshot()
          language = snapshot?.selection?.language ?? language
          const selected = snapshot?.selection?.providerId
          if (typeof selected === 'string' && selected !== '') {
            providerId = selected === 'sensevoice-hant' ? 'sensevoice-local' : selected
          }
        } catch { /* keep defaults */ }
      }
      if (providerId === 'sensevoice-hant') providerId = 'sensevoice-local'
      let spec
      try {
        spec = ctx.speechToText.resolve({ audio, providerId, language })
      } catch {
        spec = ctx.speechToText.resolve({ audio, providerId: 'sensevoice-local', language })
      }
      const inferStarted = Date.now()
      const transcript = await ctx.speechToText.transcribe(spec, AbortSignal.timeout(120_000))
      const transcribeMs = Date.now() - inferStarted
      const convertStarted = Date.now()
      const converted = convertSettings.convert(transcript.text)
      const convertMs = Date.now() - convertStarted
      const payload = {
        id,
        text: converted,
        raw: transcript.text,
        audioSeconds: transcript.audioSeconds,
        inferenceSeconds: transcript.inferenceSeconds,
        timings: { transcribeMs, convertMs, totalMs: Date.now() - startedAt },
      }
      void appendFile(telemetryPath, `${JSON.stringify({ ...payload, at: Date.now() })}\n`).catch(() => {})
      return payload
    }

    // Long-running service: connect at host boot when a remote is bound and
    // the user left the microphone enabled, without needing the panel.
    void (async () => {
      try {
        await bridge.ready()
        const snapshot = bridge.status()
        if (snapshot.enabled && snapshot.binding) await bridge.start()
      } catch (error) {
        warn(`[dsh-stt-hant] 自動連接遙控器失敗：${error instanceof Error ? error.message : String(error)}`)
      }
    })()

    const model = {
      status() {
        try {
          const snapshot = ctx.speechToText.snapshot()
          const upstream = snapshot.providers.find((entry) => entry.id === 'sensevoice-local')
          return { provider: 'sensevoice-local', phase: upstream?.preparation?.phase ?? 'unknown' }
        } catch {
          return { provider: 'sensevoice-local', phase: 'unknown' }
        }
      },
      prepare() {
        try {
          if (this.status().phase === 'standby') ctx.speechToText.prepare('sensevoice-local')
        } catch { /* preparation is best effort */ }
      },
    }
    // Warm the recognizer as soon as the helper is ready, and right away on
    // activation, so the first hold-to-talk does not pay a cold start.
    model.prepare()
    const unsubscribeWarm = typeof bridge.subscribe === 'function'
      ? bridge.subscribe(() => { if (bridge.status().phase === 'ready') model.prepare() })
      : () => {}
    scope.effect(() => () => { unsubscribeWarm(); bridge.dispose() }, 'dsh-stt-hant: remote mic helper')
    // Belt and braces for a host that exits without unloading the plugin: the
    // helper holds the remote's BLE link, so it must not outlive the host. The
    // pid file covers the case where even this hook does not run.
    const stopHelperOnExit = () => { try { bridge.stop() } catch { /* already gone */ } }
    process.once('exit', stopHelperOnExit)
    scope.effect(() => () => { process.off('exit', stopHelperOnExit) }, 'dsh-stt-hant: helper exit hook')
    const sseTrace = (entry) => {
      void appendFile(join(cacheDir, 'sse.log'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`).catch(() => {})
    }
    // Phase history: makes a flapping helper obvious instead of a guess.
    let lastPhase = null
    if (typeof bridge.subscribe === 'function') {
      bridge.subscribe(() => {
        try {
          const snapshot = bridge.status()
          if (snapshot.phase === lastPhase) return
          lastPhase = snapshot.phase
          void appendFile(join(cacheDir, 'status.log'), `${JSON.stringify({
            at: Date.now(),
            phase: snapshot.phase,
            error: snapshot.error ?? null,
            log: (snapshot.lastLog ?? []).slice(-2),
          })}\n`).catch(() => {})
        } catch { /* diagnostics only */ }
      })
    }
    try {
      registerRemoteMicRoutes(scope, bridge, warn, model, recognize, sseTrace)
      trace('remote routes registered')
    } catch (error) {
      trace('remote routes failed', error)
      warn(`[dsh-stt-hant] 註冊遙控器路由失敗：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      registerConvertRoutes(scope, convertSettings, warn)
      registerClientTelemetryRoute(scope, join(cacheDir, 'telemetry-client.jsonl'), warn)
      trace('convert routes registered')
    } catch (error) {
      trace('convert routes failed', error)
      warn(`[dsh-stt-hant] 註冊轉換路由失敗：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
