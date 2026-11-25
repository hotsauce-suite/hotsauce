package work.hotsauce.app.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import work.hotsauce.app.ServerStore
import work.hotsauce.app.TokenVault
import java.util.concurrent.TimeUnit

/** The last summary this phone fetched, so the widget always has something to show (R8). */
class SummaryStore(context: Context) {
    private val prefs = context.getSharedPreferences("hotsauce_widget", Context.MODE_PRIVATE)
    var summary: TodaySummary?
        get() = prefs.getString(KEY, null)?.let { TodaySummary.parse(it) }
        set(value) = prefs.edit().apply { if (value == null) remove(KEY) else putString(KEY, value.toJson()) }.apply()
    private companion object { const val KEY = "today" }
}

/** Fetches the summary and redraws every Hotsauce widget. */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val origin = ServerStore(ctx).origin
        val vault = TokenVault(ctx)
        val token = vault.token
        if (origin != null && token != null) {
            when (val r = WidgetApi.fetchToday(origin, token)) {
                is WidgetApi.Result.Ok -> SummaryStore(ctx).summary = r.summary
                WidgetApi.Result.Disconnected -> {
                    vault.token = null
                    SummaryStore(ctx).summary = null
                }
                is WidgetApi.Result.Failed -> {} // keep the last good summary (R8)
            }
        }
        Widgets.redraw(ctx)
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "hotsauce-widgets"
        private const val NOW = "hotsauce-widgets-now"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** About every 15 minutes, Android's floor for background work (R8). */
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }

        /** Right away: on connect, when the app opens, or on the widget's refresh mark. */
        fun now(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                NOW,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<RefreshWorker>().build(),
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }
    }
}
