package com.zeroterm.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val BrandBlue = Color(0xFF3B82F6)
private val BrandBlueDark = Color(0xFF8AB4FF)
private val BrandCyan = Color(0xFF22D3EE)

private val DarkColors = darkColorScheme(
    primary = BrandBlueDark,
    onPrimary = Color(0xFF002E69),
    primaryContainer = Color(0xFF123B70),
    onPrimaryContainer = Color(0xFFD8E7FF),
    secondary = BrandCyan,
    onSecondary = Color(0xFF00363D),
    secondaryContainer = Color(0xFF064E5A),
    onSecondaryContainer = Color(0xFFB8F4FF),
    background = Color(0xFF07111F),
    onBackground = Color(0xFFE5EDF8),
    surface = Color(0xFF0C1828),
    onSurface = Color(0xFFE5EDF8),
    surfaceVariant = Color(0xFF17263A),
    onSurfaceVariant = Color(0xFFB8C6D9),
    surfaceContainerLowest = Color(0xFF06101D),
    surfaceContainerLow = Color(0xFF0A1625),
    surfaceContainer = Color(0xFF0F1C2D),
    surfaceContainerHigh = Color(0xFF152338),
    surfaceContainerHighest = Color(0xFF1B2A40),
    outline = Color(0xFF51647D),
    outlineVariant = Color(0xFF293A51),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF7D2B2B),
    onErrorContainer = Color(0xFFFFDAD6),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF175EBC),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD8E7FF),
    onPrimaryContainer = Color(0xFF001B3F),
    secondary = Color(0xFF006879),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFAAEDFA),
    onSecondaryContainer = Color(0xFF001F25),
    background = Color(0xFFF4F7FC),
    onBackground = Color(0xFF142033),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF142033),
    surfaceVariant = Color(0xFFE5ECF5),
    onSurfaceVariant = Color(0xFF45566D),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF8FAFD),
    surfaceContainer = Color(0xFFF0F4F9),
    surfaceContainerHigh = Color(0xFFE9EEF5),
    surfaceContainerHighest = Color(0xFFE1E8F1),
    outline = Color(0xFF718198),
    outlineVariant = Color(0xFFC5D0DF),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val ZeroShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val ZeroTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 32.sp,
        lineHeight = 40.sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 32.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 18.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
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
        typography = ZeroTypography,
        shapes = ZeroShapes,
        content = content,
    )
}
