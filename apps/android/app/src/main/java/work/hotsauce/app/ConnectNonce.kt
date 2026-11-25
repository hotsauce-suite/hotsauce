package work.hotsauce.app

import java.security.SecureRandom
import java.util.Base64

/**
 * The nonce the app sends to /phone/connect and expects back with the token (PLAN-android R5):
 * random, URL-safe, used once, and only within ten minutes.
 */
class ConnectNonce(
    private val read: () -> Pair<String, Long>?,
    private val write: (Pair<String, Long>?) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    fun start(): String {
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        write(nonce to now())
        return nonce
    }

    /**
     * Whether `state` is the nonce we sent in the last ten minutes. A match spends it; so does
     * expiry. A wrong state leaves it, so a stray link can't spoil the real one.
     */
    fun take(state: String?): Boolean {
        val sent = read() ?: return false
        if (now() - sent.second !in 0..TEN_MINUTES) {
            write(null)
            return false
        }
        if (state == null || state.length != sent.first.length) return false
        var diff = 0
        for (i in state.indices) diff = diff or (state[i].code xor sent.first[i].code)
        if (diff != 0) return false
        write(null)
        return true
    }

    companion object {
        const val TEN_MINUTES = 10 * 60 * 1000L
    }
}
