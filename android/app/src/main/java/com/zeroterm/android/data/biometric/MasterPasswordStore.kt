package com.zeroterm.android.data.biometric

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Keystore-encrypted cache for the vault master password.
 * Gate reads with [BiometricGate] before calling [load].
 */
class MasterPasswordStore(context: Context) {
    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun hasPassword(): Boolean = prefs.contains(KEY_PASSWORD)

    fun save(password: String) {
        prefs.edit().putString(KEY_PASSWORD, password).apply()
    }

    fun load(): String? = prefs.getString(KEY_PASSWORD, null)

    fun clear() {
        prefs.edit().remove(KEY_PASSWORD).apply()
    }

    companion object {
        private const val PREFS_NAME = "zeroterm_secure"
        private const val KEY_PASSWORD = "master_password"
    }
}
