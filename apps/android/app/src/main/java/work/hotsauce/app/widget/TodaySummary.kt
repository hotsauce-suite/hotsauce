package work.hotsauce.app.widget

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What GET /api/widgets/today returns (docs/PLAN-android.md R7), as the widget keeps it. */
data class TodaySummary(
    val date: String,
    val meeting: Meeting?,
    val meetingsLeft: Int,
    val calendarConnected: Boolean,
    val tasks: List<Task>,
    val tasksDue: Int,
    val weather: Weather?,
    /** When this phone fetched it, epoch millis. */
    val fetchedAt: Long,
) {
    data class Meeting(val id: String, val title: String, val start: Instant, val end: Instant, val joinUrl: String?)
    data class Task(val space: String, val id: String, val title: String, val due: String?)
    data class Weather(val place: String?, val temperature: Double, val symbol: String)

    /** This summary with one task ticked off: gone from the list, one fewer due (R14). */
    fun withoutTask(space: String, id: String): TodaySummary {
        val left = tasks.filterNot { it.space == space && it.id == id }
        return if (left.size == tasks.size) this
        else copy(tasks = left, tasksDue = maxOf(tasksDue - 1, left.size))
    }

    fun toJson(): String = JSONObject().apply {
        put("date", date)
        put("meetingsLeft", meetingsLeft)
        put("calendarConnected", calendarConnected)
        put("tasksDue", tasksDue)
        put("fetchedAt", fetchedAt)
        meeting?.let {
            put("meeting", JSONObject().apply {
                put("id", it.id); put("title", it.title)
                put("start", it.start.toString()); put("end", it.end.toString())
                put("joinUrl", it.joinUrl ?: JSONObject.NULL)
            })
        }
        put("tasks", org.json.JSONArray().apply {
            tasks.forEach { t ->
                put(JSONObject().apply {
                    put("space", t.space); put("id", t.id); put("title", t.title)
                    put("due", t.due ?: JSONObject.NULL)
                })
            }
        })
        weather?.let {
            put("weather", JSONObject().apply {
                put("place", it.place ?: JSONObject.NULL)
                put("temperature", it.temperature); put("symbol", it.symbol)
            })
        }
    }.toString()

    companion object {
        /** Reads the server's answer or our own saved copy; null for anything malformed. */
        fun parse(text: String, fetchedAt: Long? = null): TodaySummary? = try {
            val o = JSONObject(text)
            val m = o.optJSONObject("meeting")
            val w = o.optJSONObject("weather")
            val tasks = o.optJSONArray("tasks")
            TodaySummary(
                date = o.getString("date"),
                meeting = m?.let {
                    Meeting(
                        id = it.getString("id"),
                        title = it.getString("title"),
                        start = Instant.parse(it.getString("start")),
                        end = Instant.parse(it.getString("end")),
                        joinUrl = it.optStringOrNull("joinUrl")?.takeIf { u -> u.startsWith("https://") },
                    )
                },
                meetingsLeft = o.optInt("meetingsLeft", if (m != null) 1 else 0),
                calendarConnected = o.optBoolean("calendarConnected", true),
                tasks = (0 until (tasks?.length() ?: 0)).map { i ->
                    val t = tasks!!.getJSONObject(i)
                    Task(t.getString("space"), t.getString("id"), t.getString("title"), t.optStringOrNull("due"))
                },
                tasksDue = o.optInt("tasksDue", tasks?.length() ?: 0),
                weather = w?.let { Weather(it.optStringOrNull("place"), it.getDouble("temperature"), it.getString("symbol")) },
                fetchedAt = fetchedAt ?: o.optLong("fetchedAt", 0),
            )
        } catch (_: Exception) {
            null
        }

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key) || !has(key)) null else getString(key)
    }
}

/** The phone's own day, as the server's `from`, `to` and `date` (it never guesses our time zone). */
fun dayQuery(now: ZonedDateTime = ZonedDateTime.now()): String {
    val start = now.toLocalDate().atStartOfDay(now.zone)
    val end = start.plusDays(1)
    fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
    return "from=${enc(start.toInstant().toString())}&to=${enc(end.toInstant().toString())}" +
        "&date=${start.toLocalDate()}"
}

/** "10:30 AM" or "10:30", as the phone shows times. */
fun clock(instant: Instant, zone: ZoneId = ZoneId.systemDefault(), use24h: Boolean, locale: Locale = Locale.getDefault()): String =
    DateTimeFormatter.ofPattern(if (use24h) "H:mm" else "h:mm a", locale).format(instant.atZone(zone))

/** A short line for when the meeting is: "Now", "in 25 min", "at 2:00 PM", or "Tomorrow 9:00 AM". */
fun whenLine(start: Instant, end: Instant, now: Instant, zone: ZoneId, use24h: Boolean): String {
    if (now >= start && now < end) return "Now"
    val minutes = java.time.Duration.between(now, start).toMinutes()
    if (minutes in 0..59) return "in ${maxOf(minutes, 1)} min"
    val day = start.atZone(zone).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    val time = clock(start, zone, use24h)
    return if (day == today) "at $time" else if (day == today.plusDays(1)) "Tomorrow $time" else time
}

/** MET Norway's symbol code as one emoji the widget can show without images. */
fun weatherEmoji(symbol: String): String {
    val s = symbol.substringBefore('_')
    return when {
        "thunder" in s -> "⛈️"
        "snow" in s || "sleet" in s -> "🌨️"
        "rain" in s -> "🌧️"
        s == "fog" -> "🌫️"
        s == "cloudy" -> "☁️"
        s == "partlycloudy" -> "⛅"
        s == "fair" -> "🌤️"
        s == "clearsky" -> if (symbol.endsWith("_night")) "🌙" else "☀️"
        else -> "🌡️"
    }
}

/** Whether a saved summary is still for today on this phone. */
fun TodaySummary.isFor(today: LocalDate): Boolean = date == today.toString()
