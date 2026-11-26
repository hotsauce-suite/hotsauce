package work.hotsauce.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** docs/PLAN-android.md R15: a widget button opens only one of the known quick actions. */
class QuickActionsTest {
    @Test fun `R15 known actions open their address`() {
        assertEquals("/dictate/voice?start=1", QuickActions.pathFor("voice-note"))
        assertEquals("/tasks?new=1", QuickActions.pathFor("new-task"))
    }

    @Test fun `R15 anything else opens nothing`() {
        assertNull(QuickActions.pathFor(null))
        assertNull(QuickActions.pathFor("/settings"))
        assertNull(QuickActions.pathFor("https://evil.example"))
    }
}
