/**
 * The recognizer this bundle contributes: the shipped local SenseVoice model,
 * plus the Simplified → Traditional step.
 *
 * Everything about audio stays with the upstream provider: this one forwards the
 * canonical WAV untouched and only rewrites the finished transcript.
 */

/** Upstream provider this one delegates to. */
export const UPSTREAM_ID = 'sensevoice-local'

/** Provider id registered by this bundle. */
export const PROVIDER_ID = 'sensevoice-hant'

/** Shown by the speech UI as the provider name. */
export const PROVIDER_NAME = 'SenseVoice（繁體）'

/** Used until the upstream provider reports its own list. */
export const FALLBACK_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'yue', 'ja', 'ko'])

const MISSING_HINT = `[dsh-stt-hant] 找不到 ${UPSTREAM_ID}，請先啟用語音輸入 bundle`

/** Structural equality for preparation snapshots; each snapshot is a fresh small object. */
function samePreparation(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

/** Element-wise equality for the upstream language list. */
function sameLanguages(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Add our hint to an upstream "unavailable" rejection, leaving every other
 * failure untouched.
 * @param error - whatever the speech service threw.
 * @returns an error whose message explains the missing dependency.
 */
function explain(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes(`Speech provider is unavailable: ${UPSTREAM_ID}`)) return error
  const wrapped = new Error(`${MISSING_HINT}（${message}）`, { cause: error })
  wrapped.name = 'SpeechProviderUnavailableError'
  return wrapped
}

/**
 * Build the `sensevoice-hant` provider over the speech service.
 *
 * Readiness is mirrored, not queried: `speechToText.snapshot()` asks every
 * provider — including this one — for its preparation state, so calling
 * `snapshot()` from here would recurse forever. A background `follow` loop keeps
 * a cached copy instead.
 * @param options - wiring and behavior.
 * @param options.speechToText - the registered speech service (`ctx.speechToText`).
 * @param options.convert - transcript text converter.
 * @param options.warn - receives non-fatal diagnostics.
 * @returns a provider accepted by `speechToText.register`.
 */
export function createHantProvider({ speechToText, convert, warn = () => {} }) {
  /** Last observed upstream readiness; a plain value, safe to serialize. */
  let preparation = Object.freeze({ phase: 'unprepared' })
  /** Last observed upstream language list, so a late upstream still informs the UI. */
  let languages = FALLBACK_LANGUAGES
  const listeners = new Set()
  let controller

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { warn(`[dsh-stt-hant] preparation listener 失敗：${error?.message ?? error}`) }
    }
  }

  const observe = () => {
    if (controller) return
    controller = new AbortController()
    const { signal } = controller
    void (async () => {
      try {
        for await (const snapshot of speechToText.follow(signal)) {
          if (signal.aborted) break
          const upstream = snapshot.providers.find((provider) => provider.id === UPSTREAM_ID)
          let changed = false
          if (upstream) {
            const nextPreparation = upstream.preparation ?? { phase: 'ready' }
            if (!samePreparation(preparation, nextPreparation)) {
              preparation = nextPreparation
              changed = true
            }
            if (Array.isArray(upstream.languages) && upstream.languages.length > 0 && !sameLanguages(languages, upstream.languages)) {
              languages = [...upstream.languages]
              changed = true
            }
          }
          // Only wake listeners on a real change: follow() re-yields after every
          // change, and our listener calls speechToText.changed(), so notifying on
          // every snapshot feeds the loop forever and blocks profile boot.
          if (changed) notify()
        }
      } catch (error) {
        if (!signal.aborted) warn(`[dsh-stt-hant] 追蹤 preparation 失敗：${error?.message ?? error}`)
      }
    })()
  }

  const preparationFace = {
    snapshot() {
      return preparation
    },
    subscribe(listener) {
      listeners.add(listener)
      observe()
      return () => { listeners.delete(listener) }
    },
    prepare(options) {
      speechToText.prepare(UPSTREAM_ID, options)
    },
    cancel() {
      return speechToText.cancelPreparation(UPSTREAM_ID)
    },
  }

  return {
    info: {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      location: 'host-local',
      get languages() {
        return languages
      },
    },
    preparation: preparationFace,
    async transcribe(input, signal) {
      let spec
      try {
        spec = speechToText.resolve({
          audio: input.audio,
          providerId: UPSTREAM_ID,
          language: input.language,
        })
      } catch (error) {
        throw explain(error)
      }
      let transcript
      try {
        transcript = await speechToText.transcribe(spec, signal)
      } catch (error) {
        throw explain(error)
      }
      return { ...transcript, text: convert(transcript.text) }
    },
  }
}
