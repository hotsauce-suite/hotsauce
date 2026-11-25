package work.hotsauce.app.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import work.hotsauce.app.LauncherActivity
import work.hotsauce.app.TokenVault
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToInt

/** "Today at a glance" (docs/PLAN-android.md R8, R9): next meeting with Join, tasks due, weather. */
class TodayWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, WIDE, TALL))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val connected = TokenVault(context).token != null
        val summary = if (connected) SummaryStore(context).summary else null
        val use24h = DateFormat.is24HourFormat(context)
        provideContent {
            GlanceTheme { Body(connected, summary, use24h) }
        }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)
        val TALL = DpSize(250.dp, 220.dp)
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedule(context)
        RefreshWorker.now(context)
    }
}

/** The refresh mark: fetch now. */
class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        RefreshWorker.now(context)
    }
}

private fun openApp(context: Context, path: String? = null, connect: Boolean = false) =
    Intent(context, LauncherActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        .apply {
            if (path != null) putExtra(LauncherActivity.EXTRA_PATH, path)
            if (connect) putExtra(LauncherActivity.EXTRA_CONNECT, true)
        }

@Composable
private fun Body(connected: Boolean, summary: TodaySummary?, use24h: Boolean) {
    val context = LocalContext.current
    val size = LocalSize.current
    val colors = GlanceTheme.colors
    val title = TextStyle(fontWeight = FontWeight.Bold, fontSize = 15.sp, color = colors.onSurface)
    val body = TextStyle(fontSize = 14.sp, color = colors.onSurface)
    val soft = TextStyle(fontSize = 12.sp, color = colors.onSurfaceVariant)
    val root = GlanceModifier.fillMaxSize().cornerRadius(20.dp).background(colors.widgetBackground).padding(14.dp)

    if (!connected) {
        Column(root.clickable(actionStartActivity(openApp(context, connect = true)))) {
            Text("Today", style = title)
            Spacer(GlanceModifier.height(6.dp))
            Text("Open Hotsauce to connect", style = soft)
        }
        return
    }

    val zone = ZoneId.systemDefault()
    val now = Instant.now()
    val today = summary?.takeIf { it.isFor(LocalDate.now(zone)) }
    Column(root) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Today",
                style = title,
                modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(openApp(context, "/today"))),
            )
            today?.weather?.let { w ->
                Text("${weatherEmoji(w.symbol)} ${w.temperature.roundToInt()}°", style = body)
                Spacer(GlanceModifier.width(8.dp))
            }
            Text("↻", style = soft, modifier = GlanceModifier.clickable(actionRunCallback<RefreshAction>()))
        }
        Spacer(GlanceModifier.height(8.dp))
        val meeting = today?.meeting?.takeIf { it.end > now }
        if (meeting != null) {
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(GlanceModifier.defaultWeight().clickable(actionStartActivity(openApp(context, "/meetings")))) {
                    Text(meeting.title, style = body, maxLines = 1)
                    Text(whenLine(meeting.start, meeting.end, now, zone, use24h), style = soft)
                }
                meeting.joinUrl?.let { url ->
                    Text(
                        "Join",
                        style = TextStyle(fontWeight = FontWeight.Bold, fontSize = 14.sp, color = colors.primary),
                        modifier = GlanceModifier.padding(start = 8.dp)
                            .clickable(actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))),
                    )
                }
            }
        } else if (today != null) {
            Text(if (today.calendarConnected) "No more meetings today" else "Calendar not connected", style = soft)
        }
        if (size.width >= TodayWidget.WIDE.width && today != null) {
            Spacer(GlanceModifier.height(8.dp))
            val shown = if (size.height >= TodayWidget.TALL.height) today.tasks else today.tasks.take(2)
            if (shown.isEmpty()) Text("Nothing due today", style = soft)
            shown.forEach { t ->
                Text(
                    "○  ${t.title}",
                    style = body,
                    maxLines = 1,
                    modifier = GlanceModifier.padding(vertical = 2.dp).clickable(actionStartActivity(openApp(context, "/tasks"))),
                )
            }
            val more = today.tasksDue - shown.size
            if (more > 0) Text("+$more more", style = soft)
        }
        if (summary == null) {
            Text("Loading…", style = soft)
        } else if (System.currentTimeMillis() - summary.fetchedAt > STALE_MS) {
            Spacer(GlanceModifier.height(4.dp))
            Text("Updated ${clock(Instant.ofEpochMilli(summary.fetchedAt), zone, use24h)}", style = soft)
        }
    }
}

/** Older than this, the widget says when it last heard from the server (R8). */
private const val STALE_MS = 35 * 60 * 1000L

