import DictateCore
import Foundation

/// One dictation streamed to `/ws/dictation` while the member speaks. Anything going wrong makes
/// `finish()` return nil, and the controller uploads the whole recording instead, so streaming
/// can only make a dictation faster, never lose one.
final class DictationStream {
    private let task: URLSessionWebSocketTask
    private let queue = DispatchQueue(label: "dev.hotsauce.dictate.stream")
    private var failed = false
    private var result: DictationResult?
    private var waiter: CheckedContinuation<DictationResult?, Never>?

    init?(server: URL, token: String, mode: DictationMode, appName: String?, appBundle: String?) {
        guard let url = StreamProtocol.url(for: server) else { return nil }
        task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        task.resume()
        task.send(.string(StreamProtocol.start(token: token, mode: mode, appName: appName, appBundle: appBundle))) { [weak self] error in
            if error != nil { self?.fail() }
        }
        receive()
    }

    /// Audio as it is converted (any thread); sent in order.
    func send(_ samples: [Int16]) {
        guard !samples.isEmpty else { return }
        let frame = StreamProtocol.frame(samples)
        queue.async { [weak self] in
            guard let self, !self.failed else { return }
            self.task.send(.data(frame)) { [weak self] error in
                if error != nil { self?.fail() }
            }
        }
    }

    /// The server's result, or nil to fall back to the upload. Waits at most `timeout`.
    func finish(timeout: TimeInterval = 25) async -> DictationResult? {
        await withCheckedContinuation { continuation in
            queue.async { [weak self] in
                guard let self else { return continuation.resume(returning: nil) }
                if self.failed || self.result != nil {
                    continuation.resume(returning: self.result)
                    return
                }
                self.waiter = continuation
                self.task.send(.string(StreamProtocol.finish)) { [weak self] error in
                    if error != nil { self?.fail() }
                }
                self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.fail() }
            }
        }
    }

    func cancel() {
        queue.async { [weak self] in
            guard let self else { return }
            self.failed = true
            self.task.send(.string(StreamProtocol.cancel)) { _ in }
            self.task.cancel(with: .normalClosure, reason: nil)
            self.resolve(nil)
        }
    }

    private func receive() {
        task.receive { [weak self] message in
            guard let self else { return }
            switch message {
            case let .success(.string(text)):
                switch StreamProtocol.parse(text) {
                case let .result(result):
                    self.queue.async {
                        self.result = result
                        self.resolve(result)
                    }
                    return
                case .error:
                    self.fail()
                    return
                case .ready, .unknown:
                    break
                }
                self.receive()
            case .success:
                self.receive()
            case .failure:
                self.fail()
            }
        }
    }

    private func fail() {
        queue.async { [weak self] in
            guard let self, self.result == nil else { return }
            self.failed = true
            self.task.cancel(with: .goingAway, reason: nil)
            self.resolve(nil)
        }
    }

    /// On `queue`.
    private func resolve(_ value: DictationResult?) {
        waiter?.resume(returning: value)
        waiter = nil
    }
}
