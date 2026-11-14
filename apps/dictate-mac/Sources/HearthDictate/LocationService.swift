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
        asked = false
        timeout?.invalidate()
        timeout = Timer.scheduledTimer(withTimeInterval: LocationBridge.timeout, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish(LocationBridge.failure(.unavailable)) }
        }
        decide()
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
            // Asked once per request: a prompt dismissed without an answer ends as "denied".
            guard !asked else { return finish(LocationBridge.failure(.denied)) }
            asked = true
            manager.requestWhenInUseAuthorization()
        case .locate:
            guard !locating else { return }
            locating = true
            manager.requestLocation()
        case .refuseAndOpenSettings:
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
        // Also called once when the manager is made, before anything is asked.
        guard asked || manager.authorizationStatus != .notDetermined else { return }
        decide()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last, !waiting.isEmpty else { return }
        finish(LocationBridge.position(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard !waiting.isEmpty else { return }
        if (error as? CLError)?.code == .denied {
            finish(LocationBridge.failure(.denied))
        } else {
            finish(LocationBridge.failure(.unavailable))
        }
    }
}
