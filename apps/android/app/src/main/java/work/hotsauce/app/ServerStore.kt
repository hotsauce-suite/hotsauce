package work.hotsauce.app

import android.content.Context

/** The member's server origin and connect bookkeeping, remembered on this phone. The token lives in TokenVault (R11). */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("hotsauce", Context.MODE_PRIVATE)

    var origin: String?
        get() = prefs.getString(KEY_ORIGIN, null)
        set(value) = prefs.edit().putString(KEY_ORIGIN, value).apply()

    /** Whether the app has offered to connect the widgets once, so it doesn't ask on every open. */
    var offeredConnect: Boolean
        get() = prefs.getBoolean(KEY_OFFERED, false)
        set(value) = prefs.edit().putBoolean(KEY_OFFERED, value).apply()

    val nonce = ConnectNonce(
        read = {
            val n = prefs.getString(KEY_NONCE, null)
            if (n == null) null else n to prefs.getLong(KEY_NONCE_AT, 0)
        },
        write = { v ->
            prefs.edit().apply {
                if (v == null) remove(KEY_NONCE).remove(KEY_NONCE_AT)
                else putString(KEY_NONCE, v.first).putLong(KEY_NONCE_AT, v.second)
            }.apply()
        },
    )

    private companion object {
        const val KEY_ORIGIN = "server_origin"
        const val KEY_OFFERED = "offered_connect"
        const val KEY_NONCE = "connect_nonce"
        const val KEY_NONCE_AT = "connect_nonce_at"
    }
}
