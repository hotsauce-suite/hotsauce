package work.hotsauce.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import work.hotsauce.app.widget.RefreshWorker
import work.hotsauce.app.widget.SummaryStore
import work.hotsauce.app.widget.WidgetApi

/** First open: which Hotsauce server is yours? (R3) */
class SetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            HotsauceTheme {
                SetupScreen(initial = ServerStore(this).origin ?: "") { origin ->
                    val store = ServerStore(this)
                    val old = store.origin
                    if (old != origin) {
                        // A token is only good on the server that made it: tell that server the
                        // phone is gone, forget the token and its data, and redraw the widget.
                        val vault = TokenVault(this)
                        val token = vault.token
                        if (old != null && token != null) {
                            Thread { WidgetApi.disconnect(old, token) }.start()
                        }
                        vault.token = null
                        SummaryStore(this).summary = null
                        store.offeredConnect = false
                        RefreshWorker.now(this)
                    }
                    store.origin = origin
                    startActivity(Intent(this, LauncherActivity::class.java))
                    finish()
                }
            }
        }
    }
}

@Composable
private fun SetupScreen(initial: String, onDone: (String) -> Unit) {
    var text by remember { mutableStateOf(initial.removePrefix("https://")) }
    var problem by remember { mutableStateOf<String?>(null) }
    fun submit() {
        when (val r = ServerAddress.parse(text)) {
            is ServerAddress.Result.Ok -> onDone(r.origin)
            is ServerAddress.Result.Problem -> problem = r.message
        }
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.safeDrawingPadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Hotsauce", style = MaterialTheme.typography.headlineLarge)
            Text("What's your Hotsauce address? It's the one you open in your browser.")
            OutlinedTextField(
                value = text,
                onValueChange = { text = it; problem = null },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Address") },
                placeholder = { Text("hotsauce.example.com") },
                isError = problem != null,
                supportingText = { problem?.let { Text(it) } },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { submit() }),
            )
            Button(onClick = { submit() }, modifier = Modifier.fillMaxWidth()) { Text("Continue") }
        }
    }
}

private val Chili = Color(0xFFC2361F)

@Composable
fun HotsauceTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFFF7A5F)) else lightColorScheme(primary = Chili)
    MaterialTheme(colorScheme = scheme, content = content)
}
