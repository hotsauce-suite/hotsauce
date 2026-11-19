import AppKit
import DictateCore

/// The screenshot tool (docs/PLAN-screenshots.md slice 2): the shortcut grabs every display, the
/// overlay picks what to keep, and the shot goes to the clipboard, the screenshots folder and the
/// preview in the corner. Nothing leaves the Mac.
@MainActor
final class ScreenshotController {
    /// A short message in the dictation pill ("Couldn't save the screenshot").
    var showMessage: (String) -> Void = { _ in }

    private var session = ScreenshotSession()
    private let overlay = CaptureOverlay()
    let preview = ScreenshotPreview()
    private let prompt = ScreenRecordingPrompt()
    private(set) var recent = RecentCaptures<Screenshot>()
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        overlay.shortcut = { [weak self] in self?.shortcut ?? .default }
        overlay.onCancel = { [weak self] in self?.cancel() }
        overlay.onPick = { [weak self] display, selection in self?.keep(selection, of: display) }
        preview.onCopy = { [weak self] shot in self?.copy(shot) }
    }

    var shortcut: ScreenshotShortcut { ScreenshotSettings.shortcut(defaults) }
    var folder: URL { ScreenshotSettings.folder(defaults, home: FileManager.default.homeDirectoryForCurrentUser) }

    /// From the key tap. Esc is swallowed only while a capture is under way.
    func handle(_ key: HotkeyMonitor.ScreenshotKey) -> Bool {
        switch key {
        case .shortcut:
            shortcutPressed()
            return true
        case .escape:
            guard session.isActive else { return false }
            cancel()
            return true
        }
    }

    /// The shortcut, or Take Screenshot in a menu: starts a capture, or ends the one on screen.
    func shortcutPressed() {
        switch session.shortcutPressed() {
        case .none: break
        case .dismiss: cancel()
        case .start: start()
        }
    }

    private func start() {
        guard Permissions.screenRecordingGranted else {
            session.end()
            Permissions.requestScreenRecording()
            prompt.show()
            return
        }
        Task { @MainActor in
            do {
                let frozen = try await ScreenCapture.grab(excluding: preview.windowNumbers.union(overlay.windowNumbers))
                // Esc during the grab: never show the overlay.
                guard session.phase == .capturing else { return }
                session.captured()
                overlay.show(frozen, ownPID: ProcessInfo.processInfo.processIdentifier)
            } catch ScreenCapture.Failure.notAllowed {
                session.end()
                prompt.show()
            } catch {
                session.end()
                showMessage("Couldn’t take the screenshot")
            }
        }
    }

    private func cancel() {
        session.end()
        overlay.close()
    }

    private func keep(_ selection: CaptureSelection, of frozen: FrozenDisplay) {
        session.end()
        overlay.close()
        guard let image = ScreenshotImage.crop(frozen.image, display: frozen.display, to: selection.rect),
              let png = ScreenshotImage.png(image)
        else { return }
        let takenAt = Date()
        let shot = Screenshot(image: image, png: png, fileURL: save(png, takenAt: takenAt), takenAt: takenAt)
        copy(shot)
        recent.add(shot)
        preview.show(shot, on: frozen.screen)
    }

    /// The clipboard gets PNG, and TIFF for the apps that only take that.
    private func copy(_ shot: Screenshot) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(shot.png, forType: .png)
        if let tiff = NSBitmapImageRep(cgImage: shot.image).tiffRepresentation {
            pasteboard.setData(tiff, forType: .tiff)
        }
    }

    /// Into the screenshots folder (made when first needed), under a name that doesn't clash.
    private func save(_ png: Data, takenAt: Date) -> URL? {
        let folder = folder
        let files = FileManager.default
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = ScreenshotFiles.fileName(for: takenAt) { files.fileExists(atPath: folder.appendingPathComponent($0).path) }
            let url = folder.appendingPathComponent(name)
            try png.write(to: url, options: .withoutOverwriting)
            return url
        } catch {
            showMessage("Copied, but couldn’t save it to \(folder.lastPathComponent)")
            return nil
        }
    }
}
