import AppKit

/// Everything on a pasteboard, every item and every type, so pasting a dictation can put back
/// what the member had copied.
public struct PasteboardSnapshot: Equatable {
    public let items: [[NSPasteboard.PasteboardType: Data]]

    /// Marks our write as transient, so clipboard managers that honour the convention skip it.
    public static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    public static func capture(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
        let items = (pasteboard.pasteboardItems ?? []).map { item in
            var types: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { types[type] = data }
            }
            return types
        }
        return PasteboardSnapshot(items: items)
    }

    public func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let restored = items.map { types -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in types { item.setData(data, forType: type) }
            return item
        }
        if !restored.isEmpty { pasteboard.writeObjects(restored) }
    }

    /// Puts the text on the pasteboard (marked transient) and returns its change count, which
    /// tells a later restore whether anything else has written since.
    @discardableResult
    public static func write(_ text: String, to pasteboard: NSPasteboard) -> Int {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: transientType)
        pasteboard.writeObjects([item])
        return pasteboard.changeCount
    }

    /// Restores the snapshot unless the pasteboard changed after our write (the member copied
    /// something new in the meantime, which must win). Returns whether it restored.
    @discardableResult
    public func restore(to pasteboard: NSPasteboard, ifUnchangedSince changeCount: Int) -> Bool {
        guard pasteboard.changeCount == changeCount else { return false }
        restore(to: pasteboard)
        return true
    }
}
