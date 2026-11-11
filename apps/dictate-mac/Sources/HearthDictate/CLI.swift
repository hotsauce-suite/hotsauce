import DictateCore
import Foundation

/// `HearthDictate --transcribe-file <path> [--literal] [--stream] [--app-name <name>] [--app-bundle <id>] [--server <url>]`
///
/// The app's own upload, for automated end-to-end tests. The token comes from HEARTH_DICTATE_TOKEN
/// only, never the saved connection, so this can’t send the app’s own token to a server it names; the
/// server from --server, HEARTH_DICTATE_SERVER, else office.example.com. Prints the JSON result;
/// exits 1 with a message on failure.
enum CLI {
    static func run(arguments: [String]) -> Int32 {
        var path: String?
        var mode = DictationMode.clean
        var appName: String?
        var appBundle: String?
        var serverText = ProcessInfo.processInfo.environment["HEARTH_DICTATE_SERVER"]
        var streamed = false
        var index = 0
        func value() -> String? {
            index += 1
            return index < arguments.count ? arguments[index] : nil
        }
        while index < arguments.count {
            switch arguments[index] {
            case "--transcribe-file": path = value()
            case "--literal": mode = .literal
            case "--app-name": appName = value()
            case "--app-bundle": appBundle = value()
            case "--server": serverText = value()
            case "--stream": streamed = true
            default: break
            }
            index += 1
        }
        guard let path, let audio = FileManager.default.contents(atPath: path) else {
            return fail("Couldn’t read the audio file")
        }
        let server = serverText.flatMap(ConnectLink.normalizedServer) ?? ConnectLink.defaultServer
        guard let token = ProcessInfo.processInfo.environment["HEARTH_DICTATE_TOKEN"], ConnectLink.isDeviceToken(token) else {
            return fail("Set HEARTH_DICTATE_TOKEN to a device token")
        }
        let request = DictationRequest(
            audio: audio,
            contentType: contentType(for: path),
            mode: mode,
            appName: appName,
            appBundle: appBundle
        )
        let client = DictationClient(server: server, token: token)
        var outcome: Result<DictationResult, Error> = .failure(DictationError.network("not run"))
        var keyUpToTextMs = 0
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                if streamed {
                    // Plays a 16 kHz mono PCM16 WAV into the stream at speaking speed, as the
                    // microphone would, then times "key-up" to text.
                    guard audio.count > 44,
                          let stream = DictationStream(server: server, token: token, mode: mode, appName: appName, appBundle: appBundle)
                    else { throw DictationError.network("couldn’t open the stream") }
                    let samples = audio.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
                    for start in stride(from: 0, to: samples.count, by: 1_600) {
                        stream.send(Array(samples[start..<min(start + 1_600, samples.count)]))
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    let keyUp = Date()
                    guard let result = await stream.finish() else { throw DictationError.network("the stream failed") }
                    keyUpToTextMs = Int(Date().timeIntervalSince(keyUp) * 1000)
                    outcome = .success(result)
                } else {
                    let keyUp = Date()
                    outcome = .success(try await client.transcribe(request))
                    keyUpToTextMs = Int(Date().timeIntervalSince(keyUp) * 1000)
                }
            } catch {
                outcome = .failure(error)
            }
            done.signal()
        }
        done.wait()
        FileHandle.standardError.write(Data("hearth-dictate: \(streamed ? "streamed" : "uploaded"), key-up to text \(keyUpToTextMs) ms\n".utf8))
        switch outcome {
        case let .success(result):
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            guard let json = try? encoder.encode(result) else { return fail("Couldn’t encode the result") }
            FileHandle.standardOutput.write(json)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return 0
        case let .failure(error):
            return fail(error.localizedDescription)
        }
    }

    static func contentType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "m4a", "mp4": "audio/mp4"
        case "webm": "audio/webm"
        default: "audio/wav"
        }
    }

    private static func fail(_ message: String) -> Int32 {
        FileHandle.standardError.write(Data("hearth-dictate: \(message)\n".utf8))
        return 1
    }
}
