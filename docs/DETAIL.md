# 語音輸入

在 DSH 的語音輸入裡多加一個識別服務 `sensevoice-hant`：辨識仍由內建的 `sensevoice-local`（SenseVoice 本機模型）完成，只把結果文字轉成繁體後回傳。左側欄另有一個測試台，方便錄音比對、播放、複製結果，並把藍牙遙控器的按鍵綁成開始／停止錄音。

## 兩半

- **宿主端**（`index.js`、`lib/`）：向 `ctx.speechToText` 註冊一個 provider。它把收到的 WAV **原封不動**轉給 `sensevoice-local`，只改寫最後的文字；`preparation` 完全鏡射上游，所以「下載模型／取消」按到的就是真正在用的那份模型。
- **客戶端**（`client.js`）：純 JS 的 module factory（沒有建置步驟）。它做兩件事：
  - 在左側欄註冊一個入口（`sidebar.panellist`，id `stt-hant`，圖示是「语／語」兩道筆畫）；
  - 註冊一個 `main` 面板（key `stt-hant`），點左側欄入口就在中間欄打開測試台。
- 測試台透過既有的 `ctx.remote.speech` 呼叫宿主（`catalog`／`configure`／`prepare`／`cancelPreparation`／`transcribe`），沒有第二套辨識、也不碰音訊裝置的系統設定。

## 測試台怎麼用

1. 左側欄點「語音轉繁體」。
2. **識別服務**：列出所有已註冊的識別服務，電臺鈕就是「設為預設」（會寫入 DSH 的語音設定）。每個服務旁有狀態徽章：
   - 尚未準備 → 可選下載源（服務有提供時）並按「下載模型」；
   - 下載中 → 顯示資源名、已完成／總量與百分比；
   - 失敗 → 顯示原因並可重試（已下載且通過校驗的檔案會保留）；
   - 檢查中／載入中／喚醒中 → 顯示目前步驟。
3. **識別語言**：跟著所選服務的語言清單，選了就直接寫入 DSH 設定。
4. **繁體轉換**：辨識後獨立的一步——可切啟用／停用、選 `s2hk`／`s2twp`／`s2tw`／`s2t`、編輯詞表；改了即時生效（不用重啟）。
5. **測試錄音**：
   - 選麥克風；第一次要先「允許麥克風」（否則裝置名稱是空的）；
   - 按「開始錄音」錄音，波形會跟著音量跑，最多到服務上限（面板會顯示秒數上限）；
   - 按「停止並辨識」送出，結果分成「繁體結果」與「簡體原文」兩欄並排，兩欄都能複製；
   - 錄音可以按播放器重聽；下面顯示音訊長度、推論時間與往返時間；
   - 錄音中按「取消」或 Esc 會丟棄這次錄音。
6. **遙控器**：見下一節。

## 遙控器綁定（手動）

功能不是自動抓最近的裝置，而是**由你手動綁定**，避免和同一個空間裡的其他 BLE 遙控器搞混：

1. 先在 macOS 的藍牙設定配對並連上「小米藍牙語音遙控器」。
2. 打開左側欄「語音轉繁體」→「遙控器綁定」→「掃描已配對的遙控器」。
3. 列表只會出現符合 RC003 身份的裝置（VID `0x2717`／PID `0x32B8`）；按「綁定」。
4. 綁定會寫入 `~/.dsh/cache/dsh-stt-hant/settings.json`；之後第一次啟動遙控器麥克風時，會把 BLE peripheral id 一併寫回，方便下次更快連上。
5. 「解除綁定」會停止 helper 並清掉綁定；未綁定時遙控器麥克風與按鍵功能都不會啟用，面板會提示先綁定。

暫時**只支援小米藍牙語音遙控器 2 Pro（RC003）**；其他型號（例如普通款、其他品牌）以後再加。

## 遙控器（藍牙 HID）

遙控器對作業系統來說就是一把鍵盤，按鍵只會變成 keyboard event，所以接入方式是「按鍵綁定」：

1. 在「開始／停止」或「停止（錄音中）」那一列按「綁定」。
2. 面板會顯示「正在等按鍵」，接著按一下遙控器上想用的按鈕；它送出的 key／code 會顯示在「最近收到的按鍵」並寫進綁定。按 Esc 取消這次綁定。
3. 之後按同一個鍵：
   - 綁在「開始／停止」：閒置時開始錄音，錄音中停止並辨識；
   - 綁在「停止（錄音中）」：只在錄音中停止，其餘時候不動。
4. 「按住說話（放開停止）」開關就放在「開始／停止」那一列下面，預設關閉（＝切換模式）。打開後，按住期間錄音、放開就送出辨識；適合有實體按住感的遙控器。若遙控器只送按下、不送放開，請保持關閉，否則會一直錄到時間上限。
5. 「清除」只清該列，「全部清除」清兩列；綁定與模式存在瀏覽器的 localStorage，換瀏覽器或清站台資料後要重綁。

行為邊界：

- **只在這個面板開著時生效**：按鍵監聽掛在面板的 document listener 上，切到對話或其他面板後遙控器不會動作。
- **在輸入框打字時不觸發**：`INPUT`／`TEXTAREA`／`SELECT`／contenteditable 內的按鍵一律不攔截，避免打「a」卻開始錄音。
- **綁定的鍵會被攔下來**：面板開著時，該鍵的 `keydown` 會被 `preventDefault`，不會再傳給頁面其他部分（例如綁 Enter 就不會送出輸入框）。綁的時候請選遙控器專用鍵。
- **多媒體鍵收不到**：音量、播放、暫停這類鍵會被 macOS 先截走，網頁端永遠看不到；「最近收到的按鍵」沒有出現就是這個原因，改綁方向鍵／OK 鍵這類一般按鍵。
- **綁定模式會自己收尾**：8 秒內沒按鍵、按 Esc、或在面板外點一下，都會取消綁定；修飾鍵不能單獨綁定，但可以綁組合鍵（會連修飾鍵一起記下、精確比對），所以 `⌃⌥Space` 這種按住型快捷鍵也綁得到，而綁一般鍵時按住 ⌘ 不會誤觸。
- 兩列綁到同一個鍵時會提示，且以「開始／停止」優先。

### 遙控器自己的麥克風（ATVV）

RC003 有麥克風，但**它不是 macOS 的音訊端點**，所以面板的麥克風清單裡永遠不會出現「遙控器」：

- 遙控器在 BLE 上只以 HID 連上（`Services: 0x400020 <HID BLE>`）；語音走 **ATVV**（Android TV Voice-over-BLE）私有 GATT：服務 `ab5e0001-5a21-4f05-bc7d-af01f617b664`、命令寫 `ab5e0002`、音訊通知 `ab5e0003`、控制通知 `ab5e0004`，音訊是 headerless 的 16 kHz IMA/DVI ADPCM、120 bytes 一幀，按住（HTT）開始、放開結束。
- **DSH 外掛不可能用瀏覽器直接讀它**：Electron 沒有實作 Web Bluetooth 的選機流程，瀏覽器就算拿到 GATT 音訊也不能把它變成麥克風。所以這個功能由插件自帶的原生小幫手完成，而不是「選一個麥克風」。

使用前提：先在面板的「遙控器綁定」綁定遙控器（見上一節）。

#### 插件怎麼做（免安裝任何 App）

1. 插件自帶 `native/atvv-capture.swift`：CoreBluetooth 連 RC003 → ATVV 握手（GET_CAPS／STREAM_START／STREAM_STOP）→ 解 IMA/DVI ADPCM → 寫 16 kHz 單聲道 WAV。
2. **第一次啟用時**宿主用系統內建的 Swift 編譯器把它編譯到
   `~/.dsh/cache/dsh-stt-hant/native/<source-hash>/atvv-capture`；不是安裝 App、不寫 `/Applications`、不加登入項目、不改系統音訊設定。
3. 之後每次啟用只 spawn 這個 binary；插件停用或 DSH 退出時自動停止（`ctx.effect` 清理）。
4. 每次按住遙控器語音鍵：helper 收到 `STREAM_START`（HTT）→ 緩衝音訊 → 放開收到 `STREAM_STOP` → 寫一個 `utt-*.wav`；面板每 1.5 秒 poll 狀態，看到新檔案就自動用目前選的識別服務轉成文字，結果顯示在「繁體結果／簡體原文」，也可以回放。
5. 面板上的「遙控器麥克風（ATVV）」卡提供啟用／停止與狀態（編譯中／連線／收音／重連／錯誤）；第一次啟用可能需要你允許一次藍牙權限。
6. **不用開面板也會出字**：對話框左側會多一個「遙控器」小控制；插件在背景維持同一條事件流，收到新的遙控器錄音就自動辨識，並用 `inputActions.insertText()` 把文字插進目前草稿。插入失敗（例如草稿被改動）會退回剪貼簿，面板仍會保留結果。
7. **延遲**：跟內建語音輸入同一種做法——client 一收到「錄音完成」（SSE 即時，或 1 秒輪詢備援）就**用一個 POST 把 utterance id 交給宿主**；宿主讀 WAV、用 DSH 選定的 provider 辨識一次、套用轉換，直接回傳 `{ text, raw, timings }`；client 收到即插入。臨界路徑只有：SSE → 讀檔 → 推論（實測 40–60 ms）→ 轉換 → HTTP 回覆 → 插入。
8. **模型／路徑選擇**：遙控器與面板都跟「識別服務」卡選的 provider（即 DSH 的 `defaultProvider`）；`sensevoice-hant` 會被映射回 `sensevoice-local`，避免重複轉換。要換模型就在那張卡切換。每次辨識的時間數字會寫入 `~/.dsh/cache/dsh-stt-hant/telemetry.jsonl` 方便診斷。

限制與邊界：

- **按鍵攔截／映射尚未實作**：現階段遙控器的普通按鍵仍然會以一般鍵盤事件送到 macOS（與物理鍵盤混在一起）。要把它「折斷」需要擷取遙控器的 HID 裝置並獨佔，這需要 macOS 的**輸入監控**授權；這部分排在下一階段，完成後才會有可自訂的按鍵映射。
- macOS 已實作並直接對 RC003 驗證過握手與收音；**Windows backend 預留但未實作**（`lib/native-bridge.js` 的 `PLATFORM_SUPPORT`），其他平台顯示不支援並提示改用系統麥克風。
- 小幫手是唯一所有者：同一時間不要再開其他 ATVV 客戶端（例如 open-voice-bridge）連同一個遙控器，兩個 central 會互相搶連線。
- WAV 只留在本機 cache，最多保留 20 個；面板不會上傳。
- 路由：`/stt-hant/remote-mic/status|start|stop` 與 `/stt-hant/remote-mic/utterances/<id>`，只接受同源 loopback 請求（`lib/http-fence.js`；LAN 代理部署可用 `DSH_STT_HANT_TRUSTED_HOSTS` 加白名單）。
- 改動宿主端（新增路由）後要**重啟 DSH** 才生效；只改 `client.js` 重新載入頁面即可。
- 可選的其他路線（本插件不需要）：ESP32-S3 + [RemoteMapper-ESP32](https://github.com/cuicui-V5/RemoteMapper-ESP32) 把遙控器麥克風變成 USB UAC 麥克風（跨 OS）；或 macOS 的 [open-voice-bridge](https://github.com/nijez/open-voice-bridge) + BlackHole。

## 辨識引擎／路徑

- **目前路徑（預設）**：`helper → 宿主端辨識（DSH 選定的 provider）→ 宿主端轉換 → SSE 推送 → client 插入`。模型選擇就是面板「識別服務」卡（寫入 DSH 的 `defaultProvider`）；`sensevoice-hant` 會被映射回 `sensevoice-local`，避免重複轉換。
- 實測（M1 Max，模型已載入）：SenseVoice worker 首次載入約 0.9 秒；1–2 秒音訊的推論約 **40–60 ms**。所以慢的地方幾乎不會是模型本身，而是辨識的觸發／傳輸路徑——現在已改成宿主端即時辨識。
- **Apple 內建語音（選項，未實作）**：macOS 的 `SFSpeechRecognizer` 要求呼叫端的 App bundle 在 `Info.plist` 帶 `NSSpeechRecognitionUsageDescription`。我們的 helper 是 CLI，直接呼叫會因缺少 usage description 被 TCC 中止（已實測 SIGABRT）。要支援它，需要多一個獨立的小 `.app`（自帶 Info.plist、用 socket 跟宿主通訊）並讓使用者授權一次「語音辨識」。是否加入由使用者決定。
- 每次辨識的時間會寫入 `~/.dsh/cache/dsh-stt-hant/telemetry.jsonl`（`transcribeMs`／`convertMs`／`totalMs`），用來判斷慢在哪一段。

## variant

辨識與轉換是**兩個步驟**：本機 SenseVoice 先出文字，之後才用這一節的設定轉成繁體。設定可以在面板的「繁體轉換」卡即時改（啟用／變體／詞表），也會即時套用到面板、遙控器麥克風，以及內建「SenseVoice（繁體）」provider。預設值來自插件的 `config`，執行時的覆寫存在 `~/.dsh/cache/dsh-stt-hant/convert.json`；路由是 `GET/POST /stt-hant/convert-settings` 與 `POST /stt-hant/convert`。

| variant | opencc 目標 | 例：软件和打印机 → | 例：内存 →
|---|---|---|---|
| `s2hk`（預設） | `hk` | 軟件和打印機 | 內存 |
| `s2twp` | `twp` | 軟體和印表機 | 記憶體 |
| `s2tw` | `tw` | 軟件和打印機 | 內存 |
| `s2t` | `t` | 軟件和打印機 | 內存 |

差別是「用詞」不只是「字形」：香港用「軟件／打印機／內存」，台灣用「軟體／印表機／記憶體」。`s2t` 只換字不換詞。

`config.keepModelWarm`（預設 `true`）會讓插件每 15 秒檢查一次 `sensevoice-local`：如果它已經下載好卻掉到 `standby`（模型被卸載），就重新載入，避免每次錄音都要「喚醒」模型。它**不會**替你下載未下載的模型；不想常駐記憶體就設 `false`。

插件的 bundle patch 另外把上游 `speech-to-text-sensevoice` 設成 `idleTimeoutMs: 0`（worker 永不因閒置被卸載）與 `threads: 6`（加快推論）；這是完整覆寫該列 config，你自己的 profile `cordis.patch.yml` 仍然優先。改了 patch 之後要**重啟 DSH** 才生效。

`config.glossary`（或面板詞表）是轉換後的最長匹配覆寫，鍵可以寫簡體或繁體（會用同一個轉換器先正規化），例如 `{ "軟體": "軟件" }` 或 `{ "软件": "軟件" }`。

## 已知邊界

- **是字面轉換，不是翻譯。** 不懂語意，只換字與常用詞。
- **只保護作者標記過的程式碼。** 圍欄區塊、行內 code span、URL、ASCII 路徑會原樣保留；`printf("干")` 這種字串字面值仍會變 `幹`。含漢字的路徑（`src/組件/按鈕.js`）會被當一般文字轉換。
- **漢字與 ASCII 混排的 `/` 不保護**：`async/await` 受保護，`或/和` 照常轉換。
- `languages` 清單即時跟隨 `sensevoice-local`；上游新增語言不必改這裡。
- `sensevoice-local` 不存在時直接報錯，**不會**改用別的 provider。
- **測試台不是聽寫 UI**：它只把結果顯示在面板裡，不會把文字插進對話輸入框（那是內建語音輸入 UI 的職責，兩者互不相干）。
- **遙控器只在測試台面板開著時作用**，而且只綁得到瀏覽器收得到的按鍵（見上）。
- 轉換規則（`variant`／`glossary`）改動後要重啟 DSH 才生效（宿主端 ESM 快取）；只改 `client.js` 時重新載入頁面即可，client HMR 有時會自動替換。

## 驗證

- `node --test`：宿主端 18 個測試（轉換、provider、遞迴回歸）＋客戶端 6 個冒煙測試（module id、locale 字典對齊、靜態文案鍵、slot 註冊、disposer、CSS class 對齊）。
- `node --check client.js`／`index.js`：語法。
- 執行中的 DSH：`sidebar.panellist` 與 `main` 兩個 slot 都已註冊（`cordis_inspect_query`）。
- 本文件沒有在運行頁面上做視覺驗證；面板若 render 失敗，內建的 error boundary 會把錯誤顯示在面板裡，不會只剩空白。
