import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-doc-download.md R10: the Mac save window for a Doc downloaded as Word or PDF.

@Suite struct DocExportTests {
    let docx = Data([0x50, 0x4B, 0x03, 0x04, 1, 2, 3])
    let pdf = Data("%PDF-1.7 body".utf8)

    @Test func startsOnWordThenRemembersThePick() {
        #expect(DocExport.initialFormat(saved: nil) == .word)
        #expect(DocExport.initialFormat(saved: "pdf") == .pdf)
        #expect(DocExport.initialFormat(saved: "pages") == .word)
    }

    @Test func namesTheFileForTheFormat() {
        #expect(DocExport.fileName("Launch plan", format: .pdf) == "Launch plan.pdf")
        #expect(DocExport.fileName("Launch plan.docx", format: .pdf) == "Launch plan.pdf")
        #expect(DocExport.fileName("Q3: a/b", format: .word) == "Q3  a b.docx")
        #expect(DocExport.fileName("  ", format: .word) == "Untitled.docx")
    }

    @Test func readsAFileFromThePage() {
        let answer = DocExport.parse(["name": "Plan.docx", "base64": docx.base64EncodedString()] as [String: Any])
        #expect(answer == .file(name: "Plan.docx", data: docx))
        let p = DocExport.parse(["name": "Plan.pdf", "base64": pdf.base64EncodedString()] as [String: Any])
        #expect(p == .file(name: "Plan.pdf", data: pdf))
    }

    @Test func refusesBytesThatAreNotTheFormatTheyClaim() {
        let answer = DocExport.parse(["name": "Plan.pdf", "base64": docx.base64EncodedString()] as [String: Any])
        #expect(answer == .failed("Couldn’t make the file. Try again in a moment."))
        #expect(DocExport.parse(["name": "Plan.pdf", "base64": "%%%"] as [String: Any]) != .file(name: "Plan.pdf", data: pdf))
    }

    @Test func noDocOpenOrThePagesOwnError() {
        #expect(DocExport.parse(nil) == .failed("Open a doc to export it."))
        #expect(DocExport.parse(["error": "Open a doc to export it."] as [String: Any]) == .failed("Open a doc to export it."))
    }
}
