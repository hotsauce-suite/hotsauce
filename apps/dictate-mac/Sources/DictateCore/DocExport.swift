import Foundation

/// A Doc downloaded as Word or PDF (docs/PLAN-doc-download.md R10). The page builds the file; the
/// app only shows the Mac's save window and writes the bytes. Two ways in:
/// - File → Export… (⌘⇧E): the app asks the open doc's page for its title
///   (`window.hotsauceDocExport`, apps/web/src/lib/download/download.ts), shows the save window
///   with a Format choice, then asks the page to build that format.
/// - The Share menu's Download items: the page posts `{name, base64}` to `hotsauceSaveFile`.
/// Pure: the formats, the scripts and reading the page's answers, tested without a page.
public enum DocExport {
    public static let saveHandlerName = "hotsauceSaveFile"
    /// Where the last pick of Format is kept.
    public static let lastFormatKey = "docExportFormat"
    /// Generous: a long doc full of photos. Anything larger is refused rather than held in memory.
    public static let maxBytes = 200 * 1024 * 1024

    public enum Format: String, CaseIterable, Sendable {
        case word = "docx"
        case pdf

        public var title: String {
            switch self {
            case .word: return "Word Document (.docx)"
            case .pdf: return "PDF"
            }
        }

        public var fileExtension: String { rawValue }
    }

    /// The Format the save window starts on: the last one picked, Word the first time.
    public static func initialFormat(saved: String?) -> Format {
        saved.flatMap(Format.init(rawValue:)) ?? .word
    }

    /// `name` with its extension swapped for the format's (the page's title plus `.docx`/`.pdf`).
    public static func fileName(_ name: String, format: Format) -> String {
        var base = name.trimmingCharacters(in: .whitespacesAndNewlines)
        for f in Format.allCases where base.lowercased().hasSuffix(".\(f.fileExtension)") {
            base = String(base.dropLast(f.fileExtension.count + 1))
        }
        base = base.replacingOccurrences(of: "/", with: " ").replacingOccurrences(of: ":", with: " ")
        if base.isEmpty { base = "Untitled" }
        return "\(base).\(format.fileExtension)"
    }

    /// Runs in the page: the open doc's title, or null when no doc is open.
    public static let titleScript = """
    const offer = window.hotsauceDocExport;
    return offer && typeof offer.title === 'function' ? offer.title() : null;
    """

    /// Runs in the page with `format`: `{name, base64}` or `{error}`.
    public static let buildScript = """
    const offer = window.hotsauceDocExport;
    if (!offer || typeof offer.build !== 'function') return { error: 'Open a doc to export it.' };
    try { return await offer.build(format); } catch (e) { return { error: 'Couldn’t make the file. Try again in a moment.' }; }
    """

    public enum Answer: Equatable, Sendable {
        case file(name: String, data: Data)
        case failed(String)
    }

    /// The page's answer to `buildScript`, or a `hotsauceSaveFile` message: checked, never trusted.
    public static func parse(_ answer: Any?) -> Answer {
        guard let answer = answer as? [String: Any] else { return .failed("Open a doc to export it.") }
        if let error = answer["error"] as? String, !error.isEmpty { return .failed(error) }
        guard let name = answer["name"] as? String, let base64 = answer["base64"] as? String,
              base64.count <= maxBytes / 3 * 4 + 4,
              let data = Data(base64Encoded: base64), !data.isEmpty
        else { return .failed("Couldn’t make the file. Try again in a moment.") }
        let format = Format.allCases.first { name.lowercased().hasSuffix(".\($0.fileExtension)") } ?? .pdf
        guard looksLike(data, format) else { return .failed("Couldn’t make the file. Try again in a moment.") }
        return .file(name: fileName(name, format: format), data: data)
    }

    /// A Word file is a zip, a PDF starts with `%PDF`: the app writes nothing else to disk.
    static func looksLike(_ data: Data, _ format: Format) -> Bool {
        let head = [UInt8](data.prefix(4))
        switch format {
        case .word: return head == [0x50, 0x4B, 0x03, 0x04]
        case .pdf: return head == [0x25, 0x50, 0x44, 0x46]
        }
    }
}
