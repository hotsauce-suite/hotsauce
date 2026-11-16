import AVFoundation
import DictateCore
import Foundation
import Network
import Speech

/// Writes a dictation up with the Mac's own speech recognition, for when the Hotsauce server
/// can't be reached (docs/PLAN-offline.md, step A2). The audio never leaves the Mac.
enum OnDeviceSpeech {
    enum Failure: LocalizedError, Equatable {
        case notAllowed
        case noModel(language: String)
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .notAllowed:
                "Offline dictation needs Speech Recognition: System Settings → Privacy & Security"
            case let .noModel(language):
                "No offline dictation for \(language) yet: System Settings → Keyboard → Dictation"
            case let .failed(detail):
                "Offline dictation didn’t work (\(detail))"
            }
        }
    }

    /// Asks for Speech Recognition the first time it's needed (A2.5); the prompt shows the
    /// app's NSSpeechRecognitionUsageDescription.
    static func authorize() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }

    /// The Mac's language with an on-device model, else US English (A2.7). Only languages whose
    /// model is on this Mac count: `supportedLocales()` also lists ones that need Apple's servers.
    static func localeIdentifier() -> String? {
        let onDevice = SFSpeechRecognizer.supportedLocales()
            .filter { SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true }
            .map(\.identifier)
        return SpeechRouting.locale(preferred: Locale.preferredLanguages, onDevice: onDevice, region: Locale.current.region?.identifier)
    }

    static func transcribe(_ samples: [Int16]) async throws -> String {
        guard await authorize() else { throw Failure.notAllowed }
        guard let id = localeIdentifier(), let recognizer = SFSpeechRecognizer(locale: Locale(identifier: id)) else {
            let mine = Locale.preferredLanguages.first ?? "en-US"
            throw Failure.noModel(language: Locale.current.localizedString(forIdentifier: mine) ?? mine)
        }
        let timeout = SpeechRouting.onDeviceTimeout(seconds: Double(samples.count) / 16_000)

        let request = SFSpeechAudioBufferRecognitionRequest()
        // Never Apple's servers either (A2.6).
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))
        else { throw Failure.failed("audio format") }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        if let channel = buffer.floatChannelData?[0] {
            for (i, sample) in samples.enumerated() { channel[i] = Float(sample) / 32_768 }
        }
        request.append(buffer)
        request.endAudio()

        let once = Once<Result<String, Error>>()
        return try await withCheckedThrowingContinuation { continuation in
            once.handler = { continuation.resume(with: $0) }
            let task = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    once.fire(.success(result.bestTranscription.formattedString))
                } else if let error {
                    once.fire(nothingHeard(error) ? .success("") : .failure(Failure.failed(error.localizedDescription)))
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                // Holds the recognizer until the task can't need it: the task doesn't keep it.
                withExtendedLifetime(recognizer) { task.cancel() }
                once.fire(.failure(Failure.failed("it took too long")))
            }
        }
    }

    /// "No speech detected" is an empty dictation, not an error.
    private static func nothingHeard(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == "kAFAssistantErrorDomain" && error.code == 1110
    }
}

/// Resumes a continuation once, whichever callback comes first.
private final class Once<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    var handler: (Value) -> Void = { _ in }

    func fire(_ value: Value) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { handler(value) }
    }
}

/// Whether the Mac has a network at all (A2.1); a closed laptop lid or Wi-Fi off shows here at
/// once, with no request that has to time out.
final class NetworkWatch: @unchecked Sendable {
    static let shared = NetworkWatch()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var up = true

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self.up = path.status == .satisfied
            self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "dev.hotsauce.dictate.network"))
    }

    var isUp: Bool {
        lock.lock()
        defer { lock.unlock() }
        return up
    }
}

/// `HotsauceDictate --on-device-file <16 kHz mono 16-bit WAV> --out <file>`: writes the file up
/// with on-device speech, exactly as an offline dictation is, and saves the outcome as JSON.
/// Opened through Launch Services (`open -a Hotsauce --args …`), so the Speech Recognition
/// permission is the app's own.
enum OnDeviceProbe {
    static func run(arguments: [String]) -> Int32 {
        func value(_ flag: String) -> String? {
            arguments.firstIndex(of: flag).flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        }
        guard let path = value("--on-device-file"), let out = value("--out"),
              let data = FileManager.default.contents(atPath: path),
              let samples = pcm16Samples(fromWAV: data)
        else { return 1 }
        _ = NetworkWatch.shared
        RunLoop.current.run(until: Date().addingTimeInterval(0.5)) // the first network answer
        var report: [String: Any] = ["network": NetworkWatch.shared.isUp, "locale": OnDeviceSpeech.localeIdentifier() ?? NSNull()]
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            let started = Date()
            do {
                report["text"] = try await OnDeviceSpeech.transcribe(samples)
            } catch {
                report["error"] = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            report["ms"] = Int(Date().timeIntervalSince(started) * 1000)
            done.signal()
        }
        while done.wait(timeout: .now() + 0.05) == .timedOut {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        let json = (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        FileManager.default.createFile(atPath: out, contents: json)
        return report["error"] == nil ? 0 : 1
    }

    /// The samples of a PCM16 WAV (its "data" chunk).
    static func pcm16Samples(fromWAV data: Data) -> [Int16]? {
        let bytes = [UInt8](data)
        var offset = 12
        while offset + 8 <= bytes.count {
            let id = String(bytes: bytes[offset..<offset + 4], encoding: .ascii)
            let size = Int(bytes[offset + 4]) | Int(bytes[offset + 5]) << 8 | Int(bytes[offset + 6]) << 16 | Int(bytes[offset + 7]) << 24
            let start = offset + 8
            if id == "data" {
                let end = min(bytes.count, start + size)
                return stride(from: start, to: end - 1, by: 2).map { Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8) }
            }
            offset = start + size + (size & 1)
        }
        return nil
    }
}
