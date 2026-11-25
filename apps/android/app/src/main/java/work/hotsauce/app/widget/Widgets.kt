package work.hotsauce.app.widget

import android.content.Context
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.state.updateAppWidgetState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import work.hotsauce.app.ServerStore
import work.hotsauce.app.TokenVault
import java.time.ZoneId

/** What every Hotsauce widget shares: one stored summary, one redraw. */
object Widgets {
    /** Bumped on each redraw, so a widget whose session is still open reads the stores again. */
    val STAMP = longPreferencesKey("drawn")

    /** Redraws every Hotsauce widget from the stored token and summary. */
    suspend fun redraw(context: Context) {
        val manager = GlanceAppWidgetManager(context)
        val all: List<GlanceAppWidget> = listOf(TodayWidget(), TasksWidget())
        for (widget in all) {
            for (id in manager.getGlanceIds(widget.javaClass)) {
                updateAppWidgetState(context, id) { it[STAMP] = System.currentTimeMillis() }
                widget.update(context, id)
            }
        }
    }
}

/** The refresh mark: fetch now. */
class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        RefreshWorker.now(context)
    }
}

/**
 * Ticking a task off (R14): it leaves the widget at once, the server is told, and a refresh
 * follows, which puts it back if the server refused.
 */
class CompleteTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val space = parameters[SPACE] ?: return
        val id = parameters[ID] ?: return
        val store = SummaryStore(context)
        store.summary?.let { store.summary = it.withoutTask(space, id) }
        Widgets.redraw(context)
        val origin = ServerStore(context).origin
        val vault = TokenVault(context)
        val token = vault.token
        if (origin != null && token != null) {
            val result = withContext(Dispatchers.IO) {
                WidgetApi.completeTask(origin, token, space, id, ZoneId.systemDefault().id)
            }
            if (result == WidgetApi.Result.Disconnected) {
                vault.token = null
                store.summary = null
            }
        }
        RefreshWorker.now(context)
    }

    companion object {
        val SPACE = ActionParameters.Key<String>("space")
        val ID = ActionParameters.Key<String>("id")
    }
}
