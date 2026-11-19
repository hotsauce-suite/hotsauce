import AppKit
import DictateCore
import os

/// One dictation at a time: the hotkey starts and stops the recorder, the audio goes to Hotsauce,
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
    /// The glow around the window being dictated into ("Edge glow while dictating").
    private let glow = EdgeGlow()
    private var machine = HotkeyStateMachine()
    private var target: NSRunningApplication?
    private var maxTimer: Timer?
    private var inFlight: Task<Void, Never>?

    private(set) var status: Status = .idle { didSet { onChange() } }
    /// The last dictation that failed in a way a retry could fix, with where it was going.
    private(set) var failed: (request: DictationRequest, target: NSRunningApplication?, samples: [Int16])?
    /// Where this dictation is written up (docs/PLAN-offline.md, step A2).
    private var route: SpeechRoute = .server
    /// When the server last couldn't be reached; the device is used for a minute after.
    private var serverFailedAt: Date?
    /// This dictation stays on the Mac because the member chose "On this Mac only"
    /// (docs/PLAN-dictate-models.md, R8): written up here, and only its text sent to be tidied.
    private var keptOnMac = false
    /// With `keptOnMac`: whether the text is sent to be tidied (not with Cleanup off).
    private var tidyOnMac = true
    var onChange: () -> Void = {}
    /// Just before the microphone starts, so the page's music is already held (music M10).
    var willRecord: () -> Void = {}

    init(settings: Settings, history: HistoryStore) {
        self.settings = settings
        self.history = history
        _ = NetworkWatch.shared // starts watching now, so the first key press has an answer
        recorder.preferredInput = { [settings] in settings.microphoneUID }
        recorder.onLevel = { [weak self] level in
            self?.overlay.model.push(level: level)
            self?.glow.push(level: level)
        }
        refreshChoices()
    }

    /// Asks the server for the member's Dictate choices and remembers them for the next key
    /// press. A failure keeps the last known ones. `newConnection` forgets the old ones first:
    /// they were another account's, and until these are known a dictation stays on the Mac.
    func refreshChoices(newConnection: Bool = false) {
        if newConnection { SpeechPreference.forget() }
        guard let connection = ConnectionStore.connection() else { return }
        let client = DictationClient(server: connection.server, token: connection.token)
        Task { @MainActor in
            if let choices = try? await client.choices() {
                SpeechPreference.set(choices.known)
            }
        }
    }

    /// The choices for this key press. Not known yet (a new connection the server hasn't
    /// answered for): kept on the Mac, so a voice is never sent before the choice is known.
    private func loadChoices() {
        let known = SpeechPreference.known()
        keptOnMac = known?.keepOnMac ?? true
        tidyOnMac = known?.tidy ?? true
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
        loadChoices()
        route = SpeechRouting.choose(networkUp: NetworkWatch.shared.isUp, serverFailedAt: serverFailedAt, now: Date(), keepOnMac: keptOnMac)
        // For the next one: the member may have changed it on the web since.
        refreshChoices()
        // Stream while the member speaks; the recording is kept too, for the upload fallback.
        // Offline, nothing is sent anywhere (A2.6).
        if route == .server, let connection = ConnectionStore.connection() {
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
        willRecord()
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
        overlay.showRecording(onDevice: route == .onDevice, label: keptOnMac ? "On this Mac" : "Offline: on-device")
        // After the microphone has started, so the glow never delays the recording.
        if settings.edgeGlow { glow.listen(pid: target?.processIdentifier) }
        if route == .server { prewarm() }
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
        glow.finish()
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
            glow.finish()
            status = .idle
            return
        }
        let request = DictationRequest(
            audio: WAV.encode(samples: samples),
            mode: settings.mode,
            appName: target?.localizedName,
            appBundle: target?.bundleIdentifier
        )
        send(request, to: target, samples: samples, stream: stream, route: route)
    }

    // MARK: Sending

    func retryLast() {
        guard let failed, inFlight == nil else { return }
        // A retry uploads the kept recording; the stream that carried it is gone.
        keyUpAt = nil // a retry's timings aren't measured from the original key-up
        // Retry is for the server: the member pressed it because they're back online. Unless they
        // chose "On this Mac only": then it's written up here again, and the audio never goes.
        loadChoices()
        send(failed.request, to: failed.target, samples: failed.samples, route: keptOnMac ? .onDevice : .server)
    }

    private func send(
        _ request: DictationRequest,
        to target: NSRunningApplication?,
        samples: [Int16],
        stream: DictationStream? = nil,
        route: SpeechRoute
    ) {
        if route == .onDevice {
            status = .processing
            overlay.showProcessing()
            glow.think()
            let tidy = keptOnMac && tidyOnMac
            inFlight = Task { @MainActor [weak self] in
                await self?.writeUpOnDevice(samples, request: request, to: target, tidy: tidy)
            }
            return
        }
        guard let connection = ConnectionStore.connection() else {
            glow.finish()
            status = .error("Not connected")
            overlay.showMessage("Connect this Mac at your workspace’s /dictate page")
            return
        }
        status = .processing
        overlay.showProcessing()
        glow.think()
        var client = DictationClient(server: connection.server, token: connection.token)
        let sentAt = Date()
        inFlight = Task { @MainActor [weak self] in
            do {
                let streamed = await stream?.finish()
                let result: DictationResult
                if let streamed {
                    result = streamed
                } else {
                    // A stream the server never answered: don't wait 90 s for the upload (A2.3).
                    client.timeout = SpeechRouting.uploadTimeout(streamReady: stream?.wasReady)
                    result = try await client.transcribe(request)
                }
                self?.serverFailedAt = nil
                var timings = self?.record(result, sentAt: sentAt, answeredAt: Date()) ?? [:]
                timings["streamed"] = streamed == nil ? 0 : 1
                self?.deliver(result, request: request, timings: timings, to: target)
            } catch {
                let dictationError = error as? DictationError ?? .network(error.localizedDescription)
                // Refused because the member just chose "On this Mac only" on the web: honour it now.
                if SpeechRouting.mayBeKeptOnMac(after: dictationError) {
                    if let choices = try? await client.choices() {
                        SpeechPreference.set(choices.known)
                        if choices.keepsSpeechOnMac {
                            await self?.writeUpOnDevice(samples, request: request, to: target, tidy: choices.tidiesText)
                            return
                        }
                    } else if case let .server(_, message) = dictationError, message.contains("On this Mac only") {
                        SpeechPreference.set(.init(keepOnMac: true, tidy: false))
                        await self?.writeUpOnDevice(samples, request: request, to: target)
                        return
                    }
                }
                guard SpeechRouting.fallsBackOnDevice(after: dictationError) else {
                    self?.fail(dictationError, request: request, target: target, samples: samples)
                    return
                }
                // Couldn't reach the server: write it up on this Mac rather than wait (A2.2).
                self?.serverFailedAt = Date()
                await self?.writeUpOnDevice(samples, request: request, to: target, afterServer: true)
            }
        }
    }

    /// The Mac's own speech recognition (A2.6 to A2.9). If it can't write it up either, the
    /// recording is kept for Retry, which sends it to the server once the connection is back
    /// (or, for a member on "On this Mac only", tries the Mac again).
    /// `tidy`: the member chose "On this Mac only", so the text (never the audio) goes to the
    /// server to be tidied; if that fails, the text is pasted as heard.
    private func writeUpOnDevice(_ samples: [Int16], request: DictationRequest, to target: NSRunningApplication?, afterServer: Bool = false, tidy: Bool = false) async {
        let started = Date()
        do {
            let text = try await OnDeviceSpeech.transcribe(samples)
            if afterServer, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // The server might have heard what this Mac didn't: keep it for Retry.
                inFlight = nil
                glow.finish()
                failed = (request, target, samples)
                status = .error("Couldn’t send the last dictation")
                overlay.showMessage("Couldn’t reach \(Brand.name) — Retry is in the menu", seconds: 3.5)
                return
            }
            let ms = { (from: Date?) in from.map { Int(Date().timeIntervalSince($0) * 1000) } ?? -1 }
            let heardMs = ms(started)
            var result = DictationResult(text: text, raw: text, cleaned: false, durationMs: samples.count / 16, ms: .init(asr: 0, llm: 0))
            if tidy, request.mode == .clean,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let connection = ConnectionStore.connection() {
                let client = DictationClient(server: connection.server, token: connection.token)
                if let tidied = try? await client.clean(text, like: request) {
                    result = DictationResult(text: tidied.text, raw: text, cleaned: tidied.cleaned, durationMs: samples.count / 16, ms: tidied.ms)
                }
            }
            let timings = ["audioMs": samples.count / 16, "onDeviceMs": heardMs, "serverLlmMs": result.ms.llm, "keyUpToTextMs": ms(keyUpAt)]
            deliver(result, request: request, timings: timings, to: target, onDevice: true)
        } catch {
            inFlight = nil
            glow.finish()
            failed = (request, target, samples)
            status = .error("Couldn’t write up the last dictation")
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            overlay.showMessage(message, seconds: 4.5)
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

    private func deliver(_ result: DictationResult, request: DictationRequest, timings: [String: Int], to target: NSRunningApplication?, onDevice: Bool = false) {
        inFlight = nil
        // Only the dictation that was kept for Retry is done with; another one still waits.
        if failed?.request.audio == request.audio { failed = nil }
        status = .idle
        // The paste follows straight away; the fade overlaps it.
        glow.finish()
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
            timings: timings,
            onDevice: onDevice ? true : nil
        ))
        onHistoryChange()
    }

    private func fail(_ dictationError: DictationError, request: DictationRequest, target: NSRunningApplication?, samples: [Int16]) {
        inFlight = nil
        glow.finish()
        if dictationError.isRetryable {
            failed = (request, target, samples)
            status = .error("Couldn’t send the last dictation")
            overlay.showMessage("Couldn’t reach \(Brand.name) — Retry is in the menu", seconds: 3.5)
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
