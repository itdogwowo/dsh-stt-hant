/**
 * dsh-stt-hant — Windows ATVV capture helper.
 *
 * Runs as a child of the DSH host (never installed as an app). It connects to
 * the Xiaomi Bluetooth Voice Remote 2 Pro (RC003) over WinRT BLE, speaks the
 * ATVV private voice protocol, decodes the 16 kHz IMA/DVI ADPCM stream to PCM,
 * and writes one WAV per hold-to-talk utterance.
 *
 * Contract with the host (one JSON object per stdout line):
 *   {"event":"state","state":"bluetooth-ready"}
 *   {"event":"state","state":"scanning"}
 *   {"event":"state","state":"connecting","name":"..."}
 *   {"event":"ready","name":"...","model":"RC003","peripheralId":"..."}
 *   {"event":"voice-start"}
 *   {"event":"voice-stop","path":"C:\\...\\utt-...wav","seconds":5.2,"frames":412,"packets":240}
 *   {"event":"voice-stop","name":"utt-...wav","seconds":5.2,"frames":412,"packets":240,"wav":"<base64>"}
 *   {"event":"state","state":"reconnecting","reason":"..."}
 *   {"event":"error","code":"no-device","message":"..."}
 * stderr carries human-readable diagnostics; the host keeps a short tail.
 *
 * The second voice-stop shape is the sandbox fallback: when the spool directory
 * is not writable the WAV travels inline as base64 and the host writes it.
 *
 * Lifecycle: runs until stdin closes or the process is terminated, then closes
 * the ATVV microphone, disconnects, and exits 0. The host closes our stdin to
 * stop us, so that is the normal shutdown path.
 *
 * Protocol facts (UUIDs, handshake bytes, ADPCM layout) come from public
 * reverse-engineering work; this implementation is original. It is the Windows
 * port of native/atvv-capture.swift and keeps the same stdout contract, so the
 * host-side manager and routes are shared between the two platforms.
 *
 * Build: the host compiles this file with the in-box C# compiler (csc.exe,
 * C# 5) against the Windows SDK WinRT metadata. No Visual Studio is needed.
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Foundation;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

// ───────────────────────────── protocol constants ─────────────────────────────

internal static class AtvvProtocol
{
    /** ATVV (Android TV Voice-over-Bluetooth) service and its three characteristics. */
    internal static readonly Guid ServiceUuid = new Guid("ab5e0001-5a21-4f05-bc7d-af01f617b664");
    internal static readonly Guid CommandUuid = new Guid("ab5e0002-5a21-4f05-bc7d-af01f617b664");
    internal static readonly Guid AudioUuid = new Guid("ab5e0003-5a21-4f05-bc7d-af01f617b664");
    internal static readonly Guid ControlUuid = new Guid("ab5e0004-5a21-4f05-bc7d-af01f617b664");

    /** Standard Device Information service: model number identifies the remote. */
    internal static readonly Guid DeviceInfoUuid = new Guid("0000180a-0000-1000-8000-00805f9b34fb");
    internal static readonly Guid ModelNumberUuid = new Guid("00002a24-0000-1000-8000-00805f9b34fb");

    internal static readonly byte[] GetCapabilitiesV10 = new byte[] { 0x0A, 0x01, 0x00, 0x00, 0x03, 0x03 };
    internal static readonly byte[] MicrophoneOpenV10 = new byte[] { 0x0C, 0x00 };
    internal static readonly byte[] MicrophoneCloseV10 = new byte[] { 0x0D, 0x00 };

    /** RC003 (Xiaomi Bluetooth Voice Remote 2 Pro) HID identity; other models are out of scope. */
    internal const int RemoteVendorId = 0x2717;
    internal const int RemoteProductId = 0x32B8;

    internal static readonly string[] NameHints = new string[] { "小米", "MI RC", "Xiaomi", "Remote", "RC003" };

    internal static bool NameMatches(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        foreach (var hint in NameHints)
        {
            if (name.IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }
}

// ───────────────────────────── output helpers ─────────────────────────────

/** Writes one JSON object per line on stdout and diagnostics on stderr. */
internal static class Emit
{
    private static readonly object Gate = new object();
    private static readonly StreamWriter Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    private static readonly StreamWriter Err = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));

    static Emit()
    {
        Out.AutoFlush = true;
        Err.AutoFlush = true;
    }

    internal static void Line(string json)
    {
        lock (Gate)
        {
            try { Out.WriteLine(json); Out.Flush(); } catch { /* the host closed our pipe */ }
        }
    }

    internal static void Diag(string message)
    {
        lock (Gate)
        {
            try { Err.WriteLine(DateTime.Now.ToString("o", CultureInfo.InvariantCulture) + " " + message); Err.Flush(); } catch { /* stderr is best effort */ }
        }
    }

    /** JSON string literal, including the surrounding quotes. */
    internal static string Quoted(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else builder.Append(character);
                    break;
            }
        }
        builder.Append('"');
        return builder.ToString();
    }

    internal static string Number(double value)
    {
        return value.ToString("0.###", CultureInfo.InvariantCulture);
    }

    internal static void State(string state, string reason)
    {
        var json = "{\"event\":\"state\",\"state\":" + Quoted(state);
        if (!string.IsNullOrEmpty(reason)) json += ",\"reason\":" + Quoted(reason);
        Line(json + "}");
    }

    internal static void Ready(string name, string model, string peripheralId)
    {
        Line("{\"event\":\"ready\",\"name\":" + Quoted(name ?? "遥控器")
            + ",\"model\":" + Quoted(model ?? "")
            + ",\"peripheralId\":" + Quoted(peripheralId ?? "") + "}");
    }

    internal static void VoiceStart()
    {
        Line("{\"event\":\"voice-start\"}");
    }

    internal static void VoiceStop(string path, double seconds, int frames, int packets)
    {
        Line("{\"event\":\"voice-stop\",\"path\":" + Quoted(path ?? "")
            + ",\"seconds\":" + Number(seconds)
            + ",\"frames\":" + frames.ToString(CultureInfo.InvariantCulture)
            + ",\"packets\":" + packets.ToString(CultureInfo.InvariantCulture) + "}");
    }

    /**
     * Same event, but the WAV travels base64-encoded in the line instead of a
     * path. Used when the helper cannot write its spool directory; the host
     * writes the bytes to its own spool and answers the client as usual.
     */
    internal static void VoiceStopInline(string name, double seconds, int frames, int packets, byte[] wav)
    {
        Line("{\"event\":\"voice-stop\",\"name\":" + Quoted(name ?? "")
            + ",\"seconds\":" + Number(seconds)
            + ",\"frames\":" + frames.ToString(CultureInfo.InvariantCulture)
            + ",\"packets\":" + packets.ToString(CultureInfo.InvariantCulture)
            + ",\"wav\":" + Quoted(Convert.ToBase64String(wav ?? new byte[0])) + "}");
    }

    internal static void Error(string code, string message)
    {
        Line("{\"event\":\"error\",\"code\":" + Quoted(code ?? "helper-error")
            + ",\"message\":" + Quoted(message ?? "") + "}");
    }

    internal static void Device(string name, string serial, int vendorId, int productId, string model, bool supported)
    {
        Line("{\"event\":\"device\",\"name\":" + Quoted(name ?? "")
            + ",\"serial\":" + Quoted(serial ?? "")
            + ",\"vendorId\":" + vendorId.ToString(CultureInfo.InvariantCulture)
            + ",\"productId\":" + productId.ToString(CultureInfo.InvariantCulture)
            + ",\"model\":" + Quoted(model ?? "RC003")
            + ",\"supported\":" + (supported ? "true" : "false") + "}");
    }
}

// ───────────────────────────── IMA/DVI ADPCM ─────────────────────────────

/** Decodes the headerless 4-bit IMA/DVI ADPCM stream ATVV sends. */
internal sealed class ImaAdpcmDecoder
{
    private static readonly int[] StepTable = new int[]
    {
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
        34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
        143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
        494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
        1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
        4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
        11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
        27086, 29794, 32767,
    };

    private static readonly int[] IndexTable = new int[] { -1, -1, -1, -1, 2, 4, 6, 8 };

    private int predictor;
    private int stepIndex;

    internal void Reset(int predictorValue, int stepIndexValue)
    {
        predictor = Math.Min(32767, Math.Max(-32768, predictorValue));
        stepIndex = Math.Min(88, Math.Max(0, stepIndexValue));
    }

    internal void Decode(byte[] data, int offset, int count, List<short> samples)
    {
        for (var index = offset; index < offset + count; index++)
        {
            var value = data[index];
            samples.Add(DecodeNibble((value >> 4) & 0x0F));
            samples.Add(DecodeNibble(value & 0x0F));
        }
    }

    private short DecodeNibble(int nibble)
    {
        var step = StepTable[stepIndex];
        var difference = step >> 3;
        if ((nibble & 1) != 0) difference += step >> 2;
        if ((nibble & 2) != 0) difference += step >> 1;
        if ((nibble & 4) != 0) difference += step;
        predictor += (nibble & 8) != 0 ? -difference : difference;
        predictor = Math.Min(32767, Math.Max(-32768, predictor));
        stepIndex += IndexTable[nibble & 7];
        stepIndex = Math.Min(88, Math.Max(0, stepIndex));
        return (short)predictor;
    }
}

/** Declip, 3-tap low-pass, and peak-normalize the way other ATVV clients do. */
internal static class PostProcess
{
    internal static short[] Run(List<short> input)
    {
        if (input.Count <= 2) return input.ToArray();
        var filtered = new short[input.Count];
        for (var index = 0; index < input.Count; index++)
        {
            var value = Math.Max(-32768, Math.Min(32767, (int)input[index]));
            filtered[index] = (short)value;
        }
        var smooth = new short[filtered.Length];
        Array.Copy(filtered, smooth, filtered.Length);
        for (var index = 1; index < filtered.Length - 1; index++)
        {
            var value = (int)filtered[index - 1] + 2 * (int)filtered[index] + (int)filtered[index + 1];
            smooth[index] = (short)Math.Max(-32768, Math.Min(32767, value / 4));
        }
        var peak = 1;
        foreach (var sample in smooth)
        {
            var magnitude = Math.Abs((int)sample);
            if (magnitude > peak) peak = magnitude;
        }
        var gain = Math.Min(30.0, 28000.0 / peak);
        if (gain <= 1.0) return smooth;
        var scaled = new short[smooth.Length];
        for (var index = 0; index < smooth.Length; index++)
        {
            scaled[index] = (short)Math.Max(-32768, Math.Min(32767, (int)Math.Round(smooth[index] * gain)));
        }
        return scaled;
    }
}

/** Builds one 16 kHz mono 16-bit PCM WAV. */
internal static class WavWriter
{
    /**
     * Assemble the complete WAV in memory. The host asks for this when the
     * helper's own spool directory is not writable (DSH runs plugin children in
     * a sandbox on Windows, and endpoint protection may also block the write).
     */
    internal static byte[] Bytes(short[] samples, int sampleRate)
    {
        var dataBytes = samples.Length * 2;
        using (var memory = new MemoryStream(44 + dataBytes))
        using (var writer = new BinaryWriter(memory))
        {
            writer.Write(new byte[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' });
            writer.Write(36 + dataBytes);
            writer.Write(new byte[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E' });
            writer.Write(new byte[] { (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(sampleRate);
            writer.Write(sampleRate * 2);
            writer.Write((short)2);
            writer.Write((short)16);
            writer.Write(new byte[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' });
            writer.Write(dataBytes);
            foreach (var sample in samples) writer.Write(sample);
            writer.Flush();
            return memory.ToArray();
        }
    }

    internal static void Write(short[] samples, int sampleRate, string path)
    {
        File.WriteAllBytes(path, Bytes(samples, sampleRate));
    }
}

// ───────────────────────────── BLE capture ─────────────────────────────

/** One WinRT BLE session against the remote's ATVV service. */
internal sealed class Capture
{
    private readonly string outDir;
    private readonly string hint;
    private readonly object gate = new object();
    private readonly TaskCompletionSource<bool> finished = new TaskCompletionSource<bool>();
    private readonly ImaAdpcmDecoder decoder = new ImaAdpcmDecoder();
    private readonly List<short> samples = new List<short>();
    private readonly List<byte> packetBuffer = new List<byte>();

    private BluetoothLEDevice device;
    private GattSession gattSession;
    private GattDeviceService voiceService;
    private GattCharacteristic command;
    private GattCharacteristic audio;
    private GattCharacteristic control;
    private string model = string.Empty;
    private volatile bool running = true;
    private bool streaming = false;
    private bool microphoneOpened = false;
    private bool capabilitiesConfirmed = false;
    private ushort version = 0x0100;
    private int frameSize = 120;
    private byte selectedCodec = 0x02;
    private int[] pendingSync;
    private int utteranceIndex = 0;
    private TaskCompletionSource<bool> sessionDone = new TaskCompletionSource<bool>();
    // How long one advertisement watch waits for the remote to wake up.
    private const int ScanTimeoutMs = 6000;
    private bool scanGate = false;
    private int scanSkips = 0;
    private int consecutiveFailures = 0;
    // The in-box C# 5 compiler cannot project WinRT events as `+=`, so the
    // handlers are attached through the add_ accessors. Disposing the device
    // releases them; the handlers below are defensive because a callback can
    // still be in flight while a session is being torn down.

    internal Capture(string outDir, string hint)
    {
        this.outDir = outDir;
        this.hint = hint ?? string.Empty;
    }

    /** Stop the helper; the host closes our stdin to ask for this. */
    internal void Shutdown(string reason)
    {
        if (!running) return;
        running = false;
        try
        {
            if (device != null && command != null)
            {
                var close = CryptographicBuffer.CreateFromByteArray(AtvvProtocol.MicrophoneCloseV10);
                var write = command.WriteValueAsync(close, GattWriteOption.WriteWithResponse);
                write.AsTask().Wait(500);
            }
        }
        catch { /* the link may already be gone */ }
        Emit.Diag("shutdown " + reason);
        Emit.State("stopped", null);
        finished.TrySetResult(true);
        sessionDone.TrySetResult(true);
    }

    /** Run until shutdown; reconnects with a short delay when the link drops. */
    internal async Task RunAsync()
    {
        // Best effort: the host creates the spool directory, and a sandboxed
        // child may not be allowed to create it. Failing here would be fatal
        // for no reason, so the write is attempted later and falls back inline.
        try { Directory.CreateDirectory(outDir); } catch (Exception error) { Emit.Diag("spool dir unavailable: " + error.Message); }
        while (running)
        {
            sessionDone = new TaskCompletionSource<bool>();
            // After a failed session the remote is usually asleep, and an
            // address that is asleep takes the full 15 s GATT timeout to say
            // so. Watch advertisements first instead: a sleeping remote is
            // skipped in seconds, and the instant the user presses a key the
            // next attempt starts. Every third skip still tries a connection in
            // case the remote is awake but not advertising (already linked).
            if (scanGate)
            {
                Emit.State("scanning", "等待遙控器");
                var seen = await WaitForAdvertisementAsync(ScanTimeoutMs);
                if (!seen && ++scanSkips < 3)
                {
                    Emit.State("scanning", "遙控器沒有廣播，按一下按鍵喚醒");
                    await Task.Delay(1000);
                    continue;
                }
                scanSkips = 0;
            }
            try
            {
                await ConnectAsync();
            }
            catch (Exception error)
            {
                scanGate = true;
                consecutiveFailures++;
                Emit.Diag("session failed: " + error.Message);
                Emit.Error("helper-failed", error.Message);
            }
            Cleanup();
            if (!running) break;
            Emit.State("reconnecting", "helper session ended");
            // Back off instead of retrying every two seconds: a remote that is
            // asleep or whose link keeps dropping should not be hammered, and a
            // connect attempt itself costs a GATT timeout.
            var backoff = Math.Min(2000 * (1 << Math.Min(consecutiveFailures - 1, 4)), 30000);
            await Task.Delay(backoff);
        }
        await finished.Task;
    }

    /**
     * Wait until the bound remote advertises, or the timeout expires.
     *
     * CoreBluetooth on macOS needs a scan to find a peripheral at all; WinRT can
     * connect by address, but an address only answers while the remote is
     * advertising. Scanning keeps a failed retry cheap and reacts to a key press
     * within a second. Returns true when no address is bound (nothing to filter
     * on, so the caller should just try to connect).
     */
    private async Task<bool> WaitForAdvertisementAsync(int timeoutMs)
    {
        var address = ParseAddress(hint);
        if (!address.HasValue) return true;
        var found = new TaskCompletionSource<bool>();
        var watcher = new BluetoothLEAdvertisementWatcher();
        watcher.ScanningMode = BluetoothLEScanningMode.Active;
        watcher.Received += delegate (BluetoothLEAdvertisementWatcher sender, BluetoothLEAdvertisementReceivedEventArgs args)
        {
            try
            {
                if (args.BluetoothAddress == address.Value) found.TrySetResult(true);
            }
            catch { /* a malformed advertisement must not stop the scan */ }
        };
        try
        {
            watcher.Start();
            var winner = await Task.WhenAny(found.Task, Task.Delay(timeoutMs));
            return winner == found.Task;
        }
        catch (Exception error)
        {
            Emit.Diag("advertisement scan failed: " + error.Message);
            return true;
        }
        finally
        {
            try { watcher.Stop(); } catch { /* already stopped */ }
        }
    }

    private async Task ConnectAsync()
    {
        Emit.State("starting", null);
        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (adapter == null)
        {
            Emit.Error("bluetooth-unsupported", "此電腦沒有可用的藍牙介面。");
            throw new InvalidOperationException("no bluetooth adapter");
        }
        var radio = await adapter.GetRadioAsync();
        if (radio != null && radio.State != RadioState.On)
        {
            Emit.Error("bluetooth-off", "藍牙已關閉，請先開啟。");
            throw new InvalidOperationException("bluetooth off");
        }
        Emit.State("bluetooth-ready", null);

        var candidate = await FindDeviceAsync();
        if (candidate == null)
        {
            Emit.Error("no-device", "找不到已配對的遙控器；請先在 Windows 設定 → 藍牙與裝置 配對「小米藍牙語音遙控器 2 Pro」，並按一下遙控器按鍵喚醒。");
            throw new InvalidOperationException("no device");
        }
        device = candidate;
        device.ConnectionStatusChanged += OnConnectionStatusChanged;
        Emit.State("connecting", device.Name);
        await DiscoverAsync();
        consecutiveFailures = 0;

        await Task.WhenAny(finished.Task, sessionDone.Task);
    }

    private async Task<BluetoothLEDevice> FindDeviceAsync()
    {
        var address = ParseAddress(hint);
        if (address.HasValue)
        {
            try
            {
                var hinted = await BluetoothLEDevice.FromBluetoothAddressAsync(address.Value);
                if (hinted != null) return hinted;
            }
            catch (Exception error) { Emit.Diag("hint connect failed: " + error.Message); }
        }
        if (!string.IsNullOrEmpty(hint) && !address.HasValue)
        {
            try
            {
                var hinted = await BluetoothLEDevice.FromIdAsync(hint);
                if (hinted != null) return hinted;
            }
            catch (Exception error) { Emit.Diag("hint id connect failed: " + error.Message); }
        }
        var selector = BluetoothLEDevice.GetDeviceSelectorFromPairingState(true);
        var found = await DeviceInformation.FindAllAsync(selector);
        foreach (var info in found)
        {
            if (!AtvvProtocol.NameMatches(info.Name)) continue;
            try
            {
                var candidate = await BluetoothLEDevice.FromIdAsync(info.Id);
                if (candidate != null) return candidate;
            }
            catch (Exception error) { Emit.Diag("paired connect failed: " + error.Message); }
        }
        return null;
    }

    /**
     * Discover the ATVV service and its characteristics.
     *
     * Windows caches each device's GATT table, and a stale cache — a firmware
     * change, an interrupted session, or another host having paired the remote —
     * leaves the ATVV service without its characteristics. The helper then
     * reported "ATVV incomplete" and reconnected forever, succeeding only when
     * the OS eventually dropped the cache. The uncached request goes first
     * because it is also what opens the link; the cached table is only a
     * fallback. Only the last attempt reports an error to the panel, so a
     * transient cache problem does not spam it.
     */
    private async Task DiscoverAsync()
    {
        // Uncached first: on Windows an uncached service request is what opens
        // the BLE link. A cached request can return a full table without ever
        // connecting, which looks like success and then makes the first
        // characteristic write come back Unreachable (and the GET_CAPS write
        // hang). The cached attempt stays as a fallback for a link that is
        // already up and whose table the OS has.
        var modes = new[] { BluetoothCacheMode.Uncached, BluetoothCacheMode.Cached };
        Exception failure = null;
        for (var index = 0; index < modes.Length; index++)
        {
            var mode = modes[index];
            try
            {
                await DiscoverOnceAsync(mode, index == modes.Length - 1);
                return;
            }
            catch (Exception error)
            {
                failure = error;
                Emit.Diag("gatt discovery (" + mode + ") failed: " + error.Message);
            }
        }
        throw failure ?? new InvalidOperationException("ATVV incomplete");
    }

    private async Task DiscoverOnceAsync(BluetoothCacheMode mode, bool report)
    {
        voiceService = null;
        command = null;
        audio = null;
        control = null;
        // Ask for the ATVV service by UUID instead of enumerating the whole
        // table. A full enumeration hands back service objects from the cached
        // table, and once that cache is stale their characteristic query answers
        // AccessDenied with an empty list — the "ATVV 服務缺少必要特徵" loop.
        // A UUID request also opens the link when it is uncached.
        var found = await device.GetGattServicesForUuidAsync(AtvvProtocol.ServiceUuid, mode);
        if (found.Status != GattCommunicationStatus.Success)
        {
            if (report) Emit.Error("gatt-failed", "遙控器沒有回應（" + found.Status + "）。按一下遙控器上的按鍵把它喚醒，讓它重新開始廣播。");
            throw new InvalidOperationException("gatt failed: " + found.Status);
        }
        GattDeviceService voice = null;
        foreach (var service in found.Services) { voice = service; break; }
        if (voice == null)
        {
            if (report) Emit.Error("no-atvv-service", "遙控器沒有提供 ATVV 語音服務（可能是不同型號）。");
            throw new InvalidOperationException("no ATVV service");
        }
        voiceService = voice;
        var characteristics = await voice.GetCharacteristicsAsync(mode);
        foreach (var characteristic in characteristics.Characteristics)
        {
            if (characteristic.Uuid == AtvvProtocol.CommandUuid) command = characteristic;
            else if (characteristic.Uuid == AtvvProtocol.AudioUuid) audio = characteristic;
            else if (characteristic.Uuid == AtvvProtocol.ControlUuid) control = characteristic;
        }
        if (command == null || audio == null || control == null)
        {
            var seen = new StringBuilder();
            foreach (var characteristic in characteristics.Characteristics) seen.Append(characteristic.Uuid).Append(' ');
            Emit.Diag("atvv characteristics (" + mode + ", " + characteristics.Status + "): " + seen.ToString().Trim());
            if (report) Emit.Error("atvv-incomplete", "ATVV 服務缺少必要特徵。");
            throw new InvalidOperationException("ATVV incomplete");
        }

        try
        {
            var info = await device.GetGattServicesForUuidAsync(AtvvProtocol.DeviceInfoUuid, mode);
            if (info.Status == GattCommunicationStatus.Success)
            {
                foreach (var service in info.Services)
                {
                    var read = await service.GetCharacteristicsAsync(mode);
                    foreach (var characteristic in read.Characteristics)
                    {
                        if (characteristic.Uuid != AtvvProtocol.ModelNumberUuid) continue;
                        var value = await characteristic.ReadValueAsync(mode);
                        if (value.Status != GattCommunicationStatus.Success) continue;
                        var reader = DataReader.FromBuffer(value.Value);
                        model = reader.ReadString(reader.UnconsumedBufferLength).Trim();
                    }
                }
            }
        }
        catch (Exception error) { Emit.Diag("model read skipped: " + error.Message); }

        var notify = GattClientCharacteristicConfigurationDescriptorValue.Notify;
        var audioStatus = await audio.WriteClientCharacteristicConfigurationDescriptorAsync(notify);
        var controlStatus = await control.WriteClientCharacteristicConfigurationDescriptorAsync(notify);
        Emit.Diag("notify audio=" + audioStatus + " control=" + controlStatus);
        if (audioStatus != GattCommunicationStatus.Success || controlStatus != GattCommunicationStatus.Success)
        {
            // Unreachable here means the link is not up yet. Failing fast lets
            // the outer loop reconnect instead of hanging on the GET_CAPS write.
            if (report) Emit.Error("notify-failed", "遙控器沒有回應（通知訂閱 " + audioStatus + " / " + controlStatus + "）。按一下遙控器上的按鍵把它喚醒。");
            throw new InvalidOperationException("notify failed");
        }
        audio.ValueChanged += OnAudioValue;
        control.ValueChanged += OnControlValue;

        // Keep the link up between utterances: a remote that drops its
        // connection between two presses would otherwise pay a full
        // reconnect on every utterance.
        try
        {
            var session = await GattSession.FromDeviceIdAsync(device.BluetoothDeviceId);
            if (session != null)
            {
                session.MaintainConnection = true;
                gattSession = session;
            }
        }
        catch (Exception error) { Emit.Diag("gatt session unavailable: " + error.Message); }

        var caps = CryptographicBuffer.CreateFromByteArray(AtvvProtocol.GetCapabilitiesV10);
        var capsStatus = await command.WriteValueAsync(caps, GattWriteOption.WriteWithResponse);
        Emit.Diag("GET_CAPS sent " + capsStatus);
        if (capsStatus != GattCommunicationStatus.Success)
        {
            if (report) Emit.Error("caps-failed", "無法傳送 ATVV 能力查詢（" + capsStatus + "）。");
            throw new InvalidOperationException("GET_CAPS failed");
        }
        Emit.Ready(device.Name, model, FormatAddress(device.BluetoothAddress));
    }

    private void OnConnectionStatusChanged(BluetoothLEDevice sender, object args)
    {
        if (!running) return;
        try
        {
            if (sender.ConnectionStatus != BluetoothConnectionStatus.Connected)
            {
                Emit.Diag("disconnected");
                sessionDone.TrySetResult(true);
            }
        }
        catch (Exception error) { Emit.Diag("connection callback failed: " + error.Message); }
    }

    private void OnAudioValue(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        try
        {
            var data = ReadBuffer(args.CharacteristicValue);
            lock (gate)
            {
                if (!streaming) return;
                HandleAudio(data);
            }
        }
        catch (Exception error) { Emit.Diag("audio callback failed: " + error.Message); }
    }

    private void OnControlValue(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        try
        {
            var data = ReadBuffer(args.CharacteristicValue);
            lock (gate)
            {
                HandleControl(data);
            }
        }
        catch (Exception error) { Emit.Diag("control callback failed: " + error.Message); }
    }

    /** ATVV control opcodes; mirrors the macOS helper's handleControl. */
    private void HandleControl(byte[] data)
    {
        if (data.Length == 0) return;
        Emit.Diag("control " + BitConverter.ToString(data).Replace("-", " "));
        switch (data[0])
        {
            case 0x0B:
                {
                    if (data.Length < 7) return;
                    version = (ushort)((data[1] << 8) | data[2]);
                    var codecs = data[3];
                    if (version >= 0x0100)
                    {
                        if (codecs == 0 && data.Length >= 9 && (data[4] & 0x03) != 0) codecs = data[4];
                    }
                    else if (data.Length >= 9)
                    {
                        codecs = data[4];
                    }
                    var frame = (data[5] << 8) | data[6];
                    frameSize = frame == 0 ? 120 : frame;
                    selectedCodec = (codecs & 0x02) != 0 ? (byte)0x02 : (byte)0x01;
                    capabilitiesConfirmed = true;
                    Emit.Diag("CAPS version=" + version.ToString("x4", CultureInfo.InvariantCulture) + " codec=" + selectedCodec + " frame=" + frameSize);
                    break;
                }
            case 0x08:
                OpenMicrophone();
                break;
            case 0x04:
                {
                    var interaction = data.Length >= 2 ? data[1] : (byte)0;
                    if (data.Length >= 3) selectedCodec = data[2];
                    if (!capabilitiesConfirmed) return;
                    if (interaction == 0x03) BeginUtterance();
                    break;
                }
            case 0x00:
                EndUtterance();
                break;
            case 0x0A:
                {
                    if (data.Length < 7) return;
                    var bits = (ushort)((data[4] << 8) | data[5]);
                    var predictor = (short)bits;
                    pendingSync = new int[] { predictor, data[6] };
                    packetBuffer.Clear();
                    break;
                }
        }
    }

    private void OpenMicrophone()
    {
        if (device == null || command == null || microphoneOpened) return;
        microphoneOpened = true;
        var open = CryptographicBuffer.CreateFromByteArray(AtvvProtocol.MicrophoneOpenV10);
        try
        {
            var status = command.WriteValueAsync(open, GattWriteOption.WriteWithResponse).AsTask().GetAwaiter().GetResult();
            Emit.Diag("MIC_OPEN sent " + status);
        }
        catch (Exception error)
        {
            Emit.Diag("MIC_OPEN failed: " + error.Message);
        }
    }

    private void BeginUtterance()
    {
        decoder.Reset(0, 0);
        pendingSync = null;
        packetBuffer.Clear();
        samples.Clear();
        streaming = true;
        Emit.VoiceStart();
        Emit.Diag("voice-started");
    }

    private void HandleAudio(byte[] data)
    {
        packetBuffer.AddRange(data);
        while (packetBuffer.Count >= frameSize)
        {
            var frame = new byte[frameSize];
            packetBuffer.CopyTo(0, frame, 0, frameSize);
            packetBuffer.RemoveRange(0, frameSize);
            if (pendingSync != null)
            {
                decoder.Reset(pendingSync[0], pendingSync[1]);
                pendingSync = null;
            }
            decoder.Decode(frame, 0, frame.Length, samples);
        }
    }

    private void EndUtterance()
    {
        if (!streaming) return;
        streaming = false;
        if (packetBuffer.Count > 0)
        {
            if (pendingSync != null)
            {
                decoder.Reset(pendingSync[0], pendingSync[1]);
                pendingSync = null;
            }
            var tail = packetBuffer.ToArray();
            decoder.Decode(tail, 0, tail.Length, samples);
            packetBuffer.Clear();
        }
        var processed = PostProcess.Run(samples);
        samples.Clear();
        if (processed.Length == 0)
        {
            Emit.VoiceStop(string.Empty, 0, 0, 0);
            return;
        }
        utteranceIndex++;
        var stamp = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        var name = "utt-" + stamp.ToString("D13", CultureInfo.InvariantCulture) + "-" + (utteranceIndex % 1000).ToString("D3", CultureInfo.InvariantCulture) + ".wav";
        var path = Path.Combine(outDir, name);
        var seconds = (double)processed.Length / 16000.0;
        var frames = processed.Length;
        var packets = Math.Max(1, processed.Length / 240);
        try
        {
            WavWriter.Write(processed, 16000, path);
            Emit.VoiceStop(path, seconds, frames, packets);
            Emit.Diag("utterance written " + name + " " + seconds.ToString("0.00", CultureInfo.InvariantCulture) + "s");
        }
        catch (Exception error)
        {
            // DSH runs plugin children in a sandbox on Windows, so the plugin's
            // spool directory may be read-only for this process. Hand the WAV
            // back inline and let the host write it: the panel keeps working
            // without asking the user to relax the sandbox.
            try
            {
                Emit.VoiceStopInline(name, seconds, frames, packets, WavWriter.Bytes(processed, 16000));
                Emit.Diag("write blocked (" + error.Message + "), sent inline " + name);
            }
            catch (Exception fatal)
            {
                Emit.Error("write-failed", "無法寫入錄音檔：" + fatal.Message);
            }
        }
    }

    private void Cleanup()
    {
        try
        {
            if (audio != null) audio.ValueChanged -= OnAudioValue;
            if (control != null) control.ValueChanged -= OnControlValue;
            if (gattSession != null)
            {
                try { gattSession.MaintainConnection = false; } catch { /* already gone */ }
                gattSession.Dispose();
            }
            if (device != null)
            {
                device.ConnectionStatusChanged -= OnConnectionStatusChanged;
                device.Dispose();
            }
        }
        catch { /* already gone */ }
        audio = null;
        control = null;
        command = null;
        voiceService = null;
        device = null;
        gattSession = null;
        streaming = false;
        microphoneOpened = false;
        capabilitiesConfirmed = false;
        pendingSync = null;
        packetBuffer.Clear();
        samples.Clear();
    }

    private static byte[] ReadBuffer(IBuffer buffer)
    {
        if (buffer == null) return new byte[0];
        var reader = DataReader.FromBuffer(buffer);
        var bytes = new byte[reader.UnconsumedBufferLength];
        reader.ReadBytes(bytes);
        return bytes;
    }

    /** "C0:5D:39:F8:3B:7E" from the 48-bit BLE address. */
    internal static string FormatAddress(ulong address)
    {
        var hex = address.ToString("X12", CultureInfo.InvariantCulture);
        var parts = new string[6];
        for (var index = 0; index < 6; index++) parts[index] = hex.Substring(index * 2, 2);
        return string.Join(":", parts);
    }

    /** Parse "C0:5D:39:F8:3B:7E" or "c05d39f83b7e"; null when the hint is not an address. */
    internal static ulong? ParseAddress(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var compact = text.Replace(":", string.Empty).Replace("-", string.Empty).Trim();
        if (compact.Length != 12) return null;
        foreach (var character in compact)
        {
            var isHex = (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');
            if (!isHex) return null;
        }
        ulong parsed;
        if (ulong.TryParse(compact, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed)) return parsed;
        return null;
    }
}

// ───────────────────────────── entry point ─────────────────────────────

internal static class Program
{
    /**
     * Enumerate paired remotes for the binding step. WinRT only lists devices
     * Windows already knows about, so pairing in Windows Settings comes first.
     */
    private static async Task ListDevicesAsync()
    {
        var selector = BluetoothLEDevice.GetDeviceSelectorFromPairingState(true);
        var found = await DeviceInformation.FindAllAsync(selector);
        foreach (var info in found)
        {
            if (!AtvvProtocol.NameMatches(info.Name)) continue;
            var address = string.Empty;
            try
            {
                var device = await BluetoothLEDevice.FromIdAsync(info.Id);
                if (device != null)
                {
                    address = Capture.FormatAddress(device.BluetoothAddress);
                    device.Dispose();
                }
            }
            catch (Exception error) { Emit.Diag("list address failed: " + error.Message); }
            Emit.Device(info.Name, address, AtvvProtocol.RemoteVendorId, AtvvProtocol.RemoteProductId, "RC003", true);
        }
    }

    private static void WatchStdin(Capture capture)
    {
        var thread = new Thread(() =>
        {
            try
            {
                var stdin = Console.OpenStandardInput();
                var buffer = new byte[256];
                while (true)
                {
                    var read = stdin.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                }
            }
            catch { /* stdin closed */ }
            capture.Shutdown("stdin-eof");
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static int Main(string[] args)
    {
        var outDir = string.Empty;
        var hint = string.Empty;
        var list = false;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--list":
                    list = true;
                    break;
                case "--out":
                    if (index + 1 < args.Length) outDir = args[++index];
                    break;
                case "--peripheral-id":
                    if (index + 1 < args.Length) hint = args[++index];
                    break;
            }
        }
        if (list)
        {
            try { ListDevicesAsync().GetAwaiter().GetResult(); }
            catch (Exception error) { Emit.Diag("list failed: " + error.Message); }
            return 0;
        }
        if (outDir.Length == 0)
        {
            Emit.Diag("usage: atvv-capture --out <directory> [--peripheral-id <address>]");
            return 64;
        }
        var capture = new Capture(outDir, hint);
        WatchStdin(capture);
        try
        {
            capture.RunAsync().GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            Emit.Diag("fatal: " + error);
            Emit.Error("fatal", error.Message);
            return 1;
        }
        return 0;
    }
}
