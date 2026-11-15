import AVFoundation
import CoreAudio
import DictateCore
import Foundation

/// "Any app on this Mac" (docs/PLAN-record-any-call.md): the microphone as "me", and everything
/// the Mac plays, through a Core Audio process tap, as "them". Not Apple's voice processing (echo
/// cancelling): on macOS 27 it fails to build its own device beside the tap and can take the mic
/// down with it (docs/learnings/mac-audio.md). Both are converted
/// to 16 kHz mono PCM16 and handed out in whole 100 ms frames every 100 ms on the main thread.
/// Pause really stops listening: the mic and the tap are released until resume.
@available(macOS 14.2, *)
@MainActor
final class MeetingCapture {
    enum CaptureError: Error {
        case failed(MeetingAudio.Failure, String)
    }

    let session = UUID().uuidString
    /// Whole frames for each track, every 100 ms (either may be nil).
    var onFrames: (Data?, Data?) -> Void = { _, _ in }
    /// A track that stopped on its own and couldn't be brought back.
    var onEnded: (MeetingAudio.Track) -> Void = { _ in }

    private let me = MeetingFramer()
    private let them = MeetingFramer()
    private var engine: AVAudioEngine?
    private var tap: SystemAudioTap?
    private var timer: Timer?
    private var configObserver: NSObjectProtocol?
    private(set) var isPaused = false
    /// Device changes that restarted the mic (for the probe).
    private(set) var micRestarts = 0
    /// The mic's rate as the engine reported it (for the probe).
    private(set) var micRate: Double = 0
    private var restartWork: DispatchWorkItem?
    /// The tap's rate and how many samples it delivered (for the probe).
    var tapRate: Double { tap?.rate ?? 0 }
    var tapSamples: Int { tap?.samplesDelivered ?? 0 }
    /// What to record; the app records both. The probe can check each part on its own.
    private let useMic: Bool
    private let useTap: Bool

    init(mic: Bool = true, tap: Bool = true) {
        useMic = mic
        useTap = tap
    }

    func start() throws {
        // The tap first: making its private device changes the Mac's device list, which would
        // otherwise reset a mic engine that had just started.
        do {
            if useTap { try startTap() }
        } catch {
            stop()
            throw CaptureError.failed(.unsupported, "\(Brand.name) couldn’t listen to this Mac’s audio. Check System Settings → Privacy & Security → Screen & System Audio Recording.")
        }
        if useMic {
            do { try startMicrophone() } catch {
                stop()
                throw error
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.deliver() }
        }
    }

    /// Releases the mic and the tap (macOS's recording indicators go out) until resume.
    func setPaused(_ paused: Bool) {
        guard paused != isPaused, timer != nil else { return }
        isPaused = paused
        if paused {
            stopMicrophone()
            tap?.stop()
            tap = nil
            _ = me.takeFrames()
            _ = them.takeFrames()
        } else {
            if useMic { do { try startMicrophone() } catch { onEnded(.me) } }
            if useTap { do { try startTap() } catch { onEnded(.them) } }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        stopMicrophone()
        tap?.stop()
        tap = nil
    }

    private func deliver() {
        let a = me.takeFrames()
        let b = them.takeFrames()
        if a != nil || b != nil { onFrames(a, b) }
    }

    // MARK: Mac audio

    private func startTap() throws {
        let tap = SystemAudioTap(sink: Self.sink(for: them))
        tap.onDead = { [weak self, weak tap] in
            MainActor.assumeIsolated {
                guard let self, let tap, self.tap === tap else { return }
                // The device went away (coreaudiod restarted, the permission was revoked):
                // one fresh try, then tell the page.
                tap.stop()
                self.tap = nil
                do { try self.startTap() } catch { self.onEnded(.them) }
            }
        }
        try tap.start()
        self.tap = tap
    }

    /// Converts the tap's samples on its queue; built outside the main actor, as it runs there.
    nonisolated private static func sink(for framer: MeetingFramer) -> @Sendable ([Float], Double) -> Void {
        let state = ResamplerBox()
        return { mono, rate in
            framer.append(state.resampler(for: rate).process(mono))
        }
    }

    // MARK: Microphone

    private func startMicrophone() throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized, .notDetermined: break
        default:
            throw CaptureError.failed(.denied, "Allow the microphone for \(Brand.name) in System Settings → Privacy & Security → Microphone.")
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.failed(.noMic, "No microphone was found, or another app is using it.")
        }
        micRate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 1_024, format: format, block: Self.micBlock(rate: format.sampleRate, framer: me))
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            engine.stop()
            throw CaptureError.failed(.noMic, "\(Brand.name) couldn’t start the microphone: \(error.localizedDescription)")
        }
        self.engine = engine
        // Headphones, AirPods or another input mid-call stop the engine: start it again on the
        // new device, and only tell the page if that fails.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.engine === engine, !self.isPaused else { return }
                self.micRestarts += 1
                self.stopMicrophone()
                self.restartMicrophone(attempt: 1)
            }
        }
    }

    /// Devices settle a moment after a change: try again after a short wait, three times.
    private func restartMicrophone(attempt: Int) {
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.timer != nil, !self.isPaused, self.engine == nil else { return }
                do {
                    try self.startMicrophone()
                } catch {
                    if attempt < 3 { self.restartMicrophone(attempt: attempt + 1) } else { self.onEnded(.me) }
                }
            }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5 * Double(attempt), execute: work)
    }

    private func stopMicrophone() {
        restartWork?.cancel()
        restartWork = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
    }

    /// The mic tap's block runs on an audio thread; built outside the main actor.
    nonisolated private static func micBlock(rate: Double, framer: MeetingFramer) -> AVAudioNodeTapBlock {
        let resampler = StreamingResampler(inputRate: rate)
        return { buffer, _ in
            framer.append(resampler.process(firstChannel(buffer)))
        }
    }

    /// The first channel: a mic's channels all carry the same voice.
    nonisolated private static func firstChannel(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let data = buffer.floatChannelData else { return [] }
        let frames = Int(buffer.frameLength)
        if buffer.format.isInterleaved {
            let channels = Int(buffer.format.channelCount)
            let all = UnsafeBufferPointer(start: data[0], count: frames * channels)
            return stride(from: 0, to: all.count, by: channels).map { all[$0] }
        }
        return Array(UnsafeBufferPointer(start: data[0], count: frames))
    }
}

/// One resampler per input rate, used only from the tap's queue.
private final class ResamplerBox: @unchecked Sendable {
    private var current: StreamingResampler?
    func resampler(for rate: Double) -> StreamingResampler {
        if let current, current.inputRate == rate { return current }
        let next = StreamingResampler(inputRate: rate)
        current = next
        return next
    }
}

/// Everything the Mac plays, except this app, from a Core Audio process tap (macOS 14.2+) inside
/// a private aggregate device. The first start asks for System Audio Recording; if it's refused,
/// macOS delivers silence, which the page's "Is sound arriving?" check reports. The tap's rate is
/// re-read whenever it changes (AirPods switching to their headset profile), so "them" never
/// plays at the wrong speed.
@available(macOS 14.2, *)
final class SystemAudioTap: @unchecked Sendable {
    struct OSStatusError: Error { let status: OSStatus; let step: String }

    /// The device stopped on its own; on the main queue.
    var onDead: (() -> Void)?

    private let sink: @Sendable ([Float], Double) -> Void
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "app.hearth.meeting-tap", qos: .userInitiated)
    private let rateLock = NSLock()
    private var storedRate: Double = 0
    private var formatListener: AudioObjectPropertyListenerBlock?
    private var aliveListener: AudioObjectPropertyListenerBlock?

    init(sink: @escaping @Sendable ([Float], Double) -> Void) {
        self.sink = sink
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    func start() throws {
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: Self.ownProcess().map { [$0] } ?? [])
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tapID), "create the tap")
        do { try readRate() } catch {
            stop()
            throw error
        }

        var formatAddress = Self.address(kAudioTapPropertyFormat)
        let formatListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in try? self?.readRate() }
        self.formatListener = formatListener
        AudioObjectAddPropertyListenerBlock(tapID, &formatAddress, queue, formatListener)

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "\(Brand.name) meeting audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "create the device")

        var aliveAddress = Self.address(kAudioDevicePropertyDeviceIsAlive)
        let aliveListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, !self.isAlive() else { return }
            DispatchQueue.main.async { self.onDead?() }
        }
        self.aliveListener = aliveListener
        AudioObjectAddPropertyListenerBlock(aggregateID, &aliveAddress, queue, aliveListener)

        let sink = self.sink
        try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, input, _, _, _ in
            guard let self else { return }
            let mono = Self.mono(input)
            let rate = self.currentRate()
            self.samplesDelivered += mono.count
            if !mono.isEmpty, rate > 0 { sink(mono, rate) }
        }, "listen to the device")
        try check(AudioDeviceStart(aggregateID, procID), "start the device")
    }

    func stop() {
        onDead = nil
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            if let aliveListener {
                var address = Self.address(kAudioDevicePropertyDeviceIsAlive)
                AudioObjectRemovePropertyListenerBlock(aggregateID, &address, queue, aliveListener)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            if let formatListener {
                var address = Self.address(kAudioTapPropertyFormat)
                AudioObjectRemovePropertyListenerBlock(tapID, &address, queue, formatListener)
            }
            AudioHardwareDestroyProcessTap(tapID)
        }
        procID = nil
        formatListener = nil
        aliveListener = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        // Let a block already queued finish before the caller moves on (never from the queue itself).
        queue.sync {}
    }

    deinit { stop() }

    var rate: Double { currentRate() }
    private(set) var samplesDelivered = 0

    private func currentRate() -> Double {
        rateLock.lock()
        defer { rateLock.unlock() }
        return storedRate
    }

    private func readRate() throws {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = Self.address(kAudioTapPropertyFormat)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format)
        let isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0 && format.mBitsPerChannel == 32
        guard status == noErr, isFloat, format.mSampleRate > 0 else {
            throw OSStatusError(status: status == noErr ? -1 : status, step: "read the tap's format")
        }
        rateLock.lock()
        storedRate = format.mSampleRate
        rateLock.unlock()
    }

    private func isAlive() -> Bool {
        var alive: UInt32 = 1
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = Self.address(kAudioDevicePropertyDeviceIsAlive)
        let status = AudioObjectGetPropertyData(aggregateID, &address, 0, nil, &size, &alive)
        return status != noErr || alive != 0
    }

    /// Float32 samples, mixed to mono: one interleaved buffer, or one buffer per channel.
    private static func mono(_ list: UnsafePointer<AudioBufferList>) -> [Float] {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        if buffers.count == 1, let first = buffers.first, let raw = first.mData {
            let perFrame = max(1, Int(first.mNumberChannels))
            let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let samples = UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Float.self), count: count)
            if perFrame == 1 { return Array(samples) }
            var mono: [Float] = []
            mono.reserveCapacity(count / perFrame)
            var i = 0
            while i + perFrame <= count {
                var sum: Float = 0
                for c in 0..<perFrame { sum += samples[i + c] }
                mono.append(sum / Float(perFrame))
                i += perFrame
            }
            return mono
        }
        let perChannel = buffers.compactMap { buffer -> [Float]? in
            guard let raw = buffer.mData else { return nil }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            return Array(UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Float.self), count: count))
        }
        return StreamingResampler.downmix(perChannel)
    }

    private func check(_ status: OSStatus, _ step: String) throws {
        guard status == noErr else {
            stop()
            throw OSStatusError(status: status, step: step)
        }
    }

    /// This app's own audio process, so its sounds (a reminder chime) aren't recorded as "them".
    private static func ownProcess() -> AudioObjectID? {
        var pid = ProcessInfo.processInfo.processIdentifier
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = Self.address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }
}
