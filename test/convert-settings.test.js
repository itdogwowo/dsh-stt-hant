import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConvertSettings, normalizeConvertSettings } from '../lib/convert-settings.js'

test('recognition text is converted after the fact and can be switched off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-convert-'))
  try {
    const settings = createConvertSettings({ cacheDir: dir, defaults: { variant: 's2hk' } })
    await settings.load()
    assert.equal(settings.snapshot().enabled, true)
    assert.equal(settings.convert('软件和打印机'), '軟件和打印機')

    const taiwan = await settings.update({ variant: 's2twp' })
    assert.equal(taiwan.variant, 's2twp')
    assert.equal(settings.convert('软件和打印机'), '軟體和印表機')

    await settings.update({ enabled: false })
    assert.equal(settings.convert('软件和打印机'), '软件和打印机')

    // Persisted overrides survive a fresh manager.
    const reopened = createConvertSettings({ cacheDir: dir, defaults: { variant: 's2hk' } })
    await reopened.load()
    const snapshot = reopened.snapshot()
    assert.equal(snapshot.enabled, false)
    assert.equal(snapshot.variant, 's2twp')
    assert.match(await readFile(join(dir, 'convert.json'), 'utf8'), /"enabled": false/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glossary is applied after conversion and validated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-glossary-'))
  try {
    const settings = createConvertSettings({ cacheDir: dir, defaults: { variant: 's2twp' } })
    await settings.load()
    await settings.update({ glossary: { 記憶體: '內存', bad: 7 } })
    assert.deepEqual(settings.snapshot().glossary, { 記憶體: '內存' })
    assert.equal(settings.convert('内存'), '內存')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid values fall back instead of throwing', () => {
  const fallback = { enabled: true, variant: 's2hk', protectCodeSpans: true, glossary: {} }
  const warnings = []
  const normalized = normalizeConvertSettings({
    enabled: 'yes',
    variant: 'nope',
    protectCodeSpans: 1,
    glossary: { 软件: '軟件' },
  }, fallback, (message) => warnings.push(message))
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.variant, 's2hk')
  assert.equal(normalized.protectCodeSpans, true)
  assert.deepEqual(normalized.glossary, { 软件: '軟件' })
  assert.equal(warnings.length, 3)
})
