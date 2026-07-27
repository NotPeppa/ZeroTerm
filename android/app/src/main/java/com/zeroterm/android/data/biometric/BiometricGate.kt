package com.zeroterm.android.data.biometric

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Shows BiometricPrompt at BIOMETRIC_STRONG and, on success, hands back
 * the authenticated [BiometricPrompt.CryptoObject].
 *
 * STRONG (Class 3) is required because the cached master password is
 * sealed with a Keystore key created for `AUTH_BIOMETRIC_STRONG`; a WEAK
 * prompt can't unlock that key, and — more importantly — WEAK biometrics
 * aren't bound to Keystore at all, which is what made the old gate
 * bypassable (AND-1).
 */
object BiometricGate {
    private const val STRONG = BiometricManager.Authenticators.BIOMETRIC_STRONG

    fun canAuthenticate(activity: FragmentActivity): Boolean {
        val mgr = BiometricManager.from(activity)
        return mgr.canAuthenticate(STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }

    /**
     * Run a strong-biometric prompt bound to [cryptoObject]. [onSuccess]
     * receives the authenticated CryptoObject whose cipher is now
     * unlocked for a single `doFinal`.
     */
    fun authenticate(
        activity: FragmentActivity,
        cryptoObject: BiometricPrompt.CryptoObject,
        title: String = activity.getString(com.zeroterm.android.R.string.biometric_title),
        subtitle: String = activity.getString(com.zeroterm.android.R.string.biometric_subtitle),
        onSuccess: (BiometricPrompt.CryptoObject) -> Unit,
        onError: (String) -> Unit,
        onCancel: () -> Unit = {},
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val crypto = result.cryptoObject
                    if (crypto == null) {
                        // Should not happen for a CryptoObject prompt, but
                        // never fall back to an unauthenticated path.
                        onError("biometric result missing crypto object")
                    } else {
                        onSuccess(crypto)
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                        errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                        errorCode == BiometricPrompt.ERROR_CANCELED
                    ) {
                        onCancel()
                    } else {
                        onError(errString.toString())
                    }
                }

                override fun onAuthenticationFailed() {
                    // Keep prompt open; no action
                }
            },
        )

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            // Passive face authentication may otherwise show a second
            // confirmation button after a successful scan.
            .setConfirmationRequired(false)
            .setNegativeButtonText(activity.getString(com.zeroterm.android.R.string.common_cancel))
            .setAllowedAuthenticators(STRONG)
            .build()

        prompt.authenticate(info, cryptoObject)
    }
}
