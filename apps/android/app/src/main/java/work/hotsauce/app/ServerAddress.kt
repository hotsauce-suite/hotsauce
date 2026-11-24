package work.hotsauce.app

import java.net.URI

/**
 * What the member typed as their Hotsauce server's address, checked and reduced to an origin
 * like `https://hotsauce.example.com` (docs/PLAN-android.md R3). A bare host gets https; a path,
 * query or trailing slash is dropped; plain http is refused except for this phone's own test
 * servers (localhost and the emulator's 10.0.2.2), which the shell never opens full screen anyway.
 */
object ServerAddress {
    sealed interface Result {
        data class Ok(val origin: String) : Result
        data class Problem(val message: String) : Result
    }

    private val hostPattern = Regex("^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
    private val localHosts = setOf("localhost", "10.0.2.2", "127.0.0.1")

    fun parse(input: String): Result {
        val text = input.trim()
        if (text.isEmpty()) return Result.Problem("Type your Hotsauce address, like hotsauce.example.com")
        if (text.any { it.isWhitespace() }) return Result.Problem("An address has no spaces in it")
        val withScheme = if ("://" in text) text else "https://$text"
        val uri = try {
            URI(withScheme)
        } catch (_: Exception) {
            return Result.Problem("That doesn't look like a web address")
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase() ?: return Result.Problem("That doesn't look like a web address")
        if (uri.userInfo != null) return Result.Problem("Leave out the name and password; just the address")
        if (!hostPattern.matches(host)) return Result.Problem("That doesn't look like a web address")
        val local = host in localHosts
        when (scheme) {
            "https" -> {}
            "http" -> if (!local) return Result.Problem("Hotsauce needs a secure address that starts with https://")
            else -> return Result.Problem("That doesn't look like a web address")
        }
        if (!local && '.' !in host) return Result.Problem("Type the whole address, like hotsauce.example.com")
        val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443)) "" else ":${uri.port}"
        return Result.Ok("$scheme://$host$port")
    }
}
