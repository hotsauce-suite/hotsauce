import Foundation

/// The sounds Dictate plays as it starts, stops, sends and is cancelled
/// (docs/PLAN-dictate-send-and-sounds.md, R11). The member picks a theme on the web; it is kept on
/// the server and remembered here. The web makes the same sounds from the same table
/// (`apps/web/src/lib/dictateSounds.ts`), and a test there checks the two match.
public enum SoundTheme: String, CaseIterable, Codable, Sendable {
    case soft
    case pop
    case click
    case chime
    case off
}

public enum SoundEvent: String, CaseIterable, Sendable {
    case start, stop, send, cancel
}

/// One tone: when it starts and how long it lasts (seconds), its pitch (Hz, gliding to `to`).
public struct Tone: Equatable, Sendable {
    public enum Wave: Sendable { case sine, triangle, noise }
    public var at: Double
    public var dur: Double
    public var freq: Double
    public var wave: Wave
    public var gain: Double
    public var to: Double?

    public init(at: Double, dur: Double, freq: Double, wave: Wave, gain: Double, to: Double? = nil) {
        self.at = at
        self.dur = dur
        self.freq = freq
        self.wave = wave
        self.gain = gain
        self.to = to
    }
}

public enum DictateSounds {
    public static func tones(_ theme: SoundTheme, _ event: SoundEvent) -> [Tone] {
        switch (theme, event) {
        case (.off, _): return []
        case (.soft, .start): return [Tone(at: 0, dur: 0.12, freq: 587, wave: .sine, gain: 0.22, to: 880)]
        case (.soft, .stop): return [Tone(at: 0, dur: 0.12, freq: 880, wave: .sine, gain: 0.22, to: 587)]
        case (.soft, .send): return [Tone(at: 0, dur: 0.07, freq: 784, wave: .sine, gain: 0.2), Tone(at: 0.07, dur: 0.11, freq: 1175, wave: .sine, gain: 0.2)]
        case (.soft, .cancel): return [Tone(at: 0, dur: 0.14, freq: 440, wave: .sine, gain: 0.16, to: 330)]
        case (.pop, .start): return [Tone(at: 0, dur: 0.06, freq: 400, wave: .triangle, gain: 0.25, to: 900)]
        case (.pop, .stop): return [Tone(at: 0, dur: 0.06, freq: 900, wave: .triangle, gain: 0.25, to: 400)]
        case (.pop, .send): return [Tone(at: 0, dur: 0.05, freq: 500, wave: .triangle, gain: 0.22, to: 1000), Tone(at: 0.06, dur: 0.05, freq: 700, wave: .triangle, gain: 0.22, to: 1400)]
        case (.pop, .cancel): return [Tone(at: 0, dur: 0.08, freq: 300, wave: .triangle, gain: 0.2, to: 200)]
        case (.click, .start): return [Tone(at: 0, dur: 0.012, freq: 0, wave: .noise, gain: 0.3), Tone(at: 0, dur: 0.03, freq: 1800, wave: .sine, gain: 0.15)]
        case (.click, .stop): return [Tone(at: 0, dur: 0.012, freq: 0, wave: .noise, gain: 0.3), Tone(at: 0, dur: 0.03, freq: 1200, wave: .sine, gain: 0.15)]
        case (.click, .send): return [Tone(at: 0, dur: 0.012, freq: 0, wave: .noise, gain: 0.3), Tone(at: 0.05, dur: 0.012, freq: 0, wave: .noise, gain: 0.3), Tone(at: 0.05, dur: 0.03, freq: 2200, wave: .sine, gain: 0.12)]
        case (.click, .cancel): return [Tone(at: 0, dur: 0.02, freq: 0, wave: .noise, gain: 0.2)]
        case (.chime, .start): return [Tone(at: 0, dur: 0.35, freq: 1318, wave: .sine, gain: 0.14), Tone(at: 0, dur: 0.35, freq: 1975, wave: .sine, gain: 0.06)]
        case (.chime, .stop): return [Tone(at: 0, dur: 0.35, freq: 988, wave: .sine, gain: 0.14), Tone(at: 0, dur: 0.35, freq: 1480, wave: .sine, gain: 0.06)]
        case (.chime, .send): return [Tone(at: 0, dur: 0.25, freq: 1318, wave: .sine, gain: 0.12), Tone(at: 0.09, dur: 0.4, freq: 1760, wave: .sine, gain: 0.12)]
        case (.chime, .cancel): return [Tone(at: 0, dur: 0.3, freq: 660, wave: .sine, gain: 0.1)]
        }
    }

    public static func length(_ tones: [Tone]) -> Double {
        tones.reduce(0) { max($0, $1.at + $1.dur) }
    }

    /// The samples, between -1 and 1: each tone rises over 4 ms and dies away, and the noise is the
    /// same every time. The same arithmetic as the web's `renderSound`.
    public static func render(_ tones: [Tone], sampleRate: Double) -> [Float] {
        var out = [Double](repeating: 0, count: Int((length(tones) * sampleRate).rounded(.up)))
        for t in tones {
            let start = Int((t.at * sampleRate).rounded())
            let count = Int((t.dur * sampleRate).rounded())
            var phase = 0.0
            var seed: Int64 = 22222
            var i = 0
            while i < count, start + i < out.count {
                let time = Double(i) / sampleRate
                let progress = Double(i) / Double(count)
                let freq = t.freq + ((t.to ?? t.freq) - t.freq) * progress
                phase += 2 * Double.pi * freq / sampleRate
                let wave: Double
                switch t.wave {
                case .noise:
                    seed = (seed * 16807) % 2_147_483_647
                    wave = Double(seed) / 2_147_483_647 * 2 - 1
                case .triangle:
                    wave = 2 / Double.pi * asin(sin(phase))
                case .sine:
                    wave = sin(phase)
                }
                let attack = min(1, time / 0.004)
                let envelope = attack * exp(-5 * progress) * min(1, Double(count - i) / (0.005 * sampleRate))
                out[start + i] += wave * t.gain * envelope
                i += 1
            }
        }
        return out.map { Float(max(-1, min(1, $0))) }
    }

    /// A theme's sound for one moment as a WAV file in memory, or nil for Off.
    public static func wav(_ theme: SoundTheme, _ event: SoundEvent, sampleRate: Int = 44_100) -> Data? {
        let samples = render(tones(theme, event), sampleRate: Double(sampleRate))
        guard !samples.isEmpty else { return nil }
        return WAV.encode(samples: samples.map { Int16($0 * Float(Int16.max)) }, sampleRate: sampleRate)
    }
}
