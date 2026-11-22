import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteMicBridge, supportFor } from '../lib/native-bridge.js'

const waitFor = async (predicate, timeoutMs = 6000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

/** Fake helper: speaks the JSON contract, then idles until its stdin closes. */
async function createFakeHelper(dir) {
  const path = join(dir, 'fake-helper.mjs')
  await writeFile(path, `#!${process.execPath}
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
  await chmod(path, 0o755)
  return path
}

test('platform support is explicit', () => {
  assert.equal(supportFor('darwin'), 'supported')
  assert.equal(supportFor('win32'), 'planned')
  assert.equal(supportFor('linux'), 'unsupported')
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
