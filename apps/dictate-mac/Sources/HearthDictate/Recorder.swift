import AVFoundation
import DictateCore

/// The microphone, converted as it records to 16 kHz mono Int16 in memory. A new engine per
/// dictation, so a microphone plugged in since the last one is the one used.
final class Recorder {
    enum RecorderError: LocalizedError {
        case noMicrophone

        var errorDescription: String? { "No microphone is available." }
    }

    /// The level (0…1) of each block as it arrives, on the main thread.
    var onLevel: ((Float) -> Void)?
    /// Each block of converted 16 kHz samples as it is ready, on the audio thread (for streaming).
    var onSamples: (([Int16]) -> Void)?

    private var engine: AVAudioEngine?
    private var resampler: StreamingResampler?
    private var samples: [Int16] = []
    private let lock = NSLock()

    var isRecording: Bool { engine != nil }

    /// Seconds recorded so far.
    var duration: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return TimeInterval(samples.count) / 16_000
    }

    func start() throws {
        cancel()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecorderError.noMicrophone }
        let resampler = StreamingResampler(inputRate: format.sampleRate)
        lock.lock()
        samples = []
        samples.reserveCapacity(16_000 * 30)
        lock.unlock()
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let mono = Self.mono(buffer)
            let converted = resampler.process(mono)
            self.onSamples?(converted)
            self.lock.lock()
            self.samples.append(contentsOf: converted)
            self.lock.unlock()
            let level = StreamingResampler.level(mono)
            DispatchQueue.main.async { self.onLevel?(level) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
        self.resampler = resampler
    }

    /// Stops and returns everything recorded.
    func stop() -> [Int16] {
        guard let engine, let resampler else { return [] }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        self.resampler = nil
        lock.lock()
        defer { lock.unlock() }
        let tail = resampler.finish()
        onSamples?(tail)
        samples.append(contentsOf: tail)
        let out = samples
        samples = []
        return out
    }

    func cancel() {
        _ = stop()
    }

    private static func mono(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let data = buffer.floatChannelData else { return [] }
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        if buffer.format.isInterleaved {
            let all = UnsafeBufferPointer(start: data[0], count: frames * channels)
            return (0..<frames).map { frame in
                var sum: Float = 0
                for c in 0..<channels { sum += all[frame * channels + c] }
                return sum / Float(channels)
            }
        }
        let perChannel = (0..<channels).map { Array(UnsafeBufferPointer(start: data[$0], count: frames)) }
        return StreamingResampler.downmix(perChannel)
    }
}
