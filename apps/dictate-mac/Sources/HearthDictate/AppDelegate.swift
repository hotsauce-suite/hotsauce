import AppKit
import DictateCore
import ServiceManagement

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let settings = Settings()
    private let historyStore = HistoryStore()
    private lazy var controller = DictationController(settings: settings, history: historyStore)
    private lazy var monitor = HotkeyMonitor(hotkey: settings.hotkey)
    private let onboarding = OnboardingWindow()
    let mainWindow = MainWindow()
    private var pruneTimer: Timer?
    private var statusItem: NSStatusItem!
    private var healthTimer: Timer?
    /// The suite's window; its page also answers the meeting reminders' calendar calls.
    lazy var suite = SuiteWindow(server: suiteServer)
    private lazy var reminders = Reminders(suite: suite) { [weak self] in self?.settings.meetingReminders ?? false }
    /// A `CallDetector` on macOS 14.2+ (stored untyped for the availability check).
    private var callDetector: AnyObject?

    /// The server in Settings, else the default server. Not Dictate's connection: a connect link names its
    /// server, and the window grants its server the camera and microphone.
    private var suiteServer: URL {
        settings.suiteServer ?? ConnectLink.defaultServer
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // hearth-dictate://connect?… from the Dictate page, and deep links (hearth://<path>),
        // before or after launch.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()
        suite.showMessage = { [weak self] in self?.controller.showMessage($0) }
        suite.handleAppLink = { [weak self] in self?.openAppLink($0.absoluteString) }
        suite.signInWithBrowser = { [weak self] in self?.startBrowserSignIn() }
        statusItem = Self.makeStatusItem()
        statusItem.isVisible = settings.showInMenuBar
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        controller.onChange = { [weak self] in self?.updateIcon() }
        updateIcon()

        monitor.handler = { [weak self] event in self?.controller.handle(event) ?? false }
        startMonitor()

        onboarding.model.connect = { [weak self] code, done in self?.connect(code: code, fromLink: false, done: done) }
        onboarding.model.openDictatePage = { [weak self] in self?.openDictatePage() }
        onboarding.model.isConnected = { ConnectionStore.connection() != nil }
        onboarding.model.account = { ConnectionStore.connection()?.account }
        onboarding.model.hotkeyReady = { [weak self] in self?.monitor.isRunning ?? false }
        onboarding.model.hotkeyName = { [weak self] in self?.settings.hotkey.title ?? "" }
        onboarding.model.relaunch = { [weak self] in self?.relaunch() }
        onboarding.model.startHotkey = { [weak self] in
            if Permissions.accessibilityGranted { self?.monitor.start() }
        }
        onboarding.model.isMenuBarIconHidden = { [weak self] in
            guard let self else { return false }
            return self.settings.showInMenuBar && !self.menuBarIconShown
        }
        onboarding.model.stepCompleted = { [weak self] in self?.bringSetupForward() }
        onboarding.model.notInApplications = {
            let path = Bundle.main.bundlePath
            return path.contains("/AppTranslocation/") || path.hasPrefix("/Volumes/")
        }
        onboarding.onClose = { [weak self] in self?.settings.hasOnboarded = true }
        wireMainWindow()
        controller.onHistoryChange = { [weak self] in
            if self?.mainWindow.isVisible == true { self?.mainWindow.model.reloadRecords() }
        }
        pruneHistory()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3_600, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pruneHistory() }
        }
        // A login item starts quietly: the suite loads (for reminders) without its window.
        if launchedAsLoginItem { suite.loadIfNeeded() } else { suite.show() }
        if !settings.hasOnboarded { onboarding.show() }
        reminders.start()
        if #available(macOS 14.2, *) {
            let detector = CallDetector(suite: suite) { [weak self] in self?.settings.offerCallNotes ?? false }
            detector.start()
            callDetector = detector
        }
        retireOldCopy()
        refreshLoginItemIfMoved()
    }

    /// Whether this copy is installed: directly in an Applications folder (not the disk image,
    /// a translocated path or a build folder).
    private var isInstalled: Bool {
        let folder = Bundle.main.bundleURL.standardizedFileURL.deletingLastPathComponent()
        return (FileManager.default.urls(for: .applicationDirectory, in: .localDomainMask)
            + FileManager.default.urls(for: .applicationDirectory, in: .userDomainMask))
            .contains { $0.standardizedFileURL == folder }
    }

    /// Up to 0.2 the app was HearthDictate.app, then Hearth.app. Installed as <Name>.app, an old copy (the same
    /// app, same bundle id) would still show in Spotlight and could answer links, so it is quit if
    /// it's running and goes to the Trash: only from an installed copy, only an app with this
    /// bundle id.
    private func retireOldCopy() {
        guard isInstalled else { return }
        let me = Bundle.main.bundleURL.standardizedFileURL
        let applications = FileManager.default.urls(for: .applicationDirectory, in: .localDomainMask)
            + FileManager.default.urls(for: .applicationDirectory, in: .userDomainMask)
        for folder in applications {
            for oldName in ["HearthDictate.app", "Hearth.app"] {
            let old = folder.appendingPathComponent(oldName).standardizedFileURL
            guard old != me, FileManager.default.fileExists(atPath: old.path),
                  Bundle(url: old)?.bundleIdentifier == Bundle.main.bundleIdentifier
            else { continue }
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
                .filter { $0.bundleURL?.standardizedFileURL == old }
            running.forEach { $0.terminate() }
            // Give it a moment to quit (it flushes its history), then trash it.
            DispatchQueue.main.asyncAfter(deadline: .now() + (running.isEmpty ? 0 : 3)) {
                running.filter { !$0.isTerminated }.forEach { $0.forceTerminate() }
                try? FileManager.default.trashItem(at: old, resultingItemURL: nil)
            }
            }
        }
    }

    /// Open at login points at the app where it was turned on; after a rename or move, register
    /// it again so the next login opens this copy. Only for an installed copy, and the new path is
    /// remembered only once that worked, so a failure is retried at the next launch.
    private func refreshLoginItemIfMoved() {
        let defaults = UserDefaults.standard
        let path = Bundle.main.bundlePath
        guard isInstalled, defaults.string(forKey: "lastBundlePath") != path else { return }
        guard SMAppService.mainApp.status == .enabled else {
            defaults.set(path, forKey: "lastBundlePath")
            return
        }
        do {
            try? SMAppService.mainApp.unregister()
            try SMAppService.mainApp.register()
            defaults.set(path, forKey: "lastBundlePath")
        } catch {
            controller.showMessage("Couldn’t update Open at login — turn it on again in Settings")
        }
    }

    /// A login item starts quietly; a launch by the member opens the window.
    private var launchedAsLoginItem: Bool {
        let event = NSAppleEventManager.shared().currentAppleEvent
        return event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    private func pruneHistory() {
        historyStore.prune(retentionDays: settings.retentionDays)
    }

    private func wireMainWindow() {
        let model = mainWindow.model
        model.reload = { [weak self] in
            guard let self else { return }
            // Assigned only when changed: each assignment redraws the window.
            func set<T: Equatable>(_ keyPath: ReferenceWritableKeyPath<MainModel, T>, _ value: T) {
                if model[keyPath: keyPath] != value { model[keyPath: keyPath] = value }
            }
            set(\.hotkey, self.settings.hotkey)
            set(\.mode, self.settings.mode)
            set(\.retentionDays, self.settings.retentionDays)
            set(\.microphone, Permissions.microphoneGranted)
            set(\.accessibility, Permissions.accessibilityGranted)
            set(\.listening, self.monitor.isRunning)
            set(\.showInMenuBar, self.settings.showInMenuBar)
            set(\.menuBarIconShown, self.menuBarIconShown)
            let connection = ConnectionStore.connection()
            set(\.account, connection.map { $0.account ?? "this Mac" })
            set(\.server, connection?.server.absoluteString ?? ConnectLink.defaultServer.absoluteString)
            let suiteServer = self.suiteServer.absoluteString
            if model.suiteServer != suiteServer {
                model.suiteServer = suiteServer
                model.suiteServerDraft = suiteServer
            }
            set(\.meetingReminders, self.settings.meetingReminders)
            set(\.offerCallNotes, self.settings.offerCallNotes)
            self.reminders.authorizationStatus { status in
                set(\.notificationsAllowed, status != .denied)
            }
        }
        model.reloadRecords = { [weak self] in
            guard let self else { return }
            model.records = self.historyStore.records
            // Asks a system service, so not on the 2 s tick.
            model.launchAtLogin = SMAppService.mainApp.status == .enabled
        }
        model.loadWords = { [weak self] in self?.loadWords() }
        model.copy = { Inserter.copy($0) }
        model.paste = { [weak self] text in
            // Back to the app the member was in, then paste there.
            NSApp.hide(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                if Inserter.insert(text, into: nil) == .copied { self?.controller.showMessage("Copied — press ⌘V") }
            }
        }
        model.editWords = { [weak self] add, remove, scope, done in
            self?.editWords(add: add, remove: remove, scope: scope, done: done)
        }
        model.setHotkey = { [weak self] hotkey in
            self?.settings.hotkey = hotkey
            self?.monitor.hotkey = hotkey
            model.reload()
        }
        model.setMode = { [weak self] mode in
            self?.settings.mode = mode
            model.reload()
        }
        model.setLaunchAtLogin = { [weak self] on in
            do {
                if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                self?.controller.showMessage("Couldn’t change Launch at login")
            }
            model.reloadRecords()
        }
        model.setShowInMenuBar = { [weak self] on in
            guard let self else { return }
            self.settings.showInMenuBar = on
            self.statusItem.isVisible = on
            model.reload()
        }
        model.setRetention = { [weak self] days in
            guard let self else { return }
            let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
            let lost = self.historyStore.records.filter { $0.date < cutoff }.count
            if lost > 0 {
                let alert = NSAlert()
                alert.messageText = "Delete \(lost) older \(lost == 1 ? "dictation" : "dictations")?"
                alert.informativeText = "Keeping history for \(days) days removes everything older, now. This can’t be undone."
                alert.addButton(withTitle: "Delete and keep \(days) days")
                alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else {
                    model.reload()
                    return
                }
            }
            self.settings.retentionDays = days
            self.pruneHistory()
            model.reload()
            model.reloadRecords()
        }
        model.clearHistory = { [weak self] in
            let alert = NSAlert()
            alert.messageText = "Clear all dictation history on this Mac?"
            alert.informativeText = "This can’t be undone. Your word lists aren’t affected."
            alert.addButton(withTitle: "Clear history")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            self?.historyStore.clear()
            model.reloadRecords()
        }
        model.disconnect = { [weak self] in
            self?.disconnect()
            model.reload()
        }
        model.openWeb = { [weak self] in self?.openDictatePage() }
        model.setSuiteServer = { [weak self] text in
            guard let self else { return nil }
            guard let server = ConnectLink.normalizedServer(text) else {
                return "Enter the server’s address, like https://office.example.com (http only for localhost)."
            }
            self.settings.suiteServer = server == ConnectLink.defaultServer ? nil : server
            self.suite.setServer(self.suiteServer)
            model.reload()
            return nil
        }
        model.setMeetingReminders = { [weak self] on in
            guard let self else { return }
            self.settings.meetingReminders = on
            if on { self.reminders.requestAuthorization { _ in model.reload() } }
            model.reload()
        }
        model.setOfferCallNotes = { [weak self] on in
            guard let self else { return }
            self.settings.offerCallNotes = on
            if on { self.reminders.requestAuthorization { _ in model.reload() } }
            model.reload()
        }
        model.openSetup = { [weak self] in self?.onboarding.show() }
        model.requestMicrophone = { Permissions.requestMicrophone { _ in model.reload() } }
        model.requestAccessibility = { Permissions.requestAccessibility() }
    }

    private func loadWords() {
        let model = mainWindow.model
        guard let connection = ConnectionStore.connection() else {
            model.wordsState = "Connect this Mac to edit the word lists."
            return
        }
        let client = DictationClient(server: connection.server, token: connection.token)
        Task { @MainActor in
            do {
                let words = try await client.words()
                model.mine = words.mine
                model.team = words.team
                model.wordsState = nil
            } catch {
                model.wordsState = (error as? DictationError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func editWords(add: [String], remove: [String], scope: DictationClient.WordScope, done: @escaping (Bool) -> Void) {
        let model = mainWindow.model
        guard let connection = ConnectionStore.connection() else { return done(false) }
        let client = DictationClient(server: connection.server, token: connection.token)
        Task { @MainActor in
            do {
                let saved = try await client.editWords(add: add, remove: remove, scope: scope)
                if scope == .mine { model.mine = saved } else { model.team = saved }
                model.wordsState = nil
                done(true)
            } catch {
                model.wordsState = (error as? DictationError)?.errorDescription ?? error.localizedDescription
                done(false)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // History is written off the main thread; let the last write finish.
        historyStore.flush()
    }

    /// Opening the app while it runs (Finder, Spotlight, the Dock) shows the suite.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { suite.show() }
        return true
    }

    /// Closing the windows doesn't quit: dictation and reminders keep running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Back to the setup window after a step is done elsewhere (System Settings, the browser),
    /// but never in the middle of a dictation, and only if the window is still open.
    private func bringSetupForward() {
        guard onboarding.isVisible, !controller.isRecording, !controller.isBusy else { return }
        onboarding.show()
    }

    private var isReady: Bool {
        Permissions.microphoneGranted && monitor.isRunning && ConnectionStore.connection() != nil
    }

    /// Starts the key tap, then keeps checking: Accessibility can be granted (or revoked) while
    /// the app runs, and macOS can switch a tap off. Never stops, so nothing fails silently.
    private func startMonitor() {
        monitor.start()
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkHealth() }
        }
        checkHealth()
    }

    static let statusItemName = "HearthDictate"

    /// The menu bar icon. A fixed autosave name keeps its place across launches; the first time,
    /// it is placed near the right edge, beside Control Center, rather than at the left end of the
    /// icons where a MacBook's camera notch hides it. The member can't drag it out by mistake.
    private static func makeStatusItem() -> NSStatusItem {
        let defaults = UserDefaults.standard
        let positionKey = "NSStatusItem Preferred Position \(statusItemName)"
        if defaults.object(forKey: positionKey) == nil { defaults.set(120.0, forKey: positionKey) }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.autosaveName = statusItemName
        item.behavior = []
        return item
    }

    /// Whether the icon is actually on screen: false when the setting is off, when macOS's
    /// Menu Bar settings don't allow it, or when the notch or a full menu bar covers it.
    var menuBarIconShown: Bool {
        guard statusItem.isVisible, let window = statusItem.button?.window else { return false }
        return window.occlusionState.contains(.visible) && NSScreen.screens.contains { $0.frame.intersects(window.frame) }
    }

    private func checkHealth() {
        if !monitor.isRunning, Permissions.accessibilityGranted { monitor.start() }
        if statusItem.isVisible != settings.showInMenuBar { statusItem.isVisible = settings.showInMenuBar }
        updateIcon()
        // What the app can see, for diagnosis with `defaults read dev.hotsauce.dictate`.
        let defaults = UserDefaults.standard
        defaults.set(Permissions.accessibilityGranted, forKey: "status.accessibility")
        defaults.set(Permissions.microphoneGranted, forKey: "status.microphone")
        defaults.set(monitor.isRunning, forKey: "status.hotkeyListening")
        defaults.set(ConnectionStore.connection() != nil, forKey: "status.connected")
        defaults.set(menuBarIconShown, forKey: "status.menuBarIconShown")
    }

    /// Some macOS versions only hand a key tap to an app after it restarts. Reopens by bundle id,
    /// not path: a copy run from the disk image or a translocated path may be gone by then.
    private func relaunch() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        // This copy by its path when installed (another copy with the same bundle id elsewhere
        // must not open instead); else by bundle id, as the disk image's copy may be gone by then.
        task.arguments = isInstalled
            ? ["-c", "sleep 1; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
            : ["-c", "sleep 1; /usr/bin/open -b dev.hotsauce.dictate"]
        do {
            try task.run()
        } catch {
            controller.showMessage("Couldn’t restart — quit from the menu bar and open it again")
            return
        }
        NSApp.terminate(nil)
    }

    // MARK: Status item

    /// The menu bar icon is the Hotsauce bottle. Dimmed until Dictate is ready, ember while it listens,
    /// orange while it writes up; a warning triangle only for an error.
    private static let markImage = ProductMark.menuBarImage()
    private static let errorImage = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: Brand.name) ?? markImage
    private static let accent = NSColor(name: nil) { appearance in
        let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? Brand.accentDark : Brand.accentLight
        return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                       blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    private func updateIcon() {
        guard let button = statusItem?.button else { return }
        let ready = ConnectionStore.connection() != nil && monitor.isRunning
        var image = Self.markImage
        var tint: NSColor?
        switch controller.status {
        case .idle: break
        case .recording: tint = Self.accent
        case .processing: tint = .systemOrange
        case .error: image = Self.errorImage
        }
        image.isTemplate = true
        if button.image !== image { button.image = image }
        if button.contentTintColor != tint { button.contentTintColor = tint }
        let dimmed = controller.status == .idle && !ready
        if button.appearsDisabled != dimmed { button.appearsDisabled = dimmed }
    }

    private var statusLine: String {
        if ConnectionStore.connection() == nil { return "Dictate isn’t connected" }
        if !Permissions.microphoneGranted { return "Needs the microphone" }
        if !monitor.isRunning {
            return Permissions.accessibilityGranted ? "Can’t see the keyboard — quit and reopen" : "Needs Accessibility"
        }
        switch controller.status {
        case .idle: return "Ready — hold \(settings.hotkey.title)"
        case .recording: return "Listening…"
        case .processing: return "Writing it up…"
        case let .error(message): return message
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(disabled(statusLine))
        menu.addItem(.separator())

        let history = controller.history.records.prefix(10).map(\.text)
        if history.isEmpty {
            menu.addItem(disabled("No dictations yet"))
        } else {
            menu.addItem(disabled("Recent — click to copy"))
            for (index, text) in history.enumerated() {
                let item = NSMenuItem(title: DictationHistory.label(for: text), action: #selector(copyHistory(_:)), keyEquivalent: "")
                item.target = self
                item.tag = index
                item.toolTip = text
                menu.addItem(item)
            }
        }
        menu.addItem(.separator())
        menu.addItem(item("Paste last dictation", #selector(pasteLast), enabled: !history.isEmpty))
        if controller.failed != nil {
            menu.addItem(item("Retry last dictation", #selector(retryLast)))
        }

        let modeMenu = NSMenu()
        for mode in DictationMode.allCases {
            let entry = item(mode.title, #selector(setMode(_:)))
            entry.representedObject = mode.rawValue
            entry.state = settings.mode == mode ? .on : .off
            modeMenu.addItem(entry)
        }
        let modeItem = NSMenuItem(title: "Mode", action: nil, keyEquivalent: "")
        modeItem.submenu = modeMenu
        menu.addItem(modeItem)

        let hotkeyMenu = NSMenu()
        for hotkey in Hotkey.allCases {
            let entry = item(hotkey.title, #selector(setHotkey(_:)))
            entry.representedObject = hotkey.rawValue
            entry.state = settings.hotkey == hotkey ? .on : .off
            hotkeyMenu.addItem(entry)
        }
        let hotkeyItem = NSMenuItem(title: "Hotkey", action: nil, keyEquivalent: "")
        hotkeyItem.submenu = hotkeyMenu
        menu.addItem(hotkeyItem)

        menu.addItem(.separator())
        menu.addItem(item("Open \(Brand.name)", #selector(showSuite)))
        menu.addItem(item("Dictate settings…", #selector(openMainWindow)))
        let login = item("Launch at login", #selector(toggleLaunchAtLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(item("Check permissions…", #selector(showOnboarding)))
        if ConnectionStore.connection() != nil {
            menu.addItem(item("Disconnect this Mac", #selector(disconnect)))
        }
        menu.addItem(.separator())
        menu.addItem(item("Quit \(Brand.name)", #selector(quit), key: "q"))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func item(_ title: String, _ action: Selector, enabled: Bool = true, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        return item
    }

    // MARK: Actions

    @objc private func copyHistory(_ sender: NSMenuItem) {
        let entries = controller.history.records.prefix(10).map(\.text)
        guard entries.indices.contains(sender.tag) else { return }
        Inserter.copy(entries[sender.tag])
        controller.showMessage("Copied")
    }

    @objc private func pasteLast() { controller.pasteLast() }

    @objc private func retryLast() { controller.retryLast() }

    @objc private func setMode(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let mode = DictationMode(rawValue: raw) { settings.mode = mode }
    }

    @objc private func setHotkey(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let hotkey = Hotkey(rawValue: raw) else { return }
        settings.hotkey = hotkey
        monitor.hotkey = hotkey
    }

    /// The Dictate page, in the suite's window, where the member is already signed in.
    @objc private func openDictatePage() {
        suite.show()
        suite.open(path: "/dictate")
    }

    @objc private func showSuite() { suite.show() }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            controller.showMessage("Couldn’t change Launch at login")
        }
    }

    @objc private func showOnboarding() { onboarding.show() }

    @objc private func openMainWindow() { mainWindow.show() }

    @objc private func disconnect() {
        guard let connection = ConnectionStore.connection() else { return }
        ConnectionStore.delete()
        updateIcon()
        controller.showMessage("Disconnected")
        Task { await DictationClient(server: connection.server, token: connection.token).revokeSelf() }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Connecting

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        openAppLink(text)
    }

    /// The sign-in started from the window and waiting for the browser's callback.
    private var browserSignIn: BrowserSignIn?

    /// Opens the member's browser at the suite's confirm page; it hands back a one-time ticket.
    private func startBrowserSignIn() {
        // Pressed again while one is under way: the same sign-in, so either tab still works.
        let signIn = browserSignIn.flatMap { Date().timeIntervalSince($0.started) < BrowserSignIn.timeout / 2 ? $0 : nil }
            ?? BrowserSignIn()
        guard let url = signIn.connectURL(server: suite.router.server) else { return }
        browserSignIn = signIn
        NSWorkspace.shared.open(url)
    }

    /// A deep link opens its path in the window; a connect link connects, asking first; a
    /// browser sign-in's callback signs the window in, if this app started that sign-in.
    private func openAppLink(_ text: String) {
        if let url = URL(string: text), BrowserSignIn.callback(url) != nil {
            guard let ticket = browserSignIn?.ticket(from: url) else {
                controller.showMessage("That sign-in expired — press Sign in with your browser again")
                return
            }
            browserSignIn = nil
            suite.finishSignIn(ticket: ticket)
            return
        }
        if let url = URL(string: text), let path = SuiteRouter.deepLinkPath(url) {
            suite.show()
            suite.open(path: path)
            return
        }
        connect(code: text, fromLink: true) { error in
            guard let error else { return }
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Couldn’t connect"
            alert.informativeText = error
            alert.runModal()
        }
    }

    /// Connects with a link or a pasted code. Asks Hearth whose token it is first, and asks the
    /// member before using a link (any web page can open one), another server, or replacing a
    /// connection. Calls back with why it didn't connect, or nil when it did.
    private func connect(code: String, fromLink: Bool, done: @escaping (String?) -> Void) {
        guard let link = ConnectLink.parse(code) else {
            done("That isn’t a Dictate connection code. Press Connect this Mac on your workspace’s /dictate page to get one.")
            return
        }
        let client = DictationClient(server: link.server, token: link.token)
        Task { @MainActor [weak self] in
            let account: String
            do {
                account = try await client.account()
            } catch {
                done((error as? DictationError)?.errorDescription ?? error.localizedDescription)
                return
            }
            guard let self else { return }
            let previous = ConnectionStore.connection()
            if fromLink || link.isUnfamiliarServer || previous != nil {
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Connect Dictate as \(account)?"
                // One app serves every organization, so the address is what to check.
                var detail = link.isUnfamiliarServer
                    ? "Your dictations will be sent to \(link.server.absoluteString). Only continue if that is your organization’s \(Brand.name)."
                    : "Your dictations will go to \(link.server.host ?? Brand.name) as \(account)."
                if previous != nil { detail += " This replaces the connection this Mac has now." }
                alert.informativeText = detail
                alert.addButton(withTitle: "Connect")
                alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else {
                    done("Not connected.")
                    return
                }
            }
            guard ConnectionStore.setConnection(.init(token: link.token, server: link.server, account: account)) else {
                done("Couldn’t save the connection.")
                return
            }
            if let previous, previous.token != link.token {
                Task { await DictationClient(server: previous.server, token: previous.token).revokeSelf() }
            }
            self.updateIcon()
            self.onboarding.model.refresh()
            self.controller.showMessage("Connected as \(account)")
            done(nil)
        }
    }
}
