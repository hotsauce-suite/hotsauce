import Foundation

/// Microphone audio (any rate, any channel count, Float32) to what Hearth wants: 16 kHz mono
/// Int16. Streaming, so a long dictation is converted as it is recorded rather than held at the
/// microphone's rate. Downsampling averages the input over each output sample's span (a box
/// filter), which keeps speech free of the worst aliasing without a filter design.
public final class StreamingResampler {
    public let inputRate: Double
    public let outputRate: Double
    private let step: Double
    private var pending: [Float] = []
    /// Position of the next output sample, in input samples from the start of `pending`.
    private var position: Double = 0

    public init(inputRate: Double, outputRate: Double = 16_000) {
        precondition(inputRate > 0 && outputRate > 0)
        self.inputRate = inputRate
        self.outputRate = outputRate
        step = inputRate / outputRate
    }

    /// Mixes interleaved or per-channel samples down to mono. `channels` holds one array per channel.
    public static func downmix(_ channels: [[Float]]) -> [Float] {
        guard let first = channels.first else { return [] }
        if channels.count == 1 { return first }
        var mono = [Float](repeating: 0, count: first.count)
        for channel in channels {
            for i in 0..<min(mono.count, channel.count) { mono[i] += channel[i] }
        }
        let scale = 1 / Float(channels.count)
        for i in mono.indices { mono[i] *= scale }
        return mono
    }

    /// Converts the next block of mono samples; returns what is ready so far.
    public func process(_ mono: [Float]) -> [Int16] {
        pending.append(contentsOf: mono)
        return drain(final: false)
    }

    /// The samples still held back at the end of the recording.
    public func finish() -> [Int16] {
        drain(final: true)
    }

    private func drain(final: Bool) -> [Int16] {
        var out: [Int16] = []
        let half = max(step / 2, 0.5)
        while true {
            let hi = position + half
            if !final, hi > Double(pending.count) { break }
            if position >= Double(pending.count) { break }
            let start = max(0, Int((position - half).rounded(.up)))
            let end = min(pending.count, max(start + 1, Int(hi.rounded(.up))))
            var sum: Float = 0
            for i in start..<end { sum += pending[i] }
            out.append(Self.int16(sum / Float(end - start)))
            position += step
        }
        // Keep only the input the next output samples can still reach.
        let keepFrom = max(0, min(pending.count, Int((position - half).rounded(.down))))
        if keepFrom > 0 {
            pending.removeFirst(keepFrom)
            position -= Double(keepFrom)
        }
        if final {
            pending.removeAll()
            position = 0
        }
        return out
    }

    public static func int16(_ sample: Float) -> Int16 {
        let clamped = max(-1, min(1, sample))
        return Int16((clamped * 32767).rounded())
    }

    /// Root-mean-square level of a block, 0…1, for the overlay's meter.
    public static func level(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        return min(1, (sum / Float(samples.count)).squareRoot())
    }
}
