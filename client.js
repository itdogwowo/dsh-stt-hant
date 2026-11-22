/**
 * Browser half of dsh-stt-hant.
 *
 * One sidebar entry opens a test console for the speech pipeline: pick a
 * recognizer, download it, choose the language, record, then read the raw
 * (Simplified) transcript beside the Traditional one. The console also binds a
 * Bluetooth remote's buttons to start and stop recording, because a voice remote
 * only ever sends HID key presses.
 *
 * Written as a plain module factory (no build step): React comes from the
 * browser module table, everything else is local. Visible text goes through the
 * Client locale service under the `stt-hant` namespace (Traditional Chinese and
 * English); colours and surfaces use `--dsw-alias-*` theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stt-hant',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Sidebar entry id; doubles as the keyed `main` panel key. */
    const PANEL_ID = 'stt-hant'
    /** Shown in the panel footer so a stale client bundle is obvious. */
    const PLUGIN_VERSION = '0.10.3'
    /** Conversion variants the panel may switch between. */
    const CONVERT_VARIANTS = ['s2hk', 's2twp', 's2tw', 's2t']
    const KEY_NAMES = {
      62: '語音', 40: 'OK', 82: '上', 81: '下', 80: '左', 79: '右', 74: 'Home',
      101: '選單', 53: 'TV', 102: '電源', 241: '返回', 128: '音量＋', 129: '音量－',
    }
    const KEY_ACTIONS = ['', 'panel', 'last']

    // ── user-recorded keyboard shortcut ──
    const hotkeyRuntime = {
      binding: (() => {
        try { const raw = window.localStorage.getItem('dsh-stt-hant.hotkey'); return raw === null ? null : JSON.parse(raw) } catch { return null }
      })(),
      copyMode: (() => {
        try { return window.localStorage.getItem('dsh-stt-hant.hotkey-copy') === '1' } catch { return false }
      })(),
      learning: false,
      active: false,
      phase: 'idle',
      recorder: null,
      warmStream: null,
      listeners: new Set(),
      notify() { for (const listener of [...this.listeners]) { try { listener() } catch { /* ignore */ } } },
      save(binding) {
        this.binding = binding
        try {
          if (binding === null) window.localStorage.removeItem('dsh-stt-hant.hotkey')
          else window.localStorage.setItem('dsh-stt-hant.hotkey', JSON.stringify(binding))
        } catch { /* storage unavailable */ }
        this.notify()
      },
    }

    function hotkeyMatches(event, binding) {
      if (binding === null) return false
      if (typeof binding.code === 'string' && binding.code !== '' ? event.code !== binding.code : event.key !== binding.key) return false
      return Boolean(event.ctrlKey) === Boolean(binding.ctrl)
        && Boolean(event.altKey) === Boolean(binding.alt)
        && Boolean(event.shiftKey) === Boolean(binding.shift)
        && Boolean(event.metaKey) === Boolean(binding.meta)
    }

    function describeHotkey(binding) {
      if (binding === null) return ''
      const parts = []
      if (binding.ctrl) parts.push('Ctrl')
      if (binding.alt) parts.push('Alt')
      if (binding.shift) parts.push('Shift')
      if (binding.meta) parts.push('Cmd')
      parts.push(binding.key && binding.key.length === 1 ? binding.key.toUpperCase() : (binding.key ?? binding.code ?? '?'))
      return parts.join(' + ')
    }

    function captureHotkey(event) {
      if (event.key === 'Escape') { hotkeyRuntime.learning = false; hotkeyRuntime.notify(); return true }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return true
      event.preventDefault()
      hotkeyRuntime.save({ code: event.code, key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey })
      hotkeyRuntime.learning = false
      void warmHotkeyStream()
      hotkeyRuntime.notify()
      return true
    }

    function insertQuickText(text) {
      if (typeof text !== 'string' || text === '') return
      const insertion = remoteMicRuntime.insertion
      if (insertion !== null) {
        try { const span = insertion.captureInsertion(); if (insertion.insertText(text, span)) return } catch { /* ignore */ }
      }
      void navigator.clipboard.writeText(text).catch(() => {})
    }

    async function warmHotkeyStream() {
      if (hotkeyRuntime.warmStream || !navigator.mediaDevices?.getUserMedia) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        hotkeyRuntime.warmStream = stream
        Recording.warmStream = stream
      } catch { /* permission not granted yet */ }
    }

    async function startHotkeyRecording() {
      if (hotkeyRuntime.active || hotkeyRuntime.phase === 'transcribing' || speechNamespace === null) return
      void warmHotkeyStream()
      hotkeyRuntime.active = true
      hotkeyRuntime.phase = 'recording'
      hotkeyRuntime.notify()
      const recorder = new Recording(() => {}, '')
      hotkeyRuntime.recorder = recorder
      try {
        await recorder.start(() => {})
      } catch {
        hotkeyRuntime.active = false
        hotkeyRuntime.phase = 'idle'
        hotkeyRuntime.notify()
      }
    }

    async function stopHotkeyRecording() {
      if (!hotkeyRuntime.active) return
      hotkeyRuntime.active = false
      hotkeyRuntime.phase = 'transcribing'
      hotkeyRuntime.notify()
      try {
        const recorder = hotkeyRuntime.recorder
        hotkeyRuntime.recorder = null
        const bytes = recorder === null ? null : await recorder.stop(60)
        if (bytes === null || bytes.byteLength === 0 || speechNamespace === null) return
        const catalog = await unwrap(speechNamespace.catalog())
        let providerId = catalog?.selection?.providerId ?? 'sensevoice-local'
        const language = catalog?.selection?.language ?? 'auto'
        if (providerId === 'sensevoice-hant') providerId = 'sensevoice-local'
        const transcript = await unwrap(speechNamespace.transcribe({ audioBase64: audioBase64(bytes), providerId, language }, new AbortController().signal))
        const converted = await convertTranscriptText(transcript.text)
        if (hotkeyRuntime.copyMode) await navigator.clipboard.writeText(converted)
        else insertQuickText(converted)
      } catch { /* quiet for hotkey recordings */ }
      finally { hotkeyRuntime.phase = 'idle'; hotkeyRuntime.notify() }
    }



    /**
     * Second step after recognition: ask the host to convert finished text to
     * Traditional Chinese with the current (panel-editable) settings.
     */
    async function convertTranscriptText(text) {
      if (typeof text !== 'string' || text === '') return text ?? ''
      try {
        const payload = await fetchJson('/stt-hant/convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        return typeof payload?.text === 'string' ? payload.text : text
      } catch {
        return text
      }
    }
    /** Locale namespace owned by this bundle. */
    const NS = 'stt-hant'
    /** localStorage keys. The remote ones keep their v0.1 names so existing bindings survive. */
    const STORAGE = {
      microphone: 'dsh-stt-hant.microphone',
      remoteToggle: 'dsh-stt-hant.remote.start',
      remoteStop: 'dsh-stt-hant.remote.stop',
      remoteHold: 'dsh-stt-hant.remote.hold',
      remoteMic: 'dsh-stt-hant.remoteMic',
    }

    // ───────────────────── speech Remote namespace ─────────────────────
    // `remote.speech` belongs to the voice-input bundle and is mounted in that
    // plugin's own apply, so it appears after this plugin activates: capture it
    // from a contextual `ctx.inject(['remote.speech'])` and publish it to the
    // panel through this tiny store. Reading `ctx.remote.speech` directly is not
    // allowed by Cordis without the injection.
    let speechNamespace = null
    const speechWatchers = new Set()

    function publishSpeech(next) {
      if (speechNamespace === next) return
      speechNamespace = next
      for (const watcher of [...speechWatchers]) {
        try { watcher() } catch { /* a component listener must not break the publisher */ }
      }
    }

    function subscribeSpeech(watcher) {
      speechWatchers.add(watcher)
      return () => { speechWatchers.delete(watcher) }
    }

    // ───────────────────── remote-mic runtime (plugin-wide) ─────────────────────
    // Polling, transcription and composer insertion live outside the panel so the
    // remote microphone keeps working while the user is in a conversation.
    const remoteMicRuntime = {
      status: null,
      unavailable: false,
      seen: new Set(),
      seeded: false,
      busy: false,
      insertion: null, // inputActions of the mounted composer control
      result: null, // last transcription for the panel to render
      listeners: new Set(),
      polling: false,
      timer: 0,
      refs: 0,
      seq: 0,
      stream: null,
      transport: 'connecting',
      selection: null,
      selectionAt: 0,
    }

    function notifyRemoteMicRuntime() {
      for (const listener of [...remoteMicRuntime.listeners]) {
        try { listener() } catch { /* a component listener must not break the poller */ }
      }
    }

    function subscribeRemoteMicRuntime(listener) {
      remoteMicRuntime.listeners.add(listener)
      return () => { remoteMicRuntime.listeners.delete(listener) }
    }

    /** Replace the cached host status (route replies also come through here). */
    /** Deliver one finished utterance to the panel/composer subscribers. */
    function publishRemoteMicResult(result) {
      remoteMicRuntime.result = result
      notifyRemoteMicRuntime()
    }

    function publishRemoteMicStatus(status) {
      if (Number.isFinite(status?.seq)) remoteMicRuntime.seq = status.seq
      const previousPhase = remoteMicRuntime.status?.phase ?? null
      const previousSeq = remoteMicRuntime.status?.seq ?? null
      remoteMicRuntime.status = status ?? null
      if (previousPhase !== (status?.phase ?? null) || previousSeq !== (status?.seq ?? null)) {
        void fetchJson('/stt-hant/telemetry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'phase', phase: status?.phase ?? null, previous: previousPhase, seq: status?.seq ?? null, at: Date.now() }),
        }).catch(() => {})
      }
      remoteMicRuntime.unavailable = false
      if (!remoteMicRuntime.seeded && status) {
        remoteMicRuntime.seeded = true
        for (const utterance of status.utterances ?? []) remoteMicRuntime.seen.add(utterance.id)
        if (status.transcript?.id) remoteMicRuntime.seen.add(status.transcript.id)
      } else if (status?.transcript) {
        handleHostTranscript(status.transcript)
      }
      notifyRemoteMicRuntime()
    }

    /** The host already recognised + converted this utterance; deliver it now. */
    function handleHostTranscript(transcript) {
      if (!transcript || typeof transcript.id !== 'string') return
      if (remoteMicRuntime.seen.has(transcript.id)) return
      remoteMicRuntime.seen.add(transcript.id)
      if (transcript.error) {
        notifyRemoteMicRuntime()
        return
      }
      const timings = transcript.timings ?? {}
      const result = {
        hant: typeof transcript.text === 'string' ? transcript.text : '',
        raw: typeof transcript.raw === 'string' ? transcript.raw : '',
        audioSeconds: transcript.audioSeconds ?? 0,
        inferenceSeconds: transcript.inferenceSeconds ?? 0,
        round: (timings.totalMs ?? 0) / 1000,
        bytes: null,
        at: Date.now(),
        utteranceId: transcript.id,
        timings: {
          total: Number.isFinite(timings.totalMs) ? timings.totalMs : null,
          wait: Number.isFinite(timings.totalMs)
            ? Math.max(0, timings.totalMs - (timings.transcribeMs ?? 0) - (timings.convertMs ?? 0))
            : null,
          infer: Number.isFinite(timings.transcribeMs) ? timings.transcribeMs : null,
          convert: Number.isFinite(timings.convertMs) ? timings.convertMs : null,
        },
      }
      // Same delivery contract as the built-in voice input: insert immediately.
      const insertion = remoteMicRuntime.insertion
      if (insertion !== null && result.hant !== '') {
        try {
          const span = insertion.captureInsertion()
          if (!insertion.insertText(result.hant, span)) {
            void navigator.clipboard.writeText(result.hant).catch(() => {})
          }
        } catch { /* the draft may have been disposed */ }
      }
      publishRemoteMicResult(result)
      // Playback only: fetch the WAV after the text is already in the draft.
      void fetchBytes(`/stt-hant/remote-mic/utterances/${encodeURIComponent(transcript.id)}`)
        .then((bytes) => {
          if (remoteMicRuntime.result?.utteranceId === transcript.id) {
            publishRemoteMicResult({ ...remoteMicRuntime.result, bytes })
          }
        })
        .catch(() => {})
    }

    /** One poll tick: fallback refresh when the event stream is unavailable. */
    async function remoteMicTick() {
      if (!remoteMicRuntime.polling) return
      try {
        const next = await fetchJson('/stt-hant/remote-mic/status')
        publishRemoteMicStatus(next)
      } catch (error) {
        void fetchJson('/stt-hant/telemetry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'longpoll-error', message: errorText(error), at: Date.now() }),
        }).catch(() => {})
        remoteMicRuntime.unavailable = true
        notifyRemoteMicRuntime()
      }
      if (!remoteMicRuntime.polling) return
      // Poll cheaply as a safety net even when the event stream is connected:
      // fast while the button is held, calm when idle.
      // Poll fast enough that the composer indicator reflects the remote's real
      // state within ~150 ms (SSE has proven unreliable in this shell).
      const delay = remoteMicRuntime.unavailable ? 2_000 : 150
      remoteMicRuntime.timer = window.setTimeout(remoteMicTick, delay)
    }

    /**
     * Open the host's SSE stream. A finished utterance then reaches the panel in
     * milliseconds instead of waiting for the next poll; polling stays as a
     * slower fallback for hosts or browsers without EventSource.
     */
    function openRemoteMicStream() {
      if (typeof EventSource === 'undefined') return null
      try {
        const source = new EventSource('/stt-hant/remote-mic/events')
        source.onmessage = (event) => {
          if (remoteMicRuntime.transport !== 'sse') {
            remoteMicRuntime.transport = 'sse'
            notifyRemoteMicRuntime()
          }
          try {
            publishRemoteMicStatus(JSON.parse(event.data))
          } catch { /* ignore malformed frame */ }
        }
        return source
      } catch {
        return null
      }
    }

    /** Reference-counted polling: the panel and the composer control both retain it. */
    function retainRemoteMicRuntime() {
      remoteMicRuntime.refs += 1
      if (remoteMicRuntime.refs === 1) {
        remoteMicRuntime.polling = true
        // Ask the host to wake the recognizer now, not on the first utterance.
        void fetchJson('/stt-hant/model/prepare', { method: 'POST' }).catch(() => {})
        remoteMicRuntime.stream = openRemoteMicStream()
        remoteMicRuntime.transport = remoteMicRuntime.stream !== null ? 'connecting' : 'poll'
        notifyRemoteMicRuntime()
        void remoteMicTick()
      }
      return () => {
        remoteMicRuntime.refs = Math.max(0, remoteMicRuntime.refs - 1)
        if (remoteMicRuntime.refs === 0) {
          remoteMicRuntime.polling = false
          window.clearTimeout(remoteMicRuntime.timer)
          try { remoteMicRuntime.stream?.close() } catch { /* already closed */ }
          remoteMicRuntime.stream = null
          remoteMicRuntime.transport = 'poll'
        }
      }
    }

    // ───────────────────── locale dictionaries ─────────────────────
    // `zh` is Traditional Chinese: this bundle exists for Traditional Chinese
    // users, so its own console copy is Traditional even when DSH runs zh-CN.
    const zh = {
      'panel.title': '語音輸入',
      'panel.subtitle': '麥克風・遙控器・語音辨識・繁體轉換',
      'panel.intro': '直接測試整條語音鏈路：選識別服務、錄音，然後同時看到簡體原文與繁體結果。辨識仍由本機的 SenseVoice 完成，繁體轉換由宿主端的 sensevoice-hant provider 負責，音訊不會離開這台機器。',
      'panel.refresh': '重新整理',
      'panel.status.connected': '語音服務已連線',
      'panel.status.connecting': '正在連線語音服務…',
      'panel.status.missing': '找不到語音服務',
      'panel.status.error': '語音服務回應失敗',
      'panel.missingService': '語音服務未就緒：請確認內建的語音輸入 bundle 已啟用（設定 → 擴充功能），然後重新載入頁面。',
      'panel.retry': '重試',
      'panel.loadingProviders': '正在讀取識別服務…',
      'panel.noProviders': '目前沒有可用的識別服務。',
      'panel.crash': '語音輸入面板發生錯誤',
      'panel.crashHint': '請重新載入頁面；若持續發生，請把下面這段訊息附在回報裡。',
      'panel.crash': 'The Traditional Chinese panel crashed',
      'panel.crashHint': 'Reload the page; if it keeps happening, include the message below in a report.',
      'panel.footnote': '辨識固定用本機 SenseVoice；繁體轉換是之後獨立的一步，可在「繁體轉換」卡即時改。',

      'section.providers': '識別服務',
      'section.convert': '繁體轉換',
      'convert.hint': '辨識先出文字，再按這裡的設定轉成繁體；改了即時生效，會套用到面板、遙控器麥克風與內建「SenseVoice（繁體）」provider。',
      'convert.enable': '啟用繁體轉換',
      'convert.variant': '轉換變體',
      'convert.glossary': '詞表（{ "簡體/繁體": "譯法" }，轉換後最長匹配）',
      'convert.save': '儲存詞表',
      'convert.saved': '已儲存',
      'convert.error': '轉換設定錯誤：',
      'convert.disabled': '目前停用：辨識結果會保持原本的簡體文字。',
      'convert.variant.s2hk': '香港（s2hk）',
      'convert.variant.s2twp': '台灣（s2twp）',
      'convert.variant.s2tw': '台灣字形（s2tw）',
      'convert.variant.s2t': '僅字形（s2t）',
      'section.providersHint': '選一個作為預設；選取會寫入 DSH 的語音設定。',
      'section.recorder': '測試錄音',
      'section.remote': '遙控器（藍牙 HID）',

      'provider.local': '本機',
      'provider.cloud': '雲端',
      'provider.languages': '{count} 種語言',
      'provider.default': '預設',
      'provider.setDefault': '設為預設',
      'provider.prepare': '下載模型',
      'provider.retryPrepare': '重試準備',
      'provider.cancelPrepare': '取消準備',
      'provider.source': '模型下載源',
      'provider.sourceAuto': '自動選擇（推薦）',
      'provider.download': '下載 {resource}：{completed} / {total} MB（{percent}%）',
      'provider.downloadUnknown': '已下載 {resource}：{completed} MB',
      'provider.failed': '準備失敗：{message}',
      'provider.retryHint': '可以重試；已下載並通過校驗的檔案會保留。',

      'phase.ready': '可使用',
      'phase.standby': '待命',
      'phase.waking': '喚醒中',
      'phase.unprepared': '尚未準備',
      'phase.downloading': '下載中',
      'phase.checking': '檢查中',
      'phase.loading': '載入中',
      'phase.cancelling': '取消中',
      'phase.cancelled': '已取消',
      'phase.failed': '失敗',
      'phase.unknown': '未知',

      'step.check': '檢查本機資源',
      'step.model': '準備辨識模型',
      'step.vad': '準備語音偵測模型',
      'step.verify': '校驗模型檔案',
      'step.load': '載入模型',

      'language.label': '識別語言',
      'language.auto': '自動辨識',
      'language.zh': '中文',
      'language.yue': '粵語',
      'language.en': '英語',
      'language.ja': '日語',
      'language.ko': '韓語',

      'mic.label': '麥克風',
      'mic.default': '系統預設麥克風',
      'mic.named': '麥克風 {number}',
      'mic.refresh': '重新整理',
      'mic.allow': '允許麥克風',
      'mic.permissionDenied': '麥克風權限被拒絕',
      'mic.unavailable': '這個瀏覽器不支援錄音',
      'mic.loading': '尚未取得麥克風清單',
      'mic.missingDevice': '已中斷的麥克風',
      'mic.bridge': '偵測到 BlackHole：遙控器自己的麥克風（ATVV）會經橋接 App 寫進這裡。選它，再用遙控器鍵觸發錄音。',
      'mic.useBridge': '用 BlackHole',
      'mic.bridgeSelected': '目前用 BlackHole 當麥克風：請確認 open-voice-bridge 正在執行，並用「按住說話」的遙控器鍵觸發。',

      'record.start': '開始錄音',
      'record.stop': '停止並辨識',
      'record.requesting': '取得麥克風…',
      'record.transcribing': '辨識中…',
      'record.cancel': '取消',
      'record.recording': '錄音中',
      'record.timer': '{elapsed}s / {max}s',
      'record.play': '播放這段錄音',
      'record.noProvider': '請先選一個識別服務。',
      'record.notReady': '這個識別服務尚未準備好：先在上方下載模型，或改選另一個服務。',
      'record.tooLarge': '錄音超過服務限制，請縮短後重試。',
      'record.limit': '最長 {max} 秒',
      'record.readyHint': '錄音完成後，結果會顯示在下方，可複製或播放。',

      'result.hant': '繁體結果',
      'result.transcript': '辨識結果',
      'result.raw': '簡體原文',
      'result.copy': '複製',
      'result.copied': '已複製',
      'result.copyFailed': '無法寫入剪貼簿。',
      'result.placeholder': '錄音後會顯示在這裡。',
      'result.rawUnavailable': '（無法取得簡體原文）',
      'result.comparing': '正在取得簡體原文…',
      'result.timing': '音訊 {audio}s · 推論 {inference}s · 往返 {round}s',
      'result.latency': '收音→出字 {total} ms（等待 {wait} · 推論 {infer}）',
      'remoteMic.transport.connecting': '事件流：連線中…',
      'remoteMic.transport.sse': '事件流：即時',
      'remoteMic.transport.poll': '事件流：輪詢備援',

      'remote.headHint': '只用來控制這個測試台：面板開著才收鍵，也不會控制對話框的聽寫。',
      'remote.ready': '遙控器待命（僅此面板）',
      'remote.idle': '尚未綁定任何按鍵',
      'remote.stopHint': '「停止（錄音中）」是第二顆鍵：只在錄音中停止，不會開始錄音。',
      'remote.modifier': '修飾鍵不能單獨綁定，請按一般按鍵。',
      'remote.scope': '這些按鍵只在這個面板開著時生效，而且在輸入框打字時不會觸發。',
      'remote.toggle': '開始／停止',
      'remote.stop': '停止（錄音中）',
      'remote.bind': '綁定',
      'remote.rebind': '重新綁定',
      'remote.listening': '請按遙控器…',
      'remote.pressNow': '正在等按鍵：請按一下遙控器上想綁定的那顆按鈕（按 Esc 取消）。',
      'remote.clear': '清除',
      'remote.clearAll': '全部清除',
      'remote.unbound': '未綁定',
      'remote.keyLog': '最近收到的按鍵',
      'remote.keyLogEmpty': '還沒有收到任何按鍵。先按一下遙控器上的按鈕，這裡會列出它送出的鍵；沒有出現就代表那個鍵被系統先截走了。',
      'remote.triggered': '遙控器已觸發',
      'remote.bound': '已綁定這個按鍵',
      'remote.conflict': '兩列綁了同一個鍵：「開始／停止」會優先。',
      'remote.media': '音量、播放這類多媒體鍵會被 macOS 先截走，網頁收不到；遇到這種鍵請改綁其他按鈕。',
      'remote.bridge': '要錄「遙控器自己的麥克風」，先用 open-voice-bridge + BlackHole 把 ATVV 音訊接成系統輸入（見 docs/DETAIL.md），再在麥克風選 BlackHole。',
      'remote.hold': '按住說話（放開停止）',
      'remote.holdHint': '關閉時是切換：按一下開始、再按一下停止。若遙控器只送按下不送放開，請保持關閉。',

      'remoteVoice.short': '遙控器',
      'remoteVoice.idle': '遙控器麥克風：未啟用（點擊開啟面板）',
      'remoteVoice.ready': '遙控器麥克風：已連線',
      'remoteVoice.recording': '遙控器麥克風：收音中',
      'remoteVoice.error': '遙控器麥克風：錯誤',
      'remoteVoice.unavailable': '遙控器麥克風：不可用',
      'binding.title': '遙控器綁定',
      'binding.hint': '先在 macOS 藍牙設定配對遙控器，然後在這裡綁定；綁定後才會啟用遙控器麥克風與按鍵功能。',
      'binding.scan': '掃描已配對的遙控器',
      'binding.scanning': '掃描中…',
      'binding.bind': '綁定',
      'binding.unbind': '解除綁定',
      'binding.bound': '已綁定：{name}（{serial}）',
      'binding.empty': '找不到遙控器：請確認系統藍牙已連上「小米藍牙語音遙控器」，再按掃描。',
      'binding.pro2Only': '暫時只支援「小米藍牙語音遙控器 2 Pro」（RC003），其他型號稍後支援。',
      'remoteMic.notBound': '尚未綁定遙控器：先在上面的「遙控器綁定」完成綁定。',
      'remoteMic.title': '遙控器麥克風（ATVV）',
      'remoteMic.hint': '不裝任何 App：插件第一次使用時用系統內建的 Swift 編譯一支小幫手，直接從遙控器收音，按住語音鍵講、放開就出結果。',
      'remoteMic.enable': '啟用',
      'remoteMic.disable': '停止',
      'remoteMic.idle': '未啟動',
      'remoteMic.provisioning': '首次使用：正在用系統 Swift 編譯小幫手（約 10–30 秒）…',
      'remoteMic.starting': '正在啟動…',
      'remoteMic.ready': '已連線：{device}',
      'remoteMic.recording': '正在收音…',
      'remoteMic.reconnecting': '連線中斷，正在重連…',
      'remoteMic.error': '錯誤：{message}',
      'remoteMic.planned': 'Windows 版的遙控器麥克風尚未實作；請先用系統麥克風。',
      'remoteMic.unsupported': '此平台不支援遙控器麥克風；請先用系統麥克風。',
      'remoteMic.unavailable': '這個宿主沒有遙控器麥克風路由（可能未重新載入 DSH）。',
      'remoteMic.how': '用法：系統藍牙先連好遙控器 → 啟用 → 按住遙控器語音鍵講話 → 放開。macOS 可能要求一次藍牙權限。',
      'remoteMic.empty': '已連線，等待你按住語音鍵…',
      'remoteMic.done': '遙控器收音完成（{seconds} 秒）',
      'remoteMic.model': '模型：{phase}',
      'remoteVoice.recording': '錄音中',
      'remoteVoice.state.ready': '已連線',
      'remoteVoice.state.idle': '待機',
      'remoteVoice.state.busy': '連線中',
      'remoteVoice.state.error': '錯誤',
      'remoteVoice.tip': '遙控器麥克風：{state}。點擊開啟插件面板。',
      'section.hotkey': '鍵盤快捷鍵',
      'hotkey.hint': '錄製你自己的快捷鍵：按住錄音、放開即出字（用系統麥克風）。視窗要有焦點；跨 App 需另開輔助使用權限。',
      'hotkey.learn': '錄製快捷鍵',
      'hotkey.learning': '請按下你要的快捷鍵（Esc 取消）…',
      'hotkey.clear': '清除',
      'hotkey.recording': '錄音中…',
      'hotkey.transcribing': '辨識中…',
      'hotkey.copy': '複製到剪貼簿（不插入草稿）',
      'hotkey.missing': '未設定快捷鍵',
      'section.keys': '遙控器按鍵接管',
      'keys.hint': '接管後遙控器按鍵唔會再傳去 macOS；按一下學習，再揀動作。需要「輸入監控」權限。',
      'keys.seized': '已接管按鍵',
      'keys.notSeized': '未接管：{error}',
      'keys.learning': '最近按鍵：{keys}',
      'keys.empty': '尚未收到按鍵；按住遙控器任何鍵試試。',
      'keys.none': '（不處理）',
      'keys.action.panel': '開啟插件面板',
      'keys.action.last': '插入上次辨識結果',
      'legend.success': '綠：已連線／可用',
      'legend.warn': '黃：準備中／重新連線',
      'legend.error': '紅：錯誤，需處理',
      'legend.muted': '灰：待機／未啟用',
      'remoteMic.warm': '預熱模型',
      'panel.version': 'v{version}',
      'panel.version.host': 'client v{client} · host v{host}',
      'panel.version.mismatch': '版本不一致：請重新載入頁面，或重新載入插件。',

      'error.permission': '麥克風權限未開啟，請在瀏覽器與系統設定中允許。',
      'error.unavailable': '這個瀏覽器不支援錄音。',
      'error.empty': '沒有錄到聲音。',
      'error.cancelled': '錄音已取消。',
      'error.interrupted': '麥克風中斷，請重試。',
      'error.deviceMissing': '找不到選定的麥克風，請改選其他裝置。',
      'hant.callout': '目前預設是一般 SenseVoice，要測簡轉繁請切到「SenseVoice（繁體）」。',
      'hant.switch': '切換到 SenseVoice（繁體）',

      'error.unknown': '發生未預期的錯誤。',
    }

    /** English dictionary; mirrors the key set of `zh` exactly (a test enforces it). */
    const en = {
      'panel.title': 'Traditional Chinese voice',
      'panel.subtitle': 'A test console for the Traditional Chinese speech pipeline',
      'panel.intro': 'Exercise the whole speech path here: pick a recognizer, record, then read the raw (Simplified) transcript beside the Traditional result. Recognition stays on this machine with the bundled SenseVoice model; the host-side sensevoice-hant provider only rewrites the finished text. Audio never leaves the machine.',
      'panel.refresh': 'Refresh',
      'panel.status.connected': 'Speech service connected',
      'panel.status.connecting': 'Connecting to the speech service…',
      'panel.status.missing': 'Speech service not found',
      'panel.status.error': 'The speech service rejected a call',
      'panel.missingService': 'The speech service is not ready. Enable the bundled voice-input bundle in Settings → Extensions, then reload the page.',
      'panel.retry': 'Retry',
      'panel.loadingProviders': 'Reading recognizers…',
      'panel.noProviders': 'No recognizer is available yet.',
      'panel.crash': '語音輸入面板發生錯誤',
      'panel.crashHint': '請重新載入頁面；若持續發生，請把下面這段訊息附在回報裡。',
      'panel.crash': 'The Traditional Chinese panel crashed',
      'panel.crashHint': 'Reload the page; if it keeps happening, include the message below in a report.',
      'panel.footnote': 'Recognition always uses the local SenseVoice model; the Traditional conversion is a separate step configured in the card above, with immediate effect.',

      'section.providers': 'Recognizers',
      'section.convert': 'Traditional conversion',
      'convert.hint': 'Recognition produces plain text first; this step turns it into Traditional Chinese. Changes apply immediately to the console, the remote microphone and the built-in “SenseVoice（繁體）” provider.',
      'convert.enable': 'Enable conversion',
      'convert.variant': 'Variant',
      'convert.glossary': 'Glossary ({ "simplified/traditional": "replacement" }, matched after conversion)',
      'convert.save': 'Save glossary',
      'convert.saved': 'Saved',
      'convert.error': 'Conversion settings error: ',
      'convert.disabled': 'Conversion is off: recognition keeps the original Simplified text.',
      'convert.variant.s2hk': 'Hong Kong (s2hk)',
      'convert.variant.s2twp': 'Taiwan (s2twp)',
      'convert.variant.s2tw': 'Taiwan characters (s2tw)',
      'convert.variant.s2t': 'Characters only (s2t)',
      'section.providersHint': 'Pick one as the default; the choice is written to the DSH speech settings.',
      'section.recorder': 'Test recording',
      'section.remote': 'Remote (Bluetooth HID)',

      'provider.local': 'On this machine',
      'provider.cloud': 'Cloud',
      'provider.languages': '{count} languages',
      'provider.default': 'Default',
      'provider.setDefault': 'Set as default',
      'provider.prepare': 'Download model',
      'provider.retryPrepare': 'Retry preparation',
      'provider.cancelPrepare': 'Cancel preparation',
      'provider.source': 'Model download source',
      'provider.sourceAuto': 'Automatic (recommended)',
      'provider.download': 'Downloading {resource}: {completed} / {total} MB ({percent}%)',
      'provider.downloadUnknown': 'Downloaded {resource}: {completed} MB',
      'provider.failed': 'Preparation failed: {message}',
      'provider.retryHint': 'Retry is safe: files already downloaded and verified are kept.',

      'phase.ready': 'Ready',
      'phase.standby': 'Standby',
      'phase.waking': 'Waking',
      'phase.unprepared': 'Not prepared',
      'phase.downloading': 'Downloading',
      'phase.checking': 'Checking',
      'phase.loading': 'Loading',
      'phase.cancelling': 'Cancelling',
      'phase.cancelled': 'Cancelled',
      'phase.failed': 'Failed',
      'phase.unknown': 'Unknown',

      'step.check': 'Check local resources',
      'step.model': 'Prepare recognition model',
      'step.vad': 'Prepare voice detection model',
      'step.verify': 'Verify model files',
      'step.load': 'Load model',

      'language.label': 'Recognition language',
      'language.auto': 'Detect automatically',
      'language.zh': 'Chinese',
      'language.yue': 'Cantonese',
      'language.en': 'English',
      'language.ja': 'Japanese',
      'language.ko': 'Korean',

      'mic.label': 'Microphone',
      'mic.default': 'System default microphone',
      'mic.named': 'Microphone {number}',
      'mic.refresh': 'Refresh',
      'mic.allow': 'Allow microphone',
      'mic.permissionDenied': 'Microphone permission was denied',
      'mic.unavailable': 'This browser cannot record audio',
      'mic.loading': 'Microphone list not available yet',
      'mic.missingDevice': 'Microphone disconnected',
      'mic.bridge': 'BlackHole detected: a bridge app writes the remote’s own microphone (ATVV) into it. Select it, then trigger recording from the remote.',
      'mic.useBridge': 'Use BlackHole',
      'mic.bridgeSelected': 'Using BlackHole as the microphone: keep open-voice-bridge running and trigger recording with the remote’s push-to-talk key.',

      'record.start': 'Start recording',
      'record.stop': 'Stop and transcribe',
      'record.requesting': 'Requesting the microphone…',
      'record.transcribing': 'Transcribing…',
      'record.cancel': 'Cancel',
      'record.recording': 'Recording',
      'record.timer': '{elapsed}s / {max}s',
      'record.play': 'Play this recording',
      'record.noProvider': 'Choose a recognizer first.',
      'record.notReady': 'This recognizer is not ready yet: download its model above, or choose another service.',
      'record.tooLarge': 'The recording exceeds the service limit; record a shorter sample.',
      'record.limit': 'Up to {max} seconds',
      'record.readyHint': 'After a recording, the results appear below and can be copied or played back.',

      'result.hant': 'Traditional text',
      'result.transcript': 'Transcript',
      'result.raw': 'Simplified source',
      'result.copy': 'Copy',
      'result.copied': 'Copied',
      'result.copyFailed': 'Could not write to the clipboard.',
      'result.placeholder': 'The result appears here after recording.',
      'result.rawUnavailable': '(the Simplified source is unavailable)',
      'result.comparing': 'Fetching the Simplified source…',
      'result.timing': 'Audio {audio}s · Inference {inference}s · Round trip {round}s',
      'result.latency': 'Key-up to text {total} ms (wait {wait} · inference {infer})',
      'remoteMic.transport.connecting': 'Event stream: connecting…',
      'remoteMic.transport.sse': 'Event stream: live',
      'remoteMic.transport.poll': 'Event stream: polling fallback',

      'remote.headHint': 'Controls this console only: keys arrive while the panel is open, and it never drives dictation in the composer.',
      'remote.ready': 'Remote ready (this panel only)',
      'remote.idle': 'No button bound yet',
      'remote.stopHint': '“Stop while recording” is a second key: it only stops a recording, never starts one.',
      'remote.modifier': 'Modifier keys cannot be bound alone; press a normal key.',
      'remote.scope': 'These keys work only while this panel is open, and never while you are typing in a text field.',
      'remote.toggle': 'Start and stop',
      'remote.stop': 'Stop while recording',
      'remote.bind': 'Bind',
      'remote.rebind': 'Rebind',
      'remote.listening': 'Press the remote…',
      'remote.pressNow': 'Waiting for a key: press the remote button you want to bind (press Esc to cancel).',
      'remote.clear': 'Clear',
      'remote.clearAll': 'Clear all',
      'remote.unbound': 'Not bound',
      'remote.keyLog': 'Recent keys',
      'remote.keyLogEmpty': 'No key received yet. Press a remote button; the key it sends is listed here. If nothing appears, the system consumed that key first.',
      'remote.triggered': 'Remote triggered',
      'remote.bound': 'Key bound',
      'remote.conflict': 'Both rows are bound to the same key; “Start and stop” wins.',
      'remote.media': 'Media keys such as volume and play are consumed by macOS before the page sees them; bind a different button instead.',
      'remote.bridge': 'To record the remote’s own microphone, bridge ATVV into a system input first (open-voice-bridge + BlackHole; see docs/DETAIL.md), then pick BlackHole as the microphone.',
      'remote.hold': 'Push to talk (release to stop)',
      'remote.holdHint': 'Off means toggle: press once to start, again to stop. If the remote only sends key-down without key-up, keep it off.',

      'remoteVoice.short': 'Remote',
      'remoteVoice.idle': 'Remote microphone: off (click to open the console)',
      'remoteVoice.ready': 'Remote microphone: connected',
      'remoteVoice.recording': 'Remote microphone: recording',
      'remoteVoice.error': 'Remote microphone: error',
      'remoteVoice.unavailable': 'Remote microphone: unavailable',
      'binding.title': 'Remote binding',
      'binding.hint': 'Pair the remote in macOS Bluetooth first, then bind it here. The remote microphone and remote keys stay disabled until a device is bound.',
      'binding.scan': 'Scan paired remotes',
      'binding.scanning': 'Scanning…',
      'binding.bind': 'Bind',
      'binding.unbind': 'Unbind',
      'binding.bound': 'Bound: {name} ({serial})',
      'binding.empty': 'No remote found: connect “Xiaomi Bluetooth Voice Remote” in macOS Bluetooth, then scan again.',
      'binding.pro2Only': 'Only the Xiaomi Bluetooth Voice Remote 2 Pro (RC003) is supported for now; other models come later.',
      'remoteMic.notBound': 'No remote is bound yet: bind one under “Remote binding” above.',
      'remoteMic.title': 'Remote microphone (ATVV)',
      'remoteMic.hint': 'No app to install: on first use the plugin compiles a small helper with the system Swift toolchain and records from the remote itself. Hold the voice key, speak, release.',
      'remoteMic.enable': 'Enable',
      'remoteMic.disable': 'Stop',
      'remoteMic.idle': 'Not started',
      'remoteMic.provisioning': 'First use: compiling the helper with the system Swift toolchain (about 10–30 s)…',
      'remoteMic.starting': 'Starting…',
      'remoteMic.ready': 'Connected: {device}',
      'remoteMic.recording': 'Recording…',
      'remoteMic.reconnecting': 'Connection lost, reconnecting…',
      'remoteMic.error': 'Error: {message}',
      'remoteMic.planned': 'The Windows remote-microphone backend is not implemented yet; use the system microphone for now.',
      'remoteMic.unsupported': 'This platform does not support the remote microphone; use the system microphone for now.',
      'remoteMic.unavailable': 'This host exposes no remote-microphone route (DSH may not have been reloaded).',
      'remoteMic.how': 'Connect the remote in macOS Bluetooth first, then enable, then hold the remote voice key and speak. macOS may ask for Bluetooth permission once.',
      'remoteMic.empty': 'Connected; waiting for you to hold the voice key…',
      'remoteMic.done': 'Remote microphone utterance captured ({seconds} s)',
      'remoteMic.model': 'Model: {phase}',
      'remoteVoice.recording': 'Recording',
      'remoteVoice.state.ready': 'connected',
      'remoteVoice.state.idle': 'standby',
      'remoteVoice.state.busy': 'connecting',
      'remoteVoice.state.error': 'error',
      'remoteVoice.tip': 'Remote microphone: {state}. Click to open the panel.',
      'section.hotkey': 'Keyboard shortcut',
      'hotkey.hint': 'Record your own shortcut: hold to talk, release to insert (system microphone). The window must be focused; global use needs Accessibility.',
      'hotkey.learn': 'Record shortcut',
      'hotkey.learning': 'Press the shortcut you want (Esc to cancel)…',
      'hotkey.clear': 'Clear',
      'hotkey.recording': 'Recording…',
      'hotkey.transcribing': 'Transcribing…',
      'hotkey.copy': 'Copy to clipboard (do not insert)',
      'hotkey.missing': 'No shortcut set',
      'section.keys': 'Remote key interception',
      'keys.hint': 'Once seized, the remote no longer reaches macOS. Press a key to learn it, then choose an action. Needs Input Monitoring permission.',
      'keys.seized': 'Keys seized',
      'keys.notSeized': 'Not seized: {error}',
      'keys.learning': 'Recent keys: {keys}',
      'keys.empty': 'No keys captured yet; press any remote key.',
      'keys.none': '(ignored)',
      'keys.action.panel': 'Open the panel',
      'keys.action.last': 'Insert the last transcript',
      'legend.success': 'Green: connected / ready',
      'legend.warn': 'Amber: preparing / reconnecting',
      'legend.error': 'Red: error, needs attention',
      'legend.muted': 'Grey: idle / disabled',
      'remoteMic.warm': 'Warm model',
      'panel.version': 'v{version}',
      'panel.version.host': 'client v{client} · host v{host}',
      'panel.version.mismatch': 'Version mismatch: reload the page or remount the plugin.',

      'error.permission': 'Microphone permission is off. Allow it in the browser and system settings.',
      'error.unavailable': 'This browser cannot record audio.',
      'error.empty': 'Nothing was recorded.',
      'error.cancelled': 'The recording was cancelled.',
      'error.interrupted': 'The microphone was interrupted; try again.',
      'error.deviceMissing': 'The selected microphone is unavailable; choose another device.',
      'hant.callout': 'The default recognizer is plain SenseVoice; switch to “SenseVoice（繁體）” to test the conversion.',
      'hant.switch': 'Switch to SenseVoice（繁體）',

      'error.unknown': 'An unexpected error occurred.',
    }

    /** Fill `{name}` placeholders the same way the Host translator does. */
    function interpolate(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
    }

    // ───────────────────── storage (best effort) ─────────────────────
    const store = {
      read(key, fallback) {
        try {
          const value = window.localStorage.getItem(key)
          return value === null ? fallback : value
        } catch { return fallback }
      },
      write(key, value) {
        try {
          if (value === undefined || value === null || value === '') window.localStorage.removeItem(key)
          else window.localStorage.setItem(key, value)
        } catch { /* private mode: keep the in-memory value only */ }
      },
    }

    // ───────────────────── remote key bindings ─────────────────────
    /** Compact modifier prefix for labels (macOS symbols, the platform this console targets). */
    function modifierText(event) {
      return `${event.ctrlKey ? '⌃' : ''}${event.altKey ? '⌥' : ''}${event.shiftKey ? '⇧' : ''}${event.metaKey ? '⌘' : ''}`
    }

    /** Descriptor shape stored for one bound key, including the modifiers it requires. */
    function describeBinding(event) {
      const key = event.key === ' ' ? 'Space' : event.key
      const prefix = modifierText(event)
      return {
        key: event.key,
        code: typeof event.code === 'string' ? event.code : '',
        ctrl: event.ctrlKey === true,
        alt: event.altKey === true,
        shift: event.shiftKey === true,
        meta: event.metaKey === true,
        label: `${prefix}${key} · ${event.code || '—'}`,
      }
    }

    /** Accept both the stored JSON string and an already parsed descriptor. */
    function normalizeBinding(value) {
      if (value === undefined || value === null || value === '') return null
      let parsed = value
      if (typeof value === 'string') {
        try { parsed = JSON.parse(value) } catch { return null }
      }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.key !== 'string' || parsed.key === '') return null
      const key = parsed.key
      const code = typeof parsed.code === 'string' ? parsed.code : ''
      const modifiers = {
        ctrl: parsed.ctrl === true,
        alt: parsed.alt === true,
        shift: parsed.shift === true,
        meta: parsed.meta === true,
      }
      const prefix = `${modifiers.ctrl ? '⌃' : ''}${modifiers.alt ? '⌥' : ''}${modifiers.shift ? '⇧' : ''}${modifiers.meta ? '⌘' : ''}`
      const label = typeof parsed.label === 'string' && parsed.label !== ''
        ? parsed.label
        : `${prefix}${key === ' ' ? 'Space' : key} · ${code || '—'}`
      return { key, code, ...modifiers, label }
    }

    function loadBindings() {
      return {
        toggle: normalizeBinding(store.read(STORAGE.remoteToggle, '')),
        stop: normalizeBinding(store.read(STORAGE.remoteStop, '')),
      }
    }

    function persistBinding(which, binding) {
      store.write(which === 'toggle' ? STORAGE.remoteToggle : STORAGE.remoteStop, binding === null ? '' : JSON.stringify(binding))
    }

    /**
     * Match a binding exactly, modifiers included: a bridge app can inject a hold
     * shortcut such as ⌃⌥Space, while a plain key binding must not fire when the
     * user happens to hold ⌘ for an unrelated shortcut.
     */
    function bindingForEvent(bindings, event) {
      const matches = (binding) => binding !== null
        && binding.key === event.key
        && (binding.code === '' || binding.code === event.code)
        && binding.ctrl === (event.ctrlKey === true)
        && binding.alt === (event.altKey === true)
        && binding.shift === (event.shiftKey === true)
        && binding.meta === (event.metaKey === true)
      if (matches(bindings.toggle)) return 'toggle'
      if (matches(bindings.stop)) return 'stop'
      return null
    }

    /** Keys that only make sense together with another key. */
    const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'CapsLock']

    /** Localized label for a preparation phase. */
    function phaseLabel(say, phase) {
      const known = ['ready', 'standby', 'waking', 'unprepared', 'downloading', 'checking', 'loading', 'cancelling', 'cancelled', 'failed']
      return known.includes(phase) ? say(`phase.${phase}`) : (phase ? String(phase) : say('phase.unknown'))
    }

    /** Host monospace stack, with the plain-CSS fallback for older builds. */
    const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

    function sameBinding(left, right) {
      return left !== null && right !== null
        && left.key === right.key && left.code === right.code
        && left.ctrl === right.ctrl && left.alt === right.alt
        && left.shift === right.shift && left.meta === right.meta
    }

    /** Text fields keep their keys: a bound key must never start a recording while typing. */
    function isTypingTarget(target) {
      if (!(target instanceof Element)) return false
      if (target instanceof HTMLElement && target.isContentEditable) return true
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    }

    // ───────────────────── microphone capture ─────────────────────
    // Port of the shipped voice-input flow: canonical 16 kHz mono PCM16 WAV on
    // stop, so the host-side speech service accepts it without re-encoding.
    class RecordingError extends Error {
      constructor(kind) { super(kind); this.name = 'RecordingError'; this.kind = kind }
    }

    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    function audioBase64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return btoa(text)
    }

    /** One microphone acquisition with the same resampling path the host expects. */
    class Recording {
      static warmStream = null

      constructor(onDispose, deviceId = '') {
        this.onDispose = onDispose
        this.deviceId = deviceId
        this.samples = new Float32Array(256)
        this.chunks = []
        this.lifetime = new AbortController()
        this.disposal = undefined
      }

      async preview(onError) {
        const devices = navigator.mediaDevices
        if (!devices) throw new RecordingError('unavailable')
        let stream = Recording.warmStream
        this.shared = stream !== null && stream !== undefined
        try {
          if (stream === null || stream === undefined) stream = await devices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              ...(this.deviceId === '' ? {} : { deviceId: { exact: this.deviceId } }),
            },
            video: false,
          })
        } catch (error) {
          if (error instanceof DOMException) {
            if (error.name === 'NotAllowedError') throw new RecordingError('permission')
            if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') throw new RecordingError('deviceMissing')
          }
          throw error
        }
        if (this.lifetime.signal.aborted) {
          stream.getTracks().forEach((track) => { track.stop() })
          throw new RecordingError('cancelled')
        }
        this.stream = stream
        try {
          this.context = new AudioContext()
          this.analyser = this.context.createAnalyser()
          this.analyser.fftSize = this.samples.length
          this.context.createMediaStreamSource(stream).connect(this.analyser)
          for (const track of stream.getTracks()) {
            track.addEventListener('ended', () => { this.interrupted(onError) }, { signal: this.lifetime.signal })
          }
        } catch (error) { await this.dispose(); throw error }
      }

      async start(onError) {
        if (typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable')
        await this.preview(onError)
        if (this.lifetime.signal.aborted) throw new RecordingError('cancelled')
        try {
          this.recorder = new MediaRecorder(this.stream)
          this.recorder.ondataavailable = (event) => {
            if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data)
          }
          this.recorder.onerror = () => { this.interrupted(onError) }
          this.recorder.start()
        } catch (error) { await this.dispose(); throw error }
      }

      interrupted(onError) {
        if (this.lifetime.signal.aborted) return
        void this.dispose().catch(() => undefined)
        try { onError?.(new RecordingError('interrupted')) } catch { /* handler is a UI callback */ }
      }

      amplitude() {
        if (!this.analyser) return 0
        this.analyser.getFloatTimeDomainData(this.samples)
        let sum = 0
        for (const sample of this.samples) sum += sample * sample
        return Math.sqrt(sum / this.samples.length)
      }

      async stop(maxDurationSeconds) {
        const recorder = this.recorder
        const context = this.context
        if (!recorder || !context || recorder.state !== 'recording') {
          await this.dispose()
          throw new RecordingError('empty')
        }
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => { resolve() }
            recorder.onerror = () => { reject(new RecordingError('empty')) }
            recorder.stop()
          })
          this.stream.getTracks().forEach((track) => { track.stop() })
          this.lifetime.signal.throwIfAborted()
          const blob = new Blob(this.chunks, { type: recorder.mimeType })
          if (blob.size === 0) throw new RecordingError('empty')
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          this.lifetime.signal.throwIfAborted()
          const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000))
          const offline = new OfflineAudioContext(1, frames, 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const resampled = await offline.startRendering()
          this.lifetime.signal.throwIfAborted()
          return encodeWave(resampled.getChannelData(0))
        } finally { await this.dispose() }
      }

      dispose() {
        if (!this.disposal) this.disposal = this.release().catch(() => undefined)
        return this.disposal
      }

      async release() {
        this.lifetime.abort(new RecordingError('cancelled'))
        if (this.recorder?.state === 'recording') this.recorder.stop()
        if (this.shared !== true) this.stream?.getTracks().forEach((track) => { track.stop() })
        this.stream = undefined
        const context = this.context
        this.context = undefined
        this.analyser = undefined
        this.chunks = []
        try { if (context && context.state !== 'closed') await context.close() } finally { this.onDispose() }
      }
    }

    /** Unwrap the Remote envelope the speech namespace returns. */
    async function unwrap(promise) {
      const result = await promise
      if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok) throw result.error ?? new Error('speech remote call failed')
        return result.value
      }
      return result
    }

    /** Readable text for an unknown failure. */
    function errorText(error) {
      if (error instanceof Error) return error.message
      if (error && typeof error === 'object' && 'message' in error) return String(error.message)
      return String(error)
    }

    /** Fetch one plugin route as JSON, same-origin, never cached. */
    async function fetchJson(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /** Fetch one plugin route as bytes. */
    async function fetchBytes(path) {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    }

    // ───────────────────── small helpers ─────────────────────
    const TONE = {
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      accent: 'var(--dsw-alias-brand-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
    }

    const ACTIVE_PREPARATION = ['downloading', 'checking', 'loading', 'waking', 'cancelling']

    function phaseTone(phase) {
      if (phase === 'ready' || phase === 'standby') return 'success'
      if (ACTIVE_PREPARATION.includes(phase)) return 'warn'
      if (phase === 'failed') return 'error'
      return 'muted'
    }

    function megabytes(bytes) {
      return (bytes / 1024 / 1024).toFixed(1)
    }

    function formatSeconds(value) {
      return Number.isFinite(value) ? value.toFixed(2) : '0.00'
    }

    function languageLabel(say, code) {
      const known = ['auto', 'zh', 'yue', 'en', 'ja', 'ko']
      return known.includes(code) ? say(`language.${code}`) : code
    }

    // ───────────────────── styles (theme tokens only) ─────────────────────
    const STYLE_ID = 'dsh-stt-hant-styles'
    const CSS = `
      /* Calm developer-tool surface: hairline cards, 4/8 spacing rhythm, one
         primary action per section, host theme tokens only. */
      .stt-root { flex: 1 1 auto; height: 100%; min-height: 0; box-sizing: border-box;
        display: flex; flex-direction: column; align-items: center;
        padding: 0 clamp(20px, 3.5vw, 40px); color: var(--dsw-alias-label-primary); font: inherit; }
      .stt-scroll { flex: 1 1 auto; min-height: 0; width: 100%; overflow-x: hidden; overflow-y: auto;
        padding: calc(30px + var(--dsh-frame-top-clearance, 0px)) 0 64px; scrollbar-gutter: stable; }
      .stt-column { width: 100%; max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }

      .stt-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
      .stt-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 650; letter-spacing: -.01em; }
      .stt-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .stt-intro { margin: 0; max-width: 68ch; font-size: 13px; line-height: 1.75;
        color: var(--dsw-alias-label-secondary); }

      .stt-card { display: flex; flex-direction: column; gap: 16px; padding: 20px;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-layer-1); }
      .stt-card-head { display: flex; flex-direction: column; gap: 4px; }
      .stt-card-title { margin: 0; font-size: 11px; line-height: 1.4; font-weight: 650;
        letter-spacing: .12em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .stt-card-hint { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }

      .stt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .stt-grow { flex: 1 1 auto; min-width: 0; }

      /* Controls */
      .stt-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; height: 32px; padding: 0 12px; border-radius: 10px;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        background: transparent; color: var(--dsw-alias-label-primary); font: inherit;
        font-size: 12.5px; font-weight: 550; line-height: 1; white-space: nowrap; cursor: pointer;
        transition: background .14s ease, border-color .14s ease, color .14s ease,
          opacity .14s ease, transform .06s ease; }
      .stt-btn:active:not(:disabled) { transform: translateY(.5px); }
      .stt-btn:disabled { opacity: .42; cursor: not-allowed; }
      .stt-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color,
        var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .stt-btn[data-primary='true'] { border-color: transparent;
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
        color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); }
      .stt-btn[data-active='true'] { border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
      .stt-btn[data-big='true'] { height: 46px; padding: 0 24px; font-size: 14px;
        border-radius: var(--dsw-radius-md, 12px); }
      .stt-btn[data-small='true'] { height: 24px; padding: 0 9px; font-size: 11.5px;
        border-radius: 8px; font-weight: 500; }
      @media (hover: hover) {
        .stt-btn:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
        .stt-btn[data-primary='true']:hover:not(:disabled) {
          background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
      }
      .stt-icon { width: 15px; height: 15px; display: block; flex: 0 0 auto; }

      .stt-select { height: 32px; padding: 0 10px; border-radius: 10px; min-width: 0;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12.5px; }
      .stt-select:focus-visible { outline: 2px solid var(--dsw-focus-ring-color,
        var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .stt-input { width: 100%; box-sizing: border-box; min-height: 84px; resize: vertical;
        padding: 10px 12px; border-radius: 10px;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px; line-height: 1.6; }
      .stt-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color,
        var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

      /* Status */
      .stt-pill { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 10px;
        border: 0; border-radius: 999px; font-size: 11.5px; font-weight: 550; line-height: 1;
        color: var(--stt-tone, var(--dsw-alias-label-secondary));
        background: color-mix(in srgb, var(--stt-tone, var(--dsw-alias-label-secondary)) 12%, transparent); }
      .stt-pill .stt-dot { background: currentColor; }
      .stt-dot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; flex: 0 0 auto; }
      .stt-glyph { width: 13px; height: 13px; display: block; flex: 0 0 auto; }
      .stt-legend { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding-top: 2px;
        font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .stt-legend-item { display: inline-flex; align-items: center; gap: 5px; }

      /* Recognizers */
      .stt-provider { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        padding: 12px 14px; border-radius: 12px; border: .5px solid transparent;
        background: var(--dsw-alias-bg-layer-2); }
      .stt-provider[data-active='true'] {
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); }
      .stt-radio { width: 15px; height: 15px; margin: 0; flex: 0 0 auto;
        accent-color: var(--dsw-alias-brand-primary); }
      .stt-radio:focus-visible { outline: 2px solid var(--dsw-focus-ring-color,
        var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
      .stt-provider-name { font-size: 13.5px; font-weight: 550; line-height: 1.4; }
      .stt-provider-meta { margin-top: 2px; font-size: 11.5px; line-height: 1.4;
        color: var(--dsw-alias-label-secondary); }
      .stt-provider-side { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .stt-detail { flex: 1 1 100%; display: flex; flex-direction: column; gap: 8px; }
      .stt-progress { height: 4px; border-radius: 999px; overflow: hidden;
        background: color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); }
      .stt-progress > span { display: block; height: 100%; border-radius: 999px;
        background: var(--dsw-alias-brand-primary); transition: width .2s ease; }

      /* Copy */
      .stt-note { margin: 0; font-size: 12px; line-height: 1.65;
        color: var(--dsw-alias-label-secondary); }
      .stt-note[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
      .stt-note[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
      .stt-note[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
      .stt-notice { position: sticky; top: 8px; z-index: 2; margin: 0; padding: 10px 12px;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
        font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent); }
      .stt-notice[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
      .stt-notice[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
      .stt-notice[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
      .stt-callout { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        padding: 12px 14px; border-radius: 12px;
        border: .5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);
        font-size: 12.5px; line-height: 1.6; }
      .stt-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px; line-height: 1.5; padding: 3px 8px; border-radius: 7px;
        background: var(--dsw-alias-bg-layer-2);
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); }

      /* Recording + results */
      .stt-wave { display: block; width: 100%; height: 44px; color: var(--dsw-alias-brand-primary); }
      .stt-audio { width: 100%; height: 34px; }
      .stt-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 12px; align-items: start; }
      .stt-result { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
        border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
        border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }
      .stt-result[data-accent='true'] {
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
      .stt-result-head { display: flex; align-items: center; gap: 8px; min-height: 24px; }
      .stt-result-label { font-size: 10.5px; font-weight: 650; letter-spacing: .1em;
        text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .stt-result-head .stt-btn { margin-left: auto; }
      .stt-result-text { font-size: 15px; line-height: 1.75; white-space: pre-wrap;
        word-break: break-word; min-height: 26px; }
      .stt-result-text[data-empty='true'] { color: var(--dsw-alias-label-secondary); }

      /* Remote bindings + keys */
      .stt-binding { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); }
      .stt-binding:last-of-type { border-bottom: none; padding-bottom: 0; }
      .stt-binding-label { min-width: 120px; font-size: 13px; font-weight: 550; }
      .stt-binding-actions { margin-left: auto; display: flex; gap: 8px; }
      .stt-subrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 0 10px; }
      .stt-listening { padding: 11px 14px; border-radius: 12px; font-size: 12.5px; line-height: 1.6;
        border: .5px dashed var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
      .stt-log { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow: auto; }
      .stt-log-row { display: flex; align-items: center; gap: 12px; padding: 3px 0;
        font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .stt-log-row[data-match='true'] { color: var(--dsw-alias-state-success-primary); }
      .stt-time { min-width: 82px; opacity: .75; }
      .stt-toggle { display: inline-flex; align-items: center; gap: 8px; height: 26px;
        font-size: 12.5px; cursor: pointer; user-select: none; }
      .stt-toggle input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
      .stt-toggle input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color,
        var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

      .stt-fatal { padding: 24px; font-size: 12.5px; line-height: 1.7;
        color: var(--dsw-alias-state-error-primary); }
      .stt-fatal pre { margin: 10px 0 0; white-space: pre-wrap;
        font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        opacity: .8; }
      @media (prefers-reduced-motion: reduce) {
        .stt-btn, .stt-progress > span { transition: none; }
      }
    `

    /** Mount the stylesheet once; unmounting the panel removes it. */
    function Styles() {
      return h('style', { 'data-dsh-stt-hant': STYLE_ID }, CSS)
    }

    // ───────────────────── icons ─────────────────────
    /**
     * Sidebar glyph: two strokes of the same word — the simplified 语 and the
     * traditional 語 — which is the conversion this bundle performs.
     */
    function PanelIcon({ size, active }) {
      const edge = typeof size === 'number' ? size : 20
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
        h('rect', {
          x: 9, y: 3, width: 6, height: 11, rx: 3,
          stroke: 'currentColor', strokeWidth: 1.7,
        }),
        h('path', {
          d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        }),
      )
    }

    function MicIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' },
      },
        h('path', {
          d: 'M12 15.5a3.75 3.75 0 0 0 3.75-3.75V6a3.75 3.75 0 1 0-7.5 0v5.75A3.75 3.75 0 0 0 12 15.5Z',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M5.75 11.75a6.25 6.25 0 0 0 12.5 0M12 18v3', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function RefreshIcon({ size = 15 }) {
      return h('svg', { className: 'stt-icon', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5', stroke: 'currentColor',
          strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CopyIcon({ size = 13 }) {
      return h('svg', { className: 'stt-icon', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M5.5 15V6.5A1.5 1.5 0 0 1 7 5h8.5', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    function StopIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 8, y: 8, width: 8, height: 8, rx: 1.6, fill: 'currentColor' }))
    }

    // ───────────────────── presentation pieces ─────────────────────
    function Dot({ tone }) {
      return h('span', { className: 'stt-dot', style: { background: TONE[tone] ?? TONE.muted } })
    }

    function StatusGlyph({ tone }) {
      const color = 'currentColor'
      if (tone === 'success') {
        return h('svg', { className: 'stt-glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: color, strokeWidth: 1.5 }),
          h('path', { d: 'M5.2 8.2 7.2 10l3.6-4', fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }
      if (tone === 'error') {
        return h('svg', { className: 'stt-glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: color, strokeWidth: 1.5 }),
          h('path', { d: 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4', fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }))
      }
      if (tone === 'warn') {
        return h('svg', { className: 'stt-glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: color, strokeWidth: 1.5 }),
          h('path', { d: 'M8 4.7v3.9M8 11.1v.2', fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }))
      }
      return h('svg', { className: 'stt-glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: color, strokeWidth: 1.5 }),
        h('circle', { cx: 8, cy: 8, r: 2, fill: color }))
    }

    function StatusPill({ tone, children, hint }) {
      return h('span', {
        className: 'stt-pill',
        style: { '--stt-tone': TONE[tone] ?? TONE.muted },
        title: hint,
        'aria-label': hint,
      }, h(StatusGlyph, { tone }), children)
    }

    function PhaseBadge({ say, phase }) {
      return h(StatusPill, { tone: phaseTone(phase) }, phaseLabel(say, phase))
    }

    function ProgressBar({ percent, label }) {
      if (percent === null || percent === undefined) return null
      return h('div', {
        className: 'stt-progress', role: 'progressbar', 'aria-label': label,
        'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent),
      },
        h('span', { style: { width: `${Math.max(0, Math.min(100, percent))}%` } }))
    }

    /** Live microphone bars; geometry is written directly, never through state. */
    function Waveform({ recording, label }) {
      const ref = useRef(null)
      useEffect(() => {
        const svg = ref.current
        if (!svg) return undefined
        const bars = Array.from(svg.querySelectorAll('line')).reverse().map((element) => ({ element, level: 0 }))
        let frame = 0
        let previous = -Infinity
        const draw = (now) => {
          if (now - previous >= 50) {
            previous = now
            let next = recording?.amplitude() ?? 0
            for (const bar of bars) {
              const carried = bar.level
              bar.level = next
              next = carried
              const height = 1 + Math.min(1, bar.level * 5) * 17
              bar.element.setAttribute('y1', String(20 - height))
              bar.element.setAttribute('y2', String(20 + height))
            }
          }
          frame = window.requestAnimationFrame(draw)
        }
        frame = window.requestAnimationFrame(draw)
        return () => { window.cancelAnimationFrame(frame) }
      }, [recording])
      return h('svg', {
        ref, viewBox: '0 0 640 40', preserveAspectRatio: 'none', role: 'img', 'aria-label': label, className: 'stt-wave',
      }, Array.from({ length: 80 }, (_, index) => h('line', {
        key: index, x1: index * 8 + 4, x2: index * 8 + 4, y1: 19, y2: 21,
        stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', opacity: 0.25 + index / 120,
      })))
    }

    /** One titled result pane with its own copy control. */
    function ResultPane({ say, label, text, accent, placeholder, copied, onCopy, live = false }) {
      const value = text || ''
      return h('div', { className: 'stt-result', 'data-accent': accent ? 'true' : 'false' },
        h('div', { className: 'stt-result-head' },
          h('span', { className: 'stt-result-label' }, label),
          value
            ? h('button', {
              type: 'button', className: 'stt-btn', 'data-small': 'true',
              onClick: () => { onCopy(value) },
            }, h(CopyIcon, { size: 12 }), copied ? say('result.copied') : say('result.copy'))
            : null,
        ),
        h('div', {
          className: 'stt-result-text', 'data-empty': value ? 'false' : 'true',
          role: live ? 'status' : undefined, 'aria-live': live ? 'polite' : undefined,
        }, value || placeholder),
      )
    }

    /**
     * Compact composer control. It shows the remote microphone state, opens the
     * console on click, and — crucially — registers the composer's inputActions
     * so finished remote utterances are inserted into the draft even when the
     * sidebar console is not open.
     */
    function RemoteVoiceControl({ t, inputActions }) {
      const say = useCallback((key, params) => {
        let text
        try { text = t?.(key, params) } catch { text = undefined }
        if (typeof text !== 'string' || text === key) text = interpolate(zh[key] ?? key, params)
        return text
      }, [t])
      const [snapshot, setSnapshot] = useState({
        status: remoteMicRuntime.status,
        unavailable: remoteMicRuntime.unavailable,
      })
      useEffect(() => {
        const release = retainRemoteMicRuntime()
        const unsubscribe = subscribeRemoteMicRuntime(() => {
          setSnapshot({ status: remoteMicRuntime.status, unavailable: remoteMicRuntime.unavailable })
        })
        return () => { unsubscribe(); release() }
      }, [])
      useEffect(() => {
        remoteMicRuntime.insertion = inputActions ?? null
        return () => { if (remoteMicRuntime.insertion === inputActions) remoteMicRuntime.insertion = null }
      }, [inputActions])

      const status = snapshot.status
      const phase = status?.phase ?? 'idle'
      const tone = snapshot.unavailable || phase === 'error'
        ? 'error'
        : phase === 'ready'
          ? 'success'
          : phase === 'recording'
            ? 'accent'
            : phase === 'provisioning' || phase === 'starting' || phase === 'reconnecting'
              ? 'warn'
              : 'muted'
      const stateKey = snapshot.unavailable || phase === 'error' ? 'error'
        : phase === 'ready' ? 'ready'
          : phase === 'recording' ? 'recording'
            : phase === 'provisioning' || phase === 'starting' || phase === 'reconnecting' ? 'busy'
              : 'idle'
      const stateText = say(`remoteVoice.state.${stateKey === 'recording' ? 'busy' : stateKey}`)
      const label = snapshot.unavailable
        ? say('remoteVoice.unavailable')
        : status === null
          ? say('remoteVoice.idle')
          : phase === 'recording'
            ? say('remoteVoice.recording')
            : phase === 'ready'
              ? say('remoteVoice.ready')
              : phase === 'error'
                ? say('remoteVoice.error')
                : say('remoteVoice.idle')
      // The composer lives outside the console panel, so it carries its own copy
      // of the stylesheet; two copies are inert and keep both surfaces styled.
      return h(React.Fragment, null,
        h(Styles),
        h('button', {
          type: 'button',
          className: 'stt-btn',
          'data-small': 'true',
          title: label,
          'aria-label': label,
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px' },
          onClick: () => { openSpeechPanel() },
        }, h(Dot, { tone }), h('span', { style: { fontSize: 11 } },
          phase === 'recording' ? say('remoteVoice.recording') : `${say('remoteVoice.short')}：${stateText}`)),
      )
    }

    // ───────────────────── the console ─────────────────────
    function Panel({ t }) {
      const say = useCallback((key, params) => {
        let text
        try { text = t?.(key, params) } catch { text = undefined }
        if (typeof text !== 'string' || text === key) text = interpolate(zh[key] ?? key, params)
        return text
      }, [t])

      // ── speech service ──
      const [speech, setSpeech] = useState(speechNamespace)
      useEffect(() => subscribeSpeech(() => { setSpeech(speechNamespace) }), [])
      const [catalog, setCatalog] = useState(null)
      const [status, setStatus] = useState(speechNamespace ? 'connecting' : 'missing')
      const [serviceError, setServiceError] = useState('')
      const catalogRef = useRef(null)

      const applyCatalog = useCallback((next) => {
        catalogRef.current = next
        setCatalog(next)
        setStatus('ready')
        setServiceError('')
      }, [])

      const refresh = useCallback(async () => {
        const namespace = speechNamespace
        if (!namespace) return undefined
        try {
          const next = await unwrap(namespace.catalog())
          applyCatalog(next)
          return next
        } catch (error) {
          setStatus((previous) => (previous === 'ready' ? 'ready' : 'error'))
          setServiceError(errorText(error))
          return undefined
        }
      }, [applyCatalog])

      // Poll the catalog: a test console does not need the streaming machinery,
      // and polling also keeps preparation progress alive while a model downloads.
      useEffect(() => {
        if (!speech) {
          setStatus('missing')
          setCatalog(null)
          catalogRef.current = null
          return undefined
        }
        setStatus((previous) => (previous === 'ready' ? 'ready' : 'connecting'))
        let stopped = false
        let timer = 0
        const tick = async () => {
          await refresh()
          if (stopped) return
          const current = catalogRef.current
          const busy = current?.providers?.some((provider) => ACTIVE_PREPARATION.includes(provider.preparation?.phase)) ?? false
          timer = window.setTimeout(tick, document.visibilityState === 'hidden' ? 8000 : busy ? 1200 : 4000)
        }
        void tick()
        return () => { stopped = true; window.clearTimeout(timer) }
      }, [refresh, speech])

      const providers = catalog?.providers ?? []
      const selectedId = catalog?.selection?.providerId ?? ''
      const selected = providers.find((provider) => provider.id === selectedId)
      const maxDuration = catalog?.maxDurationSeconds ?? 120
      const maxAudioBytes = catalog?.maxAudioBytes ?? 0
      const READY_PHASES = ['ready', 'standby', 'waking']
      const selectedReady = selected !== undefined && READY_PHASES.includes(selected.preparation?.phase ?? 'ready')

      // ── microphones ──
      const [devices, setDevices] = useState([])
      const [deviceId, setDeviceId] = useState(() => store.read(STORAGE.microphone, ''))
      const [micNote, setMicNote] = useState('')

      const refreshDevices = useCallback(async () => {
        try {
          const list = await navigator.mediaDevices.enumerateDevices()
          setDevices(list.filter((device) => device.kind === 'audioinput'))
          setMicNote('')
        } catch {
          setMicNote(say('mic.unavailable'))
        }
      }, [say])

      useEffect(() => { void refreshDevices() }, [refreshDevices])

      const requestPermission = useCallback(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => { track.stop() })
          await refreshDevices()
        } catch (error) {
          const name = error instanceof DOMException ? error.name : ''
          setMicNote(name === 'NotAllowedError' ? say('mic.permissionDenied') : say('mic.unavailable'))
        }
      }, [refreshDevices, say])

      // ── recording + transcription ──
      const [phase, setPhase] = useState('idle') // idle | requesting | recording | transcribing | done | error
      const [message, setMessage] = useState('')
      const [messageTone, setMessageTone] = useState('info')
      const [elapsed, setElapsed] = useState(0)
      const [hantText, setHantText] = useState('')
      const [rawText, setRawText] = useState('')
      const [timing, setTiming] = useState(null)
      const [copied, setCopied] = useState('')
      const [audioUrl, setAudioUrl] = useState('')
      // Remote microphone: shared plugin-wide runtime (see the module-level
      // remoteMicRuntime above); the panel only subscribes and renders it.
      const [remoteMic, setRemoteMicState] = useState(remoteMicRuntime.status)
      const [remoteMicUnavailable, setRemoteMicUnavailableState] = useState(remoteMicRuntime.unavailable)
      const [remoteMicOn, setRemoteMicOn] = useState(() => store.read(STORAGE.remoteMic, '1') !== '0')
      const [remoteMicError, setRemoteMicError] = useState('')
      const [remoteDevices, setRemoteDevices] = useState(null)
      const [bindingBusy, setBindingBusy] = useState(false)
      const [bindingError, setBindingError] = useState('')
      const lastRemoteResult = useRef(remoteMicRuntime.result)
      useEffect(() => {
        if (remoteMic && typeof remoteMic.enabled === 'boolean' && remoteMic.enabled !== remoteMicOn) {
          setRemoteMicOn(remoteMic.enabled)
          store.write(STORAGE.remoteMic, remoteMic.enabled ? '1' : '0')
        }
      }, [remoteMic, remoteMicOn])

      useEffect(() => {
        const release = retainRemoteMicRuntime()
        const unsubscribe = subscribeRemoteMicRuntime(() => {
          setRemoteMicState(remoteMicRuntime.status)
          setRemoteMicUnavailableState(remoteMicRuntime.unavailable)
          const result = remoteMicRuntime.result
          if (result !== null && result !== lastRemoteResult.current) {
            lastRemoteResult.current = result
            if (audioUrlRef.current) window.URL.revokeObjectURL(audioUrlRef.current)
            const url = window.URL.createObjectURL(new Blob([result.bytes], { type: 'audio/wav' }))
            audioUrlRef.current = url
            setAudioUrl(url)
            setHantText(result.hant)
            setRawText(result.raw ?? '')
            setTiming({
              audio: result.audioSeconds,
              inference: result.inferenceSeconds,
              round: result.round,
              timings: result.timings ?? null,
            })
            setPhase('done')
            setMessage('')
          }
        })
        return () => { unsubscribe(); release() }
      }, [])

      const active = useRef(null)
      const generation = useRef(0)
      const ticker = useRef(0)
      const autoStop = useRef(0)
      const noticeTimer = useRef(0)
      const audioUrlRef = useRef('')
      const remoteHoldActive = useRef(false)
      const remoteHoldKey = useRef(null)
      const phaseRef = useRef(phase)
      phaseRef.current = phase

      const notice = useCallback((text, tone = 'info') => {
        window.clearTimeout(noticeTimer.current)
        setMessage(text)
        setMessageTone(tone)
        if (text && tone !== 'error') noticeTimer.current = window.setTimeout(() => setMessage(''), 4000)
      }, [])

      const releaseAudio = useCallback(() => {
        if (audioUrlRef.current) {
          window.URL.revokeObjectURL(audioUrlRef.current)
          audioUrlRef.current = ''
        }
        setAudioUrl('')
      }, [])

      const failText = useCallback((error) => {
        const kind = error?.kind
        return ['permission', 'unavailable', 'empty', 'cancelled', 'interrupted', 'deviceMissing'].includes(kind)
          ? say(`error.${kind}`)
          : `${say('error.unknown')} ${errorText(error)}`
      }, [say])

      const finish = useCallback(async () => {
        const run = active.current
        if (!run || run.phase !== 'recording') return
        run.phase = 'transcribing'
        const token = generation.current
        window.clearInterval(ticker.current)
        window.clearTimeout(autoStop.current)
        setPhase('transcribing')
        setMessage('')
        try {
          const bytes = await run.capture.stop(maxDuration)
          if (token !== generation.current) return
          if (maxAudioBytes > 0 && bytes.byteLength > maxAudioBytes) {
            setPhase('error')
            notice(say('record.tooLarge'), 'error')
            return
          }
          const encoded = audioBase64(bytes)
          const recognitionProviderId = run.providerId === 'sensevoice-hant' ? 'sensevoice-local' : run.providerId
          const started = performance.now()
          const transcript = await unwrap(run.speech.transcribe(
            { audioBase64: encoded, providerId: recognitionProviderId, language: run.language },
            run.abort.signal,
          ))
          // Step two: the settings-driven Simplified -> Traditional conversion.
          const converted = await convertTranscriptText(transcript.text)
          const roundSeconds = (performance.now() - started) / 1000
          if (token !== generation.current) return
          setHantText(converted)
          setRawText(transcript.text)
          setTiming({ audio: transcript.audioSeconds, inference: transcript.inferenceSeconds, round: roundSeconds })
          const url = window.URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
          if (audioUrlRef.current) window.URL.revokeObjectURL(audioUrlRef.current)
          audioUrlRef.current = url
          setAudioUrl(url)
          if (token !== generation.current) return
          setPhase('done')
          if (transcript.text === '') notice(say('error.empty'), 'warn')
        } catch (error) {
          if (token !== generation.current) return
          const message = failText(error)
          setPhase('error')
          notice(message, 'error')
          void fetchJson('/stt-hant/telemetry', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: 'record-error', message, phase: run.phase, providerId: run.providerId, at: Date.now() }),
          }).catch(() => {})
        } finally {
          if (token === generation.current) active.current = undefined
        }
      }, [failText, maxAudioBytes, maxDuration, notice, say])

      const start = useCallback(async () => {
        if (!speech) return
        if (active.current) return
        const current = catalogRef.current
        const provider = current?.providers?.find((entry) => entry.id === current.selection?.providerId)
        if (!current || !provider) {
          notice(say('record.noProvider'), 'warn')
          return
        }
        if (!READY_PHASES.includes(provider.preparation?.phase ?? 'ready')) {
          notice(say('record.notReady'), 'warn')
          return
        }
        const token = ++generation.current
        const capture = new Recording(() => {}, deviceId)
        const run = {
          capture,
          speech,
          providerId: provider.id,
          language: current.selection?.language ?? 'auto',
          phase: 'requesting',
          abort: new AbortController(),
        }
        active.current = run
        window.clearInterval(ticker.current)
        window.clearTimeout(autoStop.current)
        releaseAudio()
        setHantText('')
        setRawText('')
        setTiming(null)
        setMessage('')
        setElapsed(0)
        setPhase('requesting')
        try {
          await capture.start((failure) => {
            if (token !== generation.current || active.current !== run) return
            active.current = undefined
            window.clearInterval(ticker.current)
            setPhase('error')
            notice(failText(failure), 'error')
          })
          if (token !== generation.current || active.current !== run) return
          run.phase = 'recording'
          setPhase('recording')
          const startedAt = performance.now()
          ticker.current = window.setInterval(() => { setElapsed((performance.now() - startedAt) / 1000) }, 250)
          autoStop.current = window.setTimeout(() => { void finish() }, Math.max(1, maxDuration) * 1000)
        } catch (error) {
          await capture.dispose()
          if (token !== generation.current) return
          active.current = undefined
          setPhase('error')
          notice(failText(error), 'error')
        }
      }, [deviceId, failText, finish, maxDuration, notice, releaseAudio, say, speech])

      const cancel = useCallback(() => {
        generation.current += 1
        remoteHoldActive.current = false
        remoteHoldKey.current = null
        window.clearInterval(ticker.current)
        window.clearTimeout(autoStop.current)
        const run = active.current
        active.current = undefined
        if (run) {
          run.abort.abort()
          void run.capture.dispose()
        }
        setPhase('idle')
        setElapsed(0)
        notice(say('error.cancelled'))
      }, [notice, say])

      // Latest callbacks for the document-level remote listener, which must not
      // re-register on every render.
      const actionsRef = useRef({ start, finish })
      actionsRef.current = { start, finish }
      const cancelRef = useRef(cancel)
      cancelRef.current = cancel

      useEffect(() => () => {
        generation.current += 1
        remoteHoldActive.current = false
        remoteHoldKey.current = null
        window.clearInterval(ticker.current)
        window.clearTimeout(autoStop.current)
        window.clearTimeout(noticeTimer.current)
        const run = active.current
        active.current = undefined
        if (run) {
          run.abort.abort()
          void run.capture.dispose()
        }
        if (audioUrlRef.current) window.URL.revokeObjectURL(audioUrlRef.current)
      }, [])

      // ── provider + language actions ──
      const selectProvider = useCallback(async (providerId) => {
        if (!speech || providerId === selectedId) return
        try {
          await unwrap(speech.configure({ providerId }))
          await refresh()
        } catch (error) {
          notice(errorText(error), 'error')
        }
      }, [notice, refresh, selectedId, speech])

      const selectLanguage = useCallback(async (language) => {
        if (!speech || language === catalog?.selection?.language) return
        try {
          await unwrap(speech.configure({ language }))
          await refresh()
        } catch (error) {
          notice(errorText(error), 'error')
        }
      }, [catalog, notice, refresh, speech])

      const [sources, setSources] = useState({})

      const prepare = useCallback(async (providerId) => {
        if (!speech) return
        const source = sources[providerId] ?? ''
        try {
          await unwrap(speech.prepare(providerId, source === '' ? undefined : { downloadSource: source }))
          await refresh()
        } catch (error) {
          notice(errorText(error), 'error')
        }
      }, [notice, refresh, sources, speech])

      const cancelPreparation = useCallback(async (providerId) => {
        if (!speech) return
        try {
          await unwrap(speech.cancelPreparation(providerId))
          await refresh()
        } catch (error) {
          notice(errorText(error), 'error')
        }
      }, [notice, refresh, speech])

      // ── remote bindings ──
      const [bindings, setBindings] = useState(loadBindings)
      const [holdMode, setHoldMode] = useState(() => store.read(STORAGE.remoteHold, '0') === '1')
      const [bindingFor, setBindingFor] = useState(null) // 'toggle' | 'stop' | null
      const [recentKeys, setRecentKeys] = useState([])
      const bindingsRef = useRef(bindings)
      bindingsRef.current = bindings
      const bindingForRef = useRef(bindingFor)
      bindingForRef.current = bindingFor
      const escapeUsedForBinding = useRef(false)
      const holdModeRef = useRef(holdMode)
      holdModeRef.current = holdMode
      const canRecordRef = useRef(false)
      canRecordRef.current = Boolean(speech && selectedReady)

      const pushKey = useCallback((event, matched) => {
        setRecentKeys((rows) => [{
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          at: new Date().toLocaleTimeString(),
          key: `${modifierText(event)}${event.key === ' ' ? 'Space' : event.key}`,
          code: event.code || '—',
          matched,
        }, ...rows].slice(0, 8))
      }, [])

      const bind = useCallback((which, binding) => {
        const next = { ...bindingsRef.current, [which]: binding }
        setBindings(next)
        persistBinding(which, binding)
      }, [])

      const clearBinding = useCallback((which) => { bind(which, null) }, [bind])

      const clearAllBindings = useCallback(() => {
        setBindings({ toggle: null, stop: null })
        persistBinding('toggle', null)
        persistBinding('stop', null)
        setBindingFor(null)
      }, [])

      const remoteCardRef = useRef(null)

      // Binding must not latch forever: expire it, and let a click elsewhere drop it.
      useEffect(() => {
        if (!bindingFor) return undefined
        const timer = window.setTimeout(() => { setBindingFor(null) }, 8000)
        const onPointerDown = (event) => {
          const card = remoteCardRef.current
          if (card && event.target instanceof Node && card.contains(event.target)) return
          setBindingFor(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [bindingFor])

      // One document-level listener: the remote reports keys to the focused
      // window, and this console owns the panel while it is mounted.
      useEffect(() => {
        const onKeyDown = (event) => {
          const binding = bindingForRef.current
          if (event.repeat) return

          if (binding) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              escapeUsedForBinding.current = true
              setBindingFor(null)
              return
            }
            if (MODIFIER_KEYS.includes(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              notice(say('remote.modifier'), 'warn')
              return
            }
            event.preventDefault()
            event.stopPropagation()
            const descriptor = describeBinding(event)
            const next = { ...bindingsRef.current, [binding]: descriptor }
            const other = binding === 'toggle' ? 'stop' : 'toggle'
            if (sameBinding(next[other], descriptor)) {
              next[other] = null
              persistBinding(other, null)
            }
            setBindings(next)
            persistBinding(binding, descriptor)
            setBindingFor(null)
            pushKey(event, true)
            notice(say('remote.bound'), 'success')
            return
          }

          if (isTypingTarget(event.target)) return

          const matched = bindingForEvent(bindingsRef.current, event)
          pushKey(event, matched !== null)
          if (matched === null) return

          event.preventDefault()
          event.stopPropagation()
          const current = phaseRef.current
          if (matched === 'toggle') {
            if (current === 'recording') {
              void actionsRef.current.finish()
              notice(say('remote.triggered'), 'success')
              return
            }
            if (current !== 'idle' && current !== 'done' && current !== 'error') return
            if (!canRecordRef.current) {
              // Let start() explain why (no service, no recognizer, model not ready).
              void actionsRef.current.start()
              return
            }
            if (holdModeRef.current) {
              remoteHoldActive.current = true
              remoteHoldKey.current = { key: event.key, code: event.code }
            }
            void actionsRef.current.start()
            notice(say('remote.triggered'), 'success')
            return
          }
          if (current === 'recording') {
            void actionsRef.current.finish()
            notice(say('remote.triggered'), 'success')
          }
        }

        const onKeyUp = (event) => {
          // Leaving binding mode with Escape must not also cancel a recording on
          // the matching keyup.
          if (escapeUsedForBinding.current) {
            escapeUsedForBinding.current = false
            return
          }
          if (bindingForRef.current) return
          const held = remoteHoldKey.current
          if (remoteHoldActive.current && held !== null && held.key === event.key && (held.code === '' || held.code === event.code)) {
            remoteHoldActive.current = false
            remoteHoldKey.current = null
            const run = active.current
            if (run?.phase === 'recording') void actionsRef.current.finish()
            else if (run?.phase === 'requesting') cancelRef.current()
            return
          }
          if (event.key !== 'Escape') return
          if (phaseRef.current === 'recording' || phaseRef.current === 'requesting' || phaseRef.current === 'transcribing') {
            event.preventDefault()
            cancelRef.current()
          }
        }

        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('keyup', onKeyUp, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('keyup', onKeyUp, true)
        }
      }, [notice, pushKey, say])

      const copy = useCallback(async (which, text) => {
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(which)
          window.setTimeout(() => { setCopied((current) => (current === which ? '' : current)) }, 1600)
        } catch {
          notice(say('result.copyFailed'), 'error')
        }
      }, [notice, say])

      // ── remote microphone: host routes + helper lifecycle ──
      const setRemoteMicEnabled = useCallback(async (enabled) => {
        setRemoteMicOn(enabled)
        store.write(STORAGE.remoteMic, enabled ? '1' : '0')
        try {
          const next = await fetchJson('/stt-hant/remote-mic/enabled', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          })
          publishRemoteMicStatus(next)
          setRemoteMicUnavailable(false)
          setRemoteMicError('')
        } catch (error) {
          setRemoteMicError(errorText(error))
        }
      }, [])

      const scanDevices = useCallback(async () => {
        setBindingBusy(true)
        setBindingError('')
        try {
          const payload = await fetchJson('/stt-hant/remote/devices')
          setRemoteDevices(Array.isArray(payload?.devices) ? payload.devices : [])
        } catch (error) {
          setBindingError(errorText(error))
          setRemoteDevices([])
        } finally {
          setBindingBusy(false)
        }
      }, [])

      const bindDevice = useCallback(async (device) => {
        setBindingBusy(true)
        setBindingError('')
        try {
          const next = await fetchJson('/stt-hant/remote/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(device),
          })
          publishRemoteMicStatus(next)
          setRemoteDevices(null)
        } catch (error) {
          setBindingError(errorText(error))
        } finally {
          setBindingBusy(false)
        }
      }, [])

      // ── conversion settings (recognition -> text -> Traditional) ──
      const [convertSettings, setConvertSettings] = useState(null)
      const [glossaryDraft, setGlossaryDraft] = useState('{}')
      const [convertSaving, setConvertSaving] = useState(false)
      const [convertSaved, setConvertSaved] = useState(false)
      const [convertError, setConvertError] = useState('')
      useEffect(() => {
        let stopped = false
        let attempt = 0
        let timer = 0
        const load = async () => {
          try {
            const payload = await fetchJson('/stt-hant/convert-settings')
            if (stopped) return
            setConvertSettings(payload.settings ?? null)
            setGlossaryDraft(JSON.stringify(payload.settings?.glossary ?? {}, null, 2))
            setConvertError('')
          } catch (error) {
            if (stopped) return
            setConvertError(`${say('convert.error')}${errorText(error)}`)
            // The host half may still be mounting/reloading; keep trying briefly.
            attempt += 1
            if (attempt < 10) timer = window.setTimeout(load, 2_000)
          }
        }
        void load()
        return () => { stopped = true; window.clearTimeout(timer) }
      }, [say])
      const applyConvert = useCallback(async (patch) => {
        setConvertSaving(true)
        setConvertError('')
        try {
          const payload = await fetchJson('/stt-hant/convert-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setConvertSettings(payload.settings ?? null)
          if (patch.glossary !== undefined) setGlossaryDraft(JSON.stringify(payload.settings?.glossary ?? {}, null, 2))
          setConvertSaved(true)
          window.setTimeout(() => setConvertSaved(false), 1600)
        } catch (error) {
          setConvertError(`${say('convert.error')}${errorText(error)}`)
        } finally {
          setConvertSaving(false)
        }
      }, [say])
      const saveGlossary = useCallback(() => {
        try {
          const parsed = JSON.parse(glossaryDraft === '' ? '{}' : glossaryDraft)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('word list must be an object')
          void applyConvert({ glossary: parsed })
        } catch (error) {
          setConvertError(`${say('convert.error')}${errorText(error)}`)
        }
      }, [applyConvert, glossaryDraft, say])

      const saveMapping = useCallback(async (usage, action) => {
        try {
          const mapping = { ...(remoteMic?.mapping ?? {}) }
          if (action === '') delete mapping[String(usage)]
          else mapping[String(usage)] = action
          const next = await fetchJson('/stt-hant/remote/mapping', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mapping }),
          })
          publishRemoteMicStatus(next)
        } catch (error) {
          setRemoteMicError(errorText(error))
        }
      }, [remoteMic?.mapping])

      const lastKeySeq = useRef(0)
      useEffect(() => {
        const keys = remoteMic?.keys ?? []
        const newest = keys.at(-1)
        if (!newest || newest.seq <= lastKeySeq.current) return
        lastKeySeq.current = newest.seq
        const action = remoteMic?.mapping?.[String(newest.usage)]
        if (!action || !newest.down) return
        if (action === 'panel') openSpeechPanel()
        if (action === 'last') {
          const text = remoteMicRuntime.result?.hant
          const insertion = remoteMicRuntime.insertion
          if (text && insertion) {
            try { insertion.insertText(text, insertion.captureInsertion()) } catch { /* draft disposed */ }
          }
        }
      }, [remoteMic])

      const [hotkeyState, setHotkeyState] = useState({
        binding: hotkeyRuntime.binding,
        learning: hotkeyRuntime.learning,
        phase: hotkeyRuntime.phase,
      })
      useEffect(() => {
        const sync = () => setHotkeyState({
          binding: hotkeyRuntime.binding,
          learning: hotkeyRuntime.learning,
          phase: hotkeyRuntime.phase,
        })
        hotkeyRuntime.listeners.add(sync)
        return () => { hotkeyRuntime.listeners.delete(sync) }
      }, [])

      const warmModel = useCallback(async () => {
        try {
          const next = await fetchJson('/stt-hant/model/prepare', { method: 'POST' })
          publishRemoteMicStatus(next)
        } catch (error) {
          setRemoteMicError(errorText(error))
        }
      }, [])

      const unbindDevice = useCallback(async () => {
        setBindingBusy(true)
        setBindingError('')
        try {
          const next = await fetchJson('/stt-hant/remote/unbind', { method: 'POST' })
          publishRemoteMicStatus(next)
        } catch (error) {
          setBindingError(errorText(error))
        } finally {
          setBindingBusy(false)
        }
      }, [])

      // Auto-start once the panel sees a supported platform with a bound remote.
      useEffect(() => {
        if (remoteMicUnavailable || !remoteMicOn) return
        if (!remoteMic || remoteMic.support !== 'supported' || remoteMic.enabled === false) return
        if (!remoteMic.binding) return
        if (remoteMic.phase !== 'idle') return
        void fetchJson('/stt-hant/remote-mic/start', { method: 'POST' })
          .then((next) => publishRemoteMicStatus(next))
          .catch((error) => setRemoteMicError(errorText(error)))
      }, [remoteMic, remoteMicOn, remoteMicUnavailable])

      // ─────────────────────────── render ───────────────────────────
      const statusView = status === 'missing'
        ? { tone: 'error', label: say('panel.status.missing') }
        : status === 'error'
          ? { tone: 'error', label: say('panel.status.error') }
          : status === 'ready'
            ? { tone: 'success', label: say('panel.status.connected') }
            : { tone: 'warn', label: say('panel.status.connecting') }

      const header = h('div', { className: 'stt-head' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('h1', { className: 'stt-title' }, say('panel.title')),
          h('p', { className: 'stt-sub' }, say('panel.subtitle')),
        ),
        h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(StatusPill, { tone: statusView.tone }, statusView.label),
          h('button', {
            type: 'button', className: 'stt-btn',
            disabled: !speech,
            onClick: () => { void refresh() },
          }, h(RefreshIcon, { size: 14 }), say('panel.refresh')),
        ),
      )

      const missingService = status === 'missing' || (status === 'error' && catalog === null)
        ? h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-missing' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-missing' }, say('panel.status.missing')),
          h('p', { className: 'stt-note', 'data-tone': 'error' }, say('panel.missingService')),
          speech
            ? h('button', { type: 'button', className: 'stt-btn', onClick: () => { void refresh() } }, say('panel.retry'))
            : null,
        )
        : null

      const providerRows = providers.map((provider) => {
        const active = provider.id === selectedId
        const phase = provider.preparation?.phase ?? 'ready'
        const busy = ACTIVE_PREPARATION.includes(phase)
        const downloading = phase === 'downloading' ? provider.preparation : undefined
        const failing = phase === 'failed' ? provider.preparation : undefined
        const sourceChoices = Array.isArray(provider.downloadSources) ? provider.downloadSources : []
        const percent = downloading && typeof downloading.totalBytes === 'number' && downloading.totalBytes > 0
          ? (downloading.completedBytes / downloading.totalBytes) * 100
          : null
        const stepLabel = provider.preparation?.step ? say(`step.${provider.preparation.step}`) : ''
        return h('div', {
          key: provider.id,
          className: 'stt-provider',
          'data-active': active ? 'true' : 'false',
        },
          h('input', {
            type: 'radio',
            className: 'stt-radio',
            name: 'stt-hant-provider',
            checked: active,
            disabled: !speech,
            onChange: () => { void selectProvider(provider.id) },
            'aria-label': active
              ? `${provider.name} — ${say('provider.default')}`
              : `${provider.name} — ${say('provider.setDefault')} — ${phaseLabel(say, phase)}`,
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('div', { className: 'stt-provider-name' },
              provider.name,
              active ? h('span', { className: 'stt-code', style: { marginLeft: 8 } }, say('provider.default')) : null,
            ),
            h('div', { className: 'stt-provider-meta' },
              provider.id,
              ' · ',
              provider.location === 'cloud' ? say('provider.cloud') : say('provider.local'),
              ' · ',
              say('provider.languages', { count: provider.languages?.length ?? 0 }),
            ),
          ),
          h('div', { className: 'stt-provider-side' },
            h(PhaseBadge, { say, phase }),
            sourceChoices.length > 0 && (phase === 'unprepared' || phase === 'failed' || phase === 'cancelled')
              ? h('select', {
                className: 'stt-select',
                value: sources[provider.id] ?? '',
                onChange: (event) => { setSources((current) => ({ ...current, [provider.id]: event.target.value })) },
                'aria-label': say('provider.source'),
                title: say('provider.source'),
              },
                h('option', { value: '' }, say('provider.sourceAuto')),
                ...sourceChoices.map((source) => h('option', { key: source, value: source }, source)),
              )
              : null,
            phase === 'unprepared' || phase === 'cancelled'
              ? h('button', { type: 'button', className: 'stt-btn', onClick: () => { void prepare(provider.id) } }, say('provider.prepare'))
              : null,
            phase === 'failed'
              ? h('button', { type: 'button', className: 'stt-btn', onClick: () => { void prepare(provider.id) } }, say('provider.retryPrepare'))
              : null,
            busy
              ? h('button', { type: 'button', className: 'stt-btn', onClick: () => { void cancelPreparation(provider.id) } }, say('provider.cancelPrepare'))
              : null,
          ),
          busy || failing
            ? h('div', { className: 'stt-detail' },
              downloading
                ? h('span', { className: 'stt-note' }, typeof downloading.totalBytes === 'number' && downloading.totalBytes > 0
                  ? say('provider.download', {
                    resource: downloading.resource ?? '',
                    completed: megabytes(downloading.completedBytes ?? 0),
                    total: megabytes(downloading.totalBytes),
                    percent: Math.round(percent ?? 0),
                  })
                  : say('provider.downloadUnknown', {
                    resource: downloading.resource ?? '',
                    completed: megabytes(downloading.completedBytes ?? 0),
                  }))
                : null,
              busy && !downloading
                ? h('span', { className: 'stt-note' }, stepLabel || say(`phase.${phase}`))
                : null,
              downloading ? h(ProgressBar, { percent, label: provider.name }) : null,
              failing
                ? h('span', { className: 'stt-note', 'data-tone': 'error' }, say('provider.failed', { message: failing.message ?? '' }))
                : null,
              failing
                ? h('span', { className: 'stt-note' }, say('provider.retryHint'))
                : null,
            )
            : null,
        )
      })

      const providerList = providerRows.length === 0
        ? [h('p', { key: 'empty', className: 'stt-note' },
          status === 'ready' ? say('panel.noProviders') : status === 'error' ? say('panel.status.error') : say('panel.loadingProviders'))]
        : providerRows

      const languageOptions = selected?.languages ?? []
      const hantProvider = providers.find((provider) => provider.id === 'sensevoice-hant')
      const showHantCallout = hantProvider !== undefined && selectedId !== 'sensevoice-hant'
      const providersSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-providers' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-providers' }, say('section.providers')),
          h('span', { className: 'stt-card-hint' }, say('section.providersHint')),
        ),
        ...providerList,
        showHantCallout
          ? h('div', { className: 'stt-callout' },
            h('span', { className: 'stt-grow' }, say('hant.callout')),
            h('button', {
              type: 'button', className: 'stt-btn',
              onClick: () => { void selectProvider('sensevoice-hant') },
            }, say('hant.switch')),
          )
          : null,
        languageOptions.length > 0
          ? h('div', { className: 'stt-row' },
            h('span', { className: 'stt-note', style: { minWidth: 88 } }, say('language.label')),
            h('select', {
              className: 'stt-select',
              value: catalog?.selection?.language ?? 'auto',
              disabled: !speech || !selected,
              onChange: (event) => { void selectLanguage(event.target.value) },
              'aria-label': say('language.label'),
            }, ...languageOptions.map((code) => h('option', { key: code, value: code }, languageLabel(say, code)))),
          )
          : null,
        serviceError ? h('p', { className: 'stt-note', 'data-tone': 'error' }, serviceError) : null,
      )

      // ── conversion card (recognition -> text -> Traditional) ──
      const conversionSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-convert' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-convert' }, say('section.convert')),
          h('span', { className: 'stt-card-hint' }, say('convert.hint')),
        ),
        h('div', { className: 'stt-row' },
          h('label', { className: 'stt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(convertSettings?.enabled),
              disabled: convertSettings === null || convertSaving,
              onChange: (event) => { void applyConvert({ enabled: event.target.checked }) },
            }),
            say('convert.enable'),
          ),
          h('span', { className: 'stt-note' }, say('convert.variant')),
          h('select', {
            className: 'stt-select',
            value: convertSettings?.variant ?? 's2hk',
            disabled: convertSettings === null || convertSaving,
            onChange: (event) => { void applyConvert({ variant: event.target.value }) },
            'aria-label': say('convert.variant'),
          }, ...CONVERT_VARIANTS.map((variant) => h('option', { key: variant, value: variant }, say(`convert.variant.${variant}`)))),
          convertSaved ? h('span', { className: 'stt-note', 'data-tone': 'success' }, say('convert.saved')) : null,
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('span', { className: 'stt-note' }, say('convert.glossary')),
          h('textarea', {
            className: 'stt-input',
            rows: 4,
            spellCheck: false,
            value: glossaryDraft,
            disabled: convertSettings === null || convertSaving,
            onChange: (event) => setGlossaryDraft(event.target.value),
            'aria-label': say('convert.glossary'),
          }),
          h('div', { className: 'stt-row' },
            h('button', {
              type: 'button', className: 'stt-btn',
              disabled: convertSettings === null || convertSaving,
              onClick: () => { void saveGlossary() },
            }, say('convert.save')),
            convertSettings && !convertSettings.enabled
              ? h('span', { className: 'stt-note', 'data-tone': 'warn' }, say('convert.disabled'))
              : null,
          ),
        ),
        convertError ? h('p', { className: 'stt-note', 'data-tone': 'error' }, convertError) : null,
      )

      const keysSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-keys' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-keys' }, say('section.keys')),
          h('span', { className: 'stt-card-hint' }, say('keys.hint')),
        ),
        h('div', { className: 'stt-row' },
          StatusPill({ tone: remoteMic?.hid?.ok ? 'success' : 'error' },
            remoteMic?.hid?.ok ? say('keys.seized') : say('keys.notSeized', { error: remoteMic?.hid?.error ?? '—' })),
          h('span', { className: 'stt-note' }, say('keys.learning', {
            keys: (remoteMic?.keys ?? []).slice(-4).map((entry) => `${KEY_NAMES[entry.usage] ?? `0x${entry.usage.toString(16)}`}${entry.down ? '↓' : '↑'}`).join(' ') || '—',
          })),
        ),
        (remoteMic?.keys ?? []).length === 0
          ? h('p', { className: 'stt-note' }, say('keys.empty'))
          : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          ...Array.from(new Set((remoteMic?.keys ?? []).map((entry) => entry.usage))).map((usage) => h('div', { className: 'stt-row', key: usage },
            h('span', { className: 'stt-binding-label' }, KEY_NAMES[usage] ?? `0x${usage.toString(16)}`),
            h('select', {
              className: 'stt-select',
              value: remoteMic?.mapping?.[String(usage)] ?? '',
              onChange: (event) => { void saveMapping(usage, event.target.value) },
              'aria-label': KEY_NAMES[usage] ?? String(usage),
            }, ...KEY_ACTIONS.map((action) => h('option', { key: action || 'none', value: action },
              action === '' ? say('keys.none') : say(`keys.action.${action}`)))),
          )),
        ),
      )

      const hotkeySection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-hotkey' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-hotkey' }, say('section.hotkey')),
          h('span', { className: 'stt-card-hint' }, say('hotkey.hint')),
        ),
        h('div', { className: 'stt-row' },
          h('span', { className: 'stt-note' },
            hotkeyState.learning
              ? say('hotkey.learning')
              : hotkeyState.binding === null
                ? say('hotkey.missing')
                : h('span', { className: 'stt-code' }, describeHotkey(hotkeyState.binding))),
          h('label', { className: 'stt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: hotkeyRuntime.copyMode,
              onChange: (event) => {
                hotkeyRuntime.copyMode = event.target.checked
                try {
                  window.localStorage.setItem('dsh-stt-hant.hotkey-copy', event.target.checked ? '1' : '0')
                } catch { /* storage may be unavailable */ }
                hotkeyRuntime.notify()
              },
            }),
            say('hotkey.copy'),
          ),
          hotkeyState.phase === 'recording' ? h(StatusPill, { tone: 'error' }, say('hotkey.recording')) : null,
          hotkeyState.phase === 'transcribing' ? h(StatusPill, { tone: 'warn' }, say('hotkey.transcribing')) : null,
          h('button', {
            type: 'button', className: 'stt-btn',
            disabled: hotkeyState.learning,
            onClick: () => { hotkeyRuntime.learning = true; hotkeyRuntime.notify() },
          }, say('hotkey.learn')),
          hotkeyState.binding !== null
            ? h('button', {
              type: 'button', className: 'stt-btn',
              onClick: () => { hotkeyRuntime.save(null); hotkeyRuntime.learning = false; hotkeyRuntime.notify() },
            }, say('hotkey.clear'))
            : null,
        ),
      )

      const recording = phase === 'recording' || phase === 'requesting'
      const canRecord = Boolean(speech && selectedReady)
      const recordButton = h('button', {
        type: 'button',
        className: 'stt-btn',
        'data-primary': 'true',
        'data-big': 'true',
        disabled: !canRecord || phase === 'requesting' || phase === 'transcribing',
        onClick: () => {
          if (phase === 'recording') void finish()
          else if (!recording && phase !== 'transcribing') void start()
        },
      },
        phase === 'recording' ? h(StopIcon, { size: 15 }) : h(MicIcon, { size: 16 }),
        phase === 'recording'
          ? say('record.stop')
          : phase === 'requesting'
            ? say('record.requesting')
            : phase === 'transcribing'
              ? say('record.transcribing')
              : say('record.start'),
      )

      const knownDevice = deviceId === '' || devices.some((device) => device.deviceId === deviceId)
      const bridgeDevice = devices.find((device) => /blackhole/i.test(device.label || ''))
      const recorderSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-recorder' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-recorder' }, say('section.recorder')),
          h('span', { className: 'stt-card-hint' }, say('record.readyHint')),
        ),
        h('div', { className: 'stt-row' },
          h('span', { className: 'stt-note', style: { minWidth: 88 } }, say('mic.label')),
          h('select', {
            className: 'stt-select stt-grow',
            value: deviceId,
            onChange: (event) => {
              setDeviceId(event.target.value)
              store.write(STORAGE.microphone, event.target.value)
            },
            'aria-label': say('mic.label'),
            disabled: recording,
          },
            h('option', { value: '' }, devices.length === 0 ? say('mic.loading') : say('mic.default')),
            !knownDevice ? h('option', { value: deviceId, disabled: true }, say('mic.missingDevice')) : null,
            ...devices.filter((device) => device.deviceId).map((device, index) => h('option', {
              key: device.deviceId, value: device.deviceId,
            }, device.label || say('mic.named', { number: index + 1 }))),
          ),
          h('button', { type: 'button', className: 'stt-btn', disabled: recording, onClick: () => { void refreshDevices() } }, say('mic.refresh')),
          h('button', { type: 'button', className: 'stt-btn', disabled: recording, onClick: () => { void requestPermission() } }, say('mic.allow')),
        ),
        bridgeDevice && deviceId !== bridgeDevice.deviceId
          ? h('div', { className: 'stt-callout' },
            h('span', { className: 'stt-grow' }, say('mic.bridge')),
            h('button', {
              type: 'button', className: 'stt-btn',
              onClick: () => {
                setDeviceId(bridgeDevice.deviceId)
                store.write(STORAGE.microphone, bridgeDevice.deviceId)
              },
            }, say('mic.useBridge')),
          )
          : null,
        bridgeDevice && deviceId === bridgeDevice.deviceId
          ? h('p', { className: 'stt-note' }, say('mic.bridgeSelected'))
          : null,
        micNote ? h('p', { className: 'stt-note', 'data-tone': 'warn' }, micNote) : null,
        selected && !selectedReady ? h('p', { className: 'stt-note', 'data-tone': 'warn' }, say('record.notReady')) : null,
        h('div', { className: 'stt-row' },
          recordButton,
          recording || phase === 'transcribing' ? h('button', { type: 'button', className: 'stt-btn', onClick: cancel }, say('record.cancel')) : null,
          h('span', { className: 'stt-note', style: { fontFamily: MONO } },
            recording || phase === 'transcribing'
              ? say('record.timer', { elapsed: elapsed.toFixed(1), max: maxDuration })
              : say('record.limit', { max: maxDuration })),
        ),
        phase === 'recording'
          ? h(Waveform, { recording: active.current?.capture, label: say('record.recording') })
          : phase === 'transcribing'
            ? h('span', { className: 'stt-note' }, say('record.transcribing'))
            : null,
        audioUrl
          ? h('audio', { className: 'stt-audio', controls: true, src: audioUrl, 'aria-label': say('record.play') })
          : null,
        h('div', { className: 'stt-results' },
          h(ResultPane, {
            say,
            label: say(selectedId === 'sensevoice-hant' ? 'result.hant' : 'result.transcript'),
            text: hantText, accent: true, live: true,
            placeholder: say('result.placeholder'), copied: copied === 'hant',
            onCopy: (value) => { void copy('hant', value) },
          }),
          selectedId === 'sensevoice-hant'
            ? h(ResultPane, {
              say, label: say('result.raw'), text: rawText, accent: false,
              placeholder: say('result.placeholder'), copied: copied === 'raw',
              onCopy: (value) => { void copy('raw', value) },
            })
            : null,
        ),
        timing
          ? h('span', { className: 'stt-note', style: { fontFamily: MONO } },
            say('result.timing', {
              audio: formatSeconds(timing.audio),
              inference: formatSeconds(timing.inference),
              round: formatSeconds(timing.round),
            }))
          : null,
        timing?.timings
          ? h('span', { className: 'stt-note', style: { fontFamily: MONO } },
            say('result.latency', {
              total: Math.round(timing.timings.total
                ?? ((timing.timings.wait ?? 0) + (timing.timings.fetch ?? 0)
                  + (timing.timings.infer ?? 0) + (timing.timings.insert ?? 0))),
              wait: Math.round(timing.timings.wait ?? 0),
              infer: Math.round(timing.timings.infer ?? 0),
            }))
          : null,
      )

      // ── remote binding card ──
      const bound = Boolean(remoteMic?.binding)
      const bindingSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-binding' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-binding' }, say('binding.title')),
          h('span', { className: 'stt-card-hint' }, say('binding.hint')),
        ),
        bound
          ? h('div', { className: 'stt-row' },
            h(StatusPill, { tone: 'success' },
              say('binding.bound', { name: remoteMic.binding.name ?? '', serial: remoteMic.binding.serial || '—' })),
            h('button', {
              type: 'button', className: 'stt-btn', style: { marginLeft: 'auto' },
              disabled: bindingBusy,
              onClick: () => { void unbindDevice() },
            }, say('binding.unbind')),
          )
          : h('div', { className: 'stt-row' },
            h('button', {
              type: 'button', className: 'stt-btn',
              disabled: bindingBusy,
              onClick: () => { void scanDevices() },
            }, bindingBusy ? say('binding.scanning') : say('binding.scan')),
            ...(remoteDevices ?? []).map((device) => h('button', {
              key: `${device.serial ?? ''}-${device.name ?? ''}`,
              type: 'button', className: 'stt-btn', 'data-primary': 'true',
              disabled: bindingBusy,
              onClick: () => { void bindDevice(device) },
            }, `${say('binding.bind')}：${device.name || device.serial || 'RC003'}`)),
          ),
        !bound && remoteDevices !== null && remoteDevices.length === 0
          ? h('p', { className: 'stt-note' }, say('binding.empty'))
          : null,
        bindingError
          ? h('p', { className: 'stt-note', 'data-tone': 'error' }, bindingError)
          : null,
        h('p', { className: 'stt-note' }, say('binding.pro2Only')),
      )

      // ── remote microphone card ──
      const remoteMicSupported = remoteMic?.support === 'supported'
      const remoteMicPhase = remoteMic?.phase ?? 'idle'
      let remoteMicText
      let remoteMicTone = 'muted'
      if (remoteMicUnavailable) {
        remoteMicText = say('remoteMic.unavailable')
        remoteMicTone = 'error'
      } else if (!remoteMic) {
        remoteMicText = say('panel.status.connecting')
        remoteMicTone = 'warn'
      } else if (remoteMic.support === 'planned') {
        remoteMicText = say('remoteMic.planned')
      } else if (remoteMic.support === 'unsupported') {
        remoteMicText = say('remoteMic.unsupported')
      } else {
        switch (remoteMicPhase) {
          case 'provisioning': remoteMicText = say('remoteMic.provisioning'); remoteMicTone = 'warn'; break
          case 'starting': remoteMicText = say('remoteMic.starting'); remoteMicTone = 'warn'; break
          case 'ready': remoteMicText = say('remoteMic.ready', { device: remoteMic.device ?? '' }); remoteMicTone = 'success'; break
          case 'recording': remoteMicText = say('remoteMic.recording'); remoteMicTone = 'accent'; break
          case 'reconnecting': remoteMicText = say('remoteMic.reconnecting'); remoteMicTone = 'warn'; break
          case 'error': remoteMicText = say('remoteMic.error', { message: remoteMic.error ?? '' }); remoteMicTone = 'error'; break
          default: remoteMicText = say('remoteMic.idle'); break
        }
      }

      const remoteMicSection = h('section', { className: 'stt-card', 'aria-labelledby': 'stt-hant-remote-mic' },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-remote-mic' }, say('remoteMic.title')),
          h('span', { className: 'stt-card-hint' }, say('remoteMic.hint')),
        ),
        h('div', { className: 'stt-row' },
          h(StatusPill, { tone: remoteMicTone }, remoteMicText),
          remoteMicSupported && (remoteMicPhase === 'ready' || remoteMicPhase === 'recording') && remoteMic.device
            ? h('span', { className: 'stt-note' },
              `${remoteMic.device}${remoteMic.model ? ` · ${remoteMic.model}` : ''}`)
            : null,
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' } },
            remoteMicSupported && bound
              ? h('button', {
                type: 'button',
                className: 'stt-btn',
                'data-primary': remoteMicOn ? 'false' : 'true',
                onClick: () => { void setRemoteMicEnabled(!remoteMicOn) },
              }, remoteMicOn ? say('remoteMic.disable') : say('remoteMic.enable'))
              : null,
            remoteMicSupported && remoteMicPhase === 'error'
              ? h('button', {
                type: 'button', className: 'stt-btn',
                onClick: () => { void setRemoteMicEnabled(true) },
              }, say('panel.retry'))
              : null,
          ),
        ),
        h('p', { className: 'stt-note' }, say('remoteMic.how')),
        h('div', { className: 'stt-row' },
          remoteMic?.model?.phase
            ? h(StatusPill, { tone: remoteMic.model.phase === 'ready' ? 'success' : remoteMic.model.phase === 'standby' ? 'muted' : 'warn' },
              say('remoteMic.model', { phase: phaseLabel(say, remoteMic.model.phase) }))
            : null,
          remoteMic?.model?.phase === 'standby'
            ? h('button', { type: 'button', className: 'stt-btn', 'data-small': 'true', onClick: () => { void warmModel() } },
              say('remoteMic.warm'))
            : null,
          h('span', { className: 'stt-note' },
            say(`remoteMic.transport.${remoteMicRuntime.transport === 'sse' ? 'sse'
              : remoteMicRuntime.transport === 'connecting' ? 'connecting' : 'poll'}`)),
        ),
        h('div', { className: 'stt-legend' },
          h('span', { className: 'stt-legend-item' }, h(StatusGlyph, { tone: 'success' }), say('legend.success')),
          h('span', { className: 'stt-legend-item' }, h(StatusGlyph, { tone: 'warn' }), say('legend.warn')),
          h('span', { className: 'stt-legend-item' }, h(StatusGlyph, { tone: 'error' }), say('legend.error')),
          h('span', { className: 'stt-legend-item' }, h(StatusGlyph, { tone: 'muted' }), say('legend.muted')),
        ),
        !bound && remoteMicSupported
          ? h('p', { className: 'stt-note', 'data-tone': 'warn' }, say('remoteMic.notBound'))
          : null,
        remoteMicOn && bound && remoteMicSupported && remoteMicPhase === 'ready'
          ? h('p', { className: 'stt-note' }, say('remoteMic.empty'))
          : null,
        remoteMicError && remoteMicPhase === 'error'
          ? h('p', { className: 'stt-note', 'data-tone': 'error' }, remoteMicError)
          : null,
      )

      const bindingRow = (which) => {
        const binding = bindings[which]
        const listening = bindingFor === which
        return h('div', { key: which, className: 'stt-binding' },
          h('span', { className: 'stt-binding-label' }, say(which === 'toggle' ? 'remote.toggle' : 'remote.stop')),
          h('code', { className: 'stt-code' }, binding ? binding.label : say('remote.unbound')),
          h('div', { className: 'stt-binding-actions' },
            h('button', {
              type: 'button', className: 'stt-btn', 'data-active': listening ? 'true' : 'false',
              onClick: () => { setBindingFor(listening ? null : which) },
            }, listening ? say('remote.listening') : binding ? say('remote.rebind') : say('remote.bind')),
            binding
              ? h('button', { type: 'button', className: 'stt-btn', onClick: () => { clearBinding(which) } }, say('remote.clear'))
              : null,
          ),
        )
      }

      const keyLog = recentKeys.length === 0
        ? h('p', { className: 'stt-note' }, say('remote.keyLogEmpty'))
        : h('div', { className: 'stt-log' },
          ...recentKeys.map((row) => h('div', {
            key: row.id, className: 'stt-log-row', 'data-match': row.matched ? 'true' : 'false',
          },
            h('span', { className: 'stt-time' }, row.at),
            h('code', { className: 'stt-code' }, row.key),
            h('span', {}, row.code),
            row.matched ? h('span', {}, say('remote.triggered')) : null,
          )),
        )

      const remoteSection = h('section', {
        className: 'stt-card', ref: remoteCardRef, 'aria-labelledby': 'stt-hant-remote',
      },
        h('div', { className: 'stt-card-head' },
          h('h2', { className: 'stt-card-title', id: 'stt-hant-remote' }, say('section.remote')),
          h('span', { className: 'stt-card-hint' }, say('remote.headHint')),
        ),
        h('div', { className: 'stt-row' },
          h(StatusPill, { tone: bindings.toggle || bindings.stop ? 'success' : 'muted' },
            bindings.toggle || bindings.stop ? say('remote.ready') : say('remote.idle')),
          h('span', { className: 'stt-note' }, say('remote.scope')),
        ),
        bindingRow('toggle'),
        h('div', { className: 'stt-subrow' },
          h('label', { className: 'stt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: holdMode,
              onChange: (event) => {
                const next = event.target.checked
                setHoldMode(next)
                store.write(STORAGE.remoteHold, next ? '1' : '')
              },
            }),
            say('remote.hold'),
          ),
          h('span', { className: 'stt-note' }, say('remote.holdHint')),
        ),
        bindingRow('stop'),
        h('p', { className: 'stt-note' }, say('remote.stopHint')),
        bindingFor
          ? h('div', { className: 'stt-listening' }, say('remote.pressNow'))
          : null,
        sameBinding(bindings.toggle, bindings.stop)
          ? h('p', { className: 'stt-note', 'data-tone': 'warn' }, say('remote.conflict'))
          : null,
        h('div', { className: 'stt-row' },
          h('span', { className: 'stt-card-title' }, say('remote.keyLog')),
          bindings.toggle || bindings.stop
            ? h('button', { type: 'button', className: 'stt-btn', style: { marginLeft: 'auto' }, onClick: clearAllBindings }, say('remote.clearAll'))
            : null,
        ),
        keyLog,
        h('p', { className: 'stt-note' }, say('remote.media')),
        h('p', { className: 'stt-note' }, say('remote.bridge')),
      )

      return h('div', { className: 'stt-root' },
        h(Styles),
        h('div', { className: 'stt-scroll' },
          h('div', { className: 'stt-column' },
            header,
            message
              ? h('div', {
                className: 'stt-notice',
                'data-tone': messageTone === 'info' ? undefined : messageTone,
                role: 'status', 'aria-live': 'polite',
              }, message)
              : null,
            h('p', { className: 'stt-intro' }, say('panel.intro')),
            missingService,
            providersSection,
            conversionSection,
            hotkeySection,
            keysSection,
            bindingSection,
            remoteMicSection,
            recorderSection,
            remoteSection,
            h('div', { className: 'stt-row' },
              h('span', { className: 'stt-note' }, say('panel.footnote')),
              h('span', { className: 'stt-note', style: { marginLeft: 'auto', fontFamily: MONO } },
                say('panel.version.host', {
                  client: PLUGIN_VERSION,
                  host: remoteMic?.hostVersion ?? '—',
                })),
              remoteMic && remoteMic.hostVersion && remoteMic.hostVersion !== PLUGIN_VERSION
                ? h('span', { className: 'stt-note', 'data-tone': 'warn' }, say('panel.version.mismatch'))
                : null,
            ),
          ),
        ),
      )
    }

    /**
     * Keep a console bug visible instead of letting it blank the whole central
     * panel: the slot boundary would only leave an empty cell behind.
     */
    class PanelBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        const { error } = this.state
        if (!error) return this.props.children
        return h('div', { className: 'stt-fatal' },
          h('div', null, interpolate(zh['panel.crash'])),
          h('div', null, interpolate(zh['panel.crashHint'])),
          h('pre', null, String(error?.stack ?? error)),
        )
      }
    }

    /** Slot component: the boundary sits inside the slot so details stay on screen. */
    function PanelShell(props) {
      return h(PanelBoundary, null, h(Panel, props))
    }

    return {
      inject: ['remote', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-stt-hant: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.inject(['layout'], (scope) => {
          openSpeechPanel = () => {
            try { scope.layout.selectPanel(PANEL_ID) } catch { /* layout may be unavailable */ }
          }
        })

        // The speech namespace appears only while the voice-input plugin is
        // mounted; the injected scope's effect clears it again when it goes away.
        ctx.inject(['remote.speech'], (scope) => {
          scope.effect(() => {
            publishSpeech(scope.remote?.speech ?? null)
            return () => { publishSpeech(null) }
          }, 'dsh-stt-hant: speech namespace')
        })

        ctx.effect(() => {
          const dispose = []
          // One sidebar row under the shipped panel entries; the id doubles as
          // the keyed `main` panel, so selecting the row renders PanelShell.
          dispose.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            locale: NS,
            label: () => t('panel.title'),
          }, PanelIcon)))
          dispose.push(ctx.effect(() => {
            if (hotkeyRuntime.binding !== null) void warmHotkeyStream()
            const onDown = (event) => {
              if (hotkeyRuntime.learning) { if (captureHotkey(event)) event.preventDefault(); return }
              if (!hotkeyMatches(event, hotkeyRuntime.binding)) return
              if (event.repeat) return
              event.preventDefault()
              void startHotkeyRecording()
            }
            const onUp = (event) => {
              if (!hotkeyRuntime.active || !hotkeyMatches(event, hotkeyRuntime.binding)) return
              void stopHotkeyRecording()
            }
            if (typeof window.addEventListener !== 'function') return () => {}
            window.addEventListener('keydown', onDown, true)
            window.addEventListener('keyup', onUp, true)
            return () => {
              window.removeEventListener('keydown', onDown, true)
              window.removeEventListener('keyup', onUp, true)
            }
          }, 'dsh-stt-hant: keyboard hotkey'))
          dispose.push(ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, PanelShell)))
          // Composer control: keeps the remote microphone alive while the user is
          // in a conversation and inserts finished utterances into the draft.
          dispose.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'stt-hant-remote-voice',
            order: 40,
            locale: NS,
          }, RemoteVoiceControl)))
          return () => { for (const stop of dispose.reverse()) stop() }
        }, 'dsh-stt-hant: sidebar console')
      },
    }
  },
})
