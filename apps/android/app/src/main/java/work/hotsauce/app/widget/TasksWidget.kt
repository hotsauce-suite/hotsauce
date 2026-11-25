package work.hotsauce.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
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
import work.hotsauce.app.TokenVault
import java.time.LocalDate
import java.time.ZoneId

/** "Tasks" (docs/PLAN-android.md R14): what's due today or overdue, each with a tick. */
class TasksWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, TALL))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val connected = remember(stamp) { TokenVault(context).token != null }
            val summary = remember(stamp) { if (connected) SummaryStore(context).summary else null }
            GlanceTheme { TasksBody(connected, summary) }
        }
    }

    companion object {
        val SMALL = DpSize(180.dp, 110.dp)
        val TALL = DpSize(180.dp, 220.dp)
    }
}

class TasksWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TasksWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedule(context)
        RefreshWorker.now(context)
    }
}

@Composable
private fun TasksBody(connected: Boolean, summary: TodaySummary?) {
    val context = LocalContext.current
    val size = LocalSize.current
    val colors = GlanceTheme.colors
    val title = TextStyle(fontWeight = FontWeight.Bold, fontSize = 15.sp, color = colors.onSurface)
    val body = TextStyle(fontSize = 14.sp, color = colors.onSurface)
    val soft = TextStyle(fontSize = 12.sp, color = colors.onSurfaceVariant)
    val tick = TextStyle(fontSize = 18.sp, color = colors.primary)
    val root = GlanceModifier.fillMaxSize().cornerRadius(20.dp).background(colors.widgetBackground).padding(14.dp)

    if (!connected) {
        Column(root.clickable(actionStartActivity(openApp(context, connect = true)))) {
            Text("Tasks", style = title)
            Spacer(GlanceModifier.height(6.dp))
            Text("Open Hotsauce to connect", style = soft)
        }
        return
    }
    val today = summary?.takeIf { it.isFor(LocalDate.now(ZoneId.systemDefault())) }
    Column(root) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (today != null && today.tasksDue > 0) "Tasks · ${today.tasksDue}" else "Tasks",
                style = title,
                modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(openApp(context, "/tasks"))),
            )
            Text("↻", style = soft, modifier = GlanceModifier.clickable(actionRunCallback<RefreshAction>()))
        }
        Spacer(GlanceModifier.height(6.dp))
        when {
            summary == null -> Text("Loading…", style = soft)
            today == null || today.tasks.isEmpty() -> Text("Nothing due today", style = soft)
            else -> {
                val shown = today.tasks.take(if (size.height >= TasksWidget.TALL.height) 6 else 2)
                shown.forEach { t ->
                    Row(GlanceModifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "○",
                            style = tick,
                            modifier = GlanceModifier.clickable(
                                actionRunCallback<CompleteTaskAction>(
                                    actionParametersOf(CompleteTaskAction.SPACE to t.space, CompleteTaskAction.ID to t.id),
                                ),
                            ),
                        )
                        Spacer(GlanceModifier.width(10.dp))
                        Text(
                            t.title,
                            style = body,
                            maxLines = 1,
                            modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(openApp(context, "/tasks"))),
                        )
                    }
                }
                val more = today.tasksDue - shown.size
                if (more > 0) Text("+$more more", style = soft)
            }
        }
    }
}
