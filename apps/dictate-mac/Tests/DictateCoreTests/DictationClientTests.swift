import Foundation
import Testing
@testable import DictateCore

@Suite struct DictationClientTests {
    let client = DictationClient(server: URL(string: "https://office.example.com")!, token: "hdt_token")

    @Test func buildsTheUpload() throws {
        let request = client.urlRequest(for: DictationRequest(audio: Data([1, 2]), mode: .literal, appName: "Slack & Co", appBundle: "com.tinyspeck.slackmacgap"))
        let url = try #require(request.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(url.path == "/api/dictation/transcribe")
        #expect(items.first { $0.name == "mode" }?.value == "literal")
        #expect(items.first { $0.name == "app_name" }?.value == "Slack & Co")
        #expect(items.first { $0.name == "app_bundle" }?.value == "com.tinyspeck.slackmacgap")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer hdt_token")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "audio/wav")
        #expect(request.httpBody == Data([1, 2]))
    }

    @Test func leavesOutAnUnknownApp() throws {
        let request = client.urlRequest(for: DictationRequest(audio: Data(), mode: .clean))
        let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.map(\.name) == ["mode"])
    }

    @Test func decodesTheResult() throws {
        let body = #"{"text":"Ship it Wednesday.","raw":"um ship it","cleaned":true,"durationMs":1500,"ms":{"asr":300,"llm":400}}"#
        let result = try DictationClient.decode(status: 200, body: Data(body.utf8))
        #expect(result.text == "Ship it Wednesday.")
        #expect(result.cleaned)
        #expect(result.ms.llm == 400)
    }

    @Test func mapsErrors() {
        #expect(throws: DictationError.notConnected) { try DictationClient.decode(status: 401, body: Data()) }
        let tooMany = Data(#"{"error":{"code":"rate_limited","message":"Too many dictations"}}"#.utf8)
        #expect(throws: DictationError.server(status: 429, message: "Too many dictations")) {
            try DictationClient.decode(status: 429, body: tooMany)
        }
        #expect(DictationError.server(status: 429, message: "").isRetryable)
        #expect(DictationError.server(status: 502, message: "").isRetryable)
        #expect(!DictationError.server(status: 400, message: "").isRetryable)
        #expect(DictationError.network("offline").isRetryable)
        #expect(!DictationError.notConnected.isRetryable)
    }

    @Test func readsTheAccountATokenBelongsTo() throws {
        #expect(try DictationClient.decodeAccount(status: 200, body: Data(#"{"mine":[],"team":[],"account":"ada@example.com"}"#.utf8)) == "ada@example.com")
        #expect(throws: DictationError.notConnected) { try DictationClient.decodeAccount(status: 401, body: Data()) }
    }

    @Test func waitsLongerThanTheServer() {
        #expect(client.timeout >= 60)
    }
}
