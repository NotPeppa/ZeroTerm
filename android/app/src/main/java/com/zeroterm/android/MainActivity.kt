package com.zeroterm.android

import android.content.Intent
import android.os.Bundle
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
        if (intent?.action == ACTION_OPEN_ACTIVE_SESSION) {
            app.container.requestOpenActiveSession()
        }
    }

    companion object {
        const val ACTION_OPEN_ACTIVE_SESSION = "com.zeroterm.android.OPEN_ACTIVE_SESSION"
    }
}
