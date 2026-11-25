package work.hotsauce.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.TwaLauncher
import work.hotsauce.app.widget.RefreshWorker

/**
 * The home-screen icon. With a server remembered it opens that server in Chrome with no address
 * bar (a Trusted Web Activity; the server's /.well-known/assetlinks.json vouches for this app).
 * Without one it asks for the address first. The first open, and a tap on a widget that isn't
 * connected, go to /phone/connect so the member can allow the widgets (R5).
 */
class LauncherActivity : Activity() {
    private var launcher: TwaLauncher? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = ServerStore(this)
        val origin = store.origin
        if (origin == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        val connected = TokenVault(this).token != null
        val askToConnect = !connected && (intent?.getBooleanExtra(EXTRA_CONNECT, false) == true || !store.offeredConnect)
        val path = if (askToConnect) {
            store.offeredConnect = true
            "/phone/connect?state=${store.nonce.start()}"
        } else {
            intent?.getStringExtra(EXTRA_PATH)?.takeIf { SAFE_PATH.matches(it) } ?: "/"
        }
        if (connected) RefreshWorker.now(this)
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
        /** Ask to connect the widgets even if the app asked before. */
        const val EXTRA_CONNECT = "connect"
        private val SAFE_PATH = Regex("^/[A-Za-z0-9/_-]*$")
    }
}
