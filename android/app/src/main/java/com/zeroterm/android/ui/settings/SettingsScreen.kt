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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zeroterm.android.BuildConfig
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.ThemeMode
import kotlinx.coroutines.launch
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
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
            Text("Appearance", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text("Theme", style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(4.dp))
            Row {
                ThemeMode.entries.forEach { mode ->
                    FilterChip(
                        selected = snap.themeMode == mode,
                        onClick = { scope.launch { settings.setThemeMode(mode) } },
                        label = { Text(mode.name) },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                }
            }

            Spacer(Modifier.height(24.dp))
            Text("Terminal", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Font size", modifier = Modifier.weight(1f))
                Text("${snap.fontSizeSp.roundToInt()} sp")
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
                "Pinch on the terminal to zoom; this is the default size for new sessions.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )

            Spacer(Modifier.height(24.dp))
            Text("Sync", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Auto-sync in foreground")
                    Text(
                        "While unlocked, sync all profiles periodically.",
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
                    Text("Interval", modifier = Modifier.weight(1f))
                    Text("${snap.autoSyncIntervalMin} min")
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
            Text("About", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text("ZeroTerm Android", style = MaterialTheme.typography.bodyLarge)
            Text(
                "v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            Text(
                "Zero telemetry. Vault crypto and SSH live in Rust (core).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
