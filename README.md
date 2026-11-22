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

## Remote microphone

The remote's own microphone is not a macOS audio endpoint (it streams over ATVV,
a private BLE GATT service), so it never shows up in the console's microphone
list. The plugin therefore ships a small Swift helper (`native/atvv-capture.swift`):

- On first use the host compiles it with the system Swift toolchain into a
  plugin-owned cache directory — **no application is installed**, no BlackHole,
  no login item, no daemon.
- The helper connects to the remote over CoreBluetooth, speaks ATVV, decodes the
  16 kHz IMA/DVI ADPCM stream, and writes one WAV per hold-to-talk utterance.
- The remote is bound **manually**: pair it in macOS Bluetooth, then scan and
  bind it under "Remote binding" in the console (only the RC003 identity is
  listed; other models come later).
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
- The remote microphone follows the same shape as the built-in voice input: the
  client gets a finished-utterance event, makes **one POST** (`utterance id`) to
  the host, and the host reads the WAV, transcribes once with the selected DSH
  provider, applies the conversion, and answers with text plus timings; the
  client inserts it immediately. On this machine the local SenseVoice inference
  measures ~40–60 ms for 1–2 s of audio once the worker is loaded.
- The bundle patch pins the recognizer to `idleTimeoutMs: 0` (worker never
  unloads while idle) with `threads: 6`, and `keepModelWarm` still re-warms any
  `standby` fallback.
- The console footer shows the client bundle version and the panel shows the
  recognizer phase plus a per-utterance latency breakdown, so a stale bundle or
  a cold model is visible instead of guessed.
- Key interception and remapping are the next step: capturing the remote's HID
  device so its keys stop acting like a normal keyboard needs the macOS Input
  Monitoring permission.
- The macOS backend is verified against a real RC003; the Windows backend is a
  planned slot and reports "not implemented yet" instead of failing silently.

Details, permissions, route paths, and the optional ESP32 hardware alternative:
[docs/DETAIL.md](docs/DETAIL.md#遙控器自己的麥克風atvv).

## Install

```sh
dsh plugin --profile desktop add link:~/Documents/Git/Sourcetree/dsh-stt-hant
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
| `test/` | `node --test` suites (host conversion/provider + client smoke) |
| `docs/DETAIL.md` | Usage, variant table, remote limits, boundaries |
| `docs/PITFALLS.md` | Incidents and the rules they produced |
