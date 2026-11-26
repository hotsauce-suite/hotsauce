package work.hotsauce.app

/**
 * The quick actions the Capture and Voice note widgets open (docs/PLAN-android.md R15): the same
 * list, in the same order, as the web app's (apps/web/src/lib/phoneShortcuts.ts, which checks
 * this copy in phoneShortcuts.test.ts).
 */
data class QuickAction(val id: String, val label: String, val path: String)

object QuickActions {
    val all = listOf(
        QuickAction("voice-note", "Voice note", "/dictate/voice?start=1"),
        QuickAction("new-task", "New task", "/tasks?new=1"),
        QuickAction("save-link", "Save link", "/links/save?paste=1"),
        QuickAction("ask", "Ask", "/today?ask=1"),
        QuickAction("ramble", "Ramble", "/tasks?ramble=1"),
    )

    /** The address for an action's id, or null for one we don't know (never a caller's own path). */
    fun pathFor(id: String?): String? = all.firstOrNull { it.id == id }?.path
}
