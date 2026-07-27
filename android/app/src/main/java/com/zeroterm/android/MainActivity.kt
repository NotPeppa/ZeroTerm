package com.zeroterm.android

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.view.WindowCompat
import com.zeroterm.android.data.ThemeMode
import com.zeroterm.android.ui.ZeroTermNav
import com.zeroterm.android.ui.theme.ZeroTermTheme

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // AND-2: Block screenshots, screen recording, and the recent-apps
        // thumbnail from capturing sensitive content (master password, private
        // keys, API keys, terminal output). Applied once on the Activity window
        // so it covers every screen (unlock, host edit, AI, sync, terminal).
        // Secure by default — every ZeroTerm screen shows secret material.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        enableEdgeToEdge()
        val app = application as ZeroTermApp
        handleIntent(intent, app)
        setContent {
            val settings by app.container.settings.flow.collectAsState(
                initial = com.zeroterm.android.data.SettingsSnapshot(),
            )
            val dark = when (settings.themeMode) {
                ThemeMode.System -> isSystemInDarkTheme()
                ThemeMode.Dark -> true
                ThemeMode.Light -> false
            }
            SideEffect {
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            ZeroTermTheme(darkTheme = dark) {
                ZeroTermNav(container = app.container)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent, application as ZeroTermApp)
    }

    private fun handleIntent(intent: Intent?, app: ZeroTermApp) {
        if (intent?.action != ACTION_OPEN_ACTIVE_SESSION) return
        // AND-7: MainActivity must stay exported for the LAUNCHER category, so
        // any app can deliver this custom navigation action. Only honor it when
        // it originates from our own process: the intent must carry the internal
        // marker extra we set on the notification PendingIntent, and the launch
        // referrer (when the platform provides one) must be this package.
        // Residual risk: a caller could set Intent.EXTRA_REFERRER to spoof the
        // referrer, but the only effect is navigating to the active-session
        // screen (no sensitive data is exposed), so this proportionate check is
        // sufficient for the Low-severity finding.
        if (!intent.getBooleanExtra(EXTRA_INTERNAL_NAV, false)) return
        val referrerPackage = referrer?.host
        if (referrerPackage != null && referrerPackage != packageName) return
        app.container.requestOpenActiveSession()
    }

    companion object {
        const val ACTION_OPEN_ACTIVE_SESSION = "com.zeroterm.android.OPEN_ACTIVE_SESSION"

        /**
         * Internal marker extra proving [ACTION_OPEN_ACTIVE_SESSION] was raised
         * by our own notification PendingIntent rather than an external app.
         */
        const val EXTRA_INTERNAL_NAV = "com.zeroterm.android.extra.INTERNAL_NAV"
    }
}
