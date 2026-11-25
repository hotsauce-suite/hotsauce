import AVFoundation
import DictateCore

/// Plays the member's Dictate sounds (docs/PLAN-dictate-send-and-sounds.md, R11). Each sound is
/// made once from the table in DictateCore and kept ready, so playing it never waits.
@MainActor
final class DictateSoundPlayer {
    private var players: [String: AVAudioPlayer] = [:]

    func play(_ event: SoundEvent, theme: SoundTheme = DictatePrefs.sounds()) {
        guard theme != .off else { return }
        let key = "\(theme.rawValue).\(event.rawValue)"
        if players[key] == nil, let wav = DictateSounds.wav(theme, event) {
            players[key] = try? AVAudioPlayer(data: wav)
            players[key]?.prepareToPlay()
        }
        guard let player = players[key] else { return }
        player.currentTime = 0
        player.play()
    }

    /// How long a sound lasts, so other audio is quieted only after the start sound is heard.
    func length(_ event: SoundEvent, theme: SoundTheme = DictatePrefs.sounds()) -> TimeInterval {
        DictateSounds.length(DictateSounds.tones(theme, event))
    }
}
