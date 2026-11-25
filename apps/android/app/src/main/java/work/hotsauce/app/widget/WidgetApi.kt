package work.hotsauce.app.widget

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** One call to the server for the widget's summary (R7), with the phone's token. */
object WidgetApi {
    sealed interface Result {
        data class Ok(val summary: TodaySummary) : Result
        /** The phone was disconnected (R10): forget the token. */
        data object Disconnected : Result
        data class Failed(val reason: String) : Result
    }

    fun fetchToday(origin: String, token: String, query: String = dayQuery(), now: Long = System.currentTimeMillis()): Result {
        val conn = URL("$origin/api/widgets/today?$query").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            when (val code = conn.responseCode) {
                200 -> {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    TodaySummary.parse(text, now)?.let { Result.Ok(it) } ?: Result.Failed("bad answer")
                }
                401, 403 -> Result.Disconnected
                else -> Result.Failed("HTTP $code")
            }
        } catch (e: IOException) {
            Result.Failed(e.javaClass.simpleName)
        } finally {
            conn.disconnect()
        }
    }

    /** Ticks a task off from the Tasks widget (R13): `POST /api/tasks/:space/:id/complete`. */
    fun completeTask(origin: String, token: String, space: String, id: String, tz: String): Result? {
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        val conn = URL("$origin/api/tasks/${enc(space)}/${enc(id)}/complete").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.instanceFollowRedirects = false
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(org.json.JSONObject().put("tz", tz).toString().toByteArray()) }
            when (val code = conn.responseCode) {
                in 200..299 -> null
                401 -> Result.Disconnected
                else -> Result.Failed("HTTP $code")
            }
        } catch (e: IOException) {
            Result.Failed(e.javaClass.simpleName)
        } finally {
            conn.disconnect()
        }
    }

    /** Best effort: tell the old server this phone is gone (DELETE of its own device, R6). */
    fun disconnect(origin: String, token: String) {
        try {
            val conn = URL("$origin/api/dictation/devices/self").openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                conn.instanceFollowRedirects = false
                conn.requestMethod = "DELETE"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.responseCode
            } finally {
                conn.disconnect()
            }
        } catch (_: IOException) {
        }
    }
}
