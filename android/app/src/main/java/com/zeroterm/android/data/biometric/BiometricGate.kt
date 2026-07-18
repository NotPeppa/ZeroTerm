package com.zeroterm.android.data.biometric

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Shows BiometricPrompt (fingerprint / face / device credential) and
 * invokes [onSuccess] only after the user authenticates.
 */
object BiometricGate {
    fun canAuthenticate(activity: FragmentActivity): Boolean {
        val mgr = BiometricManager.from(activity)
        val result = mgr.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK,
        )
        return result == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun authenticate(
        activity: FragmentActivity,
        title: String = activity.getString(com.zeroterm.android.R.string.biometric_title),
        subtitle: String = activity.getString(com.zeroterm.android.R.string.biometric_subtitle),
        onSuccess: () -> Unit,
        onError: (String) -> Unit,
        onCancel: () -> Unit = {},
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onSuccess()
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
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_WEAK,
            )
            .build()

        prompt.authenticate(info)
    }
}
