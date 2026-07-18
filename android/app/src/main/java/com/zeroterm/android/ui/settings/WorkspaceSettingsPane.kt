package com.zeroterm.android.ui.settings

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Public
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.zeroterm.android.BuildConfig
import com.zeroterm.android.R
import com.zeroterm.android.data.AppLocale
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.SettingsSnapshot
import com.zeroterm.android.data.ThemeMode
import com.zeroterm.android.ui.components.ZeroSectionCard
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.ZeroTerm
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

enum class WorkspaceSettingsPage { General, Terminal, About }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceSettingsPane(
    settings: AppSettings,
    zeroTerm: ZeroTerm,
    page: WorkspaceSettingsPage,
    onOpenNavigation: () -> Unit,
) {
    val context = LocalContext.current
    val powerManager = context.getSystemService(PowerManager::class.java)
    val isFlyme = remember {
        Build.MANUFACTURER.equals("Meizu", ignoreCase = true) ||
            Build.BRAND.equals("Meizu", ignoreCase = true)
    }
    var batteryOptimizationIgnored by remember {
        mutableStateOf(powerManager.isIgnoringBatteryOptimizations(context.packageName))
    }
    LifecycleResumeEffect(context, powerManager) {
        batteryOptimizationIgnored =
            powerManager.isIgnoringBatteryOptimizations(context.packageName)
        onPauseOrDispose { }
    }
    val snap by settings.flow.collectAsState(initial = SettingsSnapshot())
    val scope = rememberCoroutineScope()
    var backgroundBusy by remember { mutableStateOf(false) }
    var backgroundError by remember { mutableStateOf<String?>(null) }
    var proxyDraft by remember { mutableStateOf("") }
    var proxyError by remember { mutableStateOf<String?>(null) }
    var proxyBusy by remember { mutableStateOf(false) }
    LaunchedEffect(snap.proxyUrl) { proxyDraft = snap.proxyUrl }
    val backgroundPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            scope.launch {
                backgroundBusy = true
                backgroundError = null
                runCatching { settings.setBackgroundImage(uri) }
                    .onFailure { backgroundError = it.message }
                backgroundBusy = false
            }
        }
    }
    val title = when (page) {
        WorkspaceSettingsPage.General -> stringResource(R.string.settings_general)
        WorkspaceSettingsPage.Terminal -> stringResource(R.string.settings_terminal)
        WorkspaceSettingsPage.About -> stringResource(R.string.settings_about)
    }
    val contextStringProxyRequired = stringResource(R.string.settings_proxy_required)

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = title,
                navigationIcon = {
                    IconButton(onClick = onOpenNavigation) {
                        Icon(
                            Icons.Default.Menu,
                            contentDescription = stringResource(R.string.common_menu),
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
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (page) {
                WorkspaceSettingsPage.General -> {
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_appearance),
                        translucent = true,
                    ) {
                        Text(
                            stringResource(R.string.settings_theme),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        Row(Modifier.fillMaxWidth()) {
                            ThemeMode.entries.forEach { mode ->
                                FilterChip(
                                    selected = snap.themeMode == mode,
                                    onClick = { scope.launch { settings.setThemeMode(mode) } },
                                    label = { Text(workspaceThemeLabel(mode)) },
                                    modifier = Modifier.padding(end = 6.dp),
                                )
                            }
                        }
                        Text(
                            stringResource(R.string.settings_language),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        Row(Modifier.fillMaxWidth()) {
                            AppLocale.entries.forEach { locale ->
                                FilterChip(
                                    selected = snap.locale == locale,
                                    onClick = { scope.launch { settings.setLocale(locale) } },
                                    label = { Text(workspaceLocaleLabel(locale)) },
                                    modifier = Modifier.padding(end = 6.dp),
                                )
                            }
                        }
                    }
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_chrome_title),
                        translucent = true,
                    ) {
                        Text(
                            stringResource(R.string.settings_chrome_help),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            stringResource(
                                R.string.settings_top_bar_transparency_value,
                                (snap.topBarTransparency * 100).roundToInt(),
                            ),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        Slider(
                            value = snap.topBarTransparency,
                            onValueChange = { scope.launch { settings.setTopBarTransparency(it) } },
                            valueRange = 0f..0.8f,
                            steps = 15,
                        )
                        Text(
                            stringResource(
                                R.string.settings_drawer_transparency_value,
                                (snap.drawerTransparency * 100).roundToInt(),
                            ),
                            style = MaterialTheme.typography.labelLarge,
                        )
                        Slider(
                            value = snap.drawerTransparency,
                            onValueChange = { scope.launch { settings.setDrawerTransparency(it) } },
                            valueRange = 0f..0.8f,
                            steps = 15,
                        )
                    }
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_background_title),
                        translucent = true,
                    ) {
                        Text(
                            stringResource(R.string.settings_background_help),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        BackgroundPreview(
                            path = snap.backgroundImagePath,
                            opacity = snap.backgroundOpacity,
                            blurDp = snap.backgroundBlurDp,
                        )
                        backgroundError?.let {
                            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = { backgroundPicker.launch("image/*") },
                                enabled = !backgroundBusy,
                            ) {
                                if (backgroundBusy) {
                                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                } else {
                                    Icon(Icons.Default.Image, null)
                                }
                                Spacer(Modifier.size(8.dp))
                                Text(stringResource(R.string.settings_background_choose))
                            }
                            if (snap.backgroundImagePath.isNotBlank()) {
                                OutlinedButton(
                                    onClick = { scope.launch { settings.clearBackgroundImage() } },
                                    enabled = !backgroundBusy,
                                ) {
                                    Icon(Icons.Default.Delete, null)
                                    Spacer(Modifier.size(8.dp))
                                    Text(stringResource(R.string.settings_background_remove))
                                }
                            }
                        }
                        if (snap.backgroundImagePath.isNotBlank()) {
                            HorizontalDivider()
                            Text(
                                stringResource(R.string.settings_background_opacity_value, (snap.backgroundOpacity * 100).toInt()),
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Slider(
                                value = snap.backgroundOpacity,
                                onValueChange = { scope.launch { settings.setBackgroundOpacity(it) } },
                                valueRange = 0.05f..1f,
                                steps = 18,
                            )
                            Text(
                                stringResource(R.string.settings_background_blur_value, snap.backgroundBlurDp),
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Slider(
                                value = snap.backgroundBlurDp.toFloat(),
                                onValueChange = { scope.launch { settings.setBackgroundBlurDp(it.roundToInt()) } },
                                valueRange = 0f..30f,
                                steps = 29,
                            )
                        }
                    }
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_proxy_title),
                        translucent = true,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Default.Public,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(end = 12.dp),
                            )
                            Column(Modifier.weight(1f)) {
                                Text(
                                    if (snap.proxyEnabled) stringResource(R.string.settings_proxy_enabled)
                                    else stringResource(R.string.settings_proxy_disabled),
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                Text(
                                    stringResource(R.string.settings_proxy_help),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Switch(
                                checked = snap.proxyEnabled,
                                enabled = !proxyBusy,
                                onCheckedChange = { enabled ->
                                    scope.launch {
                                        proxyError = null
                                        proxyBusy = true
                                        if (!enabled) {
                                            runCatching { zeroTerm.setNetworkProxy("") }
                                            settings.setProxy(false, proxyDraft)
                                        } else if (proxyDraft.isBlank()) {
                                            proxyError = contextStringProxyRequired
                                        } else {
                                            runCatching { zeroTerm.setNetworkProxy(proxyDraft) }
                                                .onSuccess { normalized ->
                                                    proxyDraft = normalized
                                                    settings.setProxy(true, normalized)
                                                }
                                                .onFailure { proxyError = it.message }
                                        }
                                        proxyBusy = false
                                    }
                                },
                            )
                        }
                        OutlinedTextField(
                            value = proxyDraft,
                            onValueChange = { proxyDraft = it; proxyError = null },
                            label = { Text(stringResource(R.string.settings_proxy_url)) },
                            placeholder = { Text("http://127.0.0.1:7890") },
                            supportingText = { Text(stringResource(R.string.settings_proxy_url_help)) },
                            isError = proxyError != null,
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        proxyError?.let {
                            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                enabled = !proxyBusy && proxyDraft.isNotBlank(),
                                onClick = {
                                    scope.launch {
                                        proxyBusy = true
                                        proxyError = null
                                        runCatching { zeroTerm.setNetworkProxy(proxyDraft) }
                                            .onSuccess { normalized ->
                                                proxyDraft = normalized
                                                settings.setProxy(true, normalized)
                                            }
                                            .onFailure { proxyError = it.message }
                                        proxyBusy = false
                                    }
                                },
                            ) {
                                if (proxyBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                else Text(stringResource(R.string.common_save))
                            }
                            if (proxyDraft.isNotBlank()) {
                                TextButton(onClick = {
                                    scope.launch {
                                        zeroTerm.setNetworkProxy("")
                                        settings.setProxy(false, "")
                                        proxyDraft = ""
                                    }
                                }) { Text(stringResource(R.string.common_clear)) }
                            }
                        }
                    }
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_background_access_title),
                        translucent = true,
                    ) {
                        Text(
                            stringResource(R.string.settings_background_access_help),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            enabled = !batteryOptimizationIgnored,
                            onClick = {
                                runCatching {
                                    context.startActivity(
                                        Intent(
                                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                            Uri.parse("package:${context.packageName}"),
                                        ),
                                    )
                                }.onFailure {
                                    context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                                }
                            },
                        ) {
                            Text(
                                if (batteryOptimizationIgnored) {
                                    stringResource(R.string.settings_background_access_granted)
                                } else {
                                    stringResource(R.string.settings_background_access_action)
                                },
                            )
                        }
                        if (isFlyme) {
                            Text(
                                stringResource(R.string.settings_flyme_background_help),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            OutlinedButton(onClick = { openFlymeBackgroundManager(context) }) {
                                Text(stringResource(R.string.settings_flyme_background_action))
                            }
                        }
                    }
                }

                WorkspaceSettingsPage.Terminal -> {
                    ZeroSectionCard(
                        title = stringResource(R.string.settings_font_size),
                        translucent = true,
                    ) {
                        Text(
                            stringResource(
                                R.string.settings_font_size_value,
                                snap.fontSizeSp.roundToInt(),
                            ),
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Slider(
                            value = snap.fontSizeSp,
                            onValueChange = { value ->
                                scope.launch { settings.setFontSize(value) }
                            },
                            valueRange = AppSettings.MIN_FONT..AppSettings.MAX_FONT,
                            steps = (AppSettings.MAX_FONT - AppSettings.MIN_FONT).toInt() - 1,
                        )
                        Text(
                            stringResource(R.string.settings_font_help),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                WorkspaceSettingsPage.About -> {
                    ZeroSectionCard(translucent = true) {
                        Text(
                            stringResource(R.string.settings_about_title),
                            style = MaterialTheme.typography.headlineSmall,
                        )
                        Text(
                            stringResource(
                                R.string.settings_about_version,
                                BuildConfig.VERSION_NAME,
                                BuildConfig.VERSION_CODE,
                            ),
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            stringResource(R.string.settings_about_body),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun workspaceThemeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.System -> stringResource(R.string.settings_theme_system)
    ThemeMode.Dark -> stringResource(R.string.settings_theme_dark)
    ThemeMode.Light -> stringResource(R.string.settings_theme_light)
}

@Composable
private fun workspaceLocaleLabel(locale: AppLocale): String = when (locale) {
    AppLocale.System -> stringResource(R.string.settings_language_system)
    AppLocale.English -> stringResource(R.string.settings_language_en)
    AppLocale.ChineseSimplified -> stringResource(R.string.settings_language_zh_cn)
}

private fun openFlymeBackgroundManager(context: android.content.Context) {
    val flymeIntent = Intent("com.meizu.safe.security.background_manager_settings").apply {
        addCategory(Intent.CATEGORY_DEFAULT)
        putExtra("packageName", context.packageName)
        putExtra("package_name", context.packageName)
        putExtra("pkgName", context.packageName)
    }
    runCatching { context.startActivity(flymeIntent) }
        .onFailure {
            context.startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:${context.packageName}"),
                ),
            )
        }
}

@Composable
private fun BackgroundPreview(path: String, opacity: Float, blurDp: Int) {
    var bitmap by remember(path) {
        mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)
    }
    LaunchedEffect(path) {
        bitmap = withContext(Dispatchers.IO) {
            if (path.isBlank()) null
            else runCatching { BitmapFactory.decodeFile(File(path).absolutePath)?.asImageBitmap() }.getOrNull()
        }
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(144.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap!!,
                contentDescription = stringResource(R.string.settings_background_preview),
                contentScale = ContentScale.Crop,
                alpha = opacity,
                modifier = Modifier
                    .fillMaxSize()
                    .blur(blurDp.dp),
            )
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    Icons.Default.Image,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(32.dp),
                )
                Text(
                    stringResource(R.string.settings_background_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
