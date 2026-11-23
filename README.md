# dsh-stt-hant

Traditional Chinese for DSH voice input, plus a sidebar console to test it and bind a Bluetooth remote.

`SenseVoice（繁體）` is one more speech provider beside the built-in local
SenseVoice: recognition is unchanged, only the finished transcript is converted
from Simplified to Traditional. The sidebar entry opens a console that records a
sample, shows the raw and converted text side by side, plays the recording back,
and binds a Bluetooth remote's buttons to start and stop recording.

- Host: recognition always runs on the shipped `sensevoice-local` model first;
  `sensevoice-hant` is a thin provider that applies the (panel-editable)
  Simplified → Traditional step, and the console applies that same step after
  every recognition instead of choosing a different recognizer.
- Conversion is its own setting: enable/disable, `s2hk`/`s2twp`/`s2tw`/`s2t`,
  and a glossary, editable live in the console's “Traditional conversion” card
  (persisted in `~/.dsh/cache/dsh-stt-hant/convert.json`).
- Client: `sidebar.panellist` entry + `main` panel, using the existing
  `ctx.remote.speech` calls. Plain-JS module factory, no build step. It covers
  service status, recognizer selection, model preparation (progress, download
  source, cancel), language, microphone, recording with waveform and playback,
  copyable results, and the remote binding section. Text goes through the Client
  locale service (`stt-hant`, Traditional Chinese + English); colours use
  `--dsw-alias-*` tokens only.

See [docs/DETAIL.md](docs/DETAIL.md) for usage, the variant table, the remote
control's limits, and the known boundaries (it is a lexical conversion, not a
translation). Past incidents and the rules they produced live in
[docs/PITFALLS.md](docs/PITFALLS.md).

## Without a remote

The remote is optional. The plugin's core is the Traditional Chinese recognizer,
and it works in three situations without any remote at all:

1. **Built-in voice input.** Pick `SenseVoice（繁體）` in DSH's voice input
   settings (設定 → 語音輸入 → 識別服務), or use the console's "Recognizers"
   card, which writes the same DSH setting. The composer's own microphone button
   then returns Traditional Chinese. Recognition is still the shipped local
   SenseVoice; the plugin only adds the conversion step.
2. **A keyboard shortcut.** The console's "Keyboard shortcut" card records a
   shortcut (push-to-talk: hold to record, release to insert). It uses the system
   microphone, needs the window focused, and falls back to the clipboard instead
   of the draft when you ask it to. The shortcut is stored in the page's
   localStorage, so it survives a reload.
3. **The test recorder.** The console's "Test recording" card records with the
   system microphone and shows the raw and converted text side by side, so the
   whole chain can be tried without touching a remote.

The composer's small control stays out of the way in this case: once the host
reports that no remote is bound, it stops reporting a remote it does not have and
just opens the console.

## Remote microphone

The remote's own microphone is not an OS audio endpoint (it streams over ATVV,
a private BLE GATT service), so it never shows up in the console's microphone
list. The plugin therefore ships a small native helper per platform:

- macOS: `native/atvv-capture.swift` (CoreBluetooth), compiled with the system
  Swift toolchain.
- Windows: `native/atvv-capture.cs` (WinRT GATT), compiled with the in-box C#
  compiler (`csc.exe`) against the Windows SDK's merged WinRT metadata.

- On first use the host compiles the helper into a plugin-owned cache directory —
  **no application is installed**, no BlackHole, no login item, no daemon.
- The helper connects to the remote, speaks ATVV, decodes the 16 kHz IMA/DVI
  ADPCM stream, and writes one WAV per hold-to-talk utterance.
- The remote is bound **manually**: pair it in the OS Bluetooth settings first,
  then scan and bind it under "Remote binding" in the console (only the RC003
  identity is listed; other models come later).
- The sidebar console gets a "Remote microphone (ATVV)" card: enable once, hold
  the remote voice key, speak, release — the new utterance is transcribed
  automatically with the selected recognizer.
- A compact "Remote" control in the composer keeps that pipeline alive while you
  are in a conversation, and inserts the finished transcript into the draft
  (falling back to the clipboard if the draft changed), so the remote works
  without opening the console.
- The console is also a first-class, calm developer-tool page: hairline cards,
  a 4/8 spacing rhythm, one primary CTA per section, theme-token states and
  keyboard-visible focus.
- The remote microphone follows the same shape as the built-in voice input, but
  the host does the work: the helper's release event starts recognition on the
  host (read the WAV, transcribe once with the selected DSH provider, apply the
  conversion), and the finished transcript reaches the composer over the plugin's
  server-sent event stream, so the client inserts it without a round trip. The
  stream stays open for the life of the page — a GET request's own `close` event
  fires immediately, so only the response's close ends the stream. On this
  machine the local SenseVoice inference measures ~40–60 ms for 1–2 s of audio
  once the worker is loaded.
- The bundle patch pins the recognizer to `idleTimeoutMs: 0` (worker never
  unloads while idle) with `threads: 6`, and `keepModelWarm` still re-warms any
  `standby` fallback.
- The console footer shows the client bundle version and the panel shows the
  recognizer phase plus a per-utterance latency breakdown, so a stale bundle or
  a cold model is visible instead of guessed.
- Key interception and remapping are the next step: capturing the remote's HID
  device so its keys stop acting like a normal keyboard needs the macOS Input
  Monitoring permission. On Windows this card is hidden for now; the remote's
  keys still reach the OS as ordinary keyboard input.
- Both backends are verified against a real RC003. The Windows port keeps the
  same protocol and JSON contract and completed a full run on Windows: pair →
  ATVV handshake → hold-to-talk → WAV → Traditional Chinese transcript.
- The remote only answers while it is awake. Windows reports `Unreachable` for a
  sleeping remote instead of waking it, so after a failed attempt the helper
  watches BLE advertisements and reconnects within about a second of the next
  key press; the panel shows "等待遙控器" while it waits. Press any key on the
  remote once to wake it.
- Windows specifics: the C# helper needs the Windows SDK's merged WinRT metadata
  (`Windows.winmd`); the plugin reports a clear error when it is missing. An
  endpoint-protection product that blocks "compile and run" (for example Cortex
  XDR's behavioral rule) may quarantine the helper on first use — whitelist the
  plugin cache directory, or prebuild `native/atvv-capture.exe` with
  `native/build.ps1` (or point `DSH_STT_HANT_HELPER` at a built binary) and the
  host spawns it without compiling. See [docs/PITFALLS.md](docs/PITFALLS.md).

Details, permissions, route paths, and the optional ESP32 hardware alternative:
[docs/DETAIL.md](docs/DETAIL.md#遙控器自己的麥克風atvv).

## Install

```sh
# macOS / Linux
dsh plugin --profile desktop add link:~/Documents/Git/Sourcetree/dsh-stt-hant

# Windows (PowerShell)
dsh plugin --profile desktop add link:C:\Users\<you>\Documents\code\git\dsh-stt-hant
```

Then restart DSH (the host module is cached at boot) and pick
`SenseVoice（繁體）` under 設定 → 語音輸入 → 識別服務.

## Test

```sh
node --test        # host conversion/provider suites + client smoke suite
node --check client.js
```

## After a change

- `client.js` only: reload the DSH window (client HMR usually swaps the plugin
  in place, a reload always works). React state in the panel is discarded.
- `index.js` / `lib/*`: restart DSH; the host module is ESM-cached.

## Layout

| Path | Purpose |
|---|---|
| `index.js` | Host plugin: config normalization, provider registration |
| `lib/hant.js` | Simplified → Traditional, code/URL/path protection, glossary |
| `lib/provider.js` | The `sensevoice-hant` provider |
| `client.js` | Sidebar console (providers, recording, results, remote binding) |
| `native/atvv-capture.swift` | macOS ATVV capture helper (CoreBluetooth) |
| `native/atvv-capture.cs` | Windows ATVV capture helper (WinRT GATT) |
| `lib/native-bridge.js` | Host-side helper lifecycle: compile per platform, spawn, JSON lines, WAV spool |
| `test/` | `node --test` suites (host conversion/provider + client smoke) |
| `docs/DETAIL.md` | Usage, variant table, remote limits, boundaries |
| `docs/PITFALLS.md` | Incidents and the rules they produced |
