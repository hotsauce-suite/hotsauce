import AppKit
import Testing
@testable import DictateCore

@Suite struct PasteboardSnapshotTests {
    @Test func restoresEveryItemAndType() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("hearth-dictate-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        let rich = NSPasteboardItem()
        rich.setString("Hello", forType: .string)
        rich.setData(Data("{\\rtf1 Hello}".utf8), forType: .rtf)
        let second = NSPasteboardItem()
        second.setString("https://acme.example", forType: .URL)
        pasteboard.writeObjects([rich, second])
        let before = PasteboardSnapshot.capture(pasteboard)

        let ours = PasteboardSnapshot.write("Ship it Wednesday.", to: pasteboard)
        #expect(pasteboard.string(forType: .string) == "Ship it Wednesday.")
        #expect(pasteboard.types?.contains(PasteboardSnapshot.transientType) == true)

        #expect(before.restore(to: pasteboard, ifUnchangedSince: ours))
        #expect(PasteboardSnapshot.capture(pasteboard) == before)
        #expect(pasteboard.pasteboardItems?.count == 2)
        #expect(pasteboard.string(forType: .string) == "Hello")
    }

    @Test func doesNotClobberSomethingCopiedSince() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("hearth-dictate-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("old", forType: .string)
        let before = PasteboardSnapshot.capture(pasteboard)
        let ours = PasteboardSnapshot.write("dictated", to: pasteboard)
        pasteboard.clearContents()
        pasteboard.setString("copied meanwhile", forType: .string)
        #expect(!before.restore(to: pasteboard, ifUnchangedSince: ours))
        #expect(pasteboard.string(forType: .string) == "copied meanwhile")
    }

    @Test func restoresAnEmptyPasteboard() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("hearth-dictate-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        let before = PasteboardSnapshot.capture(pasteboard)
        let ours = PasteboardSnapshot.write("dictated", to: pasteboard)
        #expect(before.restore(to: pasteboard, ifUnchangedSince: ours))
        #expect(pasteboard.string(forType: .string) == nil)
    }
}

@Suite struct HistoryTests {
    @Test func keepsTheLastTenNewestFirst() {
        var history = DictationHistory()
        for i in 1...12 { history.add("dictation \(i)") }
        history.add("   ")
        #expect(history.entries.count == 10)
        #expect(history.entries.first == "dictation 12")
        #expect(history.entries.last == "dictation 3")
    }

    @Test func labelsAreOneShortLine() {
        #expect(DictationHistory.label(for: "one\ntwo") == "one two")
        #expect(DictationHistory.label(for: String(repeating: "a", count: 60), length: 10) == "aaaaaaaaa…")
    }
}
