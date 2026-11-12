import AppKit
import DictateCore
import os

/// One dictation at a time: the hotkey starts and stops the recorder, the audio goes to Hearth,
/// the text goes where the cursor was. Main thread only.
@MainActor
final class DictationController {
    enum Status: Equatable {
        case idle
        case recording
        case processing
        case error(String)
    }

    /// The server's limit is 15 MB; 7.5 minutes of 16 kHz PCM16 is 14.4 MB.
    static let maxSeconds: TimeInterval = 450
    /// A hands-free dictation this short is a slip, not speech.
    static let minSeconds: TimeInterval = 0.3

    private let settings: Settings
    private let recorder = Recorder()
    private let overlay = Overlay()
    private var machine = HotkeyStateMachine()
    private var target: NSRunningApplication?
    private var maxTimer: Timer?
    private var inFlight: Task<Void, Never>?

    private(set) var status: Status = .idle { didSet { onChange() } }
    /// The last dictation that failed in a way a retry could fix, with where it was going.
    private(set) var failed: (request: DictationRequest, target: NSRunningApplication?)?
    var onChange: () -> Void = {}

    init(settings: Settings, history: HistoryStore) {
        self.settings = settings
        self.history = history
        recorder.onLevel = { [weak self] level in self?.overlay.model.push(level: level) }
    }

    var isRecording: Bool { machine.isRecording }

    /// Dictation history on this Mac (never uploaded); the main window reads it too.
    let history: HistoryStore
    /// Called after a dictation is added, so open windows can update.
    var onHistoryChange: () -> Void = {}

    var lastText: String? { history.records.first?.text }

    var isBusy: Bool { inFlight != nil }

    // MARK: Hotkey

    func handle(_ event: HotkeyMonitor.Event) -> Bool {
        let action: HotkeyAction
        switch event {
        case let .keyDown(time): action = machine.keyDown(at: time)
        case let .keyUp(time): action = machine.keyUp(at: time)
        case .otherKey: action = machine.otherKeyDown()
        case .escape: action = machine.escape()
        }
        perform(action)
        // Swallow Esc only when it cancelled a recording.
        if case .escape = event { return action == .cancel }
        return false
    }

    private func perform(_ action: HotkeyAction) {
        switch action {
        case .none: break
        case .start: startRecording()
        case .finish: finishRecording()
        case .cancel: cancelRecording()
        }
    }

    private func startRecording() {
        // One at a time: the last one's paste would land in the middle of this one.
        guard inFlight == nil else {
            machine.reset()
            overlay.showMessage("Still writing up the last one…", seconds: 1.5)
            return
        }
        guard ConnectionStore.connection() != nil else {
            machine.reset()
            overlay.showMessage("Connect this Mac at your workspace’s /dictate page")
            return
        }
        guard Permissions.microphoneGranted else {
            machine.reset()
            overlay.showMessage("Dictate needs the microphone")
            Permissions.requestMicrophone { _ in }
            return
        }
        target = NSWorkspace.shared.frontmostApplication
        // Stream while the member speaks; the recording is kept too, for the upload fallback.
        if let connection = ConnectionStore.connection() {
            stream = DictationStream(
                server: connection.server,
                token: connection.token,
                mode: settings.mode,
                appName: target?.localizedName,
                appBundle: target?.bundleIdentifier
            )
        }
        let stream = stream
        recorder.onSamples = { samples in stream?.send(samples) }
        do {
            try recorder.start()
        } catch {
            stream?.cancel()
            self.stream = nil
            machine.reset()
            status = .error(error.localizedDescription)
            overlay.showMessage(error.localizedDescription)
            return
        }
        status = .recording
        overlay.showRecording()
        prewarm()
        maxTimer?.invalidate()
        // Timers fire on the main run loop.
        maxTimer = Timer.scheduledTimer(withTimeInterval: Self.maxSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.machine.reset()
                self?.finishRecording()
            }
        }
    }

    private func cancelRecording() {
        maxTimer?.invalidate()
        guard recorder.isRecording else { return }
        recorder.cancel()
        recorder.onSamples = nil
        stream?.cancel()
        stream = nil
        overlay.hide()
        status = .idle
    }

    private func finishRecording() {
        maxTimer?.invalidate()
        guard recorder.isRecording else { return }
        keyUpAt = Date()
        let samples = recorder.stop()
        recorder.onSamples = nil
        let stream = stream
        self.stream = nil
        guard Double(samples.count) / 16_000 >= Self.minSeconds else {
            stream?.cancel()
            overlay.hide()
            status = .idle
            return
        }
        let request = DictationRequest(
            audio: WAV.encode(samples: samples),
            mode: settings.mode,
            appName: target?.localizedName,
            appBundle: target?.bundleIdentifier
        )
        send(request, to: target, stream: stream)
    }

    // MARK: Sending

    func retryLast() {
        guard let failed, inFlight == nil else { return }
        // A retry uploads the kept recording; the stream that carried it is gone.
        keyUpAt = nil // a retry's timings aren't measured from the original key-up
        send(failed.request, to: failed.target)
    }

    private func send(_ request: DictationRequest, to target: NSRunningApplication?, stream: DictationStream? = nil) {
        guard let connection = ConnectionStore.connection() else {
            status = .error("Not connected")
            overlay.showMessage("Connect this Mac at your workspace’s /dictate page")
            return
        }
        status = .processing
        overlay.showProcessing()
        let client = DictationClient(server: connection.server, token: connection.token)
        let sentAt = Date()
        inFlight = Task { @MainActor [weak self] in
            do {
                let streamed = await stream?.finish()
                let result: DictationResult
                if let streamed {
                    result = streamed
                } else {
                    result = try await client.transcribe(request)
                }
                var timings = self?.record(result, sentAt: sentAt, answeredAt: Date()) ?? [:]
                timings["streamed"] = streamed == nil ? 0 : 1
                self?.deliver(result, request: request, timings: timings, to: target)
            } catch {
                self?.fail(error, request: request, target: target)
            }
        }
    }

    // MARK: Timing (numbers only, never the text)

    private var keyUpAt: Date?
    /// The live stream of the dictation being recorded, if one could be opened.
    private var stream: DictationStream?
    private let logger = Logger(subsystem: "dev.hotsauce.dictate", category: "timing")

    /// Opens the HTTPS connection while the member is still talking, so the upload doesn't wait
    /// for DNS and TLS. URLSession keeps it alive for the request that follows.
    private func prewarm() {
        guard let server = ConnectionStore.connection()?.server else { return }
        var request = URLRequest(url: server.appendingPathComponent("api/health"), timeoutInterval: 5)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request).resume()
    }

    private func record(_ result: DictationResult, sentAt: Date, answeredAt: Date) -> [String: Int] {
        let ms = { (from: Date?, to: Date) in from.map { Int(to.timeIntervalSince($0) * 1000) } ?? -1 }
        let total = ms(sentAt, answeredAt)
        let timings: [String: Int] = [
            "audioMs": result.durationMs,
            "keyUpToSendMs": ms(keyUpAt, sentAt),
            "roundTripMs": total,
            "serverAsrMs": result.ms.asr,
            "serverLlmMs": result.ms.llm,
            "networkMs": total - result.ms.asr - result.ms.llm,
            "keyUpToTextMs": ms(keyUpAt, answeredAt),
        ]
        logger.log("dictation \(String(describing: timings.sorted { $0.key < $1.key }), privacy: .public)")
        // The last few, for `defaults read dev.hotsauce.dictate timings`.
        var recent = UserDefaults.standard.array(forKey: "timings") as? [[String: Int]] ?? []
        recent.insert(timings, at: 0)
        UserDefaults.standard.set(Array(recent.prefix(20)), forKey: "timings")
        return timings
    }

    private func deliver(_ result: DictationResult, request: DictationRequest, timings: [String: Int], to target: NSRunningApplication?) {
        inFlight = nil
        failed = nil
        status = .idle
        let text = result.text
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            overlay.showMessage("Didn’t catch anything", seconds: 1.5)
            return
        }
        switch Inserter.insert(text, into: target) {
        case .pasted: overlay.hide()
        case .copied: overlay.showMessage("Copied — press ⌘V")
        }
        // After the paste, so writing history never delays the text.
        history.add(DictationRecord(
            date: Date(),
            text: text,
            cleaned: result.cleaned,
            appName: request.appName,
            appBundle: request.appBundle,
            audioMs: result.durationMs,
            timings: timings
        ))
        onHistoryChange()
    }

    private func fail(_ error: Error, request: DictationRequest, target: NSRunningApplication?) {
        inFlight = nil
        let dictationError = error as? DictationError ?? .network(error.localizedDescription)
        if dictationError.isRetryable {
            failed = (request, target)
            status = .error("Couldn’t send the last dictation")
            overlay.showMessage("Couldn’t reach Hearth — Retry is in the menu", seconds: 3.5)
        } else if dictationError == .notConnected {
            failed = nil
            ConnectionStore.delete()
            status = .error("Not connected")
            overlay.showMessage("Disconnected — connect again at your workspace’s /dictate page", seconds: 3.5)
        } else {
            failed = nil
            status = .error(dictationError.localizedDescription)
            overlay.showMessage(dictationError.localizedDescription, seconds: 3.5)
        }
    }

    func pasteLast() {
        guard let text = lastText else { return }
        // The menu has just closed; the app behind it is frontmost again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            if Inserter.insert(text, into: nil) == .copied { self.overlay.showMessage("Copied — press ⌘V") }
        }
    }

    func showMessage(_ text: String) {
        overlay.showMessage(text)
    }
}
