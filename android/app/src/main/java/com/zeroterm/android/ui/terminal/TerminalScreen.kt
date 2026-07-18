package com.zeroterm.android.ui.terminal

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.zeroterm.android.R
import com.zeroterm.android.data.ActiveSession
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.SessionManager
import com.zeroterm.android.data.SettingsSnapshot
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.android.terminal.CustomTerminalTheme
import com.zeroterm.android.terminal.TermKeys
import com.zeroterm.android.terminal.TerminalHostView
import com.zeroterm.android.terminal.TerminalPalettes
import com.zeroterm.android.terminal.TerminalThemeDef
import com.zeroterm.android.ui.ai.AiScreen
import com.zeroterm.android.ui.ai.rememberAiConversationState
import com.zeroterm.android.ui.snippets.SnippetsScreen
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.android.ui.components.LocalChromeTransparency
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    hostId: String?,
    hostLabel: String,
    alreadyConnected: Boolean = false,
    sessions: SessionManager,
    repository: ZeroTermRepository,
    settings: AppSettings? = null,
    fontSizeSp: Float = 13f,
    backgroundImagePath: String = "",
    backgroundOpacity: Float = 0.4f,
    backgroundBlurDp: Int = 0,
    onFontSizeChanged: (Float) -> Unit = {},
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val connecting by sessions.connecting.collectAsState()
    val error by sessions.error.collectAsState()
    val active by sessions.active.collectAsState()
    val hostKey by sessions.hostKeyPrompt.collectAsState()
    val closedEvent by sessions.closed.collectAsState()
    val frameTick by sessions.frameTick.collectAsState()
    var termView by remember { mutableStateOf<TerminalHostView?>(null) }
    var ctrlSticky by remember { mutableStateOf(false) }
    var lastCols by remember { mutableStateOf(80) }
    var lastRows by remember { mutableStateOf(24) }
    var started by remember { mutableStateOf(false) }
    var disconnectedMsg by remember { mutableStateOf<String?>(null) }
    var hasSelection by remember { mutableStateOf(false) }
    var scrolledBack by remember { mutableStateOf(false) }
    val toolsDrawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val drawerAlpha = 1f - LocalChromeTransparency.current.drawer.coerceIn(0f, 0.8f)
    var toolsPage by remember { mutableStateOf(TerminalToolsPage.Ai) }
    val settingsSnap by (settings?.flow ?: kotlinx.coroutines.flow.flowOf(SettingsSnapshot()))
        .collectAsState(initial = SettingsSnapshot())
    val isSystemDark = (context.resources.configuration.uiMode and
        android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
        android.content.res.Configuration.UI_MODE_NIGHT_YES
    val darkApp = when (settingsSnap.themeMode) {
        com.zeroterm.android.data.ThemeMode.Dark -> true
        com.zeroterm.android.data.ThemeMode.Light -> false
        com.zeroterm.android.data.ThemeMode.System -> isSystemDark
    }
    val customThemes = remember(settingsSnap.terminalCustomThemesJson) {
        TerminalPalettes.decodeCustomThemes(settingsSnap.terminalCustomThemesJson)
    }
    val hiddenBuiltins = remember(settingsSnap.terminalHiddenBuiltinThemesJson) {
        TerminalPalettes.decodeHiddenBuiltins(settingsSnap.terminalHiddenBuiltinThemesJson)
    }
    val builtinLabels = mapOf(
        "tokyo-day" to stringResource(R.string.terminal_theme_tokyo_day),
        "catppuccin-latte" to stringResource(R.string.terminal_theme_catppuccin_latte),
        "sage-light" to stringResource(R.string.terminal_theme_sage_light),
        "termark-dark" to stringResource(R.string.terminal_theme_termark_dark),
        "kanagawa-wave" to stringResource(R.string.terminal_theme_kanagawa_wave),
        "catppuccin-mocha" to stringResource(R.string.terminal_theme_catppuccin_mocha),
    )
    val terminalThemes = remember(customThemes, hiddenBuiltins, builtinLabels) {
        TerminalPalettes.resolve(customThemes, hiddenBuiltins) { b ->
            builtinLabels[b.id] ?: TerminalPalettes.builtinLabel(b)
        }
    }
    val terminalThemeId = settingsSnap.terminalThemeId
        .ifBlank { TerminalPalettes.defaultId(darkApp) }
        .let { id -> if (terminalThemes.any { it.id == id }) id else TerminalPalettes.defaultId(darkApp) }
    val terminalTheme = remember(terminalThemeId, terminalThemes) {
        terminalThemes.firstOrNull { it.id == terminalThemeId }
            ?: TerminalPalettes.byId(terminalThemeId, customThemes, hiddenBuiltins)
    }

    fun applyThemeToView(view: TerminalHostView?) {
        view?.setThemeColors(
            background = terminalTheme.backgroundColor,
            cursor = terminalTheme.cursorColor,
            selection = terminalTheme.selectionColor,
            defaultCellBackground = terminalTheme.backgroundColor,
        )
    }

    LaunchedEffect(terminalThemeId, terminalTheme.palette) {
        sessions.applyTerminalPalette(terminalTheme.palette)
        applyThemeToView(termView)
    }

    LaunchedEffect(termView, terminalThemeId, terminalTheme.palette) {
        applyThemeToView(termView)
    }

    val batteryOptimizationRequest = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { /* The session still works if the user keeps battery optimization enabled. */ }
    val permissionPrefs = remember(context) {
        context.getSharedPreferences("runtime_permission_prompts", Context.MODE_PRIVATE)
    }
    val requestBatteryExemption = {
        val power = context.getSystemService(PowerManager::class.java)
        if (
            !power.isIgnoringBatteryOptimizations(context.packageName) &&
            !permissionPrefs.getBoolean("battery_optimization_prompted", false)
        ) {
            permissionPrefs.edit().putBoolean("battery_optimization_prompted", true).apply()
            batteryOptimizationRequest.launch(
                Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ),
            )
        }
    }
    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { requestBatteryExemption() }

    LaunchedEffect(Unit) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestBatteryExemption()
        }
    }

    LaunchedEffect(closedEvent) {
        closedEvent?.let { event ->
            disconnectedMsg = event.message ?: context.getString(R.string.terminal_disconnected)
        }
    }

    LaunchedEffect(Unit) {
        sessions.networkChanged.collect {
            disconnectedMsg = context.getString(R.string.terminal_network_changed)
        }
    }

    fun doConnect() {
        val id = hostId ?: return
        scope.launch {
            disconnectedMsg = null
            sessions.connect(
                hostId = id,
                hostLabel = hostLabel,
                cols = lastCols.toUShort().coerceAtLeast(2u),
                rows = lastRows.toUShort().coerceAtLeast(1u),
            )
            scrolledBack = false
        }
    }

    fun refreshPaint() {
        val frame = sessions.snapshot() ?: sessions.takeDamage()
        if (frame != null) termView?.applyFrame(frame)
    }

    fun copySelection() {
        val text = termView?.selectedText().orEmpty()
        if (text.isBlank()) {
            // Fall back to full viewport
            val all = sessions.viewportText()
            if (all.isBlank()) {
                Toast.makeText(context, context.getString(R.string.terminal_nothing_to_copy), Toast.LENGTH_SHORT).show()
                return
            }
            copyToClipboard(context, all)
            Toast.makeText(context, context.getString(R.string.terminal_copied_screen), Toast.LENGTH_SHORT).show()
        } else {
            copyToClipboard(context, text)
            termView?.clearSelection()
            hasSelection = false
            Toast.makeText(context, context.getString(R.string.terminal_copied), Toast.LENGTH_SHORT).show()
        }
    }

    fun pasteClipboard() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
        if (text.isNullOrEmpty()) {
            Toast.makeText(context, context.getString(R.string.terminal_clipboard_empty), Toast.LENGTH_SHORT).show()
            return
        }
        scope.launch {
            // If scrolled back, jump to live first so paste goes to shell
            if (sessions.displayOffset() > 0) {
                sessions.scrollToBottom()
                scrolledBack = false
                refreshPaint()
            }
            sessions.sendText(text)
        }
    }

    fun selectedText(): String = termView?.selectedText().orEmpty().trim()

    fun clearSelectionState() {
        termView?.clearSelection()
        hasSelection = false
    }

    fun executeSelection() {
        val text = selectedText()
        if (text.isBlank()) return
        scope.launch {
            if (sessions.displayOffset() > 0) {
                sessions.scrollToBottom()
                scrolledBack = false
                refreshPaint()
            }
            sessions.sendText(if (text.endsWith("\n")) text else "$text\n")
            clearSelectionState()
        }
    }

    fun openSelectionUrl() {
        val url = extractUrl(selectedText()) ?: return
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }.onFailure {
            Toast.makeText(context, it.message ?: "open failed", Toast.LENGTH_SHORT).show()
        }
        clearSelectionState()
    }

    fun sendSelectionToAi() {
        toolsPage = TerminalToolsPage.Ai
        scope.launch { toolsDrawerState.open() }
        // Keep selection so user can still copy if needed; clear after open.
        clearSelectionState()
    }

    LaunchedEffect(hostId, lastCols, lastRows, alreadyConnected) {
        if (!started && lastCols >= 2 && lastRows >= 1) {
            started = true
            if (alreadyConnected || sessions.isActiveFor(hostId)) {
                // Re-attach after navigation or Activity/Compose recreation.
                refreshPaint()
            } else if (hostId != null) {
                doConnect()
            }
        }
    }

    LaunchedEffect(fontSizeSp) {
        termView?.setFontSizeSp(fontSizeSp)
    }

    LaunchedEffect(frameTick, active) {
        // After scroll we force snapshot via SessionManager bumping frameTick
        val frame = if (scrolledBack) {
            sessions.snapshot()
        } else {
            sessions.takeDamage() ?: sessions.snapshot()
        }
        if (frame != null) {
            termView?.applyFrame(frame)
        }
        scrolledBack = sessions.displayOffset() > 0
    }

    hostKey?.let { prompt ->
        AlertDialog(
            onDismissRequest = {
                sessions.respondHostKey(prompt.requestId, false)
            },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = {
                Text(
                    if (prompt.stored != null) stringResource(R.string.terminal_host_key_changed)
                    else stringResource(R.string.terminal_host_key_unknown),
                )
            },
            text = {
                Column {
                    Text("${prompt.info.host}:${prompt.info.port}")
                    Text(prompt.info.keyType)
                    Text(prompt.info.fingerprint, style = MaterialTheme.typography.bodySmall)
                    prompt.stored?.let {
                        Text(stringResource(R.string.terminal_previously, it), color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    sessions.respondHostKey(prompt.requestId, true)
                }) { Text(stringResource(R.string.common_accept)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    sessions.respondHostKey(prompt.requestId, false)
                }) { Text(stringResource(R.string.common_reject)) }
            },
        )
    }

    // Material's drawer follows layout direction. RTL places it on the physical
    // right, then each surface restores LTR so text and terminal input stay normal.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        ModalNavigationDrawer(
            drawerState = toolsDrawerState,
            gesturesEnabled = active != null,
            drawerContent = {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    ModalDrawerSheet(
                        modifier = Modifier
                            .fillMaxWidth(0.92f)
                            .widthIn(max = 420.dp),
                        drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = drawerAlpha),
                        drawerContentColor = MaterialTheme.colorScheme.onSurface,
                    ) {
                        TerminalToolsDrawer(
                            selectedPage = toolsPage,
                            onPageSelected = { toolsPage = it },
                            onClose = { scope.launch { toolsDrawerState.close() } },
                            repository = repository,
                            settings = settings,
                            sessions = sessions,
                            hostLabel = hostLabel,
                            contextProvider = { sessions.viewportText() },
                            selectedThemeId = terminalThemeId,
                            themes = terminalThemes,
                            onThemeSelected = { id ->
                                scope.launch { settings?.setTerminalThemeId(id) }
                            },
                            onSaveTheme = { custom ->
                                scope.launch {
                                    val next = customThemes
                                        .filterNot { it.id == custom.id } + custom
                                    settings?.setTerminalCustomThemesJson(
                                        TerminalPalettes.encodeCustomThemes(next),
                                    )
                                    settings?.setTerminalThemeId(custom.id)
                                }
                            },
                            onDeleteTheme = { theme ->
                                scope.launch {
                                    if (theme.id == terminalThemeId) return@launch
                                    val nextCustom = customThemes.filterNot { it.id == theme.id }
                                    settings?.setTerminalCustomThemesJson(
                                        TerminalPalettes.encodeCustomThemes(nextCustom),
                                    )
                                    if (theme.isBuiltin) {
                                        val nextHidden = hiddenBuiltins + theme.id
                                        settings?.setTerminalHiddenBuiltinThemesJson(
                                            TerminalPalettes.encodeHiddenBuiltins(nextHidden),
                                        )
                                    }
                                }
                            },
                            onInsertAiCommand = { command ->
                                // Tapping the explicit approval action executes the command.
                                val executable = command.trim()
                                if (executable.isNotEmpty()) {
                                    scope.launch { sessions.sendText("$executable\n") }
                                    scope.launch { toolsDrawerState.close() }
                                }
                            },
                            onInsertSnippet = { command ->
                                if (command.isNotEmpty()) {
                                    scope.launch { sessions.sendText(command) }
                                    scope.launch { toolsDrawerState.close() }
                                }
                            },
                            onTerminalCommand = { command ->
                                scope.launch { sessions.sendText("$command\n") }
                                scope.launch { toolsDrawerState.close() }
                            },
                        )
                    }
                }
            },
        ) {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                TerminalContent(
                    hostLabel = hostLabel,
                    connecting = connecting,
                    error = error,
                    active = active,
                    disconnectedMsg = disconnectedMsg,
                    hasSelection = hasSelection,
                    scrolledBack = scrolledBack,
                    ctrlSticky = ctrlSticky,
                    lastCols = lastCols,
                    lastRows = lastRows,
                    fontSizeSp = fontSizeSp,
                    backgroundImagePath = backgroundImagePath,
                    backgroundOpacity = backgroundOpacity,
                    backgroundBlurDp = backgroundBlurDp,
                    alreadyConnected = alreadyConnected,
                    sessions = sessions,
                    termView = termView,
                    onTermViewChanged = { termView = it },
                    onCtrlStickyChanged = { ctrlSticky = it },
                    onSelectionChanged = { hasSelection = it },
                    onScrolledBackChanged = { scrolledBack = it },
                    onSizeChanged = { cols, rows -> lastCols = cols; lastRows = rows },
                    onBack = onBack,
                    onDisconnect = { scope.launch { sessions.disconnect() } },
                    onReconnect = { doConnect() },
                    onCopy = { copySelection() },
                    onPaste = { pasteClipboard() },
                    onExecuteSelection = { executeSelection() },
                    onOpenSelectionUrl = { openSelectionUrl() },
                    onSendSelectionToAi = { sendSelectionToAi() },
                    selectionUrl = if (hasSelection) extractUrl(selectedText()) else null,
                    onRefreshPaint = { refreshPaint() },
                    onOpenTools = { scope.launch { toolsDrawerState.open() } },
                    onFontSizeChanged = onFontSizeChanged,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalContent(
    hostLabel: String,
    connecting: Boolean,
    error: String?,
    active: ActiveSession?,
    disconnectedMsg: String?,
    hasSelection: Boolean,
    scrolledBack: Boolean,
    ctrlSticky: Boolean,
    lastCols: Int,
    lastRows: Int,
    fontSizeSp: Float,
    backgroundImagePath: String,
    backgroundOpacity: Float,
    backgroundBlurDp: Int,
    alreadyConnected: Boolean,
    sessions: SessionManager,
    termView: TerminalHostView?,
    onTermViewChanged: (TerminalHostView) -> Unit,
    onCtrlStickyChanged: (Boolean) -> Unit,
    onSelectionChanged: (Boolean) -> Unit,
    onScrolledBackChanged: (Boolean) -> Unit,
    onSizeChanged: (Int, Int) -> Unit,
    onBack: () -> Unit,
    onDisconnect: () -> Unit,
    onReconnect: () -> Unit,
    onCopy: () -> Unit,
    onPaste: () -> Unit,
    onExecuteSelection: () -> Unit,
    onOpenSelectionUrl: () -> Unit,
    onSendSelectionToAi: () -> Unit,
    selectionUrl: String?,
    onRefreshPaint: () -> Unit,
    onOpenTools: () -> Unit,
    onFontSizeChanged: (Float) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val latestCtrlSticky by rememberUpdatedState(ctrlSticky)
    val latestCols by rememberUpdatedState(lastCols)
    val latestRows by rememberUpdatedState(lastRows)
    // AppBackground already draws the custom image under the whole NavHost.
    // Keep terminal chrome transparent so that image is not covered.
    val hasCustomBackground = backgroundImagePath.isNotBlank()
    Scaffold(
        containerColor = if (hasCustomBackground) {
            Color.Transparent
        } else {
            MaterialTheme.colorScheme.background.copy(alpha = 0.48f)
        },
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = hostLabel,
                subtitle = stringResource(R.string.terminal_connected),
                navigationIcon = {
                    IconButton(onClick = {
                        onDisconnect()
                        onBack()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                actions = {
                    if (scrolledBack) {
                        IconButton(onClick = {
                            sessions.scrollToBottom()
                            onScrolledBackChanged(false)
                            onRefreshPaint()
                        }) {
                            Icon(Icons.Default.VerticalAlignBottom, contentDescription = stringResource(R.string.terminal_bottom))
                        }
                    }
                    if (hasSelection) {
                        // Selection actions (icons only), shown at paste position.
                        if (selectionUrl != null) {
                            IconButton(onClick = onOpenSelectionUrl) {
                                Icon(
                                    Icons.AutoMirrored.Filled.OpenInNew,
                                    contentDescription = stringResource(R.string.terminal_selection_open_url),
                                )
                            }
                        }
                        IconButton(onClick = onCopy) {
                            Icon(Icons.Default.ContentCopy, contentDescription = stringResource(R.string.common_copy))
                        }
                        IconButton(onClick = onExecuteSelection) {
                            Icon(
                                Icons.Default.PlayArrow,
                                contentDescription = stringResource(R.string.terminal_selection_execute),
                            )
                        }
                        IconButton(onClick = onSendSelectionToAi) {
                            Icon(
                                Icons.Default.AutoAwesome,
                                contentDescription = stringResource(R.string.terminal_selection_ai),
                            )
                        }
                    } else {
                        IconButton(onClick = onPaste) {
                            Icon(Icons.Default.ContentPaste, contentDescription = stringResource(R.string.common_paste))
                        }
                    }
                    if (disconnectedMsg != null || (error != null && active == null)) {
                        IconButton(onClick = onReconnect, enabled = !connecting) {
                            Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.terminal_reconnect))
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(
                    if (hasCustomBackground) Color.Transparent else Color(0xFF0B1220),
                ),
        ) {
            disconnectedMsg?.let { msg ->
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            msg,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.weight(1f),
                        )
                        Button(onClick = onReconnect, enabled = !connecting) {
                            Text(stringResource(R.string.terminal_reconnect))
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(
                    factory = { ctx ->
                        TerminalHostView(ctx).also { v ->
                            onTermViewChanged(v)
                            v.setFontSizeSp(fontSizeSp)
                            v.setBackgroundConfig(backgroundImagePath, backgroundOpacity, backgroundBlurDp)
                            v.onFontSizeChanged = onFontSizeChanged
                            if (alreadyConnected) {
                                sessions.snapshot()?.let { v.applyFrame(it) }
                            }
                            v.onTextInput = { text ->
                                scope.launch {
                                    if (sessions.displayOffset() > 0) {
                                        sessions.scrollToBottom()
                                        onScrolledBackChanged(false)
                                        onRefreshPaint()
                                    }
                                    if (latestCtrlSticky && text.length == 1) {
                                        val ch = text[0]
                                        if (ch in 'a'..'z' || ch in 'A'..'Z') {
                                            sessions.sendInput(TermKeys.ctrl(ch))
                                            onCtrlStickyChanged(false)
                                            return@launch
                                        }
                                    }
                                    sessions.sendText(text)
                                }
                            }
                            v.onKeyBytes = { bytes ->
                                scope.launch {
                                    if (sessions.displayOffset() > 0) {
                                        sessions.scrollToBottom()
                                        onScrolledBackChanged(false)
                                        onRefreshPaint()
                                    }
                                    sessions.sendInput(bytes)
                                }
                            }
                            v.onSizeChangedCells = { c, r ->
                                if (c != latestCols || r != latestRows) {
                                    onSizeChanged(c, r)
                                    if (sessions.active.value != null) {
                                        scope.launch {
                                            sessions.resize(c.toUShort(), r.toUShort())
                                        }
                                    }
                                }
                            }
                            v.onScrollLines = { delta ->
                                // Finger drag down (positive y) → older history
                                sessions.scrollDisplay(delta)
                                onScrolledBackChanged(sessions.displayOffset() > 0)
                                onRefreshPaint()
                            }
                            v.onSelectionChanged = onSelectionChanged
                        }
                    },
                    update = { view ->
                        view.setFontSizeSp(fontSizeSp)
                        view.setBackgroundConfig(backgroundImagePath, backgroundOpacity, backgroundBlurDp)
                    },
                    modifier = Modifier.fillMaxSize(),
                )
                if (connecting) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                if (error != null && active == null && disconnectedMsg == null) {
                    Column(
                        Modifier.align(Alignment.Center).padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(error!!, color = MaterialTheme.colorScheme.error)
                        Button(
                            onClick = onReconnect,
                            enabled = !connecting,
                            modifier = Modifier.padding(top = 8.dp),
                        ) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                if (active != null) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .width(22.dp)
                            .height(64.dp)
                            .clickable(onClick = onOpenTools),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Default.ChevronLeft,
                            contentDescription = stringResource(R.string.terminal_tools),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            ExtraKeysBar(
                ctrlSticky = ctrlSticky,
                onCtrl = { onCtrlStickyChanged(!ctrlSticky) },
                onBytes = { scope.launch { sessions.sendInput(it) } },
                onText = { scope.launch { sessions.sendText(it) } },
                onPaste = onPaste,
                onCopy = onCopy,
                onScrollUp = {
                    sessions.scrollDisplay(5)
                    onScrolledBackChanged(true)
                    onRefreshPaint()
                },
                onScrollDown = {
                    sessions.scrollDisplay(-5)
                    onScrolledBackChanged(sessions.displayOffset() > 0)
                    onRefreshPaint()
                },
            )
        }
    }
}

private enum class TerminalToolsPage { Ai, Snippets, Metrics, Docker, Theme }

@Composable
private fun TerminalToolsDrawer(
    selectedPage: TerminalToolsPage,
    onPageSelected: (TerminalToolsPage) -> Unit,
    onClose: () -> Unit,
    repository: ZeroTermRepository,
    settings: AppSettings? = null,
    sessions: SessionManager,
    hostLabel: String,
    contextProvider: () -> String,
    selectedThemeId: String,
    themes: List<TerminalThemeDef>,
    onThemeSelected: (String) -> Unit,
    onSaveTheme: (CustomTerminalTheme) -> Unit,
    onDeleteTheme: (TerminalThemeDef) -> Unit,
    onInsertAiCommand: (String) -> Unit,
    onInsertSnippet: (String) -> Unit,
    onTerminalCommand: (String) -> Unit,
) {
    val aiConversationState = rememberAiConversationState()
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TerminalToolIconButton(
                selected = selectedPage == TerminalToolsPage.Snippets,
                icon = painterResource(R.drawable.ic_terminal_tool_snippets),
                label = stringResource(R.string.snippets_title),
                onClick = { onPageSelected(TerminalToolsPage.Snippets) },
            )
            TerminalToolIconButton(
                selected = selectedPage == TerminalToolsPage.Ai,
                icon = painterResource(R.drawable.ic_terminal_tool_ai),
                label = stringResource(R.string.ai_title),
                onClick = { onPageSelected(TerminalToolsPage.Ai) },
            )
            TerminalToolIconButton(
                selected = selectedPage == TerminalToolsPage.Metrics,
                icon = painterResource(R.drawable.ic_terminal_tool_metrics),
                label = stringResource(R.string.monitor_title),
                onClick = { onPageSelected(TerminalToolsPage.Metrics) },
            )
            TerminalToolIconButton(
                selected = selectedPage == TerminalToolsPage.Docker,
                icon = painterResource(R.drawable.ic_terminal_tool_docker),
                label = stringResource(R.string.docker_title),
                onClick = { onPageSelected(TerminalToolsPage.Docker) },
            )
            TerminalToolIconButton(
                selected = selectedPage == TerminalToolsPage.Theme,
                icon = painterResource(R.drawable.ic_terminal_tool_theme),
                label = stringResource(R.string.terminal_theme_title),
                onClick = { onPageSelected(TerminalToolsPage.Theme) },
            )
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onClose) {
                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close))
            }
        }
        when (selectedPage) {
            TerminalToolsPage.Ai -> AiScreen(
                repository = repository,
                settings = settings,
                contextLabel = hostLabel,
                contextProvider = contextProvider,
                onInsertCommand = onInsertAiCommand,
                embedded = true,
                conversationState = aiConversationState,
            )
            TerminalToolsPage.Snippets -> SnippetsScreen(
                repository = repository,
                onInsert = onInsertSnippet,
                allowEditingInPickMode = true,
                embedded = true,
            )
            TerminalToolsPage.Metrics -> MetricsPanel(sessions)
            TerminalToolsPage.Docker -> DockerPanel(sessions, onTerminalCommand)
            TerminalToolsPage.Theme -> TerminalThemePanel(
                selectedThemeId = selectedThemeId,
                themes = themes,
                onThemeSelected = onThemeSelected,
                onSaveTheme = onSaveTheme,
                onDeleteTheme = onDeleteTheme,
            )
        }
    }
}

@Composable
private fun TerminalToolIconButton(
    selected: Boolean,
    icon: Painter,
    label: String,
    onClick: () -> Unit,
) {
    IconToggleButton(
        checked = selected,
        onCheckedChange = { onClick() },
        colors = IconButtonDefaults.iconToggleButtonColors(
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            checkedContainerColor = MaterialTheme.colorScheme.primaryContainer,
            checkedContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        ),
    ) {
        Icon(icon, contentDescription = label)
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(context.getString(R.string.terminal_clip_label), text))
}

private fun extractUrl(text: String): String? {
    val raw = text.trim()
    if (raw.isEmpty()) return null
    val candidate = raw.split(Regex("\\s+")).firstOrNull().orEmpty()
    val withScheme = when {
        candidate.startsWith("http://", ignoreCase = true) ||
            candidate.startsWith("https://", ignoreCase = true) -> candidate
        candidate.startsWith("www.", ignoreCase = true) -> "https://$candidate"
        else -> return null
    }
    return runCatching {
        val uri = Uri.parse(withScheme)
        if (uri.scheme.isNullOrBlank() || uri.host.isNullOrBlank()) null else withScheme
    }.getOrNull()
}

@Composable
private fun ExtraKeysBar(
    ctrlSticky: Boolean,
    onCtrl: () -> Unit,
    onBytes: (ByteArray) -> Unit,
    onText: (String) -> Unit,
    onPaste: () -> Unit,
    onCopy: () -> Unit,
    onScrollUp: () -> Unit,
    onScrollDown: () -> Unit,
) {
    Surface(tonalElevation = 2.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(44.dp)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KeyBtn("Esc") { onBytes(TermKeys.esc()) }
            KeyBtn("Tab") { onBytes(TermKeys.tab()) }
            KeyBtn("Ctrl", highlight = ctrlSticky) { onCtrl() }
            KeyBtn("↑") { onBytes(TermKeys.up()) }
            KeyBtn("↓") { onBytes(TermKeys.down()) }
            KeyBtn("←") { onBytes(TermKeys.left()) }
            KeyBtn("→") { onBytes(TermKeys.right()) }
            KeyBtn("PgUp") { onBytes(TermKeys.pgUp()) }
            KeyBtn("PgDn") { onBytes(TermKeys.pgDn()) }
            KeyBtn("Scr↑") { onScrollUp() }
            KeyBtn("Scr↓") { onScrollDown() }
            KeyBtn(stringResource(R.string.terminal_key_copy)) { onCopy() }
            KeyBtn(stringResource(R.string.terminal_key_paste)) { onPaste() }
            KeyBtn("|") { onText("|") }
            KeyBtn("~") { onText("~") }
            KeyBtn("-") { onText("-") }
            KeyBtn("/") { onText("/") }
        }
    }
}

@Composable
private fun KeyBtn(label: String, highlight: Boolean = false, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.height(40.dp),
    ) {
        Text(
            label,
            color = if (highlight) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurface,
        )
    }
}
