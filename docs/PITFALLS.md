# 教訓（Pitfalls）

## 2026-11-22：裝了插件，DSH 就開不起來

**症狀**

- 點 DSH 沒視窗；`pgrep` 看得到 host 進程，`ps -o %cpu` 是 100%（忙迴圈）。
- `~/Library/Logs/DeepSeek Harness/crash-*.log` 只有一句 `dsh desktop host stopped`，沒有任何 renderer 錯誤。
- `lsof -nP -iTCP -sTCP:LISTEN -a -p <host pid>` 沒有 web server 在聽：Desktop 要等 host 送出 `ready` 才建視窗，boot 沒完成就永遠沒畫面。

**根因**

`lib/provider.js` 的 `observe()` 每收到一個 snapshot 就無條件 `notify()`：

```js
for await (const snapshot of speechToText.follow(signal)) {
  ...
  notify()   // ← 錯在這裡
}
```

真服務在 `register()` 時用 `provider.preparation.subscribe(() => speechToText.changed())` 訂閱，
於是形成閉環：

```
follow() 吐 snapshot → observe() notify() → 服務的 listener 呼叫 changed()
      ↑                                              │
      └──────────── follow() 立刻再吐一個 snapshot ───┘
```

每一輪都在微任務佇列裡完成，event loop 完全被餓死（連 `setTimeout` 都跑不到），
profile boot 永遠不 settle，也**不會有任何錯誤訊息**。

**規則**

1. 消費 `follow()`／任何 `changed()` 型串流時，只有「值真的變了」才通知。
   用值比較（`samePreparation`、`sameLanguages`），不要比物件 identity——snapshot 每次都是新物件。
2. `preparation.snapshot()` 裡絕對不能呼叫 `speechToText.snapshot()` 或 `follow()`，會遞迴。
3. 動手前先把「誰訂閱誰、誰會回寫、誰會再觸發」畫出來；只要鏈路一端是服務的 `changed()`，就必須證明它會收斂。

**測試的坑（為什麼原本全綠）**

`test/provider.test.js` 的 `createService()` 在 `register()` 時傳給 `subscribe()` 的是空 listener：

```js
provider.preparation?.subscribe(() => {})   // 假服務
```

真服務傳的是 `() => this.changed()`。少了這一環，`notify → changed → follow 再吐 → notify`
的回饋鏈在測試裡根本不存在，所以 bug 通過了所有測試。

現在 fake 已改成跟真服務一致的語意（訂閱時傳 `() => notify()`，`follow()` 用
`changed` 旗標、通知落在 yield 期間就立刻再吐），並用 `calls.emitted` 計數斷言
`follow()` 的迭代次數有上限；把 `if (changed)` 改回無條件 `notify()`，這個測試會
立刻失敗（`follow() emitted 51 snapshots`），不會再靜默通過。

**排查手冊（下次快速定位）**

1. 先分辨 host 是「忙」還是「等」：`ps -o pid,%cpu,stat -p <host>`。
   100% ≈ JS 迴圈；0% ≈ 卡在永不 resolve 的 promise。
2. 看有沒有在聽埠；沒有就是 boot 沒完成，別去猜 UI。
3. 用 profile 複本二分，不要動真設定：
   ```sh
   rsync -a --exclude node_modules ~/.dsh/profiles/desktop/ /tmp/p/
   ln -s ~/.dsh/profiles/desktop/node_modules /tmp/p/node_modules
   # 從 /tmp/p/package.json 的 dsh.profile.bundles 逐一移除，直到能開機
   ```
4. 直接跑 host 時**一定要帶 IPC**，否則行為不等於真實啟動：
   用 `child_process.spawn(..., { stdio: ['ignore','pipe','pipe','ipc'] })`，
   entry 前可加 `--inspect-brk=9233` 抓 JS 堆疊（idle 時 `Debugger.pause` 不會觸發，忙迴圈才抓得到）。
5. 改完宿主端立刻重啟 DSH：host 模組有 ESM 快取，熱改不會生效。

## 2026-11-22：左側欄入口在，點下去面板卻空白

**症狀**

- 側欄出現「語音轉繁體」，點下去中間面板空白，DOM 上該格是 `data-slot-error="main"`。
- console 不一定看得到 JS 例外：slot 在 render 失敗後會把入口退場，錯誤只存在於那一次 render。

**根因（兩個，先後發生）**

1. `providerRows` 在「沒有 provider」時回傳的是**單一 React element**，render 時卻寫 `...providerRows` 展開。
   catalog 第一次還是 `null`（providers 空陣列）時必定拋 `object is not iterable`，所以面板第一次開就炸。
2. 直接讀 `ctx.remote.speech`：Cordis 會拋 `cannot get property "remote" without inject`；
   把 `remote` 加進 `export const inject` 之後它仍是 `undefined`，因為 `remote.speech` 這個命名空間是
   語音輸入插件的 `apply` 裡 `ctx.remote.$mount(...)` 才掛上的。
   正確寫法是 `export const inject = ['remote', 'slots', 'locale']`，再用
   `ctx.inject(['remote.speech'], (scope) => { scope.effect(() => { … }) })` 在命名空間出現時取得、消失時清理。
   期間看到的 `Maximum call stack size exceeded` 一度被誤判成 client 問題，真正來源是宿主的遞迴（上一節），
   遠端呼叫只是代罪羔羊。

**規則**

1. **任何會被 spread 的變數永遠保持陣列**：空狀態回傳 `[element]`，不要把單一 element 放進 `...`。
2. slot entry 的 render 拋錯時，slot 只會標 `data-slot-error` 然後把入口退場，畫面留白；
   **面板內一定要有 error boundary**，把錯誤留在畫面上，否則只能靠 CDP 挖。
3. `ctx.remote.<namespace>` 一律用 `ctx.inject([...])` 取：它同時處理「命名空間晚於本插件掛載」與「提供者卸載後消失」。
4. 只改 `client.js` 時重新載入頁面即可（client HMR 有時會自動替換）；改宿主端檔案一定要重啟 DSH。

**現在的防線**

- `test/client.test.js` 用 VM 載入 `client.js`，檢查 module id 與套件名一致、locale 字典 zh／en 鍵集一致、
  靜態文案鍵都存在、兩個 slot 都註冊、cleanup 可呼叫。這類「apply 沒拋、註冊沒少」的錯會先被測試擋下來。
- 面板的 `PanelBoundary` 會把 render 錯誤印在面板裡，不再只剩空白。


## 2026-11-22：「遙控器麥克風接不上」不是外掛的 bug

**事實**

- 小米藍牙語音遙控器 2 Pro（RC003，VID `0x2717`／PID `0x32B8`）在 macOS 上只以 **BLE HID** 連線
  （`Services: 0x400020 <HID BLE>`），不會多出一個音訊輸入裝置。
- 它的麥克風走 **ATVV** 私有 GATT（`ab5e0001-5a21-4f05-bc7d-af01f617b664`，16 kHz IMA/DVI ADPCM、120 bytes 一幀、
  HTT 按住開始／放開結束），**不是**系統音訊端點，也不是 HFP/HSP。
- DSH 的 Electron **沒有實作 Web Bluetooth 的選機流程**（安裝包內沒有 `select-bluetooth-device` handler），
  DSH 外掛不可能直接連 GATT、更不可能把 GATT 音訊變成麥克風。

**規則（v0.2 起已實作成插件自帶的 Swift helper，見 `native/atvv-capture.swift`）**

1. 不要指望瀏覽器讀 ATVV；一定要有原生層。這個原生層放在插件裡、用系統 Swift 編譯，
   **不要**安裝第三方 App 或驅動當成必要條件。
2. helper 是唯一所有者：同一時間不要再開別的 ATVV 客戶端（open-voice-bridge 等）連同一個遙控器，
   兩個 central 會互搶連線。
3. helper 由插件生命週期管理：`ctx.effect` 清理時停止；不要在系統裡留 launch agent / login item。
4. 第一次啟用需要編譯（約 10–30 秒）與一次藍牙權限；失敗時面板要顯示可讀錯誤，不要靜默。
5. 改宿主端（新增路由/manager）後要重啟 DSH 才生效；只改 `client.js` 重新載入頁面即可。
6. 若日後要支援 Windows：`PLATFORM_SUPPORT.win32 = 'planned'` 的 slot 在 `lib/native-bridge.js`，
   後端協議（JSON lines + WAV spool + 同組 HTTP 路由）保持不變，只加一個 helper 實作。

**出處**

- ATVV UUID／握手／ADPCM 行為：`dsh-xiaomi-remote-2-pro` 的 `docs/EVIDENCE.md`、`cuicui-V5/RemoteMapper-ESP32` 的 `src/ble/ble_remote_client.cpp`。
- macOS 已驗收的 ATVV 實作：`nijez/open-voice-bridge`（CoreBluetooth → BlackHole）。

## 2026-11-22：`atomic-write: timed out waiting for the writer lock`

**症狀**

- DSH 回報 `atomic-write: timed out waiting for the writer lock at ~/.dsh/profiles/desktop/package.json.lock`，
  之後任何要改 profile（安裝／停用插件等）的動作都失敗。

**根因**

- 鎖檔是 17:20 那次宿主崩潰留下的：內容是當時寫入者的 PID，但那個 PID 後來被別的程式（嘉立創 EDA 的
  crashpad handler）重用。atomic-write 的「寫入者還活著嗎」檢查因此永遠判定活著，鎖不會自己過期。

**規則**

1. 先確認沒有 process 真的握著它：`lsof ~/.dsh/profiles/desktop/package.json.lock` 應為空。
2. 鎖檔的 mtime **早於目前宿主啟動時間** 就幾乎一定是崩潰殘留，可安全刪除：
   `rm ~/.dsh/profiles/desktop/package.json.lock`。
3. 刪除後不要重跑安裝指令前先確認 DSH 本身沒有在寫入；宿主重啟後不會重建殘留鎖。
