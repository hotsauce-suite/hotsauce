import CoreGraphics
@testable import DictateCore
import XCTest

final class PdfBridgeTests: XCTestCase {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

    func testTakesOnlyAPngPicture() {
        XCTAssertEqual(TextReading.picture(from: ["png": png.base64EncodedString()]), png)
        XCTAssertNil(TextReading.picture(from: ["png": Data("%PDF-1.4".utf8).base64EncodedString()]))
        XCTAssertNil(TextReading.picture(from: ["png": "not base64!"]))
        XCTAssertNil(TextReading.picture(from: "png"))
        XCTAssertNil(TextReading.picture(from: nil))
    }

    func testTurnsVisionBoxesToFractionsFromTheTopLeft() {
        let answer = TextReading.answer([
            .init(text: " Invoice 42 ", box: CGRect(x: 0.1, y: 0.7, width: 0.3, height: 0.05)),
            .init(text: "  ", box: CGRect(x: 0, y: 0, width: 0.1, height: 0.1)),
            .init(text: "Edge", box: CGRect(x: -0.1, y: 0.95, width: 0.2, height: 0.1)),
        ])
        XCTAssertEqual(answer["ok"] as? Bool, true)
        let lines = answer["lines"] as? [[String: Any]] ?? []
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0]["text"] as? String, "Invoice 42")
        XCTAssertEqual(lines[0]["x"] as? Double ?? -1, 0.1, accuracy: 1e-9)
        XCTAssertEqual(lines[0]["y"] as? Double ?? -1, 0.25, accuracy: 1e-9)
        XCTAssertEqual(lines[0]["height"] as? Double ?? -1, 0.05, accuracy: 1e-9)
        // Off the picture: kept inside it.
        XCTAssertEqual(lines[1]["x"] as? Double, 0)
        XCTAssertEqual(lines[1]["y"] as? Double, 0)
    }

    func testDroppedFilesKeepTheirOrderAndSkipFolders() {
        let a = URL(fileURLWithPath: "/tmp/a.pdf")
        let folder = URL(fileURLWithPath: "/tmp/folder/", isDirectory: true)
        let b = URL(fileURLWithPath: "/tmp/b.txt")
        let result = DroppedFiles.payload([a, folder, b], read: { Data($0.lastPathComponent.utf8) }, size: { _ in 10 })
        guard case let .success(files) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(files.map { $0["name"] }, ["a.pdf", "b.txt"])
        XCTAssertEqual(files[0]["base64"], Data("a.pdf".utf8).base64EncodedString())
    }

    func testRefusesNothingTooManyAndTooLarge() {
        let a = URL(fileURLWithPath: "/tmp/a.pdf")
        XCTAssertEqual(DroppedFiles.payload([], read: { _ in Data() }), .failure(.nothing))
        XCTAssertEqual(DroppedFiles.payload([URL(string: "https://example.com/a.pdf")!], read: { _ in Data([1]) }), .failure(.nothing))
        XCTAssertEqual(
            DroppedFiles.payload(Array(repeating: a, count: 21), read: { _ in Data([1]) }, size: { _ in 1 }),
            .failure(.tooMany)
        )
        XCTAssertEqual(
            DroppedFiles.payload([a], read: { _ in Data([1]) }, size: { _ in DroppedFiles.maxBytes + 1 }),
            .failure(.tooLarge("a.pdf"))
        )
        XCTAssertTrue(DroppedFiles.message(.tooLarge("a.pdf")).contains("a.pdf"))
        // Each under the limit, together over it.
        XCTAssertEqual(
            DroppedFiles.payload(Array(repeating: a, count: 4), read: { _ in Data([1]) }, size: { _ in 90 * 1024 * 1024 }),
            .failure(.tooMuch)
        )
        XCTAssertFalse(DroppedFiles.message(.tooMuch).isEmpty)
    }

    func testRefusesHugePictures() {
        XCTAssertTrue(TextReading.fits(width: 2900, height: 2200))
        XCTAssertFalse(TextReading.fits(width: 50000, height: 50000))
        XCTAssertFalse(TextReading.fits(width: 0, height: 10))
    }

    func testReadsThePagesAnswer() {
        XCTAssertEqual(DroppedFiles.parse(["ok": true, "opened": 2, "path": "/files/x"]), .opened(2))
        XCTAssertEqual(DroppedFiles.parse(["missing": true]), .notReady)
        XCTAssertEqual(DroppedFiles.parse(nil), .notReady)
        XCTAssertEqual(DroppedFiles.parse(["ok": false, "error": "Sign in to Hotsauce to add files."]),
                       .failed("Sign in to Hotsauce to add files."))
        XCTAssertEqual(DroppedFiles.parse(["ok": 1]), .failed("Couldn’t add those files."))
    }
}
