package work.hotsauce.app.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/** docs/PLAN-android.md R7, R8: reading the server's summary and what the widget says. */
class TodaySummaryTest {
    private val answer = """
        {"date":"2026-11-25","now":"2026-11-25T15:00:00.000Z","calendarConnected":true,
         "meeting":{"id":"ev1","title":"Acme sync","start":"2026-11-25T16:00:00.000Z",
           "end":"2026-11-25T16:30:00.000Z","joinUrl":"https://meet.google.com/abc"},
         "meetingsLeft":2,
         "tasks":[{"space":"morgan","id":"t1","title":"Pay invoice","due":"2026-11-25","dueAt":null}],
         "tasksDue":4,
         "weather":{"place":"Montpelier","temperature":-1.6,"symbol":"lightsnow_day"}}
    """.trimIndent()

    @Test fun `R7 reads the summary and round-trips it`() {
        val s = TodaySummary.parse(answer, fetchedAt = 42)!!
        assertEquals("Acme sync", s.meeting?.title)
        assertEquals("https://meet.google.com/abc", s.meeting?.joinUrl)
        assertEquals(2, s.meetingsLeft)
        assertEquals(listOf("Pay invoice"), s.tasks.map { it.title })
        assertEquals(4, s.tasksDue)
        assertEquals("Montpelier", s.weather?.place)
        assertEquals(42L, s.fetchedAt)
        assertEquals(s, TodaySummary.parse(s.toJson()))
    }

    @Test fun `R7 no meeting, no weather and a non-https join link are fine`() {
        val s = TodaySummary.parse(
            """{"date":"2026-11-25","meeting":{"id":"e","title":"T","start":"2026-11-25T16:00:00Z",
               "end":"2026-11-25T17:00:00Z","joinUrl":"javascript:alert(1)"},"tasks":[],"weather":null}""",
        )!!
        assertNull(s.meeting?.joinUrl)
        assertNull(s.weather)
        assertNull(TodaySummary.parse("""{"date":"2026-11-25","meeting":null,"tasks":[]}""")?.meeting)
    }

    @Test fun `R7 something malformed is ignored`() {
        assertNull(TodaySummary.parse("<html>"))
        assertNull(TodaySummary.parse("""{"tasks":[]}"""))
    }

    @Test fun `R7 asks for the phone's own day`() {
        val now = ZonedDateTime.of(2026, 11, 25, 23, 30, 0, 0, ZoneId.of("America/New_York"))
        assertEquals(
            "from=2026-11-25T05%3A00%3A00Z&to=2026-11-26T05%3A00%3A00Z&date=2026-11-25",
            dayQuery(now),
        )
    }

    @Test fun `R8 says when the meeting is`() {
        val zone = ZoneId.of("America/New_York")
        val start = Instant.parse("2026-11-25T19:00:00Z") // 2:00 PM
        val end = Instant.parse("2026-11-25T19:30:00Z")
        Locale.setDefault(Locale.US)
        assertEquals("Now", whenLine(start, end, start.plusSeconds(60), zone, false))
        assertEquals("in 25 min", whenLine(start, end, start.minusSeconds(25 * 60), zone, false))
        assertEquals("at 2:00 PM", whenLine(start, end, start.minusSeconds(3 * 3600), zone, false))
        assertEquals("at 14:00", whenLine(start, end, start.minusSeconds(3 * 3600), zone, true))
        assertEquals("Tomorrow 2:00 PM", whenLine(start, end, start.minusSeconds(24 * 3600), zone, false))
    }

    @Test fun `R8 weather symbols as emoji`() {
        assertEquals("☀️", weatherEmoji("clearsky_day"))
        assertEquals("🌙", weatherEmoji("clearsky_night"))
        assertEquals("🌨️", weatherEmoji("lightsnow_day"))
        assertEquals("🌧️", weatherEmoji("heavyrain"))
        assertEquals("⛈️", weatherEmoji("rainandthunder"))
        assertEquals("☁️", weatherEmoji("cloudy"))
    }
}
