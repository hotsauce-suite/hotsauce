import Foundation
import Testing
@testable import DictateCore

@Suite struct ResamplerTests {
    private func sine(_ frequency: Double, rate: Double, seconds: Double, amplitude: Float = 0.5) -> [Float] {
        (0..<Int(rate * seconds)).map { amplitude * Float(sin(2 * .pi * frequency * Double($0) / rate)) }
    }

    @Test(arguments: [48_000.0, 44_100.0, 16_000.0, 24_000.0])
    func lengthMatchesTheRateRatio(rate: Double) {
        let resampler = StreamingResampler(inputRate: rate)
        let input = sine(440, rate: rate, seconds: 1)
        // Fed in uneven blocks, as a microphone tap delivers them.
        var out: [Int16] = []
        var offset = 0
        while offset < input.count {
            let size = min([480, 1024, 333, 4096, 17][out.count % 5], input.count - offset)
            out += resampler.process(Array(input[offset..<(offset + size)]))
            offset += size
        }
        out += resampler.finish()
        #expect(abs(out.count - 16_000) <= 1)
    }

    @Test func keepsTheToneAndItsLevel() {
        let resampler = StreamingResampler(inputRate: 48_000)
        var out = resampler.process(sine(440, rate: 48_000, seconds: 0.5))
        out += resampler.finish()
        // Count zero crossings: a 440 Hz tone crosses 880 times a second.
        let crossings = zip(out, out.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count
        #expect(abs(crossings - 440) <= 4)
        let peak = out.map { abs(Int($0)) }.max() ?? 0
        #expect(peak > 15_500 && peak < 16_500) // 0.5 of full scale
    }

    @Test func attenuatesWhatCantBeRepresented() {
        // 15 kHz at 48 kHz would alias to 1 kHz at 16 kHz; the box filter must quieten it.
        let resampler = StreamingResampler(inputRate: 48_000)
        var out = resampler.process(sine(15_000, rate: 48_000, seconds: 0.25))
        out += resampler.finish()
        // Away from the first and last sample, whose windows are cut short by the edges.
        let peak = out.dropFirst(2).dropLast(2).map { abs(Int($0)) }.max() ?? 0
        #expect(peak < 16_384 / 8)
    }

    @Test func downmixAveragesChannels() {
        #expect(StreamingResampler.downmix([[1, 0.5], [0, -0.5]]) == [0.5, 0])
        #expect(StreamingResampler.downmix([[0.25]]) == [0.25])
        #expect(StreamingResampler.downmix([]) == [])
    }

    @Test func int16ClampsAndRounds() {
        #expect(StreamingResampler.int16(2) == Int16.max)
        #expect(StreamingResampler.int16(-2) == -Int16.max)
        #expect(StreamingResampler.int16(0) == 0)
        #expect(StreamingResampler.int16(0.5) == 16_384)
    }

    @Test func levelIsRMS() {
        #expect(StreamingResampler.level([]) == 0)
        #expect(abs(StreamingResampler.level([0.5, -0.5]) - 0.5) < 0.0001)
    }
}
