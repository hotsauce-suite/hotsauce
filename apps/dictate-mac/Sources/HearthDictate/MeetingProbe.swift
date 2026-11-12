import DictateCore
import Foundation

/// `HearthDictate --meeting-audio-probe [seconds]`: records "Any app on this Mac" for a few
/// seconds and prints, per track, how many 100 ms frames arrived and their loudest sample, as
/// JSON. For checking the mic and the process tap on a real Mac (play a sound meanwhile).
/// `--dictation-mic` instead runs Dictate's own recorder, to tell a mic problem from ours.
enum MeetingProbe {
    @MainActor
    static func run(arguments: [String]) -> Int32 {
        guard #available(macOS 14.2, *) else {
            print(#"{"error":"needs macOS 14.2"}"#)
            return 1
        }
        let seconds = arguments.firstIndex(of: "--meeting-audio-probe")
            .flatMap { $0 + 1 < arguments.count ? Double(arguments[$0 + 1]) : nil } ?? 4
        if arguments.contains("--dictation-mic") {
            let recorder = Recorder()
            do { try recorder.start() } catch {
                print(#"{"error":"\#(error)"}"#)
                return 1
            }
            RunLoop.main.run(until: Date().addingTimeInterval(seconds))
            let samples = recorder.stop()
            let peak = samples.map { abs(Int($0)) }.max() ?? 0
            print(#"{"dictationMic":{"samples":\#(samples.count),"peak":\#(peak)}}"#)
            return 0
        }
        var bytes: [String: Int] = ["me": 0, "them": 0]
        var peak: [String: Int] = ["me": 0, "them": 0]
        func count(_ track: String, _ data: Data?) {
            guard let data else { return }
            bytes[track, default: 0] += data.count
            data.withUnsafeBytes { raw in
                for i in stride(from: 0, to: raw.count - 1, by: 2) {
                    let sample = Int16(bitPattern: UInt16(raw[i]) | UInt16(raw[i + 1]) << 8)
                    peak[track] = max(peak[track] ?? 0, abs(Int(sample)))
                }
            }
        }
        // --mic-only / --tap-only check the parts on their own.
        let capture = MeetingCapture(mic: !arguments.contains("--tap-only"), tap: !arguments.contains("--mic-only"))
        var ended: [String] = []
        capture.onFrames = { me, them in
            count("me", me)
            count("them", them)
        }
        capture.onEnded = { ended.append($0.rawValue) }
        do {
            try capture.start()
        } catch {
            print(#"{"error":"\#(error)"}"#)
            return 1
        }
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
        let tapRate = capture.tapRate
        let tapSamples = capture.tapSamples
        capture.stop()
        let frames = bytes.mapValues { $0 / MeetingAudio.bytesPerFrame }
        let result: [String: Any] = [
            "frames": frames, "peak": peak, "ended": ended, "seconds": seconds, "micRestarts": capture.micRestarts, "micRate": capture.micRate, "tapRate": tapRate, "tapSamples": tapSamples,
        ]
        if let json = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            print(String(decoding: json, as: UTF8.self))
            // `--out <file>` too, for a run through `open` (the app bundle, so macOS asks for
            // System Audio Recording as the app), where nothing reads stdout.
            if let index = arguments.firstIndex(of: "--out"), index + 1 < arguments.count {
                try? json.write(to: URL(fileURLWithPath: arguments[index + 1]))
            }
        }
        return 0
    }
}
