package work.hotsauce.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import android.security.keystore.KeyPermanentlyInvalidatedException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone's device token (docs/PLAN-android.md R11), sealed with an Android Keystore key that
 * never leaves the phone's secure hardware. Clearing the app's data removes both.
 */
class TokenVault(context: Context) {
    private val prefs = context.getSharedPreferences("hotsauce_vault", Context.MODE_PRIVATE)

    var token: String?
        get() {
            val sealed = prefs.getString(KEY_TOKEN, null) ?: return null
            return try {
                val bytes = Base64.decode(sealed, Base64.NO_WRAP)
                val cipher = Cipher.getInstance(TRANSFORM)
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
                String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
            } catch (e: Exception) {
                // A key lost to a restore on another phone, or a token sealed by another key: it
                // can never be read again, so connect again. Anything else may pass: keep it.
                if (e is AEADBadTagException || e is KeyPermanentlyInvalidatedException ||
                    e is IllegalArgumentException
                ) {
                    prefs.edit().remove(KEY_TOKEN).apply()
                }
                null
            }
        }
        set(value) {
            if (value == null) {
                prefs.edit().remove(KEY_TOKEN).apply()
                return
            }
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            prefs.edit().putString(KEY_TOKEN, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
        }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ALIAS = "hotsauce-device-token"
        const val KEY_TOKEN = "token"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
