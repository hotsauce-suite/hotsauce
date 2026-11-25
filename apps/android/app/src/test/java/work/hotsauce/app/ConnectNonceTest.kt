package work.hotsauce.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/PLAN-android.md R5: only our own, fresh nonce, once. */
class ConnectNonceTest {
    private var saved: Pair<String, Long>? = null
    private var clock = 1_000_000L
    private val nonce = ConnectNonce({ saved }, { saved = it }, { clock })

    @Test fun `R5 the nonce we sent is taken once`() {
        val n = nonce.start()
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(n))
        assertTrue(nonce.take(n))
        assertFalse(nonce.take(n))
    }

    @Test fun `R5 another nonce or none is refused, and spends ours`() {
        val n = nonce.start()
        assertFalse(nonce.take("x".repeat(n.length)))
        assertFalse(nonce.take(n))
        nonce.start()
        assertFalse(nonce.take(null))
    }

    @Test fun `R5 a nonce older than ten minutes is refused`() {
        val n = nonce.start()
        clock += ConnectNonce.TEN_MINUTES + 1
        assertFalse(nonce.take(n))
    }
}
