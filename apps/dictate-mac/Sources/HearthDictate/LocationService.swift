import AppKit
import CoreLocation
import DictateCore

/// Answers the Today page's `hearthLocation.postMessage('position')` with CoreLocation
/// (`LocationBridge`). The first request shows macOS's location prompt; a refused or switched-off
/// Mac opens System Settings at Location Services. Requests that arrive together share one fix.
@MainActor
final class LocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: [(Any?) -> Void] = []
    private var asked = false
    private var locating = false
    private var timeout: Timer?

    override init() {
        super.init()
        manager.delegate = self
        // Weather needs the town, not the street.
        manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
    }

    func request(reply: @escaping (Any?) -> Void) {
        waiting.append(reply)
        guard waiting.count == 1 else { return }
        note("request (services \(CLLocationManager.locationServicesEnabled()), status \(manager.authorizationStatus.rawValue))")
        asked = false
        // Long enough to read and answer macOS's prompt; finding the position gets its own wait.
        startTimer(LocationBridge.promptTimeout)
        decide()
    }

    private func startTimer(_ seconds: TimeInterval) {
        timeout?.invalidate()
        timeout = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.note("timed out (status \(self.manager.authorizationStatus.rawValue))")
                // Never answered: Location Services lists the app now, so open it there.
                if self.manager.authorizationStatus == .notDetermined { NSWorkspace.shared.open(LocationBridge.settingsURL) }
                self.finish(LocationBridge.failure(.unavailable))
            }
        }
    }

    /// The last few steps, for diagnosing on a member's Mac:
    /// `defaults read dev.hotsauce.dictate locationSteps`. No positions are kept.
    private func note(_ step: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(step)"
        let steps = (UserDefaults.standard.stringArray(forKey: "locationSteps") ?? []) + [line]
        UserDefaults.standard.set(Array(steps.suffix(20)), forKey: "locationSteps")
    }

    private var access: LocationBridge.Access {
        guard CLLocationManager.locationServicesEnabled() else { return .servicesOff }
        switch manager.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        default: return .allowed
        }
    }

    private func decide() {
        guard !waiting.isEmpty else { return }
        switch LocationBridge.step(for: access) {
        case .ask:
            // Once per request; a prompt left unanswered ends with the timer. On macOS,
            // requestWhenInUseAuthorization alone may show nothing: asking for a position is
            // what reliably brings up macOS's prompt, and it answers once the member decides.
            guard !asked else { return }
            asked = true
            note("ask")
            manager.requestWhenInUseAuthorization()
            locating = true
            manager.requestLocation()
        case .locate:
            guard !locating else { return }
            note("locate")
            locating = true
            startTimer(LocationBridge.timeout)
            manager.requestLocation()
        case .refuseAndOpenSettings:
            note(asked ? "refused in prompt" : "refused before; opening Settings")
            // Refused just now in macOS's prompt: respect that. Refused before: the member is
            // asking again, so take them to where it's turned on.
            if !asked { NSWorkspace.shared.open(LocationBridge.settingsURL) }
            finish(LocationBridge.failure(.denied))
        }
    }

    private func finish(_ answer: [String: Any]) {
        timeout?.invalidate()
        timeout = nil
        locating = false
        let replies = waiting
        waiting = []
        for reply in replies { reply(answer) }
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if !waiting.isEmpty { note("authorization \(manager.authorizationStatus.rawValue)") }
        // Also called when the manager is made, maybe late; an undecided status changes nothing.
        guard manager.authorizationStatus != .notDetermined else { return }
        decide()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last, !waiting.isEmpty else { return }
        note("located")
        finish(LocationBridge.position(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard !waiting.isEmpty else { return }
        note("failed \((error as? CLError)?.code.rawValue ?? -1)")
        if (error as? CLError)?.code == .denied {
            finish(LocationBridge.failure(.denied))
        } else {
            finish(LocationBridge.failure(.unavailable))
        }
    }
}
