package work.hotsauce.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import work.hotsauce.app.QuickActions

/**
 * "Quick capture" (docs/PLAN-android.md R15): a bar of the quick actions, each opening the app
 * straight into it. Two when narrow, four when wide.
 */
class CaptureWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(NARROW, WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { GlanceTheme { CaptureBar() } }
    }

    companion object {
        val NARROW = DpSize(110.dp, 50.dp)
        val WIDE = DpSize(250.dp, 50.dp)
    }
}

class CaptureWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CaptureWidget()
}

private val GLYPH = mapOf("voice-note" to "🎙", "new-task" to "✓", "save-link" to "🔗", "ask" to "✦", "ramble" to "≋")

@Composable
private fun CaptureBar() {
    val context = LocalContext.current
    val colors = GlanceTheme.colors
    val wide = LocalSize.current.width >= CaptureWidget.WIDE.width
    val shown = QuickActions.all.take(if (wide) 4 else 2)
    Row(
        GlanceModifier.fillMaxSize().cornerRadius(24.dp).background(colors.widgetBackground).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        shown.forEach { a ->
            Box(
                GlanceModifier.defaultWeight().fillMaxHeight().padding(4.dp).cornerRadius(18.dp)
                    .background(colors.secondaryContainer)
                    .clickable(actionStartActivity(openApp(context, action = a.id))),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "${GLYPH[a.id] ?: ""} ${a.label}",
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium, color = colors.onSecondaryContainer),
                    maxLines = 1,
                )
            }
        }
    }
}

/** "Voice note" (R15): one tap to start recording, as the held icon's first shortcut does. */
class VoiceNoteWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Single

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { GlanceTheme { VoiceButton() } }
    }
}

class VoiceNoteWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = VoiceNoteWidget()
}

@Composable
private fun VoiceButton() {
    val context = LocalContext.current
    val colors = GlanceTheme.colors
    Column(
        GlanceModifier.fillMaxSize().cornerRadius(28.dp).background(colors.primary)
            .clickable(actionStartActivity(openApp(context, action = "voice-note"))),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("🎙", style = TextStyle(fontSize = 28.sp, textAlign = TextAlign.Center))
        Spacer(GlanceModifier.height(2.dp))
        Text(
            "Voice note",
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, color = colors.onPrimary),
            maxLines = 1,
        )
    }
}
