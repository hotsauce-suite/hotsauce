import CoreGraphics
import Foundation

/// PDF tools in Files (docs/PLAN-pdf-tools.md). Two ways the Mac app helps the page:
/// - Make searchable (R6): the page posts a page picture to `hotsauceReadText`; the app reads its
///   words with Vision and answers with each line and where it sits.
/// - Files dropped on the app's icon (R10): the app hands them to the signed-in page,
///   `window.hotsauceMac.openFiles([{name, base64}])` (apps/web/src/lib/macOpenFiles.ts), which
///   uploads them to Personal files and opens PDFs in PDF tools.
/// Pure: checking what the page sends, shaping the answers, reading the files. Tested without a page.
public enum TextReading {
    public static let handlerName = "hotsauceReadText"
    /// A page picture at about 250 dpi is a few MB; anything far bigger is refused.
    public static let maxBytes = 60 * 1024 * 1024

    /// The page picture's text as the page sent it, when it isn't too big. Cheap, so it can run on
    /// the main thread; decoding waits for `picture(fromBase64:)` off it.
    public static func base64(from body: Any?) -> String? {
        guard let body = body as? [String: Any], let base64 = body["png"] as? String,
              base64.utf8.count <= maxBytes / 3 * 4 + 4
        else { return nil }
        return base64
    }

    /// The PNG in that text, or nil when it isn't one.
    public static func picture(fromBase64 base64: String) -> Data? {
        guard let data = Data(base64Encoded: base64), data.count > 8 else { return nil }
        let magic: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        return [UInt8](data.prefix(8)) == magic ? data : nil
    }

    /// The PNG the page sent, or nil when it isn't one.
    public static func picture(from body: Any?) -> Data? {
        base64(from: body).flatMap(picture(fromBase64:))
    }

    /// Page pictures are about 3000 pixels on the long side; anything far bigger isn't read.
    public static let maxSide = 12000
    public static func fits(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && width <= maxSide && height <= maxSide
    }

    /// A line Vision read: its text and box in Vision's terms (fractions, origin bottom-left).
    public struct Line: Equatable, Sendable {
        public var text: String
        public var box: CGRect
        public init(text: String, box: CGRect) {
            self.text = text
            self.box = box
        }
    }

    /// The answer for the page: each line's box as fractions from the picture's top-left.
    public static func answer(_ lines: [Line]) -> [String: Any] {
        let clamp = { (v: CGFloat) in Double(min(1, max(0, v))) }
        return [
            "ok": true,
            "lines": lines.compactMap { line -> [String: Any]? in
                let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, line.box.width > 0, line.box.height > 0 else { return nil }
                return [
                    "text": text,
                    "x": clamp(line.box.minX),
                    "y": clamp(1 - line.box.maxY),
                    "width": clamp(line.box.width),
                    "height": clamp(line.box.height),
                ]
            },
        ]
    }

    public static func failure(_ message: String) -> [String: Any] {
        ["ok": false, "error": message, "lines": [Any]()]
    }
}

public enum DroppedFiles {
    /// Matches the page's MAX_DROPPED_BYTES and MAX_DROPPED_FILES.
    public static let maxBytes = 100 * 1024 * 1024
    public static let maxFiles = 20
    /// All of a drop together: it crosses to the page as text, so it is kept well below memory.
    public static let maxTotalBytes = 300 * 1024 * 1024

    public enum Failure: Error, Equatable, Sendable {
        case nothing
        case tooMany
        case tooLarge(String)
        case tooMuch
    }

    /// What the app sends: each file's name and bytes, in the order dropped. Folders and files it
    /// can't read are left out.
    public static func payload(_ urls: [URL], read: (URL) -> Data? = { try? Data(contentsOf: $0) },
                               size: (URL) -> Int? = { (try? $0.resourceValues(forKeys: [.fileSizeKey]))?.fileSize },
                               isFolder: (URL) -> Bool = { $0.hasDirectoryPath }) -> Result<[[String: String]], Failure> {
        let files = urls.filter { $0.isFileURL && !isFolder($0) }
        guard !files.isEmpty else { return .failure(.nothing) }
        guard files.count <= maxFiles else { return .failure(.tooMany) }
        var total = 0
        for url in files {
            guard let bytes = size(url) else { continue }
            if bytes > maxBytes { return .failure(.tooLarge(url.lastPathComponent)) }
            total += bytes
        }
        if total > maxTotalBytes { return .failure(.tooMuch) }
        var out: [[String: String]] = []
        total = 0
        for url in files {
            guard let data = read(url) else { continue }
            if data.count > maxBytes { return .failure(.tooLarge(url.lastPathComponent)) }
            total += data.count
            if total > maxTotalBytes { return .failure(.tooMuch) }
            out.append(["name": url.lastPathComponent, "base64": data.base64EncodedString()])
        }
        return out.isEmpty ? .failure(.nothing) : .success(out)
    }

    /// Whether the page is ready for the files: cheap to ask again and again while it loads, so
    /// the files themselves cross only once.
    public static let readyScript = """
    return !!(window.hotsauceMac && typeof window.hotsauceMac.openFiles === 'function');
    """

    /// Runs in the page with `files`: the function's answer, or `{missing: true}` when the page
    /// hasn't put it there (an older web app, or nobody signed in yet).
    public static let script = """
    const open = window.hotsauceMac && window.hotsauceMac.openFiles;
    if (typeof open !== 'function') return { missing: true };
    return await open(files);
    """

    public enum Outcome: Equatable, Sendable {
        case opened(Int)
        case notReady
        case failed(String)
    }

    /// The page's answer, checked.
    public static func parse(_ answer: Any?) -> Outcome {
        guard let answer = answer as? [String: Any] else { return .notReady }
        if answer["missing"] as? Bool == true { return .notReady }
        if let ok = answer["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue {
            return .opened((answer["opened"] as? NSNumber)?.intValue ?? 0)
        }
        let error = (answer["error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .failed(error.isEmpty ? "Couldn’t add those files." : error)
    }

    /// What to tell the person when it didn't work.
    public static func message(_ failure: Failure) -> String {
        switch failure {
        case .nothing: return "Drop files, not folders, on Hotsauce to add them to Files."
        case .tooMany: return "Drop up to \(maxFiles) files at a time."
        case let .tooLarge(name): return "“\(name)” is over 100 MB. Use Upload in Files for big files."
        case .tooMuch: return "Those files come to over 300 MB. Drop fewer at a time, or use Upload in Files."
        }
    }
}
