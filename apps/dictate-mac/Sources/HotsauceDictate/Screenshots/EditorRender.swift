import AppKit
import CoreText
import DictateCore

/// `HotsauceDictate --render-screenshot-editor <folder>`: the editor window with one of each
/// layer (light and dark, and in Crop), the flattened export of that document, a redaction
/// before/after pair, and Copy Text's result on a made-up picture, without the app running.
@MainActor
enum EditorRender {
    static func render(to folder: String) -> Int32 {
        let out = URL(fileURLWithPath: folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard let screen = ScreenshotRender.standInFrame(),
              let source = screen.cropping(to: CGRect(x: 160, y: 120, width: 1800, height: 1160)),
              let png = ScreenshotImage.png(source)
        else { return fail("couldn’t draw the stand-in capture") }
        let shot = Screenshot(image: source, png: png, fileURL: nil, takenAt: Date())

        var document = ShotDocument(sourceWidth: source.width, sourceHeight: source.height)
        let ember = ShotPalette.defaultColor
        let arrow = document.add(.arrow(from: CGPoint(x: 1150, y: 260), to: CGPoint(x: 820, y: 470)), color: ember, width: 6)
        document.add(.rectangle(CGRect(x: 1180, y: 520, width: 460, height: 260)), color: ShotPalette.colors[4].color, width: 6)
        document.add(.ellipse(CGRect(x: 120, y: 620, width: 300, height: 180)), color: ShotPalette.colors[3].color, width: 6)
        document.add(.highlighter(points: [CGPoint(x: 160, y: 120), CGPoint(x: 900, y: 120)]), color: ShotPalette.colors[2].color, width: 6)
        document.add(.text(origin: CGPoint(x: 1180, y: 160), string: "Click here first\nthen Save", fontSize: 44), color: ember, width: 6)
        document.add(.step(center: CGPoint(x: 1120, y: 560), radius: 26, number: 0), color: ember, width: 6)
        document.add(.step(center: CGPoint(x: 160, y: 590), radius: 26, number: 0), color: ShotPalette.colors[2].color, width: 6)
        document.add(.redact(CGRect(x: 200, y: 330, width: 420, height: 60), style: .fill), color: ShotPalette.redactColor, width: 6)
        document.add(.redact(CGRect(x: 200, y: 420, width: 420, height: 60), style: .mosaic), color: ShotPalette.redactColor, width: 6)

        for (name, appearance) in [("screenshot-editor-light", NSAppearance.Name.aqua), ("screenshot-editor-dark", .darkAqua)] {
            let editor = ScreenshotEditor(shot: shot, document: document)
            editor.canvas.tool = .select
            editor.canvas.selection = [arrow]
            guard snapshot(editor, appearance: appearance, to: out.appendingPathComponent("\(name).png")) else { return fail("couldn’t draw \(name)") }
        }
        let cropping = ScreenshotEditor(shot: shot, document: document)
        cropping.canvas.tool = .crop
        _ = snapshot(cropping, appearance: .aqua, to: out.appendingPathComponent("screenshot-editor-crop.png"))

        guard let flattened = ShotRenderer.exportPNG(document, source: source) else { return fail("couldn’t export") }
        try? flattened.write(to: out.appendingPathComponent("screenshot-editor-export.png"))

        // Redaction before and after, over text that matters.
        guard let secret = textPicture(["Account 4421 9087 3310", "Password: hunter2-correct-horse", "Balance £12,408.17"]) else { return fail("couldn’t draw text") }
        _ = write(secret, to: out.appendingPathComponent("screenshot-redact-before.png"))
        var redacted = ShotDocument(sourceWidth: secret.width, sourceHeight: secret.height)
        redacted.add(.redact(CGRect(x: 250, y: 10, width: 540, height: 70), style: .fill), color: ShotPalette.redactColor, width: 6)
        redacted.add(.redact(CGRect(x: 280, y: 90, width: 700, height: 70), style: .mosaic), color: ShotPalette.redactColor, width: 6)
        guard let after = ShotRenderer.exportPNG(redacted, source: secret) else { return fail("couldn’t redact") }
        try? after.write(to: out.appendingPathComponent("screenshot-redact-after.png"))

        // Copy Text on the picture with no redactions.
        let text = TextRecognition.read(secret)
        try? text.write(to: out.appendingPathComponent("screenshot-copy-text.txt"), atomically: true, encoding: .utf8)
        // And as the editor does it, with the redactions on: their text must not come back.
        if let masked = ShotRenderer.export(redacted.redactionsOnly, source: secret) {
            try? TextRecognition.read(masked).write(to: out.appendingPathComponent("screenshot-copy-text-redacted.txt"), atomically: true, encoding: .utf8)
        }
        return 0
    }

    private static func snapshot(_ editor: ScreenshotEditor, appearance: NSAppearance.Name, to url: URL) -> Bool {
        editor.window.appearance = NSAppearance(named: appearance)
        editor.window.setContentSize(NSSize(width: 1180, height: 760))
        guard let view = editor.window.contentView else { return false }
        view.layoutSubtreeIfNeeded()
        editor.canvas.refit()
        editor.refreshControls()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: rep) }
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: url)) != nil
    }

    /// Black text on white, one line per string, at Retina size.
    static func textPicture(_ lines: [String]) -> CGImage? {
        let width = 1100, height = 90 * lines.count + 20
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("Helvetica" as CFString, 48, nil)
        for (index, text) in lines.enumerated() {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                kCTFontAttributeName as NSAttributedString.Key: font,
                kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(gray: 0, alpha: 1),
            ]))
            context.textPosition = CGPoint(x: 30, y: CGFloat(height - 70 - index * 90))
            CTLineDraw(line, context)
        }
        return context.makeImage()
    }

    private static func write(_ image: CGImage, to url: URL) -> Bool {
        guard let data = ScreenshotImage.png(image) else { return false }
        return (try? data.write(to: url)) != nil
    }

    private static func fail(_ message: String) -> Int32 {
        FileHandle.standardError.write(Data("hotsauce-dictate: \(message)\n".utf8))
        return 1
    }
}
