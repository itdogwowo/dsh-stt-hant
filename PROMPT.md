# dsh-stt-hant — 建置提示詞（給實作代理）

> 這份檔案就是規格。照它做，不要擴大範圍；範圍外的寫在「不要做的事」。

## 0. 一句話

一個 **host-only** 的 DSH bundle：在 `ctx.speechToText` 註冊一個 provider，把現成 `sensevoice-local` 的辨識結果轉成繁體中文。**沒有 UI、沒有錄音、沒有第二套 STT。**

## 1. 為什麼不是 fork 上游

- `@deepseek-ai/dsh-experimental-client-ui-voice-input` 與 `...-speech-to-text-sensevoice` 在 DSH 安裝目錄（`app.asar`）內，改不到，升級即失效。
- 需求只是「文字轉換」，發生的位置在 provider 邊界（辨識結果之後、插入草稿之前）。
- 既有語音 UI 會自動列出註冊的 provider，切換即可生效——不需要寫任何 UI 程式碼。

## 2. 已查證的契約（照這個寫，不要猜）

套件：`@deepseek-ai/dsh-experimental-speech-to-text`，型別在 `lib/types/index.d.ts`。

```ts
interface Context { speechToText: SpeechToText }

class SpeechToText {
  register(provider: SpeechProvider): () => Promise<void>   // 回傳 async disposer
  listProviders(): readonly SpeechProviderInfo[]
  snapshot(): SpeechSnapshot                                 // {providers:[{...info, preparation}], selection}
  follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot>
  resolve(request: {audio: Uint8Array, providerId?: string, language?: string}): SpeechSpec
  transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript>
  prepare(id: string, options?: {downloadSource?: string}): void
  cancelPreparation(id: string): Promise<void>
  configure(patch: {providerId?: string, language?: string}): Promise<void>
}

interface SpeechProvider {
  info: { id, name, location: 'host-local' | 'cloud', languages: string[], setupEstimate?, downloadSources? }
  preparation?: {
    snapshot(): SpeechPreparationState
    subscribe(listener: () => void): () => void
    prepare(options?): void
    cancel(): Promise<void>
  }
  transcribe(input: {audio: Uint8Array, language: string}, signal: AbortSignal): Promise<Transcript>
}

type Transcript = { text: string, audioSeconds: number, inferenceSeconds: number }
```

要點：

- `input.audio` 是已驗證的 canonical WAV（16 kHz 單聲道 PCM16）。**直接原封不動轉發**，不要重編碼、不要 base64 來回。
- 委派時**必須顯式指定** `providerId: 'sensevoice-local'`，否則會解析回自己造成遞迴。
- `languages` 照抄 `sensevoice-local` 目前支援的：`['auto','zh','en','yue','ja','ko']`（上游若新增語言，這裡要跟；在程式註解標明）。
- 註冊要包在 `ctx.effect` 內，並回傳 cleanup；`inject: ['speechToText']`。

## 3. 檔案結構

```
dsh-stt-hant/
├── package.json          # dsh.bundle.patch + exports(locale, icon) + files
├── cordis.patch.yml      # insert 一行
├── index.js              # apply(): 註冊 provider
├── lib/hant.js           # 純函式：簡→繁 + code span 保護 + glossary
├── lib/provider.js       # provider 物件（委派 + preparation 鏡射）
├── locale/en.json, zh.json
├── docs/DETAIL.md
├── icon.svg
├── test/hant.test.js, provider.test.js
└── README.md
```

`package.json` 骨架（實際欄位照 `dsh-doc` 的 `references/host-plugin.md`）：

```json
{
  "name": "dsh-stt-hant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "lib", "cordis.patch.yml", "locale/*.json", "docs", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "opencc-js": "^1.0.5" }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: stt-hant
      name: 'dsh-stt-hant'
      config: {}
```

## 4. 轉換模組（`lib/hant.js`）

介面：`createConverter({ variant, glossary, protectCodeSpans }) → (text) => string`

- `variant`：`s2hk`（預設）、`s2twp`、`s2tw`、`s2t`。用 `opencc-js` 的 `Converter({from:'cn', to:'hk'|'twp'|'tw'|'t'})`。
- 保護範圍：``` 圍欄 ```、`` `inline` ``、含 `/` 或 `\\` 的路徑、`http(s)://` URL。做法是切段後只轉換「一般文字」段，最後原樣拼回。
- `glossary`：`{ "软件": "軟件" }` 形式的詞表，**轉換之後**做最長匹配取代，用來修 opencc 選錯的詞。
- 空字串、全英文、emoji、純數字要原樣回傳。
- 已知邊界（寫進測試）：`printf("干")` 會變 `printf("幹")`——所以字串字面值放在 code span 內才安全；一般文字靠 glossary 修。**不要**自作聰明去偵測程式碼。

驗收用的樣本：

| 輸入 | s2hk | s2twp |
|---|---|---|
| 帮我把这个 function 改成 async | 幫我把這個 function 改成 async | 同 |
| 软件和打印机 | 軟件和打印機 | 軟體和印表機 |
| 变量名改成 userNameList | 變量名改成 userNameList | 變數名改成 userNameList |
| 后台服务、内存、视频、默认值 | 後臺服務、記憶體、影片、預設值 | 同 |

## 5. Provider（`lib/provider.js`）

- `info`：`{ id: 'sensevoice-hant', name: 'SenseVoice（繁體）', location: 'host-local', languages: [...] }`
- `transcribe(input, signal)`：
  1. `const spec = ctx.speechToText.resolve({ audio: input.audio, providerId: 'sensevoice-local', language: input.language })`
  2. `const t = await ctx.speechToText.transcribe(spec, signal)`
  3. `return { ...t, text: convert(t.text) }`
- `preparation` 鏡射 `sensevoice-local`：
  - `snapshot()`：`ctx.speechToText.snapshot().providers.find(p => p.id === 'sensevoice-local')?.preparation ?? { phase: 'unprepared' }`
  - `subscribe(fn)`：用 `follow(ac.signal)` 開一個 async 迴圈，狀態變了就叫 `fn()`；回傳 `() => ac.abort()`
  - `prepare(opts)`：`ctx.speechToText.prepare('sensevoice-local', opts)`
  - `cancel()`：`ctx.speechToText.cancelPreparation('sensevoice-local')`
- 錯誤：`sensevoice-local` 不存在時，讓 `resolve()` 的錯誤往外拋，但加上 `[dsh-stt-hant] 找不到 sensevoice-local，請先啟用語音輸入 bundle` 的訊息。**不要** fallback 到其他 provider（上游原則：不把音訊送去別的地方）。

## 6. 設定（`Config`）

```ts
{
  variant: 's2hk' | 's2twp' | 's2tw' | 's2t'   // 預設 s2hk
  glossary: Record<string, string>              // 預設 {}
  protectCodeSpans: boolean                     // 預設 true
}
```

非法值要降級成預設並記一條警告，**不要讓插件啟動失敗**（照 `dsh-doc` 的 `Config` 做法；若 `@deepseek-ai/schemastery` 在 profile 裡解析不到，就在 `apply()` 手動驗證）。

## 7. 顯示資源

- `locale/zh.json` / `en.json` 的 `meta.title`、`meta.description`、`meta.detail`。
  - zh：`語音轉繁體` / `把語音辨識結果從簡體轉成繁體（香港／台灣用語可切），沿用 DSH 內建語音輸入，不錄音、不上傳。`
  - en：`Traditional Chinese for voice input` / sentence case。
- `icon.svg`：自製或可再發佈的圖示（繁＝一點一橫，別用現成商標）。
- `docs/DETAIL.md`：怎麼切 provider、variant 差異、已知邊界（code span、glossary）。

## 8. 測試（`node --test`，零依賴跑得起來）

- `hant.test.js`：上表四句、code span 保護、glossary 覆寫、空字串、純英文、emoji。
- `provider.test.js`：mock `ctx.speechToText`，驗證
  - `resolve` 收到 `providerId: 'sensevoice-local'` 與原封不動的 audio bytes
  - 回傳的 `text` 已轉換、`audioSeconds`/`inferenceSeconds` 保留
  - `sensevoice-local` 不存在 → reject 且訊息可讀
  - `preparation.snapshot()` 鏡射、`prepare()` 轉呼叫、`subscribe()` 收到變更
  - `register` 的 disposer 有被 effect cleanup 呼叫

## 9. 驗收（人做）

1. `node --test` 全綠；`node --check index.js`。
2. 安裝：`dsh plugin --profile desktop add link:~/Documents/Git/Sourcetree/dsh-stt-hant`（或 Plugins 頁裝本地目錄）。
3. **完整重啟 DSH**（ESM 快取與 client 掃描都只在啟動時做；刷新頁面不夠）。
4. 設定 → 語音輸入 → 識別服務 → 選 `SenseVoice（繁體）`。
5. 按麥克風說「帮我把这个 function 改成 async」，草稿應出現「幫我把這個 function 改成 async」。
6. 切 `s2twp` 再說「软件和打印机」，應得「軟體和印表機」。

## 10. 不要做的事

- 不要 fork／修改任何 `@deepseek-ai/dsh-experimental-*` 套件，也不要 unpack `app.asar`。
- 不要自己錄音、不要自己做 STT、不要碰音訊裝置（那是語音輸入的事）。
- 不要用 DOM 找輸入框、不要 `execCommand`（插入由既有 UI 負責）。
- 不要自動改 `defaultProvider`（切換留給使用者在設定頁做；若要做，必須是預設關閉的 config）。
- 不要加 agent tool、不要加 slash command（v0.1 不需要）。
- 不要在轉換時動英文、數字、標點、emoji。

## 11. 風險與已知限制

- `ctx.speechToText` 是 experimental：型別可能變；升級 DSH 後要重跑測試。
- `opencc-js` 若在 profile 的 pnpm 裝不起來，改成把字典檔 vendor 進 `lib/`（授權要一併帶）。
- `languages` 清單是硬編碼的；上游新增語言時要同步。
- 簡→繁是字面轉換，不懂語意；`後臺/後台`、`裡/裏` 這類差異靠 variant 與 glossary 處理，不要假裝是翻譯。
