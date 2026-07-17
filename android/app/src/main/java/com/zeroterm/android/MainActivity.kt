package com.zeroterm.android

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import com.zeroterm.android.data.ThemeMode
import com.zeroterm.android.ui.ZeroTermNav
import com.zeroterm.android.ui.theme.ZeroTermTheme

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as ZeroTermApp
        setContent {
            val settings by app.container.settings.flow.collectAsState(
                initial = com.zeroterm.android.data.SettingsSnapshot(),
            )
            val dark = when (settings.themeMode) {
                ThemeMode.System -> isSystemInDarkTheme()
                ThemeMode.Dark -> true
                ThemeMode.Light -> false
            }
            ZeroTermTheme(darkTheme = dark) {
                ZeroTermNav(container = app.container)
            }
        }
    }
}
