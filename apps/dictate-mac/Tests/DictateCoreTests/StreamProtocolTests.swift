import Foundation
import Testing
@testable import DictateCore

@Suite struct StreamProtocolTests {
    @Test func socketURLFollowsTheServerScheme() {
        #expect(StreamProtocol.url(for: URL(string: "https://office.example.com")!)?.absoluteString == "wss://office.example.com/ws/dictation")
        #expect(StreamProtocol.url(for: URL(string: "http://localhost:3000")!)?.absoluteString == "ws://localhost:3000/ws/dictation")
    }

    @Test func startCarriesTheTokenModeAndApp() throws {
        let text = StreamProtocol.start(token: "hdt_x", mode: .literal, appName: "Slack", appBundle: nil)
        let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: String]
        #expect(object == ["type": "start", "token": "hdt_x", "mode": "literal", "app_name": "Slack"])
        #expect(StreamProtocol.finish == #"{"type":"finish"}"#)
    }

    @Test func parsesServerMessages() {
        #expect(StreamProtocol.parse(#"{"type":"ready"}"#) == .ready)
        let result = StreamProtocol.parse(#"{"type":"result","text":"Ship it.","raw":"ship it","cleaned":true,"durationMs":900,"ms":{"asr":120,"llm":400}}"#)
        guard case let .result(value) = result else { Issue.record("not a result"); return }
        #expect(value.text == "Ship it.")
        #expect(value.ms.asr == 120)
        #expect(StreamProtocol.parse(#"{"type":"error","code":"unauthorized","message":"Connect again"}"#) == .error(code: "unauthorized", message: "Connect again"))
        #expect(StreamProtocol.parse("nonsense") == .unknown)
    }

    @Test func framesArePCM16LittleEndian() {
        #expect(Array(StreamProtocol.frame([0x0102, -2])) == [0x02, 0x01, 0xFE, 0xFF])
    }
}
