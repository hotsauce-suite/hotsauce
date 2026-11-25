package work.hotsauce.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import work.hotsauce.app.widget.RefreshWorker

/**
 * Where /phone/connect sends the member back (docs/PLAN-android.md R5): the nonce we sent, and
 * the new token or "not now". A nonce that isn't ours, or older than ten minutes, is ignored.
 */
class ConnectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = ServerStore(this)
        val state = intent?.getStringExtra("state")
        val token = intent?.getStringExtra("token")
        val declined = intent?.getStringExtra("declined") == "1"
        if (store.nonce.take(state)) {
            if (!declined && token != null && TOKEN.matches(token)) {
                TokenVault(this).token = token
                RefreshWorker.schedule(this)
                RefreshWorker.now(this)
                Toast.makeText(this, "Connected. Add a Hotsauce widget from your home screen.", Toast.LENGTH_LONG).show()
            }
        }
        startActivity(
            Intent(this, LauncherActivity::class.java)
                .putExtra(LauncherActivity.EXTRA_PATH, "/today")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
    }

    private companion object {
        val TOKEN = Regex("^hpt_[A-Za-z0-9_-]{20,200}$")
    }
}
