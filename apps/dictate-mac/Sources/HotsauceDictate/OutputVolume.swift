import AudioToolbox
import CoreAudio
import DictateCore
import Foundation

/// The Mac's output volume, for Quiet other audio (docs/PLAN-dictate-send-and-sounds.md, R12).
/// Lowers or mutes the default output while dictating and puts it back after, only if the member
/// didn't move it meanwhile. Devices without a volume control (some HDMI and USB outputs) are left.
enum OutputVolume {
    /// Called as the mic starts; remembers what to put back, also on disk for a crash.
    static func quiet(_ choice: QuietAudio) {
        guard choice != .off, QuietedVolume.saved() == nil, let volume = read(),
              let quiet = choice.quietVolume(from: volume), quiet < volume
        else { return }
        QuietedVolume(original: volume, quiet: quiet).save()
        guard write(quiet) else { return QuietedVolume.clear() }
        // Many outputs round to their own steps: remember where it really landed, or the restore
        // would think the member moved it and leave it low.
        if let landed = read() { QuietedVolume(original: volume, quiet: landed).save() }
    }

    /// Called as the mic stops (finished, sent or cancelled).
    static func restore() {
        guard let quieted = QuietedVolume.saved() else { return }
        QuietedVolume.clear()
        if let current = read(), let original = quieted.restore(current: current) { _ = write(original) }
    }

    /// At launch: a dictation that never finished left the volume low.
    static func restoreLeftover() { restore() }

    private static func volumeAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    private static func defaultOutput() -> AudioDeviceID? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var where_ = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &where_, 0, nil, &size, &device)
        return status == noErr && device != 0 ? device : nil
    }

    private static func read() -> Float? {
        var address = volumeAddress()
        guard let device = defaultOutput(), AudioObjectHasProperty(device, &address) else { return nil }
        var volume = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &volume) == noErr ? volume : nil
    }

    private static func write(_ volume: Float) -> Bool {
        var address = volumeAddress()
        guard let device = defaultOutput(), AudioObjectHasProperty(device, &address) else { return false }
        var settable: DarwinBoolean = false
        guard AudioObjectIsPropertySettable(device, &address, &settable) == noErr, settable.boolValue else { return false }
        var value = Float32(max(0, min(1, volume)))
        return AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value) == noErr
    }
}
