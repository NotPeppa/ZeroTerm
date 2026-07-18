package com.zeroterm.android.ui.settings

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.zeroterm.android.BuildConfig
import com.zeroterm.android.R
import com.zeroterm.android.data.AppLocale
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.SettingsSnapshot
import com.zeroterm.android.data.UpdateCheckResult
import com.zeroterm.android.data.UpdateChecker
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
                    AboutPageContent()
                }
            }
        }
    }
}

@Composable
private fun AboutPageContent() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val repoUrl = stringResource(R.string.settings_about_repo_url)
    val brandBlue = Color(0xFF3B82F6)
    val brandBlueSoft = Color(0xFF60A5FA)
    val currentVersion = BuildConfig.VERSION_NAME
    var checking by remember { mutableStateOf(false) }
    var downloading by remember { mutableStateOf(false) }
    var downloadProgress by remember { mutableStateOf<Float?>(null) }
    var updateResult by remember { mutableStateOf<UpdateCheckResult?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    var downloadedApk by remember { mutableStateOf<java.io.File?>(null) }

    val installPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val apk = downloadedApk
        if (apk != null && UpdateChecker.canInstallPackages(context)) {
            runCatching { UpdateChecker.installApk(context, apk) }
                .onFailure { actionError = it.message }
        }
    }

    fun checkUpdate() {
        scope.launch {
            checking = true
            actionError = null
            updateResult = UpdateChecker.check(currentVersion)
            checking = false
        }
    }

    fun downloadAndInstall() {
        val result = updateResult ?: return
        val url = result.apkUrl
        if (url.isNullOrBlank()) {
            actionError = context.getString(R.string.settings_update_no_apk)
            return
        }
        scope.launch {
            downloading = true
            actionError = null
            downloadProgress = 0f
            val download = runCatching {
                UpdateChecker.downloadApk(
                    context = context,
                    url = url,
                    fileName = result.apkName ?: "zeroterm-${result.latestVersion}.apk",
                    expectedSize = result.apkSize,
                    onProgress = { downloadProgress = it },
                )
            }
            downloading = false
            download.fold(
                onSuccess = { file ->
                    downloadedApk = file
                    if (!UpdateChecker.canInstallPackages(context)) {
                        actionError = context.getString(R.string.settings_update_install_permission)
                        installPermissionLauncher.launch(
                            UpdateChecker.installPermissionSettingsIntent(context),
                        )
                    } else {
                        runCatching { UpdateChecker.installApk(context, file) }
                            .onFailure {
                                actionError = it.message
                                    ?: context.getString(R.string.settings_update_download_failed, "install")
                            }
                    }
                },
                onFailure = {
                    actionError = context.getString(
                        R.string.settings_update_download_failed,
                        it.message ?: "error",
                    )
                },
            )
        }
    }

    LaunchedEffect(Unit) { checkUpdate() }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Brand header — mirrors desktop settings-about-header
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.48f),
            border = BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
            ),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Box(
                        modifier = Modifier
                            .size(88.dp)
                            .clip(CircleShape)
                            .background(
                                Brush.radialGradient(
                                    colors = listOf(
                                        brandBlue.copy(alpha = 0.28f),
                                        Color.Transparent,
                                    ),
                                ),
                            ),
                    )
                    Image(
                        painter = painterResource(R.drawable.zeroterm_desktop_logo),
                        contentDescription = null,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(72.dp),
                    )
                }
                Text(
                    text = stringResource(R.string.settings_about_title),
                    style = MaterialTheme.typography.headlineMedium.copy(
                        fontWeight = FontWeight.ExtraBold,
                        letterSpacing = (-0.3).sp,
                    ),
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(R.string.settings_about_tagline),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
        }

        // Metadata cards — version / author / github
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AboutMetaCard(
                icon = Icons.Default.Info,
                label = stringResource(R.string.settings_about_version_label),
                value = stringResource(
                    R.string.settings_about_version,
                    BuildConfig.VERSION_NAME,
                    BuildConfig.VERSION_CODE,
                ),
            )
            AboutMetaCard(
                icon = Icons.Default.Person,
                label = stringResource(R.string.settings_about_author_label),
                value = stringResource(R.string.settings_about_author),
            )
            AboutMetaCard(
                icon = Icons.Default.Code,
                label = stringResource(R.string.settings_about_repo_label),
                value = stringResource(R.string.settings_about_repo),
                trailing = {
                    Icon(
                        Icons.AutoMirrored.Filled.OpenInNew,
                        contentDescription = stringResource(R.string.settings_about_open_github),
                        tint = brandBlueSoft,
                        modifier = Modifier.size(18.dp),
                    )
                },
                onClick = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(repoUrl)))
                    }
                },
            )
        }

        // Update check card — mirrors desktop settings-about-update-card
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.55f),
            border = BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f),
            ),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    val pulseColor = when {
                        checking -> MaterialTheme.colorScheme.primary
                        updateResult?.available == true -> Color(0xFFFBBF24)
                        updateResult?.error != null -> MaterialTheme.colorScheme.error
                        else -> Color(0xFF10B981)
                    }
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(pulseColor),
                    )
                    Text(
                        text = stringResource(R.string.settings_update_title),
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        Icons.Default.SystemUpdate,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
                val statusText = when {
                    downloading -> {
                        val p = downloadProgress
                        if (p != null && p >= 0f) {
                            stringResource(
                                R.string.settings_update_downloading,
                                (p * 100).roundToInt(),
                            )
                        } else {
                            stringResource(R.string.settings_update_downloading_indeterminate)
                        }
                    }
                    checking -> stringResource(R.string.settings_update_checking)
                    actionError != null -> actionError!!
                    updateResult?.error != null -> stringResource(
                        R.string.settings_update_failed,
                        updateResult?.error.orEmpty(),
                    )
                    updateResult?.available == true && updateResult?.apkUrl.isNullOrBlank() ->
                        stringResource(R.string.settings_update_no_apk)
                    updateResult?.available == true -> stringResource(
                        R.string.settings_update_available,
                        updateResult?.currentVersion ?: currentVersion,
                        updateResult?.latestVersion.orEmpty(),
                    )
                    updateResult != null -> stringResource(
                        R.string.settings_update_latest,
                        updateResult?.currentVersion ?: currentVersion,
                    )
                    else -> stringResource(R.string.settings_update_checking)
                }
                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        actionError != null || updateResult?.error != null ->
                            MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
                if (downloading) {
                    val p = downloadProgress
                    if (p != null && p >= 0f) {
                        androidx.compose.material3.LinearProgressIndicator(
                            progress = { p.coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        androidx.compose.material3.LinearProgressIndicator(
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedButton(
                        onClick = { checkUpdate() },
                        enabled = !checking && !downloading,
                    ) {
                        if (checking) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(stringResource(R.string.settings_update_check))
                    }
                    if (updateResult?.available == true) {
                        if (!updateResult?.apkUrl.isNullOrBlank()) {
                            Button(
                                onClick = {
                                    val apk = downloadedApk
                                    if (apk != null && apk.exists()) {
                                        if (!UpdateChecker.canInstallPackages(context)) {
                                            actionError = context.getString(
                                                R.string.settings_update_install_permission,
                                            )
                                            installPermissionLauncher.launch(
                                                UpdateChecker.installPermissionSettingsIntent(context),
                                            )
                                        } else {
                                            runCatching { UpdateChecker.installApk(context, apk) }
                                                .onFailure { actionError = it.message }
                                        }
                                    } else {
                                        downloadAndInstall()
                                    }
                                },
                                enabled = !checking && !downloading,
                            ) {
                                Text(
                                    if (downloadedApk?.exists() == true) {
                                        stringResource(R.string.settings_update_install)
                                    } else {
                                        stringResource(R.string.settings_update_download)
                                    },
                                )
                            }
                        }
                        val releaseUrl = updateResult?.releaseUrl ?: repoUrl
                        TextButton(
                            onClick = {
                                runCatching {
                                    context.startActivity(
                                        Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl)),
                                    )
                                }
                            },
                            enabled = !downloading,
                        ) {
                            Text(stringResource(R.string.settings_update_open))
                        }
                    }
                }
            }
        }

        // Privacy / architecture note (Android-specific, keep)
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.28f),
            border = BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
            ),
        ) {
            Text(
                text = stringResource(R.string.settings_about_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun AboutMetaCard(
    icon: ImageVector,
    label: String,
    value: String,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(14.dp)
    val clickableMod = if (onClick != null) {
        Modifier.clickable(onClick = onClick)
    } else {
        Modifier
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .then(clickableMod),
        shape = shape,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.55f),
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        border = BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f),
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(
                    1.dp,
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.22f),
                ),
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(10.dp)
                        .size(20.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label.uppercase(),
                    style = MaterialTheme.typography.labelSmall.copy(
                        letterSpacing = 0.8.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = value,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (onClick != null) {
                        Color(0xFF60A5FA)
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
            }
            trailing?.invoke()
        }
    }
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
