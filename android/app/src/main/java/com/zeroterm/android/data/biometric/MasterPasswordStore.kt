package com.zeroterm.android.data.biometric

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Biometric-bound cache for the vault master password.
 *
 * The password is sealed with an AES-256-GCM key that lives in the
 * Android Keystore and is created with `setUserAuthenticationRequired(true)`
 * at BIOMETRIC_STRONG. That is the whole point of the fix for the
 * 2026-07 audit's AND-1: the key can only be *used* — for both
 * encryption at save time and decryption at load time — inside a
 * [BiometricPrompt] `CryptoObject` transaction that the OS unlocks only
 * after a successful strong-biometric scan. Code running as the app
 * (repackaged APK, accessibility abuse, root) can read the ciphertext
 * blob out of SharedPreferences but cannot decrypt it without the user's
 * fingerprint/face, because the Keystore refuses to run the cipher.
 *
 * Contrast with the previous design (EncryptedSharedPreferences under a
 * plain `MasterKey`): there the biometric prompt was pure UI theatre —
 * `load()` decrypted with no authentication at all.
 *
 * Usage:
 *   save: [encryptCipher] → BiometricPrompt(CryptoObject) → [finishSave]
 *   load: [decryptCipher] → BiometricPrompt(CryptoObject) → [finishLoad]
 */
class MasterPasswordStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** True when a sealed password blob is present to unlock. */
    fun hasPassword(): Boolean = prefs.contains(KEY_CIPHERTEXT) && prefs.contains(KEY_IV)

    /**
     * Cipher initialised for encryption under the biometric-bound key.
     * The caller must run it through a [BiometricPrompt] CryptoObject and
     * then hand the authenticated cipher to [finishSave]. Creates the
     * Keystore key on first use.
     */
    fun encryptCipher(): Cipher {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        return cipher
    }

    /**
     * Cipher initialised for decryption of the stored blob, or `null`
     * when there is nothing cached or the key was invalidated (e.g. the
     * user enrolled a new fingerprint — [setInvalidatedByBiometricEnrollment]
     * wipes the key, so an attacker can't add their own biometric to get
     * in). On invalidation the stale blob is cleared.
     */
    fun decryptCipher(): Cipher? {
        val ivB64 = prefs.getString(KEY_IV, null) ?: return null
        val key = try {
            existingKey() ?: return null
        } catch (_: KeyPermanentlyInvalidatedException) {
            clear()
            return null
        }
        return try {
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher
        } catch (_: KeyPermanentlyInvalidatedException) {
            clear()
            null
        }
    }

    /** Encrypt and persist `password` using an authenticated encrypt cipher. */
    fun finishSave(cipher: Cipher, password: String) {
        val ct = cipher.doFinal(password.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(KEY_CIPHERTEXT, Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    /** Decrypt the stored blob with an authenticated decrypt cipher. */
    fun finishLoad(cipher: Cipher): String? {
        val ctB64 = prefs.getString(KEY_CIPHERTEXT, null) ?: return null
        return try {
            val ct = Base64.decode(ctB64, Base64.NO_WRAP)
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: Exception) {
            // Tampered blob / wrong key — treat as no cached password.
            null
        }
    }

    /** Forget the cached password. The Keystore key is left in place. */
    fun clear() {
        prefs.edit().remove(KEY_CIPHERTEXT).remove(KEY_IV).apply()
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? =
        keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun getOrCreateKey(): SecretKey {
        existingKey()?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // A fresh biometric enrollment must NOT be able to unlock an
            // existing cache — invalidate the key so re-caching requires
            // the original credential path.
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Per-use authentication, restricted to STRONG biometrics.
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG,
            )
        } else {
            // Pre-30: -1 means "authenticate on every use" via a
            // CryptoObject-bound prompt (which we require at STRONG).
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        generator.init(builder.build())
        return generator.generateKey()
    }

    companion object {
        private const val PREFS_NAME = "zeroterm_secure_v2"
        private const val KEY_CIPHERTEXT = "master_password_ct"
        private const val KEY_IV = "master_password_iv"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "zeroterm_master_password_key"
        private const val GCM_TAG_BITS = 128
        private const val TRANSFORMATION =
            "${KeyProperties.KEY_ALGORITHM_AES}/${KeyProperties.BLOCK_MODE_GCM}/" +
                KeyProperties.ENCRYPTION_PADDING_NONE
    }
}
