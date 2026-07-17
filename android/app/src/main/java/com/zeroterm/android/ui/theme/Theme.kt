package com.zeroterm.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val ZeroBlue = Color(0xFF5B9DFF)
private val ZeroSurface = Color(0xFF0B1220)
private val ZeroSurfaceLight = Color(0xFFF5F7FB)

private val DarkColors = darkColorScheme(
    primary = ZeroBlue,
    onPrimary = Color.White,
    background = ZeroSurface,
    surface = ZeroSurface,
    onBackground = Color(0xFFE8EEF8),
    onSurface = Color(0xFFE8EEF8),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1A5FBF),
    onPrimary = Color.White,
    background = ZeroSurfaceLight,
    surface = Color.White,
    onBackground = Color(0xFF0B1220),
    onSurface = Color(0xFF0B1220),
)

@Composable
fun ZeroTermTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
