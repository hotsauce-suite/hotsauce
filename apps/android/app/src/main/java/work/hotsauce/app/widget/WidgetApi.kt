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
}
