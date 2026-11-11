import Foundation

/// A 16-bit PCM WAV file in memory. Hearth Dictate never writes audio to disk.
public enum WAV {
    public static let headerBytes = 44

    public static func encode(samples: [Int16], sampleRate: Int = 16_000, channels: Int = 1) -> Data {
        let dataBytes = samples.count * 2
        var data = Data(capacity: headerBytes + dataBytes)
        data.append(contentsOf: Array("RIFF".utf8))
        data.appendLE(UInt32(36 + dataBytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.appendLE(UInt32(16))
        data.appendLE(UInt16(1)) // PCM
        data.appendLE(UInt16(channels))
        data.appendLE(UInt32(sampleRate))
        data.appendLE(UInt32(sampleRate * channels * 2))
        data.appendLE(UInt16(channels * 2))
        data.appendLE(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        data.appendLE(UInt32(dataBytes))
        samples.withUnsafeBufferPointer { buffer in
            for sample in buffer { data.appendLE(UInt16(bitPattern: sample)) }
        }
        return data
    }
}

extension Data {
    mutating func appendLE(_ value: UInt16) {
        append(UInt8(value & 0xFF))
        append(UInt8(value >> 8))
    }

    mutating func appendLE(_ value: UInt32) {
        for shift in stride(from: 0, to: 32, by: 8) { append(UInt8((value >> UInt32(shift)) & 0xFF)) }
    }
}
