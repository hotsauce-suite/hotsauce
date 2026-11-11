import Foundation
import Testing
@testable import DictateCore

@Suite struct WAVTests {
    @Test func headerDescribes16kMonoPCM16() {
        let data = WAV.encode(samples: [0, 1, -1, Int16.max, Int16.min])
        #expect(data.count == 44 + 10)
        #expect(String(decoding: data[0..<4], as: UTF8.self) == "RIFF")
        #expect(String(decoding: data[8..<16], as: UTF8.self) == "WAVEfmt ")
        #expect(u32(data, 4) == 36 + 10)
        #expect(u16(data, 20) == 1) // PCM
        #expect(u16(data, 22) == 1) // mono
        #expect(u32(data, 24) == 16_000)
        #expect(u32(data, 28) == 32_000) // byte rate
        #expect(u16(data, 32) == 2) // block align
        #expect(u16(data, 34) == 16)
        #expect(String(decoding: data[36..<40], as: UTF8.self) == "data")
        #expect(u32(data, 40) == 10)
    }

    @Test func samplesAreLittleEndian() {
        let data = WAV.encode(samples: [0x0102, -2])
        #expect(Array(data[44..<48]) == [0x02, 0x01, 0xFE, 0xFF])
    }

    @Test func emptyIsJustAHeader() {
        #expect(WAV.encode(samples: []).count == 44)
    }

    private func u16(_ d: Data, _ at: Int) -> UInt16 { UInt16(d[at]) | UInt16(d[at + 1]) << 8 }
    private func u32(_ d: Data, _ at: Int) -> UInt32 {
        (0..<4).reduce(UInt32(0)) { $0 | UInt32(d[at + $1]) << UInt32(8 * $1) }
    }
}
