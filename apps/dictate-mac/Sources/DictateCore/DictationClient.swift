import Foundation

public enum DictationMode: String, CaseIterable, Codable, Sendable {
    case clean
    case literal

    public var title: String {
        switch self {
        case .clean: "Clean up"
        case .literal: "Literal"
        }
    }
}

/// `POST /api/dictation/transcribe`'s answer.
public struct DictationResult: Codable, Equatable, Sendable {
    public struct Timing: Codable, Equatable, Sendable {
        public let asr: Int
        public let llm: Int

        public init(asr: Int, llm: Int) {
            self.asr = asr
            self.llm = llm
        }
    }

    public let text: String
    public let raw: String
    public let cleaned: Bool
    public let durationMs: Int
    public let ms: Timing

    public init(text: String, raw: String, cleaned: Bool, durationMs: Int, ms: Timing) {
        self.text = text
        self.raw = raw
        self.cleaned = cleaned
        self.durationMs = durationMs
        self.ms = ms
    }
}

public enum DictationError: Error, Equatable, LocalizedError {
    /// No token, or the server refused it: connect again from the Dictate page.
    case notConnected
    /// The request didn't reach the server or got no answer; the audio is kept for a retry.
    case network(String)
    /// The server answered with an error.
    case server(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to \(Brand.name). Connect this Mac from Dictate on the web."
        case let .network(detail): "Couldn’t reach \(Brand.name) (\(detail))."
        case let .server(_, message): message
        }
    }

    /// Whether trying the same audio again could work.
    public var isRetryable: Bool {
        switch self {
        case .network: true
        case let .server(status, _): status >= 500 || status == 429
        case .notConnected: false
        }
    }
}

public struct DictationRequest: Sendable {
    public var audio: Data
    public var contentType: String
    public var mode: DictationMode
    public var appName: String?
    public var appBundle: String?

    public init(audio: Data, contentType: String = "audio/wav", mode: DictationMode, appName: String? = nil, appBundle: String? = nil) {
        self.audio = audio
        self.contentType = contentType
        self.mode = mode
        self.appName = appName
        self.appBundle = appBundle
    }
}

/// Talks to Hotsauce with a device token. Never logs the audio or the text.
public struct DictationClient: Sendable {
    public let server: URL
    public let token: String
    /// The server answers within about a minute (45 s transcription, 15 s cleanup).
    public var timeout: TimeInterval = 90

    public init(server: URL, token: String) {
        self.server = server
        self.token = token
    }

    public func urlRequest(for request: DictationRequest) -> URLRequest {
        var components = URLComponents(url: server.appendingPathComponent("api/dictation/transcribe"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "mode", value: request.mode.rawValue)]
        if let name = request.appName, !name.isEmpty { items.append(URLQueryItem(name: "app_name", value: String(name.prefix(200)))) }
        if let bundle = request.appBundle, !bundle.isEmpty { items.append(URLQueryItem(name: "app_bundle", value: String(bundle.prefix(200)))) }
        components.queryItems = items
        var urlRequest = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&urlRequest)
        urlRequest.setValue(request.contentType, forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = request.audio
        return urlRequest
    }

    /// The result from a response, or the error it means.
    public static func decode(status: Int, body: Data) throws -> DictationResult {
        if status == 401 { throw DictationError.notConnected }
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error.message
            throw DictationError.server(status: status, message: message ?? "\(Brand.name) answered \(status)")
        }
        do {
            return try JSONDecoder().decode(DictationResult.self, from: body)
        } catch {
            throw DictationError.server(status: status, message: "\(Brand.name) answered with something unexpected")
        }
    }

    public func transcribe(_ request: DictationRequest, session: URLSession = .shared) async throws -> DictationResult {
        let (body, response): (Data, URLResponse)
        do {
            (body, response) = try await session.data(for: urlRequest(for: request))
        } catch {
            throw DictationError.network((error as NSError).localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try Self.decode(status: status, body: body)
    }

    /// The member's Dictate choices (`GET /api/dictation/settings`, docs/PLAN-dictate-models.md).
    public struct Choices: Decodable, Equatable, Sendable {
        /// `online`, or `device` for "On this Mac only".
        public let speech: String
        /// `fast`, `careful` or `off`.
        public let cleanup: String
        /// False when the server has no AI key, so nothing is tidied.
        public let cleanupAvailable: Bool?
        /// The send key and the sounds (docs/PLAN-dictate-send-and-sounds.md); nil from a server
        /// that predates them.
        public let sendKey: String?
        public let sounds: String?

        public init(speech: String, cleanup: String, cleanupAvailable: Bool? = true, sendKey: String? = nil, sounds: String? = nil) {
            self.speech = speech
            self.cleanup = cleanup
            self.cleanupAvailable = cleanupAvailable
            self.sendKey = sendKey
            self.sounds = sounds
        }

        /// The member chose "On this Mac only": their voice never leaves the Mac.
        public var keepsSpeechOnMac: Bool { speech == "device" }

        /// Whether text heard on the Mac is worth sending to be tidied.
        public var tidiesText: Bool { cleanup != "off" && cleanupAvailable != false }

        public var known: SpeechPreference.Known {
            SpeechPreference.Known(keepOnMac: keepsSpeechOnMac, tidy: tidiesText)
        }
    }

    public func choices(session: URLSession = .shared) async throws -> Choices {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/settings"), timeoutInterval: 15)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&request)
        let (body, status) = try await send(request, session: session)
        return try Self.decodeChoices(status: status, body: body)
    }

    /// A server from before the choices (404) has none: everything stays online.
    public static func decodeChoices(status: Int, body: Data) throws -> Choices {
        if status == 401 { throw DictationError.notConnected }
        if status == 404 { return Choices(speech: "online", cleanup: "fast") }
        guard (200..<300).contains(status), let choices = try? JSONDecoder().decode(Choices.self, from: body) else {
            throw DictationError.server(status: status, message: "\(Brand.name) answered \(status)")
        }
        return choices
    }

    /// Text this Mac heard itself, sent to be tidied like a dictation (`POST /api/dictation/clean`).
    /// Only the text goes, never the audio.
    public func urlRequest(cleaning text: String, like request: DictationRequest) throws -> URLRequest {
        var body: [String: Any] = ["text": text, "mode": request.mode.rawValue]
        if let name = request.appName, !name.isEmpty { body["app_name"] = String(name.prefix(200)) }
        if let bundle = request.appBundle, !bundle.isEmpty { body["app_bundle"] = String(bundle.prefix(200)) }
        var urlRequest = URLRequest(url: server.appendingPathComponent("api/dictation/clean"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&urlRequest)
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        return urlRequest
    }

    public func clean(_ text: String, like request: DictationRequest, session: URLSession = .shared) async throws -> DictationResult {
        let (body, status) = try await send(try urlRequest(cleaning: text, like: request), session: session)
        return try Self.decode(status: status, body: body)
    }

    /// Whose Hotsauce this token belongs to (`GET /api/dictation/words` names the account).
    public func account(session: URLSession = .shared) async throws -> String {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/words"), timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&request)
        let (body, response): (Data, URLResponse)
        do {
            (body, response) = try await session.data(for: request)
        } catch {
            throw DictationError.network((error as NSError).localizedDescription)
        }
        return try Self.decodeAccount(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: body)
    }

    public static func decodeAccount(status: Int, body: Data) throws -> String {
        if status == 401 { throw DictationError.notConnected }
        struct Words: Decodable { let account: String }
        guard (200..<300).contains(status), let words = try? JSONDecoder().decode(Words.self, from: body) else {
            throw DictationError.server(status: status, message: "\(Brand.name) answered \(status)")
        }
        return words.account
    }

    /// The member's and the team's word lists.
    public struct Words: Codable, Equatable, Sendable {
        public var mine: [String]
        public var team: [String]
        public var account: String?
        /// The heard-as spellings, the member's first; nil from a server before them.
        public var fixes: [WordFix]?
    }

    public enum WordScope: String, Sendable { case mine, team }

    public func words(session: URLSession = .shared) async throws -> Words {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/words"), timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&request)
        let (body, status) = try await send(request, session: session)
        if status == 401 { throw DictationError.notConnected }
        guard (200..<300).contains(status), let words = try? JSONDecoder().decode(Words.self, from: body) else {
            throw DictationError.server(status: status, message: "\(Brand.name) answered \(status)")
        }
        return words
    }

    /// Adds and removes words against the list as the server has it now (never a stale copy);
    /// returns the list as saved.
    public func editWords(add: [String] = [], remove: [String] = [], scope: WordScope, session: URLSession = .shared) async throws -> [String] {
        try await putWords(["scope": scope.rawValue, "add": add, "remove": remove], session: session)
    }

    /// Replaces one list; returns it as the server saved it (trimmed, deduplicated).
    public func setWords(_ words: [String], scope: WordScope, session: URLSession = .shared) async throws -> [String] {
        try await putWords(["scope": scope.rawValue, "words": words], session: session)
    }

    private func putWords(_ body: [String: Any], session: URLSession) async throws -> [String] {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/words"), timeoutInterval: 20)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (body, status) = try await send(request, session: session)
        if status == 401 { throw DictationError.notConnected }
        struct Saved: Decodable { let words: [String] }
        guard (200..<300).contains(status), let saved = try? JSONDecoder().decode(Saved.self, from: body) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error.message
            throw DictationError.server(status: status, message: message ?? "\(Brand.name) answered \(status)")
        }
        return saved.words
    }

    private func send(_ request: URLRequest, session: URLSession) async throws -> (Data, Int) {
        do {
            let (body, response) = try await session.data(for: request)
            return (body, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw DictationError.network((error as NSError).localizedDescription)
        }
    }

    /// Revokes this token on the server (`DELETE /api/dictation/devices/self`). Best effort.
    public func revokeSelf(session: URLSession = .shared) async {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/devices/self"), timeoutInterval: 15)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        AppVersion.tag(&request)
        _ = try? await session.data(for: request)
    }

    private struct ErrorBody: Decodable {
        struct Inner: Decodable { let message: String }
        let error: Inner
    }
}
