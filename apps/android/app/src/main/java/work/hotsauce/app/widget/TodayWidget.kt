package work.hotsauce.app.widget

import android.content.Context
import android.content.Intent
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import work.hotsauce.app.LauncherActivity

/**
 * "Today at a glance" (R8). Slice 0 shows only the not-connected state; the summary from
 * /api/widgets/today arrives in slice 2.
 */
class TodayWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val open = Intent(context, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        provideContent {
            GlanceTheme {
                Column(
                    GlanceModifier.fillMaxSize().cornerRadius(20.dp)
                        .background(GlanceTheme.colors.widgetBackground)
                        .padding(16.dp)
                        .clickable(actionStartActivity(open)),
                ) {
                    Text("Today", style = TextStyle(fontWeight = FontWeight.Bold, color = GlanceTheme.colors.onSurface))
                    Text("Open Hotsauce to connect", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
                }
            }
        }
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}
