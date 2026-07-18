package com.zeroterm.android.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.zeroterm.android.BuildConfig
import com.zeroterm.android.R
import com.zeroterm.android.data.AppLocale
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.ThemeMode
import kotlinx.coroutines.launch
import com.zeroterm.android.ui.components.ZeroTopBar
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    settings: AppSettings,
    onBack: () -> Unit,
) {
    val snap by settings.flow.collectAsState(
        initial = com.zeroterm.android.data.SettingsSnapshot(),
    )
    val scope = rememberCoroutineScope()

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = stringResource(R.string.settings_title),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(stringResource(R.string.settings_appearance), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.settings_theme), style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(4.dp))
            Row {
                ThemeMode.entries.forEach { mode ->
                    FilterChip(
                        selected = snap.themeMode == mode,
                        onClick = { scope.launch { settings.setThemeMode(mode) } },
                        label = { Text(themeModeLabel(mode)) },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.settings_language), style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(4.dp))
            Row {
                AppLocale.entries.forEach { locale ->
                    FilterChip(
                        selected = snap.locale == locale,
                        onClick = { scope.launch { settings.setLocale(locale) } },
                        label = { Text(localeLabel(locale)) },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                }
            }

            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.settings_terminal), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings_font_size), modifier = Modifier.weight(1f))
                Text(
                    stringResource(
                        R.string.settings_font_size_value,
                        snap.fontSizeSp.roundToInt(),
                    ),
                )
            }
            Slider(
                value = snap.fontSizeSp,
                onValueChange = { v ->
                    scope.launch { settings.setFontSize(v) }
                },
                valueRange = AppSettings.MIN_FONT..AppSettings.MAX_FONT,
                steps = (AppSettings.MAX_FONT - AppSettings.MIN_FONT).toInt() - 1,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                stringResource(R.string.settings_font_help),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )

            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.settings_sync), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.settings_auto_sync))
                    Text(
                        stringResource(R.string.settings_auto_sync_help),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
                Switch(
                    checked = snap.autoSync,
                    onCheckedChange = { scope.launch { settings.setAutoSync(it) } },
                )
            }
            if (snap.autoSync) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.settings_interval), modifier = Modifier.weight(1f))
                    Text(
                        stringResource(
                            R.string.settings_interval_value,
                            snap.autoSyncIntervalMin,
                        ),
                    )
                }
                Slider(
                    value = snap.autoSyncIntervalMin.toFloat(),
                    onValueChange = { v ->
                        scope.launch { settings.setAutoSyncIntervalMin(v.roundToInt()) }
                    },
                    valueRange = AppSettings.MIN_INTERVAL.toFloat()..AppSettings.MAX_INTERVAL.toFloat(),
                    steps = AppSettings.MAX_INTERVAL - AppSettings.MIN_INTERVAL - 1,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(32.dp))
            Text(stringResource(R.string.settings_about), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.settings_about_title), style = MaterialTheme.typography.bodyLarge)
            Text(
                stringResource(
                    R.string.settings_about_version,
                    BuildConfig.VERSION_NAME,
                    BuildConfig.VERSION_CODE,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            Text(
                stringResource(R.string.settings_about_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun themeModeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.System -> stringResource(R.string.settings_theme_system)
    ThemeMode.Dark -> stringResource(R.string.settings_theme_dark)
    ThemeMode.Light -> stringResource(R.string.settings_theme_light)
}

@Composable
private fun localeLabel(locale: AppLocale): String = when (locale) {
    AppLocale.System -> stringResource(R.string.settings_language_system)
    AppLocale.English -> stringResource(R.string.settings_language_en)
    AppLocale.ChineseSimplified -> stringResource(R.string.settings_language_zh_cn)
}
