package work.hotsauce.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.TwaLauncher

/**
 * The home-screen icon. With a server remembered it opens that server in Chrome with no address
 * bar (a Trusted Web Activity; the server's /.well-known/assetlinks.json vouches for this app).
 * Without one it asks for the address first.
 */
class LauncherActivity : Activity() {
    private var launcher: TwaLauncher? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val origin = ServerStore(this).origin
        if (origin == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        val path = intent?.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") } ?: "/"
        launcher = TwaLauncher(this).also { it.launch(Uri.parse(origin + path)) }
    }

    override fun onRestart() {
        super.onRestart()
        // Back from Chrome: the shell has nothing of its own to show.
        finish()
    }

    override fun onDestroy() {
        launcher?.destroy()
        super.onDestroy()
    }

    companion object {
        /** A path on the server to open instead of the start page, such as /tasks. */
        const val EXTRA_PATH = "path"
    }
}
