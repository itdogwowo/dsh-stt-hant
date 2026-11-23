/**
 * Host-side manager for the ATVV capture helper.
 *
 * The helper is a native program the plugin ships as source: Swift on macOS,
 * C# on Windows. It is never installed as an application: on first use this
 * module compiles it with the system toolchain into a plugin-owned cache
 * directory, keyed by the source hash, then spawns it as a child of the DSH
 * host. Everything the helper says arrives as JSON lines on stdout; one WAV per
 * hold-to-talk utterance lands in the spool directory and is read back by the
 * panel through the host routes.
 *
 * Lifecycle is tied to the plugin: `start()` is lazy, `dispose()` stops the
 * child, and no launch agent, login item, or daemon is created.
 *
 * A prebuilt binary wins over compiling: point DSH_STT_HANT_HELPER at an
 * executable, or drop `atvv-capture.exe` next to the Windows source. That is
 * the escape hatch for machines whose endpoint protection blocks compiling a
 * helper at runtime (see docs/PITFALLS.md).
 */
import { spawn as spawnProcess, execFile as execFileProcess } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How much of this platform the plugin can support today. */
export const PLATFORM_SUPPORT = Object.freeze({
  darwin: 'supported',
  win32: 'supported',
})

/** What each platform compiles: source file and the binary name it produces. */
const HELPER = Object.freeze({
  darwin: { source: '../native/atvv-capture.swift', binary: 'atvv-capture' },
  win32: { source: '../native/atvv-capture.cs', binary: 'atvv-capture.exe' },
})

/** The helper source shipped for one platform, or null when there is none. */
export function defaultSourceFor(platform) {
  const entry = HELPER[platform]
  return entry === undefined ? null : fileURLToPath(new URL(entry.source, import.meta.url))
}

/** The executable name the helper compiles to on one platform. */
export function defaultBinaryName(platform) {
  return HELPER[platform]?.binary ?? 'atvv-capture'
}

/** One utterance file name the helper writes; the id doubles as the route key. */
const UTTERANCE_ID = /^utt-\d{13}-\d{3}\.wav$/

/** Default plugin-owned cache location; nothing is written outside it. */
export function defaultCacheDir() {
  return join(homedir(), '.dsh', 'cache', 'dsh-stt-hant')
}

/** @returns 'supported' | 'planned' | 'unsupported' for one platform id. */
export function supportFor(platform) {
  return PLATFORM_SUPPORT[platform] ?? 'unsupported'
}

/** True when the path exists and is a non-empty file. */
async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * Find the Swift compiler once. macOS ships it with the Command Line Tools.
 * @param {typeof execFileProcess} execFile
 * @returns {Promise<string>}
 */
async function findSwiftc(execFile) {
  try {
    await stat('/usr/bin/swiftc')
    return '/usr/bin/swiftc'
  } catch { /* fall through to xcrun */ }
  return await new Promise((resolve, reject) => {
    execFile('xcrun', ['--find', 'swiftc'], { timeout: 20_000 }, (error, stdout) => {
      if (error) reject(new Error('找不到 Swift 編譯器：請安裝 Xcode Command Line Tools（xcode-select --install）。'))
      else resolve(String(stdout).trim())
    })
  })
}

/** The in-box C# compiler that ships with .NET Framework 4.x. */
async function findCsc() {
  const candidates = [
    process.env.FrameworkDir64 && join(process.env.FrameworkDir64, 'csc.exe'),
    process.env.WINDIR && join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    process.env.WINDIR && join(process.env.WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  throw new Error('找不到 C# 編譯器（csc.exe）：請確認這台電腦已安裝 .NET Framework 4.x。')
}

/**
 * The merged WinRT metadata the .NET Framework projection needs. It ships with
 * the Windows SDK (UnionMetadata\Windows.winmd), not with the base OS.
 */
async function findWinmd() {
  const roots = [
    process.env.WindowsSdkDir && join(process.env.WindowsSdkDir, 'UnionMetadata'),
    'C:\\Program Files (x86)\\Windows Kits\\10\\UnionMetadata',
    'C:\\Program Files\\Windows Kits\\10\\UnionMetadata',
  ].filter(Boolean)
  for (const root of roots) {
    const direct = join(root, 'Windows.winmd')
    if (await isFile(direct)) return direct
    let versions = []
    try {
      versions = (await readdir(root)).filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort().reverse()
    } catch { /* SDK not installed at this root */ }
    for (const version of versions) {
      const candidate = join(root, version, 'Windows.winmd')
      if (await isFile(candidate)) return candidate
    }
  }
  throw new Error(
    '找不到 Windows.winmd（Windows SDK 的 WinRT 中繼資料）：請安裝 Windows SDK，'
    + '或設定 DSH_STT_HANT_HELPER 指向你自己編譯好的 atvv-capture.exe。',
  )
}

/** Compile the Swift helper into a content-addressed cache slot. */
async function provisionDarwin({ sourcePath, cacheDir, execFile, clock }) {
  const source = await readFile(sourcePath, 'utf8')
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binDir = join(cacheDir, 'native', hash)
  const binPath = join(binDir, 'atvv-capture')
  if (await isFile(binPath)) return binPath

  await mkdir(binDir, { recursive: true })
  const swiftc = await findSwiftc(execFile)
  const tmp = `${binPath}.tmp-${process.pid}-${clock()}`
  await new Promise((resolve, reject) => {
    execFile(swiftc, ['-O', sourcePath, '-o', tmp], { timeout: 300_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Swift 編譯失敗：${String(stderr || error.message).split('\n').slice(0, 6).join(' ')}`))
      else resolve()
    })
  })
  await chmod(tmp, 0o755)
  await rename(tmp, binPath)
  return binPath
}

/**
 * Compile the C# helper with the in-box csc.exe against the WinRT metadata.
 * The source is UTF-8 without a BOM, so csc needs `/codepage:65001`; the
 * `/r:` set is what the .NET Framework WinRT projection needs to type-check.
 */
async function provisionWindows({ sourcePath, cacheDir, execFile, clock, cscPath, winmdPath }) {
  const prebuilt = process.env.DSH_STT_HANT_HELPER || join(dirname(sourcePath), 'atvv-capture.exe')
  if (await isFile(prebuilt)) return prebuilt

  const source = await readFile(sourcePath, 'utf8')
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const binDir = join(cacheDir, 'native', hash)
  const binPath = join(binDir, 'atvv-capture.exe')
  if (await isFile(binPath)) return binPath

  await mkdir(binDir, { recursive: true })
  const csc = cscPath ?? await findCsc()
  const winmd = winmdPath ?? await findWinmd()
  const framework = dirname(csc)
  const tmp = `${binPath}.tmp-${process.pid}-${clock()}`
  const args = [
    '/nologo',
    '/target:exe',
    '/codepage:65001',
    `/out:${tmp}`,
    `/r:${winmd}`,
    `/r:${join(framework, 'System.Runtime.dll')}`,
    `/r:${join(framework, 'System.Runtime.InteropServices.WindowsRuntime.dll')}`,
    `/r:${join(framework, 'System.Runtime.WindowsRuntime.dll')}`,
    sourcePath,
  ]
  await new Promise((resolve, reject) => {
    execFile(csc, args, { timeout: 300_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).split('\n').slice(0, 6).join(' ')
        reject(new Error(
          `C# 編譯失敗：${detail}`
          + '（若被端點防護攔截，請改用手動編譯的 atvv-capture.exe，見 docs/PITFALLS.md。）',
        ))
      } else resolve()
    })
  })
  await rename(tmp, binPath)
  return binPath
}

/**
 * Compile the helper into a content-addressed cache slot and return its path.
 * @param {object} options - platform, paths and injected process helpers.
 * @returns {Promise<string>} absolute path to an executable helper.
 */
export async function provisionHelper(options) {
  const { platform } = options
  if (platform === 'win32') return await provisionWindows(options)
  if (platform === 'darwin') return await provisionDarwin(options)
  throw new Error(`不支援的平台：${platform}`)
}

/**
 * Create one manager. Tests inject `platform`, `provision`, `spawn`, `clock`,
 * and `cacheDir`; production uses the real ones.
 * @param {object} [options]
 * @returns {object} manager with status/start/stop/readUtterance/dispose.
 */
export function createRemoteMicBridge(options = {}) {
  const platform = options.platform ?? process.platform
  const support = supportFor(platform)
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const spoolDir = options.spoolDir ?? join(cacheDir, 'utterances')
  const settingsPath = options.settingsPath ?? join(cacheDir, 'settings.json')
  const helperLockPath = options.helperLockPath ?? join(cacheDir, 'helper.pid')
  const sourcePath = options.sourcePath ?? defaultSourceFor(platform)
  const execFile = options.execFile ?? execFileProcess
  const spawnImpl = options.spawn ?? spawnProcess
  const clock = options.clock ?? Date.now
  const log = options.log ?? (() => {})
  const maxUtterances = options.maxUtterances ?? 10
  const onUtterance = options.onUtterance
  const provision = options.provision ?? (() => provisionHelper({ platform, sourcePath, cacheDir, execFile, clock }))

  const state = {
    platform,
    support,
    phase: 'idle', // idle | provisioning | starting | ready | recording | reconnecting | error
    device: null,
    model: null,
    peripheralId: null,
    error: null,
    utterances: [], // newest last: { id, seconds, frames, at }
    updatedAt: clock(),
    helper: null, // path, once provisioned
    binding: null, // { name, serial, vendorId, productId, model, boundAt, peripheralId }
    enabled: true, // remember the panel toggle so a restart auto-connects
    hid: null, // { ok, error } seize state
    keys: [], // recent { seq, usage, down, at }
    mapping: {}, // usage -> action
    transcript: null, // last host-transcribed utterance
    lastLog: [],
  }
  let child = null
  let buffer = ''
  let stopping = false
  let keySeq = 0
  const listeners = new Set()

  const touch = () => {
    state.seq = (state.seq ?? 0) + 1
    state.updatedAt = clock()
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a stream consumer must not break the bridge */ }
    }
  }

  /** Record one diagnostic line, keeping only a short tail for the panel. */
  const note = (line) => {
    const text = String(line).trim()
    if (text === '') return
    state.lastLog = [...state.lastLog, text].slice(-40)
    log(text)
  }

  /**
   * Remember which helper process this host owns.
   *
   * A helper whose host dies keeps the remote's BLE link until its stdin closes
   * or it is killed, and a leftover would fight the next helper for the same
   * remote. The pid file makes that leftover findable on the next launch. It
   * records the host pid as well, so a second DSH instance that is still alive
   * is never robbed of its helper.
   */
  const writeHelperLock = (pid) => {
    try {
      writeFileSync(helperLockPath, JSON.stringify({ pid, hostPid: process.pid, at: clock() }))
    } catch { /* the lock is best effort; a helper without it still works */ }
  }

  const clearHelperLock = () => {
    try { unlinkSync(helperLockPath) } catch { /* already gone */ }
  }

  const processAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  /**
   * Kill a helper left behind by a previous run. Called when the plugin loads
   * and before every spawn: if the recorded host is still alive another DSH
   * instance owns that helper, so it is left alone; if the host is gone the
   * helper is an orphan and is taken down before a new one starts.
   */
  const cleanupStaleHelper = async () => {
    let lock = null
    try { lock = JSON.parse(readFileSync(helperLockPath, 'utf8')) } catch { return }
    if (lock === null || typeof lock !== 'object') return
    const pid = Number(lock.pid)
    if (processAlive(Number(lock.hostPid))) return
    if (processAlive(pid)) {
      note(`killing leftover helper ${pid}`)
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 100).unref?.() })
      }
      if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    }
    clearHelperLock()
  }

  /** Drop the oldest spool files so a long session cannot fill the disk. */
  const pruneSpool = async () => {
    try {
      const files = (await readdir(spoolDir)).filter((name) => UTTERANCE_ID.test(name)).sort()
      for (const name of files.slice(0, Math.max(0, files.length - 20))) {
        await unlink(join(spoolDir, name))
      }
      state.utterances = state.utterances.slice(-maxUtterances)
    } catch { /* spool does not exist until the helper writes it */ }
  }

  let settingsLoaded = false
  let settingsLoading = null

  /** Normalize one stored binding; an unknown shape leaves the remote unbound. */
  const normalizeBinding = (value) => {
    if (value === null || typeof value !== 'object') return null
    const vendorId = Number(value.vendorId)
    const productId = Number(value.productId)
    if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) return null
    return {
      name: typeof value.name === 'string' ? value.name : '小米蓝牙语音遥控器',
      serial: typeof value.serial === 'string' ? value.serial : '',
      vendorId,
      productId,
      model: typeof value.model === 'string' ? value.model : 'RC003',
      boundAt: Number.isFinite(value.boundAt) ? value.boundAt : clock(),
      peripheralId: typeof value.peripheralId === 'string' ? value.peripheralId : null,
    }
  }

  /** Read the plugin's own settings file; missing or malformed means "unbound". */
  const ensureSettings = async () => {
    if (settingsLoaded) return
    if (settingsLoading !== null) { await settingsLoading; return }
    settingsLoading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
        state.binding = normalizeBinding(parsed?.binding ?? null)
        state.enabled = parsed?.enabled !== false
        if (parsed?.mapping && typeof parsed.mapping === 'object' && !Array.isArray(parsed.mapping)) state.mapping = parsed.mapping
      } catch { /* first run: no settings yet */ }
      settingsLoaded = true
      touch()
    })()
    await settingsLoading
  }

  /** Persist the binding so the manual choice survives restarts. */
  const persistSettings = async () => {
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify({ binding: state.binding, enabled: state.enabled, mapping: state.mapping }, null, 2)}\n`, 'utf8')
  }

  /** Compile the helper once and remember its path. */
  const ensureHelper = async () => {
    if (state.helper !== null) return state.helper
    state.helper = await provision()
    return state.helper
  }

  /** Handle one parsed helper message. */
  const handleMessage = (message) => {
    switch (message.event) {
      case 'state': {
        const next = message.state
        if (next === 'scanning' || next === 'connecting' || next === 'bluetooth-ready' || next === 'starting') {
          if (state.phase !== 'recording') state.phase = 'starting'
        } else if (next === 'reconnecting') {
          state.phase = 'reconnecting'
        } else if (next === 'stopped') {
          if (!stopping) state.phase = 'idle'
        }
        if (typeof message.reason === 'string' && message.reason !== '') state.device = message.reason
        if (message.reason) note(`state ${next}: ${message.reason}`)
        break
      }
      case 'ready':
        state.phase = 'ready'
        state.device = message.name ?? state.device
        state.model = message.model ?? null
        state.peripheralId = message.peripheralId ?? null
        if (state.binding !== null && !state.binding.peripheralId && typeof message.peripheralId === 'string' && message.peripheralId !== '') {
          state.binding = { ...state.binding, peripheralId: message.peripheralId }
          void persistSettings().catch(() => {})
        }
        state.error = null
        note(`ready ${state.device ?? ''} ${state.model ?? ''}`.trim())
        break
      case 'hid':
        state.hid = { ok: message.ok === true, error: typeof message.error === 'string' ? message.error : null }
        note(`hid ${state.hid.ok ? 'seized' : state.hid.error ?? 'unavailable'}`)
        break
      case 'key': {
        const usage = Number(message.usage)
        if (Number.isFinite(usage) && usage > 0) {
          state.keys = [...state.keys, { seq: ++keySeq, usage, down: message.down === true, at: clock() }].slice(-20)
        }
        break
      }
      case 'voice-start':
        state.phase = 'recording'
        note('voice-start')
        break
      case 'voice-stop': {
        state.phase = state.phase === 'recording' ? 'ready' : state.phase
        // A sandboxed helper cannot write the spool directory, so it sends the
        // WAV inline instead of a path. Write it here, synchronously, so the
        // client's first fetch of the utterance cannot race the write.
        const inline = typeof message.wav === 'string' && message.wav !== ''
        const id = inline
          ? (typeof message.name === 'string' ? message.name : '')
          : (typeof message.path === 'string' && message.path !== '' ? basename(message.path) : '')
        let ready = false
        if (UTTERANCE_ID.test(id)) {
          ready = true
          if (inline) {
            try {
              writeFileSync(join(spoolDir, id), Buffer.from(message.wav, 'base64'))
            } catch (error) {
              ready = false
              note(`utterance write failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        if (ready) {
          const entry = {
            id,
            seconds: Number.isFinite(message.seconds) ? message.seconds : 0,
            frames: Number.isFinite(message.frames) ? message.frames : 0,
            at: clock(),
          }
          state.utterances = [...state.utterances, entry].slice(-maxUtterances)
          void pruneSpool()
          if (typeof onUtterance === 'function') {
            Promise.resolve()
              .then(() => onUtterance({ ...entry, path: join(spoolDir, id) }))
              .catch((error) => note(`utterance hook failed: ${error instanceof Error ? error.message : String(error)}`))
          }
        }
        note(`voice-stop ${id} ${Number(message.seconds ?? 0).toFixed(2)}s${inline ? ' (inline)' : ''}`)
        break
      }
      case 'error':
        state.phase = 'error'
        state.error = typeof message.message === 'string' ? message.message : String(message.code ?? 'helper error')
        note(`error ${message.code ?? ''} ${state.error}`)
        break
      default:
        break
    }
    touch()
  }

  /** Consume stdout as newline-delimited JSON, tolerating split chunks. */
  const consume = (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        try { handleMessage(JSON.parse(line)) } catch { note(`bad helper line: ${line.slice(0, 160)}`) }
      }
      index = buffer.indexOf('\n')
    }
  }

  /**
   * Kill the helper and forget the child.
   *
   * Three things stop it, in order of politeness: closing stdin (the helper
   * treats EOF as "shut down"), SIGTERM, and SIGKILL three seconds later. The
   * pid file is deliberately left in place: it is cleared by the exit handler,
   * so if the host itself is killed the file survives and the next launch can
   * find and take down the orphan.
   */
  const stop = () => {
    stopping = true
    const running = child
    child = null
    if (running) {
      try { running.stdin?.end() } catch { /* already closed */ }
      try { running.kill('SIGTERM') } catch { /* already gone */ }
      const killTimer = setTimeout(() => { try { running.kill('SIGKILL') } catch { /* already gone */ } }, 3_000)
      killTimer.unref?.()
    } else {
      clearHelperLock()
    }
    if (state.phase !== 'idle') { state.phase = 'idle'; touch() }
    return status()
  }

  /** Start the helper, compiling it first if this is the first use. */
  const start = async () => {
    stopping = false
    if (support !== 'supported') {
      const error = new Error(`這個平台（${platform}）不支援遙控器麥克風；請先用系統麥克風。`)
      state.phase = 'error'
      state.error = error.message
      touch()
      throw error
    }
    if (child !== null) return status()
    if (state.phase === 'provisioning') return status()
    await ensureSettings()
    if (state.binding === null) {
      state.phase = 'error'
      state.error = '尚未綁定遙控器：請先在面板的「遙控器綁定」綁定。'
      touch()
      throw new Error(state.error)
    }
    state.phase = 'provisioning'
    state.error = null
    touch()
    try {
      await mkdir(spoolDir, { recursive: true })
      const helper = await ensureHelper()
      if (stopping) return status()
      await cleanupStaleHelper()
      const args = ['--out', spoolDir]
      const peripheralId = state.peripheralId ?? state.binding.peripheralId
      if (peripheralId) args.push('--peripheral-id', peripheralId)
      const spawned = spawnImpl(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child = spawned
      writeHelperLock(spawned.pid)
      state.phase = 'starting'
      touch()
      spawned.stdout.setEncoding('utf8')
      spawned.stdout.on('data', consume)
      spawned.stderr.setEncoding('utf8')
      spawned.stderr.on('data', (chunk) => { for (const line of String(chunk).split('\n')) note(line) })
      spawned.on('error', (error) => {
        state.phase = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        note(`spawn error ${state.error}`)
        child = null
        clearHelperLock()
        touch()
      })
      spawned.on('exit', (code, signal) => {
        if (child === spawned) child = null
        clearHelperLock()
        if (stopping) { state.phase = 'idle'; stopping = false; touch(); return }
        state.phase = 'error'
        state.error = `helper 結束（code=${code ?? 'null'} signal=${signal ?? 'null'}）${state.lastLog.slice(-2).join(' / ')}`
        note(state.error)
        touch()
        // A crashed helper must not leave the service silent until the panel is
        // opened: restart it in the background when the user still wants it.
        if (state.enabled && state.binding !== null) {
          setTimeout(() => {
            if (child === null && !stopping && state.enabled && state.binding !== null) {
              void start().catch(() => {})
            }
          }, 1_000).unref?.()
        }
      })
      return status()
    } catch (error) {
      state.phase = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      note(`start failed ${state.error}`)
      touch()
      throw error
    }
  }

  /** Public snapshot; plain JSON so the routes can serialize it directly. */
  const status = () => ({
    platform: state.platform,
    support: state.support,
    phase: state.phase,
    device: state.device,
    model: state.model,
    peripheralId: state.peripheralId,
    error: state.error,
    utterances: state.utterances.map((entry) => ({ ...entry })),
    updatedAt: state.updatedAt,
    seq: state.seq ?? 0,
    helper: state.helper,
    binding: state.binding === null ? null : { ...state.binding },
    enabled: state.enabled,
    hid: state.hid === null ? null : { ...state.hid },
    keys: state.keys.map((entry) => ({ ...entry })),
    mapping: { ...state.mapping },
    transcript: state.transcript === null ? null : { ...state.transcript },
    lastLog: state.lastLog.slice(-8),
  })

  /** Read one spooled utterance after validating its id. */
  const readUtterance = async (id) => {
    if (typeof id !== 'string' || !UTTERANCE_ID.test(id)) throw new Error('invalid utterance id')
    return await readFile(join(spoolDir, id))
  }

  /**
   * Enumerate connected remotes. Runs the helper's `--list` mode, which only
   * reads HID properties and needs no permissions.
   * @returns {Promise<Array<object>>} supported devices.
   */
  const listDevices = async () => {
    if (support !== 'supported') throw new Error('這個平台不支援遙控器綁定。')
    await ensureSettings()
    const helper = await ensureHelper()
    const stdout = await new Promise((resolve, reject) => {
      execFile(helper, ['--list'], { timeout: 20_000, windowsHide: true }, (error, out) => {
        if (error) reject(new Error(`列舉遙控器失敗：${error.message}`))
        else resolve(String(out))
      })
    })
    const devices = []
    for (const line of stdout.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const message = JSON.parse(text)
        if (message.event !== 'device') continue
        devices.push({
          name: typeof message.name === 'string' ? message.name : '',
          serial: typeof message.serial === 'string' ? message.serial : '',
          vendorId: Number(message.vendorId),
          productId: Number(message.productId),
          model: typeof message.model === 'string' ? message.model : 'RC003',
          supported: message.supported === true,
        })
      } catch { /* ignore non-JSON diagnostics */ }
    }
    return devices
  }

  /** Persist the manual binding (one remote at a time; Pro 2 identity only). */
  const bind = async (device) => {
    if (support !== 'supported') throw new Error('這個平台不支援遙控器綁定。')
    if (!device || typeof device !== 'object') throw new Error('綁定資訊無效。')
    const vendorId = Number(device.vendorId)
    const productId = Number(device.productId)
    if (vendorId !== 0x2717 || productId !== 0x32B8) {
      throw new Error('暫時只支援「小米藍牙語音遙控器 2 Pro」（RC003）。')
    }
    await ensureSettings()
    state.binding = normalizeBinding({
      ...device,
      vendorId,
      productId,
      model: 'RC003',
      boundAt: clock(),
    })
    await persistSettings()
    // A binding change applies to the next start; stop the current helper so
    // the panel can restart it against the selected device.
    if (child !== null) stop()
    touch()
    return status()
  }

  /** Forget the binding and stop the helper. */
  const unbind = async () => {
    await ensureSettings()
    state.binding = null
    state.peripheralId = null
    await persistSettings()
    if (child !== null) stop()
    touch()
    return status()
  }

  /** Stop the child; safe to call from a plugin disposer. */
  const dispose = () => { stop() }

  /** Toggle the long-running helper; false stops it, true (re)starts on demand. */
  const setEnabled = async (enabled) => {
    state.enabled = Boolean(enabled)
    await persistSettings()
    if (!state.enabled) {
      await stop()
      return status()
    }
    touch()
    return status()
  }

  /** Persist one per-key action mapping ({ usage: action }). */
  const setMapping = async (mapping) => {
    const next = {}
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
      for (const [key, value] of Object.entries(mapping)) {
        if (/^\d+$/.test(key) && typeof value === 'string' && value !== '') next[key] = value
      }
    }
    state.mapping = next
    await persistSettings()
    touch()
    return status()
  }

  /** Publish one host-side transcription (recognition -> conversion happened above). */
  const setTranscript = (transcript) => {
    state.transcript = transcript === null ? null : { ...transcript }
    touch()
    return status()
  }

  /** Notify whenever the status snapshot changes (SSE routes use this). */
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  // A helper left behind by a killed host would keep the remote's BLE link and
  // fight the next one, so the leftover is cleared as soon as the plugin loads,
  // not only when the user turns the microphone on.
  void cleanupStaleHelper().catch(() => {})

  return { start, stop, status, listDevices, bind, unbind, readUtterance, dispose, ready: ensureSettings, subscribe, setTranscript, setEnabled, setMapping, cleanupStaleHelper }
}
