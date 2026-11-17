import CoreAudio
import DictateCore
import Foundation

/// The Mac's microphones, for Settings → This Mac → Microphone for dictation
/// (docs/PLAN-one-settings.md R14). Devices are named by their UID, which stays the same across
/// restarts and replugging, unlike their AudioDeviceID.
enum AudioInputs {
    /// Every device with an input stream, in the order Core Audio lists them.
    static func all() -> [MacSettingsBridge.Microphone] {
        deviceIDs().compactMap { id in
            guard hasInput(id), let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
            return MacSettingsBridge.Microphone(id: uid, name: string(id, kAudioObjectPropertyName) ?? uid)
        }
    }

    /// The device with this UID, while it's connected.
    static func deviceID(uid: String) -> AudioDeviceID? {
        deviceIDs().first { hasInput($0) && string($0, kAudioDevicePropertyDeviceUID) == uid }
    }

    private static func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
    }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
}
