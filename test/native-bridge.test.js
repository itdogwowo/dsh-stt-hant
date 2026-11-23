import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileProcess, spawn as spawnProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRemoteMicBridge,
  defaultBinaryName,
  defaultSourceFor,
  provisionHelper,
  supportFor,
} from '../lib/native-bridge.js'

const waitFor = async (predicate, timeoutMs = 6000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

/**
 * Fake helper: speaks the JSON contract, then idles until its stdin closes.
 * Returns the script path; the spawn/execFile wrappers below run it through the
 * current Node binary so the test works on Windows too (no shebang, no chmod).
 */
async function createFakeHelper(dir) {
  const script = join(dir, 'fake-helper.mjs')
  await writeFile(script, `
const args = process.argv.slice(2)
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (args.includes('--list')) {
  send({ event: 'device', name: 'Fake Remote', serial: 'SN1', vendorId: 10007, productId: 12984, model: 'RC003', supported: true })
  process.exit(0)
}
const out = args[args.indexOf('--out') + 1]
send({ event: 'state', state: 'bluetooth-ready' })
send({ event: 'ready', name: 'Fake Remote', model: 'RC003', peripheralId: 'TEST-ID' })
setTimeout(() => {
  send({ event: 'voice-start' })
  send({ event: 'voice-stop', path: out + '/utt-1700000000000-001.wav', seconds: 1.25, frames: 20000 })
}, 40)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`)
  return script
}

/** Run the fake helper script through the current Node binary. */
const nodeSpawn = (script) => (_helper, args, options) => spawnProcess(process.execPath, [script, ...args], options)

/** Same, for the one-shot `--list` call the bridge makes through execFile. */
const nodeExecFile = (script) => (_helper, args, options, callback) => execFileProcess(process.execPath, [script, ...args], options, callback)

test('platform support is explicit', () => {
  assert.equal(supportFor('darwin'), 'supported')
  assert.equal(supportFor('win32'), 'supported')
  assert.equal(supportFor('linux'), 'unsupported')
  assert.ok(defaultSourceFor('darwin').endsWith('atvv-capture.swift'))
  assert.ok(defaultSourceFor('win32').endsWith('atvv-capture.cs'))
  assert.equal(defaultSourceFor('linux'), null)
  assert.equal(defaultBinaryName('win32'), 'atvv-capture.exe')
  assert.equal(defaultBinaryName('darwin'), 'atvv-capture')
})

test('a deliberate platform without a backend refuses to start', async () => {
  const bridge = createRemoteMicBridge({ platform: 'linux', cacheDir: join(tmpdir(), 'dsh-stt-hant-nobackend') })
  await assert.rejects(bridge.start(), /不支援/)
  assert.equal(bridge.status().phase, 'error')
  bridge.dispose()
})

test('starting without a manual binding is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-unbound-'))
  const helper = await createFakeHelper(dir)
  const bridge = createRemoteMicBridge({ platform: 'darwin', cacheDir: dir, provision: async () => helper })
  try {
    await assert.rejects(bridge.start(), /尚未綁定/)
    bridge.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the manager spawns the helper, follows its events, and spools utterances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-bridge-'))
  const helper = await createFakeHelper(dir)
  const spoolDir = join(dir, 'utterances')
  await mkdir(spoolDir, { recursive: true })
  const wav = Buffer.from('RIFF....WAVEfmt fake')
  await writeFile(join(spoolDir, 'utt-1700000000000-001.wav'), wav)
  const hooked = []
  let bridge
  bridge = createRemoteMicBridge({
    platform: 'darwin',
    cacheDir: dir,
    spoolDir,
    provision: async () => helper,
    spawn: nodeSpawn(helper),
    execFile: nodeExecFile(helper),
    onUtterance: async ({ id }) => {
      hooked.push(id)
      bridge.setTranscript({ id, text: '轉換後', raw: '转换后', timings: { totalMs: 42 } })
    },
  })
  try {
    const devices = await bridge.listDevices()
    assert.deepEqual(devices, [{
      name: 'Fake Remote',
      serial: 'SN1',
      vendorId: 10007,
      productId: 12984,
      model: 'RC003',
      supported: true,
    }])
    await assert.rejects(bridge.bind({ vendorId: 1, productId: 2 }), /只支援/)
    const bound = await bridge.bind({ ...devices[0] })
    assert.equal(bound.binding.name, 'Fake Remote')
    const started = await bridge.start()
    assert.equal(started.support, 'supported')
    assert.ok(['provisioning', 'starting', 'ready'].includes(started.phase))

    await waitFor(() => bridge.status().phase === 'ready' && bridge.status().utterances.length === 1)
    const status = bridge.status()
    assert.equal(status.device, 'Fake Remote')
    assert.equal(status.model, 'RC003')
    assert.equal(status.peripheralId, 'TEST-ID')
    assert.deepEqual(status.utterances[0], {
      id: 'utt-1700000000000-001.wav',
      seconds: 1.25,
      frames: 20000,
      at: status.utterances[0].at,
    })

    await waitFor(() => hooked.length === 1)
    assert.deepEqual(hooked, ['utt-1700000000000-001.wav'])
    assert.equal(bridge.status().transcript.text, '轉換後')
    assert.equal(bridge.status().transcript.timings.totalMs, 42)

    const bytes = await bridge.readUtterance('utt-1700000000000-001.wav')
    assert.deepEqual(bytes, wav)
    await assert.rejects(bridge.readUtterance('../secret'), /invalid/)
    await assert.rejects(bridge.readUtterance('utt-1.wav'), /invalid/)

    bridge.stop()
    await waitFor(() => bridge.status().phase === 'idle')
  } finally {
    bridge.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sandboxed helper can hand the WAV back inline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-inline-'))
  const script = join(dir, 'inline-helper.mjs')
  const wav = Buffer.from('RIFFinlineWAVEfmt fake')
  await writeFile(script, `
const args = process.argv.slice(2)
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (args.includes('--list')) {
  send({ event: 'device', name: 'Fake Remote', serial: 'SN1', vendorId: 10007, productId: 12984, model: 'RC003', supported: true })
  process.exit(0)
}
send({ event: 'state', state: 'bluetooth-ready' })
send({ event: 'ready', name: 'Fake Remote', model: 'RC003', peripheralId: 'TEST-ID' })
setTimeout(() => {
  send({ event: 'voice-start' })
  // No "path": the sandbox refused the write, so the helper sends the bytes.
  send({ event: 'voice-stop', name: 'utt-1700000000000-002.wav', seconds: 0.5, frames: 8000, wav: '${wav.toString('base64')}' })
}, 40)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`)
  const spoolDir = join(dir, 'utterances')
  const bridge = createRemoteMicBridge({
    platform: 'darwin',
    cacheDir: dir,
    spoolDir,
    provision: async () => script,
    spawn: nodeSpawn(script),
    execFile: nodeExecFile(script),
  })
  try {
    const devices = await bridge.listDevices()
    await bridge.bind({ ...devices[0] })
    await bridge.start()
    await waitFor(() => bridge.status().utterances.length === 1)
    assert.equal(bridge.status().utterances[0].id, 'utt-1700000000000-002.wav')
    const bytes = await bridge.readUtterance('utt-1700000000000-002.wav')
    assert.deepEqual(bytes, wav)
  } finally {
    bridge.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Windows provisioning compiles the C# helper with csc', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-win-'))
  const sourcePath = join(dir, 'atvv-capture.cs')
  await writeFile(sourcePath, '// fake helper source\n')
  const cscPath = join(dir, 'csc.exe')
  const winmdPath = join(dir, 'Windows.winmd')
  await writeFile(cscPath, 'fake csc')
  await writeFile(winmdPath, 'fake winmd')
  const calls = []
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const out = args.find((arg) => arg.startsWith('/out:'))
    void writeFile(out.slice('/out:'.length), 'MZ fake').then(() => callback(null, '', ''))
  }
  const options = { platform: 'win32', sourcePath, cacheDir: join(dir, 'cache'), execFile, clock: () => 1, cscPath, winmdPath }
  try {
    const bin = await provisionHelper(options)
    assert.ok(bin.endsWith('atvv-capture.exe'), bin)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, cscPath)
    assert.ok(calls[0].args.includes('/target:exe'))
    assert.ok(calls[0].args.includes('/codepage:65001'))
    assert.ok(calls[0].args.includes(`/r:${winmdPath}`))
    assert.ok(calls[0].args.includes(sourcePath))
    assert.ok(calls[0].args.some((arg) => arg.endsWith('System.Runtime.InteropServices.WindowsRuntime.dll')))
    // A second call reuses the cache slot instead of compiling again.
    const again = await provisionHelper(options)
    assert.equal(again, bin)
    assert.equal(calls.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a prebuilt Windows helper wins over compiling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-prebuilt-'))
  const sourcePath = join(dir, 'atvv-capture.cs')
  const prebuilt = join(dir, 'atvv-capture.exe')
  await writeFile(sourcePath, '// fake helper source\n')
  await writeFile(prebuilt, 'MZ prebuilt')
  let compiled = false
  const execFile = (_file, _args, _options, callback) => {
    compiled = true
    callback(new Error('should not compile'))
  }
  try {
    const bin = await provisionHelper({ platform: 'win32', sourcePath, cacheDir: join(dir, 'cache'), execFile, clock: () => 1 })
    assert.equal(bin, prebuilt)
    assert.equal(compiled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Windows backend spawns the compiled helper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stt-hant-win-spawn-'))
  const helper = await createFakeHelper(dir)
  const bridge = createRemoteMicBridge({
    platform: 'win32',
    cacheDir: dir,
    spoolDir: join(dir, 'utterances'),
    provision: async () => helper,
    spawn: nodeSpawn(helper),
    execFile: nodeExecFile(helper),
  })
  try {
    await bridge.bind({ serial: 'SN1', vendorId: 10007, productId: 12984 })
    const started = await bridge.start()
    assert.equal(started.support, 'supported')
    assert.equal(started.platform, 'win32')
    await waitFor(() => bridge.status().phase === 'ready')
    bridge.stop()
    await waitFor(() => bridge.status().phase === 'idle')
  } finally {
    bridge.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
