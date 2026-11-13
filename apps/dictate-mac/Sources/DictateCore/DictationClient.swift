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
    }

    public let text: String
    public let raw: String
    public let cleaned: Bool
    public let durationMs: Int
    public let ms: Timing
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

/// Talks to Hearth with a device token. Never logs the audio or the text.
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

    /// Whose Hearth this token belongs to (`GET /api/dictation/words` names the account).
    public func account(session: URLSession = .shared) async throws -> String {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/words"), timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
    }

    public enum WordScope: String, Sendable { case mine, team }

    public func words(session: URLSession = .shared) async throws -> Words {
        var request = URLRequest(url: server.appendingPathComponent("api/dictation/words"), timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
        _ = try? await session.data(for: request)
    }

    private struct ErrorBody: Decodable {
        struct Inner: Decodable { let message: String }
        let error: Inner
    }
}
