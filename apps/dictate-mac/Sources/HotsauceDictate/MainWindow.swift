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
    @Published var edgeGlow = true
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
    var setEdgeGlow: (Bool) -> Void = { _ in }
    var setRetention: (Int) -> Void = { _ in }
    var clearHistory: () -> Void = {}
    var disconnect: () -> Void = {}
    var openWeb: () -> Void = {}
    /// The main window, from the fallback Settings page.
    var openSuite: () -> Void = {}
    var openSetup: () -> Void = {}
    /// Settings → Run setup again (docs/PLAN-replay-setup.md R1).
    var runSetupAgain: () -> Void = {}
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
        // Settings is only the fallback for ⌘, (docs/PLAN-one-settings.md R11): open on it only when asked.
        if let page { model.page = page } else if model.page == .settings { model.page = .dictations }
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
            List(MainModel.Page.allCases.filter { $0 != .settings || model.page == .settings }, selection: Binding(get: { model.page }, set: { if let p = $0 { model.page = p } })) { page in
                Label(page.rawValue, systemImage: page.symbol).tag(page)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
            .safeAreaInset(edge: .bottom) {
                Button(action: model.openWeb) {
                    Label("\(Brand.name) on the web", systemImage: "arrow.up.right.square")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Hotsauce.inkSoft)
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
            .background(Hotsauce.paper)
        }
        .tint(Hotsauce.ember)
    }
}

private struct TopBar: View {
    @ObservedObject var model: MainModel

    var body: some View {
        HStack(spacing: 10) {
            Text(model.page.rawValue).font(Hotsauce.display(20)).foregroundStyle(Hotsauce.ink)
            Spacer()
            if model.listening && model.account != nil {
                HStack(spacing: 6) {
                    Circle().fill(Hotsauce.ember).frame(width: 7, height: 7)
                    Text("Hold \(model.hotkey.shortName) to dictate")
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Hotsauce.inkSoft)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(Hotsauce.raised))
                .overlay(Capsule().strokeBorder(Hotsauce.ash))
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
                                                Text(app.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Hotsauce.ink)
                                                Spacer()
                                                Text("\(app.words.formatted()) words").font(.system(size: 11)).foregroundStyle(Hotsauce.inkFaint)
                                            }
                                            GeometryReader { geo in
                                                Capsule().fill(Hotsauce.ember.opacity(0.75))
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
                        Text("Recent dictations").font(Hotsauce.display(16)).foregroundStyle(Hotsauce.ink)
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
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Hotsauce.inkFaint).textCase(.uppercase)
            Text(value).font(Hotsauce.display(26)).foregroundStyle(Hotsauce.ink)
            Text(detail).font(.system(size: 11)).foregroundStyle(Hotsauce.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Hotsauce.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hotsauce.ash))
    }
}

private struct Card<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(Hotsauce.display(15)).foregroundStyle(Hotsauce.ink)
            content
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Hotsauce.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hotsauce.ash))
    }
}

private struct Empty: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Hotsauce.inkFaint).frame(maxWidth: .infinity, alignment: .leading)
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
                        Text(symbol).font(.system(size: 9, weight: .semibold)).foregroundStyle(Hotsauce.inkFaint)
                    case .blank:
                        Color.clear.frame(width: 26, height: 22)
                    case let .day(number, day):
                        RoundedRectangle(cornerRadius: 5)
                            .fill(color(level: month.level(for: day)))
                            .frame(width: 26, height: 22)
                            .overlay(Text("\(number)").font(.system(size: 8)).foregroundStyle(Hotsauce.inkFaint.opacity(0.7)))
                            .help("\(day.date.formatted(date: .abbreviated, time: .omitted)): \(day.words) words")
                    }
                }
            }
            Text("\(month.activeDays) active \(month.activeDays == 1 ? "day" : "days")")
                .font(.system(size: 11)).foregroundStyle(Hotsauce.inkSoft)
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
        case 0: Hotsauce.sunk
        case 1: Hotsauce.glow.opacity(0.35)
        case 2: Hotsauce.glow.opacity(0.65)
        case 3: Hotsauce.ember.opacity(0.75)
        default: Hotsauce.ember
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
            Image(systemName: "app.dashed").font(.system(size: size * 0.8)).foregroundStyle(Hotsauce.inkFaint).frame(width: size, height: size)
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
                    Text(record.appName ?? "Unknown app").font(.system(size: 12, weight: .semibold)).foregroundStyle(Hotsauce.ink)
                    Text(record.date.formatted(.relative(presentation: .named))).font(.system(size: 11)).foregroundStyle(Hotsauce.inkFaint)
                    if record.onDevice == true {
                        Text("on this Mac").font(.system(size: 10, weight: .medium)).foregroundStyle(Hotsauce.inkFaint)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Hotsauce.sunk))
                            .help("Written up by this Mac’s own speech recognition, with no connection")
                    } else if !record.cleaned {
                        Text("as spoken").font(.system(size: 10, weight: .medium)).foregroundStyle(Hotsauce.inkFaint)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Hotsauce.sunk))
                    }
                }
                Text(record.text).font(.system(size: 13)).foregroundStyle(Hotsauce.ink).lineLimit(5).textSelection(.enabled)
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
        .background(RoundedRectangle(cornerRadius: 12).fill(Hotsauce.raised))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Hotsauce.ash))
    }
}

// MARK: Dictionary

private struct DictionaryPage: View {
    @ObservedObject var model: MainModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Names and terms \(Brand.name) should hear and spell exactly as written. Yours apply to your dictations; the team’s apply to everyone on the team.")
                    .font(.system(size: 13)).foregroundStyle(Hotsauce.inkSoft).fixedSize(horizontal: false, vertical: true)
                if let state = model.wordsState {
                    Text(state).font(.system(size: 12)).foregroundStyle(Hotsauce.inkFaint)
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
            Text(hint).font(.system(size: 11)).foregroundStyle(Hotsauce.inkFaint)
            if words.isEmpty {
                Empty("None yet.")
            } else {
                Flow(spacing: 6) {
                    ForEach(words, id: \.self) { word in
                        HStack(spacing: 4) {
                            Text(word).font(.system(size: 12)).foregroundStyle(Hotsauce.ink)
                            Button {
                                model.editWords([], [word], scope) { _ in }
                            } label: {
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Hotsauce.inkFaint)
                            .help("Remove \(word)")
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Hotsauce.paper))
                        .overlay(Capsule().strokeBorder(Hotsauce.ash))
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

    // The app's settings are in the main window, Settings → This Mac (docs/PLAN-one-settings.md).
    // This page is the fallback for when that can't load (R11): the workspace's address, so the
    // app can reach it again, and the permissions it needs.
    var body: some View {
        Form {
            Section {
                Text("Your \(Brand.name) settings are in the main window, under Settings → This Mac. These are here for when \(Brand.name) can’t load.")
                    .font(.system(size: 12)).foregroundStyle(Hotsauce.inkSoft)
                Button("Open \(Brand.name)", action: model.openSuite)
            }
            Section("Workspace") {
                LabeledContent("Address") {
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
                    Text(error).font(.system(size: 11)).foregroundStyle(Hotsauce.ember)
                }
                LabeledContent("Signed in as") { Text(model.account ?? "Not connected").foregroundStyle(Hotsauce.inkSoft) }
                if ServerAddress.differs(model.server, model.suiteServer) {
                    LabeledContent("Dictate connected to") {
                        Text(model.server).font(.system(size: 11, design: .monospaced)).foregroundStyle(Hotsauce.inkFaint)
                    }
                }
            }
            Section("Setup") {
                PermissionRow(title: "Microphone", granted: model.microphone, action: model.requestMicrophone)
                PermissionRow(title: "Accessibility", granted: model.accessibility, action: model.requestAccessibility)
                LabeledContent("Hotkey") {
                    Text(model.listening ? "Listening" : "Not listening").foregroundStyle(model.listening ? Hotsauce.moss : Hotsauce.ember)
                }
                LabeledContent {
                    Button("Run setup again", action: model.runSetupAgain)
                } label: {
                    Text("First-run steps")
                    Text("Walks through them again. Nothing is reset.")
                }
            }
            Section("History") {
                // Dictation text is on this Mac only: clearing it can't wait for the workspace.
                Button("Clear history…", action: model.clearHistory)
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
                Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(Hotsauce.moss)
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
                .foregroundStyle(Hotsauce.ember)
            Text("On a MacBook the camera notch can cover it. ⌘-drag it to the right, or hide other icons. If it's switched off, turn on \(Brand.name) under System Settings → Menu Bar.")
                .font(.system(size: 11))
                .foregroundStyle(Hotsauce.inkSoft)
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
