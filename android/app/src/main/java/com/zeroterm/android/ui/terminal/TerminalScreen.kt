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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.zeroterm.android.terminal.ExtraKeyId
import com.zeroterm.android.terminal.TermKeys
import com.zeroterm.android.terminal.TerminalHostView
import com.zeroterm.android.terminal.TerminalPalettes
import com.zeroterm.android.terminal.TerminalThemeDef
import com.zeroterm.android.ui.ai.AiScreen
import com.zeroterm.android.ui.ai.rememberAiConversationState
import com.zeroterm.android.ui.snippets.SnippetsScreen
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.android.ui.components.LocalChromeTransparency
import kotlinx.coroutines.flow.first
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
    var altSticky by remember { mutableStateOf(false) }
    var shiftSticky by remember { mutableStateOf(false) }
    var lastCols by remember { mutableStateOf(80) }
    var lastRows by remember { mutableStateOf(24) }
    var started by remember { mutableStateOf(false) }
    var disconnectedMsg by remember { mutableStateOf<String?>(null) }
    var hasSelection by remember { mutableStateOf(false) }
    var scrolledBack by remember { mutableStateOf(false) }
    val toolsDrawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    var toolsDrawerOpenKey by remember { mutableIntStateOf(0) }
    val drawerAlpha = 1f - LocalChromeTransparency.current.drawer.coerceIn(0f, 0.8f)
    var toolsPage by remember { mutableStateOf(TerminalToolsPage.Snippets) }
    val settingsSnap by (settings?.flow ?: kotlinx.coroutines.flow.flowOf(SettingsSnapshot()))
        .collectAsState(initial = SettingsSnapshot())
    val enabledExtraKeys = remember(settingsSnap.terminalExtraKeysCsv) {
        ExtraKeyId.parseCsv(settingsSnap.terminalExtraKeysCsv)
    }
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

    val themeDefaultBgPacked =
        (terminalTheme.palette.background.toLong() and 0xFFFFFFL).toInt()

    fun applyThemeToView(view: TerminalHostView?) {
        view?.setThemeColors(
            background = terminalTheme.backgroundColor,
            cursor = terminalTheme.cursorColor,
            selection = terminalTheme.selectionColor,
            defaultCellBackgroundPacked = themeDefaultBgPacked,
        )
    }

    // Apply palette before first paint/connect so glass-mode bg matching uses the
    // active theme (SessionManager defaults to termark-dark until this runs).
    LaunchedEffect(terminalThemeId, terminalTheme.palette) {
        sessions.applyTerminalPalette(terminalTheme.palette)
        applyThemeToView(termView)
        // Force a full frame so already-drawn cells pick up the new palette.
        if (sessions.active.value != null) {
            sessions.snapshot()?.let { termView?.applyFrame(it) }
        }
    }

    LaunchedEffect(termView, terminalThemeId, themeDefaultBgPacked) {
        applyThemeToView(termView)
        if (termView != null && sessions.active.value != null) {
            sessions.snapshot()?.let { termView?.applyFrame(it) }
        }
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
            // Wait for persisted theme (DataStore) so we never paint with the
            // SessionManager default palette (termark-dark) on first open.
            val snap = settings?.flow?.first() ?: settingsSnap
            val theme = resolveTerminalTheme(snap, darkApp, context)
            sessions.applyTerminalPalette(theme.palette)
            applyThemeToView(termView)
            sessions.connect(
                hostId = id,
                hostLabel = hostLabel,
                cols = lastCols.toUShort().coerceAtLeast(2u),
                rows = lastRows.toUShort().coerceAtLeast(1u),
            )
            scrolledBack = false
            // Session exists now: re-apply so setPalette forces a full damage frame.
            sessions.applyTerminalPalette(theme.palette)
            termView?.setThemeColors(
                background = theme.backgroundColor,
                cursor = theme.cursorColor,
                selection = theme.selectionColor,
                defaultCellBackgroundPacked = (theme.palette.background.toLong() and 0xFFFFFFL).toInt(),
            )
            sessions.snapshot()?.let { termView?.applyFrame(it) }
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

    fun openToolsDrawer(page: TerminalToolsPage = TerminalToolsPage.Snippets) {
        // Keep soft keyboard down until user taps an input field.
        termView?.hideIme()
        toolsPage = page
        toolsDrawerOpenKey += 1
        scope.launch { toolsDrawerState.open() }
    }

    fun sendSelectionToAi() {
        openToolsDrawer(TerminalToolsPage.Ai)
        // Keep selection so user can still copy if needed; clear after open.
        clearSelectionState()
    }

    // Swipe-open also keeps the terminal IME from covering the AI page.
    LaunchedEffect(toolsDrawerState.currentValue) {
        if (toolsDrawerState.currentValue == DrawerValue.Open) {
            termView?.hideIme()
            toolsDrawerOpenKey += 1
        }
    }

    LaunchedEffect(hostId, lastCols, lastRows, alreadyConnected) {
        if (!started && lastCols >= 2 && lastRows >= 1) {
            started = true
            // Seed SessionManager with the real theme before any paint/connect.
            val snap = settings?.flow?.first() ?: settingsSnap
            val theme = resolveTerminalTheme(snap, darkApp, context)
            sessions.applyTerminalPalette(theme.palette)
            applyThemeToView(termView)
            if (alreadyConnected || sessions.isActiveFor(hostId)) {
                // Re-attach: palette may still be default if session was created early.
                sessions.applyTerminalPalette(theme.palette)
                sessions.snapshot()?.let { termView?.applyFrame(it) }
                    ?: refreshPaint()
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
                            toolsDrawerOpenKey = toolsDrawerOpenKey,
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
                    altSticky = altSticky,
                    shiftSticky = shiftSticky,
                    enabledExtraKeys = enabledExtraKeys,
                    lastCols = lastCols,
                    lastRows = lastRows,
                    fontSizeSp = fontSizeSp,
                    backgroundImagePath = backgroundImagePath,
                    backgroundOpacity = backgroundOpacity,
                    backgroundBlurDp = backgroundBlurDp,
                    themeBackground = terminalTheme.backgroundColor,
                    themeCursor = terminalTheme.cursorColor,
                    themeSelection = terminalTheme.selectionColor,
                    themeDefaultBgPacked = themeDefaultBgPacked,
                    alreadyConnected = alreadyConnected,
                    sessions = sessions,
                    termView = termView,
                    onTermViewChanged = { termView = it },
                    onCtrlStickyChanged = { ctrlSticky = it },
                    onAltStickyChanged = { altSticky = it },
                    onShiftStickyChanged = { shiftSticky = it },
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
                    onOpenTools = { openToolsDrawer() },
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
    altSticky: Boolean,
    shiftSticky: Boolean,
    enabledExtraKeys: List<ExtraKeyId>,
    lastCols: Int,
    lastRows: Int,
    fontSizeSp: Float,
    backgroundImagePath: String,
    backgroundOpacity: Float,
    backgroundBlurDp: Int,
    themeBackground: Color,
    themeCursor: Color,
    themeSelection: Color,
    themeDefaultBgPacked: Int,
    alreadyConnected: Boolean,
    sessions: SessionManager,
    termView: TerminalHostView?,
    onTermViewChanged: (TerminalHostView) -> Unit,
    onCtrlStickyChanged: (Boolean) -> Unit,
    onAltStickyChanged: (Boolean) -> Unit,
    onShiftStickyChanged: (Boolean) -> Unit,
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
    val latestAltSticky by rememberUpdatedState(altSticky)
    val latestShiftSticky by rememberUpdatedState(shiftSticky)
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
                DisconnectBanner(
                    message = msg,
                    connecting = connecting,
                    onReconnect = onReconnect,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(
                    factory = { ctx ->
                        TerminalHostView(ctx).also { v ->
                            onTermViewChanged(v)
                            v.setFontSizeSp(fontSizeSp)
                            v.setBackgroundConfig(backgroundImagePath, backgroundOpacity, backgroundBlurDp)
                            // Apply theme immediately so default-cell transparency
                            // uses the active palette (not the 0x0B1220 placeholder).
                            v.setThemeColors(
                                background = themeBackground,
                                cursor = themeCursor,
                                selection = themeSelection,
                                defaultCellBackgroundPacked = themeDefaultBgPacked,
                            )
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
                                    var payload = text
                                    if (latestCtrlSticky && payload.length == 1) {
                                        val ch = payload[0]
                                        if (ch in 'a'..'z' || ch in 'A'..'Z') {
                                            sessions.sendInput(TermKeys.ctrl(ch))
                                            onCtrlStickyChanged(false)
                                            onShiftStickyChanged(false)
                                            return@launch
                                        }
                                    }
                                    if (latestShiftSticky && payload.length == 1) {
                                        val ch = payload[0]
                                        if (ch in 'a'..'z') {
                                            payload = ch.uppercaseChar().toString()
                                            onShiftStickyChanged(false)
                                        }
                                    }
                                    if (latestAltSticky && payload.isNotEmpty()) {
                                        onAltStickyChanged(false)
                                        payload = "\u001b$payload"
                                    }
                                    sessions.sendText(payload)
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
                        view.setThemeColors(
                            background = themeBackground,
                            cursor = themeCursor,
                            selection = themeSelection,
                            defaultCellBackgroundPacked = themeDefaultBgPacked,
                        )
                    },
                    modifier = Modifier.fillMaxSize(),
                )
                if (connecting) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                if (error != null && active == null && disconnectedMsg == null) {
                    DisconnectBanner(
                        message = error!!,
                        connecting = connecting,
                        onReconnect = onReconnect,
                        title = stringResource(R.string.common_retry),
                        actionLabel = stringResource(R.string.common_retry),
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(16.dp)
                            .fillMaxWidth(0.92f),
                    )
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
                enabledKeys = enabledExtraKeys,
                ctrlSticky = ctrlSticky,
                altSticky = altSticky,
                shiftSticky = shiftSticky,
                onCtrl = { onCtrlStickyChanged(!ctrlSticky) },
                onAlt = { onAltStickyChanged(!altSticky) },
                onShift = { onShiftStickyChanged(!shiftSticky) },
                onBytes = { bytes ->
                    scope.launch {
                        // Shift+Tab → reverse tab
                        if (latestShiftSticky && bytes.contentEquals(TermKeys.tab())) {
                            onShiftStickyChanged(false)
                            sessions.sendInput("\u001b[Z".toByteArray())
                        } else {
                            sessions.sendInput(bytes)
                        }
                    }
                },
                onText = { text ->
                    scope.launch {
                        var payload = text
                        if (latestShiftSticky && payload.length == 1) {
                            val ch = payload[0]
                            if (ch in 'a'..'z') {
                                payload = ch.uppercaseChar().toString()
                                onShiftStickyChanged(false)
                            }
                        }
                        if (latestAltSticky && payload.isNotEmpty()) {
                            onAltStickyChanged(false)
                            payload = "\u001b$payload"
                        }
                        sessions.sendText(payload)
                    }
                },
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

private fun resolveTerminalTheme(
    snap: SettingsSnapshot,
    darkApp: Boolean,
    context: Context,
): TerminalThemeDef {
    val customThemes = TerminalPalettes.decodeCustomThemes(snap.terminalCustomThemesJson)
    val hiddenBuiltins = TerminalPalettes.decodeHiddenBuiltins(snap.terminalHiddenBuiltinThemesJson)
    val themes = TerminalPalettes.resolve(customThemes, hiddenBuiltins) { b ->
        runCatching { context.getString(b.nameRes) }.getOrDefault(TerminalPalettes.builtinLabel(b))
    }
    val id = snap.terminalThemeId
        .ifBlank { TerminalPalettes.defaultId(darkApp) }
        .let { key -> if (themes.any { it.id == key }) key else TerminalPalettes.defaultId(darkApp) }
    return themes.firstOrNull { it.id == id }
        ?: TerminalPalettes.byId(id, customThemes, hiddenBuiltins)
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
    toolsDrawerOpenKey: Int = 0,
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
                embeddedOpenKey = toolsDrawerOpenKey,
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
private fun DisconnectBanner(
    message: String,
    connecting: Boolean,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
    title: String = stringResource(R.string.terminal_disconnected_title),
    actionLabel: String = stringResource(R.string.terminal_reconnect),
) {
    val shape = RoundedCornerShape(14.dp)
    Surface(
        modifier = modifier,
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.92f),
        border = BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.error.copy(alpha = 0.28f),
        ),
        tonalElevation = 1.dp,
        shadowElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.error.copy(alpha = 0.14f),
                shape = CircleShape,
                border = BorderStroke(
                    1.dp,
                    MaterialTheme.colorScheme.error.copy(alpha = 0.22f),
                ),
            ) {
                Icon(
                    imageVector = Icons.Default.LinkOff,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .padding(8.dp)
                        .size(18.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = if (connecting) {
                        stringResource(R.string.terminal_reconnecting)
                    } else {
                        title
                    },
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            FilledTonalButton(
                onClick = onReconnect,
                enabled = !connecting,
                shape = RoundedCornerShape(10.dp),
            ) {
                if (connecting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(8.dp))
                } else {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(actionLabel)
            }
        }
    }
}

@Composable
private fun ExtraKeysBar(
    enabledKeys: List<ExtraKeyId>,
    ctrlSticky: Boolean,
    altSticky: Boolean,
    shiftSticky: Boolean,
    onCtrl: () -> Unit,
    onAlt: () -> Unit,
    onShift: () -> Unit,
    onBytes: (ByteArray) -> Unit,
    onText: (String) -> Unit,
    onPaste: () -> Unit,
    onCopy: () -> Unit,
    onScrollUp: () -> Unit,
    onScrollDown: () -> Unit,
) {
    // Match ZeroTopBar chrome transparency so bottom keys bar blends the same way.
    val transparency = LocalChromeTransparency.current.topBar.coerceIn(0f, 0.8f)
    val containerAlpha = 1f - transparency
    val keys = enabledKeys.ifEmpty { ExtraKeyId.DEFAULT_ENABLED }
    Surface(
        color = MaterialTheme.colorScheme.background.copy(alpha = containerAlpha),
        contentColor = MaterialTheme.colorScheme.onBackground,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(44.dp)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            keys.forEach { id ->
                when (id) {
                    ExtraKeyId.ESC -> KeyBtn("Esc") { onBytes(TermKeys.esc()) }
                    ExtraKeyId.TAB -> KeyBtn("Tab") { onBytes(TermKeys.tab()) }
                    ExtraKeyId.CTRL -> KeyBtn(stringResource(R.string.terminal_key_ctrl), highlight = ctrlSticky, onClick = onCtrl)
                    ExtraKeyId.ALT -> KeyBtn(stringResource(R.string.terminal_key_alt), highlight = altSticky, onClick = onAlt)
                    ExtraKeyId.SHIFT -> KeyBtn(stringResource(R.string.terminal_key_shift), highlight = shiftSticky, onClick = onShift)
                    ExtraKeyId.ENTER -> KeyBtn(stringResource(R.string.terminal_key_enter)) { onBytes(TermKeys.enter()) }
                    ExtraKeyId.BACKSPACE -> KeyBtn(stringResource(R.string.terminal_key_backspace)) { onBytes(TermKeys.backspace()) }
                    ExtraKeyId.DELETE -> KeyBtn(stringResource(R.string.terminal_key_delete)) { onBytes(TermKeys.delete()) }
                    ExtraKeyId.INSERT -> KeyBtn(stringResource(R.string.terminal_key_insert)) { onBytes(TermKeys.insert()) }
                    ExtraKeyId.UP -> KeyBtn("↑") { onBytes(TermKeys.up()) }
                    ExtraKeyId.DOWN -> KeyBtn("↓") { onBytes(TermKeys.down()) }
                    ExtraKeyId.LEFT -> KeyBtn("←") { onBytes(TermKeys.left()) }
                    ExtraKeyId.RIGHT -> KeyBtn("→") { onBytes(TermKeys.right()) }
                    ExtraKeyId.HOME -> KeyBtn(stringResource(R.string.terminal_key_home)) { onBytes(TermKeys.home()) }
                    ExtraKeyId.END -> KeyBtn(stringResource(R.string.terminal_key_end)) { onBytes(TermKeys.end()) }
                    ExtraKeyId.PGUP -> KeyBtn(stringResource(R.string.terminal_key_pgup)) { onBytes(TermKeys.pgUp()) }
                    ExtraKeyId.PGDN -> KeyBtn(stringResource(R.string.terminal_key_pgdn)) { onBytes(TermKeys.pgDn()) }
                    ExtraKeyId.SCR_UP -> KeyBtn(stringResource(R.string.terminal_key_scr_up), onClick = onScrollUp)
                    ExtraKeyId.SCR_DOWN -> KeyBtn(stringResource(R.string.terminal_key_scr_down), onClick = onScrollDown)
                    ExtraKeyId.COPY -> KeyBtn(stringResource(R.string.terminal_key_copy), onClick = onCopy)
                    ExtraKeyId.PASTE -> KeyBtn(stringResource(R.string.terminal_key_paste), onClick = onPaste)
                    ExtraKeyId.F1 -> KeyBtn("F1") { onBytes(TermKeys.f1()) }
                    ExtraKeyId.F2 -> KeyBtn("F2") { onBytes(TermKeys.f2()) }
                    ExtraKeyId.F3 -> KeyBtn("F3") { onBytes(TermKeys.f3()) }
                    ExtraKeyId.F4 -> KeyBtn("F4") { onBytes(TermKeys.f4()) }
                    ExtraKeyId.F5 -> KeyBtn("F5") { onBytes(TermKeys.f5()) }
                    ExtraKeyId.F6 -> KeyBtn("F6") { onBytes(TermKeys.f6()) }
                    ExtraKeyId.F7 -> KeyBtn("F7") { onBytes(TermKeys.f7()) }
                    ExtraKeyId.F8 -> KeyBtn("F8") { onBytes(TermKeys.f8()) }
                    ExtraKeyId.F9 -> KeyBtn("F9") { onBytes(TermKeys.f9()) }
                    ExtraKeyId.F10 -> KeyBtn("F10") { onBytes(TermKeys.f10()) }
                    ExtraKeyId.F11 -> KeyBtn("F11") { onBytes(TermKeys.f11()) }
                    ExtraKeyId.F12 -> KeyBtn("F12") { onBytes(TermKeys.f12()) }
                }
            }
        }
    }
}

@Composable
private fun KeyBtn(label: String, highlight: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Surface(
        onClick = onClick,
        shape = shape,
        color = if (highlight) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            Color.Transparent
        },
        contentColor = if (highlight) {
            MaterialTheme.colorScheme.onPrimaryContainer
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        border = if (highlight) {
            BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.55f))
        } else {
            null
        },
        modifier = Modifier.height(36.dp),
    ) {
        Box(
            modifier = Modifier.padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = if (highlight) FontWeight.SemiBold else FontWeight.Medium,
            )
        }
    }
}
