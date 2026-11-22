/**
 * Runtime conversion settings: recognition happens first, then this module maps
 * the finished text from Simplified to Traditional. The defaults come from the
 * plugin's row config, while the panel can edit them at runtime — the settings
 * are stored next to the other plugin state and rebuilt into a converter on
 * every change, so both the panel and the `sensevoice-hant` provider see them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createConverter, resolveVariant } from './hant.js'

/** Variants the UI may switch between. */
export const CONVERT_VARIANTS = Object.freeze(['s2hk', 's2twp', 's2tw', 's2t'])

/**
 * Validate one conversion settings object, falling back per field.
 * @param raw - stored or posted settings.
 * @param fallback - current settings used for invalid/missing fields.
 * @param warn - receives one message per dropped value.
 * @returns validated settings.
 */
export function normalizeConvertSettings(raw, fallback, warn = () => {}) {
  const base = { ...fallback, glossary: { ...fallback.glossary } }
  if (raw === undefined || raw === null) return base
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('[dsh-stt-hant] 轉換設定必須是物件，已忽略')
    return base
  }
  const enabled = raw.enabled === undefined ? base.enabled : raw.enabled
  if (typeof enabled !== 'boolean') warn('[dsh-stt-hant] convert.enabled 必須是布林值，已忽略')

  let variant = base.variant
  if (raw.variant !== undefined) {
    if (typeof raw.variant === 'string') variant = resolveVariant(raw.variant, warn)
    else warn('[dsh-stt-hant] convert.variant 必須是字串，已忽略')
  }

  const protectCodeSpans = raw.protectCodeSpans === undefined ? base.protectCodeSpans : raw.protectCodeSpans
  if (typeof protectCodeSpans !== 'boolean') warn('[dsh-stt-hant] convert.protectCodeSpans 必須是布林值，已忽略')

  const glossary = {}
  if (raw.glossary !== undefined && raw.glossary !== null) {
    if (typeof raw.glossary !== 'object' || Array.isArray(raw.glossary)) {
      warn('[dsh-stt-hant] convert.glossary 必須是 { 詞: 譯法 } 物件，已忽略')
      Object.assign(glossary, base.glossary)
    } else {
      for (const [key, value] of Object.entries(raw.glossary)) {
        if (typeof value === 'string' && key !== '') glossary[key] = value
        else warn(`[dsh-stt-hant] convert.glossary 的 ${JSON.stringify(key)} 不是字串，已忽略`)
      }
    }
  } else {
    Object.assign(glossary, base.glossary)
  }

  return {
    enabled: typeof enabled === 'boolean' ? enabled : base.enabled,
    variant,
    protectCodeSpans: typeof protectCodeSpans === 'boolean' ? protectCodeSpans : base.protectCodeSpans,
    glossary,
  }
}

/**
 * Own one live converter and its persisted overrides.
 * @param options - defaults, storage and diagnostics.
 * @returns manager with load/snapshot/update/convert.
 */
export function createConvertSettings(options = {}) {
  const warn = options.warn ?? (() => {})
  const cacheDir = options.cacheDir ?? join(homedir(), '.dsh', 'cache', 'dsh-stt-hant')
  const settingsPath = options.settingsPath ?? join(cacheDir, 'convert.json')
  const defaults = normalizeConvertSettings(options.defaults ?? {}, {
    enabled: true,
    variant: 's2hk',
    protectCodeSpans: true,
    glossary: {},
  }, warn)

  let current = defaults
  let converter = buildConverter(current)
  let loading = null

  function buildConverter(settings) {
    if (!settings.enabled) return (text) => text
    try {
      return createConverter(settings)
    } catch (error) {
      warn(`[dsh-stt-hant] 建立轉換器失敗：${error instanceof Error ? error.message : String(error)}`)
      return (text) => text
    }
  }

  /** Load persisted overrides once; defaults stay in effect until then. */
  const load = async () => {
    if (loading !== null) return await loading
    loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
        current = normalizeConvertSettings(parsed, current, warn)
        converter = buildConverter(current)
      } catch { /* first run: keep the defaults */ }
    })()
    await loading
  }

  /** Current validated settings, safe to serialize. */
  const snapshot = () => ({
    ...current,
    glossary: { ...current.glossary },
  })

  /** Merge and persist one partial update, then rebuild the converter. */
  const update = async (patch) => {
    const next = normalizeConvertSettings(patch, current, warn)
    current = next
    converter = buildConverter(current)
    try {
      await mkdir(dirname(settingsPath), { recursive: true })
      await writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    } catch (error) {
      warn(`[dsh-stt-hant] 無法儲存轉換設定：${error instanceof Error ? error.message : String(error)}`)
    }
    return snapshot()
  }

  /** Convert one finished transcript, identity when conversion is disabled. */
  const convert = (text) => (typeof text === 'string' && text !== '' ? converter(text) : text ?? '')

  return { load, snapshot, update, convert }
}
