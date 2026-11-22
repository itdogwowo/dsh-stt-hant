import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('..', import.meta.url)
const source = readFileSync(new URL('client.js', ROOT), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))

/**
 * Run the browser bundle enough to reach its factory: the file only touches
 * `window.__ModuleLoader__.load`, so a bare sandbox with that hook is enough.
 * @returns the module record the loader received.
 */
function loadRecord() {
  let record
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { record = value } } },
    console,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(record, 'the bundle calls window.__ModuleLoader__.load')
  return record
}

/** React stand-in: the factory only destructures hooks, but PanelBoundary extends Component. */
function createReact() {
  const noop = () => undefined
  return {
    createElement: () => null,
    Component: class Component { constructor(props) { this.props = props } },
    useCallback: (fn) => fn,
    useEffect: noop,
    useRef: () => ({ current: undefined }),
    useState: (value) => [typeof value === 'function' ? value() : value, noop],
    useMemo: (fn) => fn(),
  }
}

/** Fake Client context that records every registration instead of mounting it. */
function createContext(speech) {
  const state = { locale: 'zh', dictionaries: {}, slots: [], injected: [], speech }
  const effect = (fn) => (typeof fn === 'function' ? fn() : undefined)
  const ctx = {
    effect,
    inject(deps, callback) {
      state.injected.push(deps)
      const scope = { remote: { speech: state.speech }, effect }
      return callback(scope) ?? (() => undefined)
    },
    locale: {
      register(namespace, dicts) { state.dictionaries[namespace] = dicts; return () => undefined },
      bind(namespace) {
        return (key, params) => {
          const dict = state.dictionaries[namespace]?.[state.locale] ?? {}
          let text = dict[key] ?? key
          if (params) text = text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
          return text
        }
      },
    },
    remote: {},
    slots: {
      inject(owner, callback) {
        state.slots.push({ owner })
        const result = callback()
        return typeof result === 'function' ? result : () => undefined
      },
      register(entry, component) {
        state.slots.push({ entry, component })
        return () => undefined
      },
    },
  }
  return { ctx, state }
}

test('the bundle declares the package name the loader registers', () => {
  const record = loadRecord()
  assert.equal(record.id, manifest.name)
})

test('activate registers the dictionaries, the speech namespace, and both slots', () => {
  const record = loadRecord()
  const plugin = record.factory((name) => {
    if (name === 'react') return createReact()
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual(Array.from(plugin.inject), ['remote', 'slots', 'locale'])

  const { ctx, state } = createContext({ marker: true })
  plugin.apply(ctx)

  // Dictionaries: one namespace, both locales, identical key sets.
  const dicts = state.dictionaries['stt-hant']
  assert.ok(dicts, 'registers the stt-hant locale namespace')
  assert.deepEqual([...Object.keys(dicts)].sort(), ['en', 'zh'])
  const zhKeys = Object.keys(dicts.zh)
  const enKeys = Object.keys(dicts.en)
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh and en expose the same keys')
  for (const key of zhKeys) {
    assert.equal(typeof dicts.zh[key], 'string')
    assert.notEqual(dicts.zh[key], '', `zh.${key} is not empty`)
    assert.equal(typeof dicts.en[key], 'string')
    assert.notEqual(dicts.en[key], '', `en.${key} is not empty`)
  }

  // Optional services are injected contextually: the speech Remote namespace and
  // the layout service used to open the console from the composer control.
  const injected = JSON.parse(JSON.stringify(state.injected))
  assert.ok(injected.some((deps) => deps.length === 1 && deps[0] === 'remote.speech'), 'injects remote.speech')
  assert.ok(injected.some((deps) => deps.length === 1 && deps[0] === 'layout'), 'injects layout')

  const sidebar = state.slots.find((row) => row.entry?.name === 'sidebar.panellist')
  assert.ok(sidebar, 'registers the sidebar entry')
  assert.equal(sidebar.entry.id, 'stt-hant')
  assert.equal(sidebar.entry.locale, 'stt-hant')
  assert.equal(sidebar.entry.order, 40)
  assert.equal(typeof sidebar.entry.label, 'function')
  assert.equal(sidebar.entry.label(), '語音輸入')

  state.locale = 'en'
  assert.equal(sidebar.entry.label(), 'Traditional Chinese voice', 'label follows the active locale')

  const panel = state.slots.find((row) => row.entry?.name === 'main')
  assert.ok(panel, 'registers the main panel')
  assert.equal(panel.entry.key, 'stt-hant')
  assert.equal(panel.entry.locale, 'stt-hant')
  assert.equal(typeof panel.component, 'function')

  const composer = state.slots.find((row) => row.entry?.name === 'conversation.input.left')
  assert.ok(composer, 'registers the composer control')
  assert.equal(composer.entry.id, 'stt-hant-remote-voice')
  assert.equal(composer.entry.locale, 'stt-hant')
  assert.equal(typeof composer.component, 'function')
})

test('every static dictionary lookup in the bundle has a zh entry', () => {
  const record = loadRecord()
  const plugin = record.factory((name) => {
    if (name === 'react') return createReact()
    throw new Error(`unexpected require: ${name}`)
  })
  const { ctx, state } = createContext(undefined)
  plugin.apply(ctx)
  const zh = state.dictionaries['stt-hant'].zh

  const keys = new Set()
  for (const match of source.matchAll(/(?<![\w$.])(?:say|t)\(\s*'([^']+)'/g)) keys.add(match[1])
  assert.ok(keys.size > 40, `found ${keys.size} static lookups`)
  for (const key of keys) assert.ok(key in zh, `missing zh.${key}`)

  // Dynamic families are built from template literals; the fixed vocabularies must exist.
  for (const phase of ['ready', 'standby', 'waking', 'unprepared', 'downloading', 'checking', 'loading', 'cancelling', 'cancelled', 'failed']) {
    assert.ok(`phase.${phase}` in zh, `missing phase.${phase}`)
  }
  for (const step of ['check', 'model', 'vad', 'verify', 'load']) assert.ok(`step.${step}` in zh, `missing step.${step}`)
  for (const language of ['auto', 'zh', 'yue', 'en', 'ja', 'ko']) assert.ok(`language.${language}` in zh, `missing language.${language}`)
  for (const kind of ['permission', 'unavailable', 'empty', 'cancelled', 'interrupted', 'deviceMissing']) {
    assert.ok(`error.${kind}` in zh, `missing error.${kind}`)
  }
})

test('the bundle leaves no debug globals behind', () => {
  assert.doesNotMatch(source, /__sttProbe|__sttCall|window\.__stt/)
  assert.doesNotMatch(source, /console\.log\(/)
})

test('disposers returned by the registration effects are callable', () => {
  const record = loadRecord()
  const plugin = record.factory((name) => {
    if (name === 'react') return createReact()
    throw new Error(`unexpected require: ${name}`)
  })
  const { ctx } = createContext({ marker: true })
  const disposers = []
  const originalEffect = ctx.effect
  ctx.effect = (fn) => {
    const dispose = originalEffect(fn)
    disposers.push(dispose)
    return dispose
  }
  plugin.apply(ctx)
  for (const dispose of disposers.reverse()) {
    if (typeof dispose === 'function') assert.doesNotThrow(() => dispose())
  }
})

test('every stt- class the components use is defined in the stylesheet', () => {
  const cssMatch = source.match(/const CSS = `([\s\S]*?)`\n/)
  assert.ok(cssMatch, 'the bundle carries a stylesheet')
  const css = cssMatch[1]
  const defined = new Set()
  for (const match of css.matchAll(/\.(stt-[a-z0-9-]+)/g)) defined.add(match[1])

  const used = new Set()
  for (const match of source.matchAll(/className: '([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('stt-')) used.add(name)
  }
  assert.ok(used.size > 20, `found ${used.size} styled classes in use`)
  for (const name of used) assert.ok(defined.has(name), `class ${name} is used but not styled`)
})
