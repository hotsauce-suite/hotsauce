import AppKit
import DictateCore
import SwiftUI

/// Everything the main window shows and does. The app delegate fills in the actions.
final class MainModel: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case dictations = "Dictations"
        case dictionary = "Dictionary"
        case settings = "Settings"
        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .dictations: "waveform"
            case .dictionary: "character.book.closed"
            case .settings: "gearshape"
            }
        }
    }

    enum Range: String, CaseIterable, Identifiable {
        case week = "7 days"
        case month = "30 days"
        case all = "All"
        var id: String { rawValue }
        func since(_ now: Date) -> Date? {
            switch self {
            case .week: now.addingTimeInterval(-7 * 86_400)
            case .month: now.addingTimeInterval(-30 * 86_400)
            case .all: nil
            }
        }
    }

    @Published var page: Page = .dictations
    @Published var range: Range = .month
    @Published var search = ""
    @Published var records: [DictationRecord] = []

    // Dictionary
    @Published var mine: [String] = []
    @Published var team: [String] = []
    @Published var wordsState: String? = "Loading…"
    /// What's typed in each list's Add field. Kept here: the Command Line Tools' SwiftUI has no
    /// @State (its macro plugin ships with Xcode only).
    @Published var drafts: [DictationClient.WordScope: String] = [:]

    // Settings and status
    @Published var hotkey: Hotkey = .rightOption
    @Published var mode: DictationMode = .clean
    @Published var launchAtLogin = false
    @Published var showInMenuBar = true
    @Published var menuBarIconShown = true
    @Published var retentionDays = 30
    @Published var microphone = false
    @Published var accessibility = false
    @Published var listening = false
    @Published var account: String?
    @Published var server = ""
    // The app
    @Published var suiteServer = ""
    /// What's typed in the server field; applied with Save.
    @Published var suiteServerDraft = ""
    @Published var suiteServerError: String?
    @Published var meetingReminders = true
    @Published var offerCallNotes = true
    @Published var notificationsAllowed = true

    /// Status and settings: cheap, every 2 s while the window is seen.
    var reload: () -> Void = {}
    /// The history list: when it changes.
    var reloadRecords: () -> Void = {}
    var loadWords: () -> Void = {}
    var copy: (String) -> Void = { _ in }
    var paste: (String) -> Void = { _ in }
    /// Adds and removes words; calls back with whether it saved.
    var editWords: (_ add: [String], _ remove: [String], DictationClient.WordScope, @escaping (Bool) -> Void) -> Void = { _, _, _, done in done(false) }
    var setHotkey: (Hotkey) -> Void = { _ in }
    var setMode: (DictationMode) -> Void = { _ in }
    var setLaunchAtLogin: (Bool) -> Void = { _ in }
    var setShowInMenuBar: (Bool) -> Void = { _ in }
    var setRetention: (Int) -> Void = { _ in }
    var clearHistory: () -> Void = {}
    var disconnect: () -> Void = {}
    var openWeb: () -> Void = {}
    var openSetup: () -> Void = {}
    var requestMicrophone: () -> Void = {}
    var requestAccessibility: () -> Void = {}
    /// Saves the suite's server; returns why not, or nil.
    var setSuiteServer: (String) -> String? = { _ in nil }
    var setMeetingReminders: (Bool) -> Void = { _ in }
    var setOfferCallNotes: (Bool) -> Void = { _ in }

    var stats: DictationStats { DictationStats.compute(records, since: range.since(Date())) }
    var month: MonthActivity { MonthActivity.month(containing: Date(), records: records) }

    var filtered: [DictationRecord] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return records }
        return records.filter {
            $0.text.localizedCaseInsensitiveContains(query) || ($0.appName ?? "").localizedCaseInsensitiveContains(query)
        }
    }
}

final class MainWindow: NSObject, NSWindowDelegate {
    let model = MainModel()
    private var window: NSWindow?
    private var timer: Timer?

    var isVisible: Bool { window?.isVisible ?? false }

    func show(page: MainModel.Page? = nil) {
        if let page { model.page = page }
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.title = "Dictate"
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 780, height: 520)
            window.delegate = self
            window.setFrameAutosaveName("HearthDictateMain")
            window.contentView = NSHostingView(rootView: MainView(model: model))
            if !window.setFrameUsingName("HearthDictateMain") { window.center() }
            self.window = window
        }
        model.reload()
        model.reloadRecords()
        model.loadWords()
        timer?.invalidate()
        // Permissions and the key tap can change while the window is open; only while it's seen.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isVisible, !NSApp.isHidden else { return }
                self.model.reload()
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
    }
}

// MARK: - Views

struct MainView: View {
    @ObservedObject var model: MainModel

    var body: some View {
        NavigationSplitView {
            List(MainModel.Page.allCases, selection: Binding(get: { model.page }, set: { if let p = $0 { model.page = p } })) { page in
                Label(page.rawValue, systemImage: page.symbol).tag(page)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
            .safeAreaInset(edge: .bottom) {
                Button(action: model.openWeb) {
                    Label("\(Brand.name) on the web", systemImage: "arrow.up.right.square")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Hearth.inkSoft)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } detail: {
            VStack(spacing: 0) {
                TopBar(model: model)
                Group {
                    switch model.page {
                    case .dictations: DictationsPage(model: model)
                    case .dictionary: DictionaryPage(model: model)
                    case .settings: SettingsPage(model: model)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Hearth.paper)
        }
        .tint(Hearth.ember)
    }
}

private struct TopBar: View {
    @ObservedObject var model: MainModel

    var body: some View {
        HStack(spacing: 10) {
            Text(model.page.rawValue).font(Hearth.display(20)).foregroundStyle(Hearth.ink)
            Spacer()
            if model.listening && model.account != nil {
                HStack(spacing: 6) {
                    Circle().fill(Hearth.ember).frame(width: 7, height: 7)
                    Text("Hold \(model.hotkey.shortName) to dictate")
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Hearth.inkSoft)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(Hearth.raised))
                .overlay(Capsule().strokeBorder(Hearth.ash))
            } else {
                Button("Finish setting up", action: model.openSetup)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }
}

// MARK: Dictations

private struct DictationsPage: View {
    @ObservedObject var model: MainModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Picker("Range", selection: $model.range) {
                    ForEach(MainModel.Range.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 260)

                let stats = model.stats
                HStack(spacing: 12) {
                    Tile(title: "Total words", value: stats.totalWords.formatted(), detail: "\(stats.dictations) dictations")
                    Tile(title: "Time saved", value: duration(stats.timeSavedMinutes), detail: "vs typing at 40 wpm")
                    Tile(title: "Average speed", value: "\(stats.averageWPM) wpm", detail: "while speaking")
                }

                HStack(alignment: .top, spacing: 12) {
                    Card(title: "Top sources") {
                        if stats.topApps.isEmpty {
                            Empty("Apps you dictate into show up here.")
                        } else {
                            let most = max(1, stats.topApps.first?.words ?? 1)
                            VStack(spacing: 10) {
                                ForEach(Array(stats.topApps.prefix(6).enumerated()), id: \.offset) { _, app in
                                    HStack(spacing: 10) {
                                        AppIcon(bundle: app.bundle, size: 20)
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack {
                                                Text(app.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Hearth.ink)
                                                Spacer()
                                                Text("\(app.words.formatted()) words").font(.system(size: 11)).foregroundStyle(Hearth.inkFaint)
                                            }
                                            GeometryReader { geo in
                                                Capsule().fill(Hearth.ember.opacity(0.75))
                                                    .frame(width: max(4, geo.size.width * CGFloat(app.words) / CGFloat(most)), height: 4)
                                            }
                                            .frame(height: 4)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Card(title: model.month.days.first.map { $0.date.formatted(.dateTime.month(.wide)) } ?? "This month") {
                        ActivityGrid(month: model.month)
                    }
                    .frame(width: 270)
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Recent dictations").font(Hearth.display(16)).foregroundStyle(Hearth.ink)
                        Spacer()
                        TextField("Search", text: $model.search)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 220)
                    }
                    let list = model.filtered
                    if list.isEmpty {
                        Empty(model.records.isEmpty ? "Hold \(model.hotkey.shortName) anywhere and speak. Your dictations stay on this Mac." : "Nothing matches “\(model.search)”.")
                    } else {
                        LazyVStack(spacing: 8) {
                            ForEach(list.prefix(200)) { record in
                                RecordRow(record: record, copy: model.copy, paste: model.paste)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 28)
        }
    }

    private func duration(_ minutes: Double) -> String {
        if minutes < 1 { return "\(Int((minutes * 60).rounded())) s" }
        if minutes < 60 { return "\(Int(minutes.rounded())) min" }
        return String(format: "%.1f h", minutes / 60)
    }
}

private struct Tile: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Hearth.inkFaint).textCase(.uppercase)
            Text(value).font(Hearth.display(26)).foregroundStyle(Hearth.ink)
            Text(detail).font(.system(size: 11)).foregroundStyle(Hearth.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Hearth.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hearth.ash))
    }
}

private struct Card<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(Hearth.display(15)).foregroundStyle(Hearth.ink)
            content
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Hearth.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hearth.ash))
    }
}

private struct Empty: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Hearth.inkFaint).frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ActivityGrid: View {
    let month: MonthActivity
    private let columns = Array(repeating: GridItem(.fixed(26), spacing: 5), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: columns, spacing: 5) {
                // One list of cells with distinct ids: separate ForEach blocks in one grid would
                // share ids (0, 1, 2…) and SwiftUI would drop the duplicates.
                ForEach(cells) { cell in
                    switch cell.kind {
                    case let .weekday(symbol):
                        Text(symbol).font(.system(size: 9, weight: .semibold)).foregroundStyle(Hearth.inkFaint)
                    case .blank:
                        Color.clear.frame(width: 26, height: 22)
                    case let .day(number, day):
                        RoundedRectangle(cornerRadius: 5)
                            .fill(color(level: month.level(for: day)))
                            .frame(width: 26, height: 22)
                            .overlay(Text("\(number)").font(.system(size: 8)).foregroundStyle(Hearth.inkFaint.opacity(0.7)))
                            .help("\(day.date.formatted(date: .abbreviated, time: .omitted)): \(day.words) words")
                    }
                }
            }
            Text("\(month.activeDays) active \(month.activeDays == 1 ? "day" : "days")")
                .font(.system(size: 11)).foregroundStyle(Hearth.inkSoft)
        }
    }

    private struct Cell: Identifiable {
        enum Kind {
            case weekday(String)
            case blank
            case day(Int, MonthActivity.Day)
        }

        let id: String
        let kind: Kind
    }

    private var cells: [Cell] {
        let symbols = MonthActivity.weekdaySymbols()
        return symbols.enumerated().map { Cell(id: "w\($0.offset)", kind: .weekday($0.element)) }
            + (0..<month.leadingBlanks).map { Cell(id: "b\($0)", kind: .blank) }
            + month.days.enumerated().map { Cell(id: "d\($0.offset)", kind: .day($0.offset + 1, $0.element)) }
    }

    private func color(level: Int) -> Color {
        switch level {
        case 0: Hearth.sunk
        case 1: Hearth.glow.opacity(0.35)
        case 2: Hearth.glow.opacity(0.65)
        case 3: Hearth.ember.opacity(0.75)
        default: Hearth.ember
        }
    }
}

private struct AppIcon: View {
    let bundle: String?
    let size: CGFloat

    var body: some View {
        if let image = AppIcons.icon(for: bundle) {
            Image(nsImage: image).resizable().frame(width: size, height: size)
        } else {
            Image(systemName: "app.dashed").font(.system(size: size * 0.8)).foregroundStyle(Hearth.inkFaint).frame(width: size, height: size)
        }
    }
}

private struct RecordRow: View {
    let record: DictationRecord
    let copy: (String) -> Void
    let paste: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AppIcon(bundle: record.appBundle, size: 26)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(record.appName ?? "Unknown app").font(.system(size: 12, weight: .semibold)).foregroundStyle(Hearth.ink)
                    Text(record.date.formatted(.relative(presentation: .named))).font(.system(size: 11)).foregroundStyle(Hearth.inkFaint)
                    if !record.cleaned {
                        Text("as spoken").font(.system(size: 10, weight: .medium)).foregroundStyle(Hearth.inkFaint)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Hearth.sunk))
                    }
                }
                Text(record.text).font(.system(size: 13)).foregroundStyle(Hearth.ink).lineLimit(5).textSelection(.enabled)
            }
            Spacer(minLength: 8)
            VStack(spacing: 6) {
                Button("Copy") { copy(record.text) }
                Button("Paste") { paste(record.text) }
                    .help("Paste into the app you were in before this window")
            }
            .controlSize(.small)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Hearth.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hearth.ash))
    }
}

// MARK: Dictionary

private struct DictionaryPage: View {
    @ObservedObject var model: MainModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Names and terms \(Brand.name) should hear and spell exactly as written. Yours apply to your dictations; the team’s apply to everyone on the team.")
                    .font(.system(size: 13)).foregroundStyle(Hearth.inkSoft).fixedSize(horizontal: false, vertical: true)
                if let state = model.wordsState {
                    Text(state).font(.system(size: 12)).foregroundStyle(Hearth.inkFaint)
                }
                HStack(alignment: .top, spacing: 12) {
                    WordList(model: model, scope: .mine, title: "My words", hint: "Only you", words: model.mine)
                    WordList(model: model, scope: .team, title: "Team words", hint: "Everyone on the team", words: model.team)
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 28)
        }
    }
}

private struct WordList: View {
    @ObservedObject var model: MainModel
    let scope: DictationClient.WordScope
    let title: String
    let hint: String
    let words: [String]

    private var draft: Binding<String> {
        Binding(get: { model.drafts[scope] ?? "" }, set: { model.drafts[scope] = $0 })
    }


    var body: some View {
        Card(title: title) {
            Text(hint).font(.system(size: 11)).foregroundStyle(Hearth.inkFaint)
            if words.isEmpty {
                Empty("None yet.")
            } else {
                Flow(spacing: 6) {
                    ForEach(words, id: \.self) { word in
                        HStack(spacing: 4) {
                            Text(word).font(.system(size: 12)).foregroundStyle(Hearth.ink)
                            Button {
                                model.editWords([], [word], scope) { _ in }
                            } label: {
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Hearth.inkFaint)
                            .help("Remove \(word)")
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Hearth.paper))
                        .overlay(Capsule().strokeBorder(Hearth.ash))
                    }
                }
            }
            HStack {
                TextField("Add a word or name", text: draft).textFieldStyle(.roundedBorder).onSubmit(add)
                Button("Add", action: add).disabled(draft.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func add() {
        let added = draft.wrappedValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !added.isEmpty else { return }
        // Cleared only once saved, so a failed save doesn't lose what was typed.
        model.editWords(added, [], scope) { saved in
            if saved { draft.wrappedValue = "" }
        }
    }
}

/// Wrapping row of chips.
private struct Flow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? rows.width, height: rows.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(width: bounds.width, subviews: subviews)
        for (index, point) in rows.points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (points: [CGPoint], width: CGFloat, height: CGFloat) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            maxX = max(maxX, x)
            rowHeight = max(rowHeight, size.height)
        }
        return (points, maxX, y + rowHeight)
    }
}

// MARK: Settings

private struct SettingsPage: View {
    @ObservedObject var model: MainModel

    var body: some View {
        Form {
            Section(Brand.name) {
                Toggle("Open at login", isOn: Binding(get: { model.launchAtLogin }, set: model.setLaunchAtLogin))
                Toggle("Meeting reminders", isOn: Binding(get: { model.meetingReminders }, set: model.setMeetingReminders))
                if model.meetingReminders && !model.notificationsAllowed {
                    HStack {
                        Text("Notifications are off for \(Brand.name) in System Settings.")
                            .font(.system(size: 11)).foregroundStyle(Hearth.ember)
                        Button("Open Notifications settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link).font(.system(size: 11))
                    }
                }
                if #available(macOS 14.2, *) {
                    Toggle("Offer to take notes when a call starts", isOn: Binding(get: { model.offerCallNotes }, set: model.setOfferCallNotes))
                }
                LabeledContent("Server") {
                    HStack {
                        TextField("", text: Binding(get: { model.suiteServerDraft }, set: { model.suiteServerDraft = $0 }))
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 12, design: .monospaced))
                            .frame(minWidth: 220)
                        Button("Save") { model.suiteServerError = model.setSuiteServer(model.suiteServerDraft) }
                            .disabled(model.suiteServerDraft == model.suiteServer)
                    }
                }
                if let error = model.suiteServerError {
                    Text(error).font(.system(size: 11)).foregroundStyle(Hearth.ember)
                }
            }
            Section("Dictation") {
                Picker("Hotkey", selection: Binding(get: { model.hotkey }, set: model.setHotkey)) {
                    ForEach(Hotkey.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("Mode", selection: Binding(get: { model.mode }, set: model.setMode)) {
                    Text("Clean up (removes ums, applies corrections)").tag(DictationMode.clean)
                    Text("Literal (exactly as spoken)").tag(DictationMode.literal)
                }
                Toggle("Show in menu bar", isOn: Binding(get: { model.showInMenuBar }, set: model.setShowInMenuBar))
                if model.showInMenuBar && !model.menuBarIconShown {
                    MenuBarHint()
                }
            }
            Section("Permissions") {
                PermissionRow(title: "Microphone", granted: model.microphone, action: model.requestMicrophone)
                PermissionRow(title: "Accessibility", granted: model.accessibility, action: model.requestAccessibility)
                LabeledContent("Keyboard shortcut") {
                    Text(model.listening ? "Listening" : "Not listening").foregroundStyle(model.listening ? Hearth.moss : Hearth.ember)
                }
            }
            Section("Account") {
                LabeledContent("Connected as") { Text(model.account ?? "Not connected").foregroundStyle(Hearth.inkSoft) }
                HStack {
                    Button("Open Dictate in \(Brand.name)", action: model.openWeb)
                    if model.account != nil { Button("Disconnect this Mac", role: .destructive, action: model.disconnect) }
                }
                LabeledContent("Server") { Text(model.server).font(.system(size: 11, design: .monospaced)).foregroundStyle(Hearth.inkFaint) }
            }
            Section {
                Picker("Keep history for", selection: Binding(get: { model.retentionDays }, set: model.setRetention)) {
                    Text("7 days").tag(7)
                    Text("30 days").tag(30)
                    Text("90 days").tag(90)
                }
                Button("Clear history…", action: model.clearHistory)
            } header: {
                Text("History")
            } footer: {
                Text("Dictation text stays on this Mac, readable only by you. It is never uploaded and never includes audio.")
                    .font(.system(size: 11)).foregroundStyle(Hearth.inkFaint)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .padding(.horizontal, 12)
    }
}

private struct PermissionRow: View {
    let title: String
    let granted: Bool
    let action: () -> Void

    var body: some View {
        LabeledContent(title) {
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(Hearth.moss)
            } else {
                Button("Allow…", action: action)
            }
        }
    }
}

/// Shown when the menu bar icon is on but can't be seen: behind the camera notch, crowded out, or
/// turned off in System Settings → Menu Bar.
struct MenuBarHint: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("The mic icon may be hidden in the menu bar", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Hearth.ember)
            Text("On a MacBook the camera notch can cover it. ⌘-drag it to the right, or hide other icons. If it's switched off, turn on \(Brand.name) under System Settings → Menu Bar.")
                .font(.system(size: 11))
                .foregroundStyle(Hearth.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Menu Bar settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.ControlCenter-Settings.extension") {
                    NSWorkspace.shared.open(url)
                }
            }
            .buttonStyle(.link)
            .font(.system(size: 11))
        }
    }
}
