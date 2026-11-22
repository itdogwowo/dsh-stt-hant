/**
 * Simplified → Traditional conversion with the pieces a coding assistant must not
 * mangle: code spans, URLs, and paths stay byte-identical.
 *
 * The conversion is purely lexical. It does not translate, and it cannot infer
 * that a Han character inside a string literal is code — that is why escapes are
 * limited to spans the author marked.
 */
import { Converter } from 'opencc-js'

/** Accepted `variant` values, matching the opencc-js target names we expose. */
export const VARIANTS = Object.freeze(['s2hk', 's2twp', 's2tw', 's2t'])

/** Variant → opencc-js target. */
const TARGET = Object.freeze({ s2hk: 'hk', s2twp: 'twp', s2tw: 'tw', s2t: 't' })

/** Variant used when the configured value is missing or unknown. */
export const DEFAULT_VARIANT = 's2hk'

/**
 * Pick a supported variant out of unvalidated configuration.
 * @param value - the raw `variant` from the plugin config.
 * @param warn - receives one message per invalid value instead of throwing.
 * @returns a supported variant, or the default.
 */
export function resolveVariant(value, warn = () => {}) {
  if (value === undefined) return DEFAULT_VARIANT
  if (typeof value === 'string' && VARIANTS.includes(value)) return value
  warn(`[dsh-stt-hant] 不認得的 variant ${JSON.stringify(value)}，改用 ${DEFAULT_VARIANT}`)
  return DEFAULT_VARIANT
}

/**
 * Regions copied through unchanged when `protectCodeSpans` is on.
 *
 * Alternation order matters: a fenced block wins over the inline span that would
 * otherwise match its opening backticks, and a URL wins over the path inside it.
 * Path matching requires ASCII on both sides of every slash, so Han text such as
 * `或/和` is never mistaken for a path.
 */
const PROTECTED = new RegExp([
  '```[\\s\\S]*?```',
  '~~~[\\s\\S]*?~~~',
  '`[^`\\n]*`',
  'https?://[^\\s<>"\'`）】。，、；]+',
  '(?:[A-Za-z]:\\\\[^\\s"\'<>|]+)',
  '(?:[A-Za-z0-9_.@~$+-]*/)+[A-Za-z0-9_.@~$+-]+',
].join('|'), 'g')

/** Whether a string has any Han character worth converting. */
const HAN = /\p{Script=Han}/u

/**
 * Compile the user glossary into one pass of longest-first alternatives.
 *
 * Keys may be written in either script: each key is converted with the same
 * converter before matching, so `{ "软件": "軟件" }` and `{ "軟體": "軟件" }` both
 * work under `s2twp`.
 * @param converter - the active converter.
 * @param glossary - post-conversion phrase overrides.
 * @returns a replacer, or undefined when the glossary is empty.
 */
function compileGlossary(converter, glossary) {
  const pairs = []
  for (const [rawKey, rawValue] of Object.entries(glossary)) {
    if (typeof rawKey !== 'string' || rawKey === '' || typeof rawValue !== 'string') continue
    pairs.push([converter(rawKey), rawValue])
  }
  if (pairs.length === 0) return undefined
  const longestFirst = pairs.slice().sort((a, b) => b[0].length - a[0].length)
  const value = new Map(longestFirst.map(([key, replacement]) => [key, replacement]))
  const pattern = new RegExp(longestFirst.map(([key]) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return (text) => text.replace(pattern, (matched) => value.get(matched) ?? matched)
}

/**
 * Build the text converter used by the provider.
 * @param options - conversion settings.
 * @param options.variant - opencc target variant; already validated by the caller.
 * @param options.glossary - post-conversion phrase overrides.
 * @param options.protectCodeSpans - keep code, URL and path spans verbatim.
 * @returns a pure string → string function.
 */
export function createConverter({ variant = DEFAULT_VARIANT, glossary = {}, protectCodeSpans = true } = {}) {
  const toOpencc = Converter({ from: 'cn', to: TARGET[variant] ?? TARGET[DEFAULT_VARIANT] })
  const gloss = compileGlossary(toOpencc, glossary)
  const convertPlain = (text) => {
    const converted = toOpencc(text)
    return gloss ? gloss(converted) : converted
  }
  return function convert(text) {
    if (typeof text !== 'string' || text === '') return text
    // Nothing Han in the text: conversion and glossary cannot apply.
    if (!HAN.test(text)) return text
    if (!protectCodeSpans) return convertPlain(text)
    let output = ''
    let cursor = 0
    for (const match of text.matchAll(PROTECTED)) {
      const start = match.index
      if (start > cursor) output += convertPlain(text.slice(cursor, start))
      output += match[0]
      cursor = start + match[0].length
    }
    if (cursor < text.length) output += convertPlain(text.slice(cursor))
    return output
  }
}
