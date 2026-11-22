/**
 * dsh-stt-hant — macOS ATVV capture helper.
 *
 * Runs as a child of the DSH host (never installed as an app). It connects to
 * the Xiaomi Bluetooth Voice Remote 2 Pro (RC003) over CoreBluetooth, speaks
 * the ATVV private voice protocol, decodes the 16 kHz IMA/DVI ADPCM stream to
 * PCM, and writes one WAV per hold-to-talk utterance.
 *
 * Contract with the host (one JSON object per stdout line):
 *   {"event":"state","state":"bluetooth-ready"}
 *   {"event":"state","state":"scanning"}
 *   {"event":"state","state":"connecting","name":"..."}
 *   {"event":"ready","name":"...","model":"RC003","peripheralId":"..."}
 *   {"event":"voice-start"}
 *   {"event":"voice-stop","path":"/abs/path.wav","seconds":5.2,"frames":412,"packets":240}
 *   {"event":"state","state":"reconnecting","reason":"..."}
 *   {"event":"error","code":"no-device","message":"..."}
 * stderr carries human-readable diagnostics; the host keeps a short tail.
 *
 * Lifecycle: runs until stdin closes or SIGTERM/SIGINT arrives, then closes the
 * ATVV microphone, disconnects, and exits 0.
 *
 * Protocol facts (UUIDs, handshake bytes, ADPCM layout) come from public
 * reverse-engineering work; this implementation is original.
 */
import Foundation
import CoreBluetooth
import IOKit.hid

// ───────────────────────────── protocol constants ─────────────────────────────

let atvvService = CBUUID(string: "ab5e0001-5a21-4f05-bc7d-af01f617b664")
let atvvCommand = CBUUID(string: "ab5e0002-5a21-4f05-bc7d-af01f617b664")
let atvvAudio = CBUUID(string: "ab5e0003-5a21-4f05-bc7d-af01f617b664")
let atvvControl = CBUUID(string: "ab5e0004-5a21-4f05-bc7d-af01f617b664")
let deviceInfoService = CBUUID(string: "180A")
let modelNumberCharacteristic = CBUUID(string: "2A24")

let getCapabilitiesV10 = Data([0x0A, 0x01, 0x00, 0x00, 0x03, 0x03])
let microphoneOpenV10 = Data([0x0C, 0x00])
let microphoneCloseV10 = Data([0x0D, 0x00])

let nameHints = ["小米", "MI RC", "Xiaomi", "Remote", "RC003"]

/** RC003 (Xiaomi Bluetooth Voice Remote 2 Pro) HID identity; other models are out of scope. */
let remoteVendorID = 0x2717
let remoteProductID = 0x32B8

// ───────────────────────────── output helpers ─────────────────────────────

let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError

/** One JSON object per line on stdout, flushed immediately for the host reader. */
func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    stdoutHandle.write(data)
    stdoutHandle.write(Data([0x0A]))
}

func emitState(_ state: String, reason: String? = nil) {
    var object: [String: Any] = ["event": "state", "state": state]
    if let reason { object["reason"] = reason }
    emit(object)
}

func emitError(_ code: String, _ message: String) {
    emit(["event": "error", "code": code, "message": message])
}

let isoFormatter = ISO8601DateFormatter()

func diag(_ message: String) {
    let line = "\(isoFormatter.string(from: Date())) \(message)\n"
    stderrHandle.write(Data(line.utf8))
}

// ───────────────────────────── IMA/DVI ADPCM ─────────────────────────────

final class IMAADPCMDecoder {
    private static let stepTable: [Int] = [
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
        34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
        143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
        494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
        1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
        4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
        11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
        27086, 29794, 32767,
    ]
    private static let indexTable = [-1, -1, -1, -1, 2, 4, 6, 8]

    private var predictor = 0
    private var stepIndex = 0

    func reset(predictor: Int = 0, stepIndex: Int = 0) {
        self.predictor = min(32_767, max(-32_768, predictor))
        self.stepIndex = min(88, max(0, stepIndex))
    }

    func decode(_ data: Data) -> [Int16] {
        var samples: [Int16] = []
        samples.reserveCapacity(data.count * 2)
        for byte in data {
            samples.append(decodeNibble(Int(byte >> 4)))
            samples.append(decodeNibble(Int(byte & 0x0F)))
        }
        return samples
    }

    private func decodeNibble(_ nibble: Int) -> Int16 {
        let step = Self.stepTable[stepIndex]
        var difference = step >> 3
        if nibble & 1 != 0 { difference += step >> 2 }
        if nibble & 2 != 0 { difference += step >> 1 }
        if nibble & 4 != 0 { difference += step }
        predictor += nibble & 8 != 0 ? -difference : difference
        predictor = min(32_767, max(-32_768, predictor))
        stepIndex += Self.indexTable[nibble & 7]
        stepIndex = min(88, max(0, stepIndex))
        return Int16(predictor)
    }
}

/** Declip, 3-tap low-pass, and peak-normalize the way other ATVV clients do. */
func postprocess(_ input: [Int16]) -> [Int16] {
    guard input.count > 2 else { return input }
    var declipped = input
    for index in declipped.indices {
        declipped[index] = max(-32_768, min(32_767, declipped[index]))
    }
    var filtered = declipped
    for index in 1..<(declipped.count - 1) {
        let value = Int(declipped[index - 1]) + 2 * Int(declipped[index]) + Int(declipped[index + 1])
        filtered[index] = Int16(max(-32_768, min(32_767, value / 4)))
    }
    let peak = max(1, filtered.reduce(0) { max($0, abs(Int($1))) })
    let gain = min(30.0, 28_000.0 / Double(peak))
    if gain <= 1.0 { return filtered }
    return filtered.map { Int16(max(-32_768, min(32_767, Double($0) * gain))) }
}

// ───────────────────────────── WAV writer ─────────────────────────────

func writeWav(_ samples: [Int16], sampleRate: Int, to url: URL) throws {
    var data = Data()
    let dataBytes = samples.count * 2
    func appendUInt32(_ value: UInt32) { var v = value.littleEndian; data.append(Data(bytes: &v, count: 4)) }
    func appendUInt16(_ value: UInt16) { var v = value.littleEndian; data.append(Data(bytes: &v, count: 2)) }
    data.append(Data("RIFF".utf8))
    appendUInt32(UInt32(36 + dataBytes))
    data.append(Data("WAVE".utf8))
    data.append(Data("fmt ".utf8))
    appendUInt32(16)
    appendUInt16(1)
    appendUInt16(1)
    appendUInt32(UInt32(sampleRate))
    appendUInt32(UInt32(sampleRate * 2))
    appendUInt16(2)
    appendUInt16(16)
    data.append(Data("data".utf8))
    appendUInt32(UInt32(dataBytes))
    for sample in samples {
        var value = sample.littleEndian
        data.append(Data(bytes: &value, count: 2))
    }
    try data.write(to: url, options: .atomic)
}

// ───────────────────────────── presence bridge ─────────────────────────────

final class ATVVCapture: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var command: CBCharacteristic?
    private var audioCharacteristic: CBCharacteristic?
    private var controlCharacteristic: CBCharacteristic?
    private var modelNumber: String?

    private let outDir: URL
    private let peripheralHint: UUID?
    private var running = true
    private var reconnecting = false
    private var retryWork: DispatchWorkItem?
    private var scanWork: DispatchWorkItem?

    private var version: UInt16 = 0x0100
    private var frameSize = 120
    private var selectedCodec: UInt8 = 0x02
    private var capabilitiesConfirmed = false

    private let decoder = IMAADPCMDecoder()
    private var pendingSync: (predictor: Int, stepIndex: Int)?
    private var packetBuffer = Data()
    private var samples: [Int16] = []
    private var streaming = false
    private var microphoneOpened = false
    private var utteranceIndex = 0

    init(outDir: URL, peripheralHint: UUID?) {
        self.outDir = outDir
        self.peripheralHint = peripheralHint
        super.init()
    }

    // ── lifecycle ──

    func run() {
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        central = CBCentralManager(delegate: self, queue: nil,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
        watchStdin()
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown("signal") }
            source.resume()
            signalSources.append(source)
        }
    }

    private var signalSources: [DispatchSourceSignal] = []

    /** The host closes our stdin to stop us; that is the normal shutdown path. */
    private func watchStdin() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while readLine(strippingNewline: true) != nil { /* commands are ignored; EOF means stop */ }
            DispatchQueue.main.async { self?.shutdown("stdin-eof") }
        }
    }

    private func shutdown(_ reason: String) {
        guard running else { return }
        running = false
        retryWork?.cancel()
        scanWork?.cancel()
        central?.stopScan()
        if let peripheral, let command {
            peripheral.writeValue(microphoneCloseV10, for: command, type: .withResponse)
        }
        if let peripheral, let central {
            central.cancelPeripheralConnection(peripheral)
        }
        diag("shutdown \(reason)")
        emitState("stopped")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }

    // ── discovery ──

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard running else { return }
        switch central.state {
        case .poweredOn:
            emitState("bluetooth-ready")
            connectOrScan()
        case .unauthorized:
            emitError("bluetooth-unauthorized", "macOS 未允許 DSH 使用藍牙；請在系統設定允許後重試。")
            shutdown("unauthorized")
        case .poweredOff:
            emitError("bluetooth-off", "藍牙已關閉，請先開啟。")
            shutdown("bluetooth-off")
        case .unsupported:
            emitError("bluetooth-unsupported", "此 Mac 不支援 BLE。")
            shutdown("unsupported")
        default:
            diag("central state \(central.state.rawValue)")
        }
    }

    private func connectOrScan() {
        guard running, peripheral == nil else { return }
        if let peripheralHint,
           let saved = central.retrievePeripherals(withIdentifiers: [peripheralHint]).first {
            connect(saved)
            return
        }
        if let connected = central.retrieveConnectedPeripherals(withServices: [atvvService]).first {
            connect(connected)
            return
        }
        startScan()
    }

    private func startScan() {
        guard running else { return }
        emitState("scanning")
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.running, self.peripheral == nil else { return }
            self.central.stopScan()
            emitError("no-device", "找不到已連線的遙控器；請先在同一個 Mac 的藍牙設定連上「小米藍牙語音遙控器」。")
            self.scheduleRetry(seconds: 5)
        }
        scanWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let localName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        let advertised = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let nameMatches = nameHints.contains { localName.localizedCaseInsensitiveContains($0) }
        guard nameMatches || advertised.contains(atvvService) else { return }
        central.stopScan()
        scanWork?.cancel()
        connect(peripheral)
    }

    private func connect(_ candidate: CBPeripheral) {
        guard running, peripheral == nil else { return }
        central.stopScan()
        scanWork?.cancel()
        peripheral = candidate
        candidate.delegate = self
        emitState("connecting", reason: candidate.name)
        central.connect(candidate, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard running else { return }
        diag("connected \(peripheral.name ?? "?")")
        peripheral.discoverServices([atvvService, deviceInfoService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        diag("connect failed: \(error?.localizedDescription ?? "?")")
        self.peripheral = nil
        emitError("connect-failed", error?.localizedDescription ?? "連線失敗")
        scheduleRetry(seconds: 2)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        guard running else { return }
        diag("disconnected: \(error?.localizedDescription ?? "no error")")
        self.peripheral = nil
        command = nil
        audioCharacteristic = nil
        controlCharacteristic = nil
        capabilitiesConfirmed = false
        microphoneOpened = false
        streaming = false
        packetBuffer.removeAll()
        emitState("reconnecting", reason: error?.localizedDescription)
        scheduleRetry(seconds: 2)
    }

    private func scheduleRetry(seconds: Double) {
        guard running else { return }
        retryWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.running else { return }
            self.connectOrScan()
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // ── GATT ──

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { diag("services error: \(error.localizedDescription)") }
        guard let service = peripheral.services?.first(where: { $0.uuid == atvvService }) else {
            emitError("no-atvv-service", "遙控器沒有提供 ATVV 語音服務（可能是不同型號）。")
            scheduleRetry(seconds: 10)
            return
        }
        peripheral.discoverCharacteristics([atvvCommand, atvvAudio, atvvControl], for: service)
        if let info = peripheral.services?.first(where: { $0.uuid == deviceInfoService }) {
            peripheral.discoverCharacteristics([modelNumberCharacteristic], for: info)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if service.uuid == deviceInfoService {
            for characteristic in service.characteristics ?? [] where characteristic.uuid == modelNumberCharacteristic {
                peripheral.readValue(for: characteristic)
            }
            return
        }
        guard service.uuid == atvvService else { return }
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case atvvCommand: command = characteristic
            case atvvAudio: audioCharacteristic = characteristic
            case atvvControl: controlCharacteristic = characteristic
            default: break
            }
        }
        guard let command, let audioCharacteristic, let controlCharacteristic else {
            emitError("atvv-incomplete", "ATVV 服務缺少必要特徵。")
            return
        }
        peripheral.setNotifyValue(true, for: audioCharacteristic)
        peripheral.setNotifyValue(true, for: controlCharacteristic)
        peripheral.writeValue(getCapabilitiesV10, for: command, type: .withResponse)
        diag("subscribed; GET_CAPS sent")
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value else { return }
        if characteristic.uuid == modelNumberCharacteristic {
            if let text = String(data: data, encoding: .utf8) { modelNumber = text.trimmingCharacters(in: .whitespaces) }
            announceReady(name: peripheral.name)
            return
        }
        if characteristic.uuid == atvvControl {
            handleControl(data)
        } else if characteristic.uuid == atvvAudio, streaming {
            handleAudio(data)
        }
    }

    private var announced = false

    private func announceReady(name: String?) {
        guard !announced else { return }
        announced = true
        emit([
            "event": "ready",
            "name": name ?? "遥控器",
            "model": modelNumber ?? "",
            "peripheralId": peripheral?.identifier.uuidString ?? "",
        ])
    }

    // ── ATVV control ──

    private func handleControl(_ data: Data) {
        guard let opcode = data.first else { return }
        diag("control \(data.map { String(format: "%02X", $0) }.joined(separator: " "))")
        switch opcode {
        case 0x0B: // capabilities
            guard data.count >= 7 else { return }
            version = UInt16(data[1]) << 8 | UInt16(data[2])
            var codecs = data[3]
            if version >= 0x0100 {
                if codecs == 0, data.count >= 9, data[4] & 0x03 != 0 { codecs = data[4] }
            } else if data.count >= 9 {
                codecs = data[4]
            }
            let frame = Int(data[5]) << 8 | Int(data[6])
            frameSize = frame == 0 ? 120 : frame
            selectedCodec = codecs & 0x02 != 0 ? 0x02 : 0x01
            capabilitiesConfirmed = true
            diag("CAPS version=\(String(version, radix: 16)) codec=\(selectedCodec) frame=\(frameSize)")
        case 0x08: // device asks the host to open the microphone
            openMicrophone()
        case 0x04: // stream start: bytes[1] == 0x03 is hold-to-talk voice
            let interaction = data.count >= 2 ? data[1] : 0
            if data.count >= 3 { selectedCodec = data[2] }
            guard capabilitiesConfirmed else { return }
            if interaction == 0x03 {
                beginUtterance()
            }
        case 0x00: // stream stop
            endUtterance()
        case 0x0A: // audio sync: predictor + step index
            guard data.count >= 7 else { return }
            let bits = UInt16(data[4]) << 8 | UInt16(data[5])
            let predictor = Int(Int16(bitPattern: bits))
            pendingSync = (predictor, Int(data[6]))
            packetBuffer.removeAll()
        default:
            break
        }
    }

    private func openMicrophone() {
        guard let peripheral, let command, !microphoneOpened else { return }
        microphoneOpened = true
        peripheral.writeValue(microphoneOpenV10, for: command, type: .withResponse)
        diag("MIC_OPEN sent")
    }

    // ── audio ──

    private func beginUtterance() {
        decoder.reset()
        pendingSync = nil
        packetBuffer.removeAll()
        samples.removeAll(keepingCapacity: true)
        streaming = true
        emit(["event": "voice-start"])
        diag("voice-started")
    }

    private func handleAudio(_ data: Data) {
        packetBuffer.append(data)
        while packetBuffer.count >= frameSize {
            let frame = packetBuffer.prefix(frameSize)
            packetBuffer.removeFirst(frameSize)
            if let sync = pendingSync {
                decoder.reset(predictor: sync.predictor, stepIndex: sync.stepIndex)
                pendingSync = nil
            }
            samples.append(contentsOf: decoder.decode(frame))
        }
    }

    private func endUtterance() {
        guard streaming else { return }
        streaming = false
        // Decode any tail that never reached a full frame.
        if !packetBuffer.isEmpty {
            if let sync = pendingSync {
                decoder.reset(predictor: sync.predictor, stepIndex: sync.stepIndex)
                pendingSync = nil
            }
            samples.append(contentsOf: decoder.decode(packetBuffer))
            packetBuffer.removeAll()
        }
        let processed = postprocess(samples)
        samples.removeAll(keepingCapacity: false)
        guard !processed.isEmpty else {
            emit(["event": "voice-stop", "path": "", "seconds": 0, "frames": 0, "packets": 0])
            return
        }
        utteranceIndex += 1
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let name = String(format: "utt-%013d-%03d.wav", stamp, utteranceIndex % 1000)
        let url = outDir.appendingPathComponent(name)
        do {
            try writeWav(processed, sampleRate: 16_000, to: url)
            let seconds = Double(processed.count) / 16_000.0
            emit([
                "event": "voice-stop",
                "path": url.path,
                "seconds": seconds,
                "frames": processed.count,
                "packets": max(1, processed.count / 240),
            ])
            diag("utterance written \(name) \(String(format: "%.2f", seconds))s")
        } catch {
            emitError("write-failed", "無法寫入錄音檔：\(error.localizedDescription)")
        }
    }
}


/// Seizes the remote's HID interface so its buttons stop reaching macOS, and
/// reports key transitions as JSON. Requires Input Monitoring permission.
final class HIDKeyGrabber {
    private var manager: IOHIDManager?
    private var pressed = Set<Int>()

    func start() {
        let access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        if access == kIOHIDAccessTypeDenied {
            emit(["event": "hid", "ok": false, "error": "input-monitoring"])
            return
        }
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matching: [String: Any] = [
            kIOHIDVendorIDKey as String: remoteVendorID,
            kIOHIDProductIDKey as String: remoteProductID,
        ]
        IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
        IOHIDManagerRegisterInputValueCallback(manager, { context, result, _, value in
            guard result == kIOReturnSuccess, let context else { return }
            Unmanaged<HIDKeyGrabber>.fromOpaque(context).takeUnretainedValue().handle(value)
        }, Unmanaged.passUnretained(self).toOpaque())
        let opened = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        guard opened == kIOReturnSuccess else {
            emit(["event": "hid", "ok": false, "error": "input-monitoring", "code": Int(opened)])
            IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
            return
        }
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        self.manager = manager
        emit(["event": "hid", "ok": true])
    }

    private func handle(_ value: IOHIDValue) {
        let element = IOHIDValueGetElement(value)
        guard IOHIDElementGetUsagePage(element) == 0x07 else { return }
        let usage = Int(IOHIDElementGetUsage(element))
        guard usage > 0 else { return }
        if IOHIDValueGetIntegerValue(value) != 0 {
            if pressed.insert(usage).inserted { emit(["event": "key", "usage": usage, "down": true]) }
        } else if pressed.remove(usage) != nil {
            emit(["event": "key", "usage": usage, "down": false])
        }
    }
}

var keyGrabber: HIDKeyGrabber?

// ───────────────────────────── entry point ─────────────────────────────

/**
 * Enumerate connected HID devices that match the remote identity and print one
 * device per line. Works without Input Monitoring: enumeration is allowed even
 * when opening the device for input is not.
 */
func listRemoteDevices() {
    let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
    let matching: [String: Any] = [
        kIOHIDVendorIDKey as String: remoteVendorID,
        kIOHIDProductIDKey as String: remoteProductID,
    ]
    IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
    _ = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
    let devices = (IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>) ?? []
    for device in devices {
        let name = IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String ?? ""
        let serial = IOHIDDeviceGetProperty(device, kIOHIDSerialNumberKey as CFString) as? String ?? ""
        let vendor = IOHIDDeviceGetProperty(device, kIOHIDVendorIDKey as CFString) as? Int ?? remoteVendorID
        let product = IOHIDDeviceGetProperty(device, kIOHIDProductIDKey as CFString) as? Int ?? remoteProductID
        emit([
            "event": "device",
            "name": name,
            "serial": serial,
            "vendorId": vendor,
            "productId": product,
            "model": "RC003",
            "supported": true,
        ])
    }
    IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
}

func argumentValue(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

if CommandLine.arguments.contains("--list") {
    listRemoteDevices()
    exit(0)
}

guard let outDirArgument = argumentValue("--out") else {
    FileHandle.standardError.write(Data("usage: atvv-capture --out <directory> [--peripheral-id <uuid>]\n".utf8))
    exit(64)
}

let outDir = URL(fileURLWithPath: outDirArgument, isDirectory: true)
let hint = argumentValue("--peripheral-id").flatMap { UUID(uuidString: $0) }
let capture = ATVVCapture(outDir: outDir, peripheralHint: hint)
emitState("starting")
capture.run()
if CommandLine.arguments.contains("--hid") {
    let grabber = HIDKeyGrabber()
    keyGrabber = grabber
    grabber.start()
}
RunLoop.main.run()
