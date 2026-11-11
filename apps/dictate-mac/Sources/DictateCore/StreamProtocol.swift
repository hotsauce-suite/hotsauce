import Foundation

/// The messages of `/ws/dictation` (ARCHITECTURE §9.2), apart from the binary audio frames.
public enum StreamProtocol {
    /// The socket's URL for a server: https → wss, http (localhost) → ws.
    public static func url(for server: URL) -> URL? {
        guard var components = URLComponents(url: server.appendingPathComponent("ws/dictation"), resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        return components.url
    }

    public static func start(token: String, mode: DictationMode, appName: String?, appBundle: String?) -> String {
        var message: [String: String] = ["type": "start", "token": token, "mode": mode.rawValue]
        if let appName, !appName.isEmpty { message["app_name"] = String(appName.prefix(200)) }
        if let appBundle, !appBundle.isEmpty { message["app_bundle"] = String(appBundle.prefix(200)) }
        return json(message)
    }

    public static let finish = json(["type": "finish"])
    public static let cancel = json(["type": "cancel"])

    public enum ServerMessage: Equatable {
        case ready
        case result(DictationResult)
        case error(code: String, message: String)
        case unknown
    }

    public static func parse(_ text: String) -> ServerMessage {
        let data = Data(text.utf8)
        struct Kind: Decodable { let type: String }
        struct Failure: Decodable { let code: String; let message: String }
        guard let kind = try? JSONDecoder().decode(Kind.self, from: data) else { return .unknown }
        switch kind.type {
        case "ready": return .ready
        case "result":
            return (try? JSONDecoder().decode(DictationResult.self, from: data)).map { .result($0) } ?? .unknown
        case "error":
            return (try? JSONDecoder().decode(Failure.self, from: data)).map { .error(code: $0.code, message: $0.message) } ?? .unknown
        default: return .unknown
        }
    }

    /// Little-endian PCM16 bytes for a binary frame.
    public static func frame(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples { data.appendLE(UInt16(bitPattern: sample)) }
        return data
    }

    private static func json(_ object: [String: String]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
