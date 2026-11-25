package work.hotsauce.app

import android.content.Context

/** The member's server origin, remembered on this phone (R3). The device token lives elsewhere (R11). */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("hotsauce", Context.MODE_PRIVATE)

    var origin: String?
        get() = prefs.getString(KEY_ORIGIN, null)
        set(value) = prefs.edit().putString(KEY_ORIGIN, value).apply()

    private companion object {
        const val KEY_ORIGIN = "server_origin"
    }
}
