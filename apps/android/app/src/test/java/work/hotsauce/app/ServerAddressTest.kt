package work.hotsauce.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import work.hotsauce.app.ServerAddress.Result

/** docs/PLAN-android.md R3. */
class ServerAddressTest {
    private fun ok(input: String) = (ServerAddress.parse(input) as Result.Ok).origin
    private fun refused(input: String) = assertTrue(input, ServerAddress.parse(input) is Result.Problem)

    @Test fun `R3 a bare host gets https`() = assertEquals("https://hotsauce.example.com", ok("hotsauce.example.com"))

    @Test fun `R3 a full address keeps only its origin`() {
        assertEquals("https://hotsauce.example.com", ok("https://Hotsauce.Example.com/today?x=1"))
        assertEquals("https://hotsauce.example.com", ok("  https://hotsauce.example.com/  "))
        assertEquals("https://hotsauce.example.com", ok("https://hotsauce.example.com:443"))
        assertEquals("https://h.example.com:8443", ok("h.example.com:8443"))
    }

    @Test fun `R3 local test servers may use http`() {
        assertEquals("http://10.0.2.2:3000", ok("http://10.0.2.2:3000"))
        assertEquals("http://localhost:3000", ok("http://localhost:3000"))
    }

    @Test fun `R3 anything else is refused with a message`() {
        listOf("", "   ", "http://hotsauce.example.com", "ftp://x.example.com", "hot sauce.com",
            "https://user:pw@x.example.com", "intranet", "javascript:alert(1)", "https://-bad.example.com")
            .forEach(::refused)
    }
}
