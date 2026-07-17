package com.zeroterm.android.ui.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.zeroterm.android.data.HostKeyPrompt
import com.zeroterm.android.data.SessionManager
import com.zeroterm.android.terminal.TermKeys
import com.zeroterm.android.terminal.TerminalHostView
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    hostId: String?,
    hostLabel: String,
    alreadyConnected: Boolean = false,
    sessions: SessionManager,
    fontSizeSp: Float = 13f,
    onFontSizeChanged: (Float) -> Unit = {},
    onOpenSnippets: (() -> Unit)? = null,
    snippetCommand: String? = null,
    onSnippetConsumed: () -> Unit = {},
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val connecting by sessions.connecting.collectAsState()
    val error by sessions.error.collectAsState()
    val active by sessions.active.collectAsState()
    val frameTick by sessions.frameTick.collectAsState()
    var hostKey by remember { mutableStateOf<HostKeyPrompt?>(null) }
    var termView by remember { mutableStateOf<TerminalHostView?>(null) }
    var ctrlSticky by remember { mutableStateOf(false) }
    var lastCols by remember { mutableStateOf(80) }
    var lastRows by remember { mutableStateOf(24) }
    var started by remember { mutableStateOf(false) }
    var disconnectedMsg by remember { mutableStateOf<String?>(null) }
    var hasSelection by remember { mutableStateOf(false) }
    var scrolledBack by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        sessions.hostKeyPrompts.collect { hostKey = it }
    }

    LaunchedEffect(Unit) {
        sessions.closed.collect { (_, msg) ->
            disconnectedMsg = msg ?: "Disconnected"
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

    LaunchedEffect(snippetCommand) {
        val cmd = snippetCommand ?: return@LaunchedEffect
        if (cmd.isNotEmpty()) {
            if (sessions.displayOffset() > 0) {
                sessions.scrollToBottom()
                scrolledBack = false
                refreshPaint()
            }
            sessions.sendText(cmd)
            onSnippetConsumed()
        }
    }

    fun copySelection() {
        val text = termView?.selectedText().orEmpty()
        if (text.isBlank()) {
            // Fall back to full viewport
            val all = sessions.viewportText()
            if (all.isBlank()) {
                Toast.makeText(context, "Nothing to copy", Toast.LENGTH_SHORT).show()
                return
            }
            copyToClipboard(context, all)
            Toast.makeText(context, "Copied screen", Toast.LENGTH_SHORT).show()
        } else {
            copyToClipboard(context, text)
            termView?.clearSelection()
            hasSelection = false
            Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
        }
    }

    fun pasteClipboard() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
        if (text.isNullOrEmpty()) {
            Toast.makeText(context, "Clipboard empty", Toast.LENGTH_SHORT).show()
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

    LaunchedEffect(hostId, lastCols, lastRows, alreadyConnected) {
        if (!started && lastCols >= 2 && lastRows >= 1) {
            started = true
            if (alreadyConnected) {
                // Session already opened by Quick Connect
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

    DisposableEffect(Unit) {
        onDispose {
            scope.launch { sessions.disconnect() }
        }
    }

    hostKey?.let { prompt ->
        AlertDialog(
            onDismissRequest = {
                sessions.respondHostKey(prompt.requestId, false)
                hostKey = null
            },
            title = {
                Text(
                    if (prompt.stored != null) "Host key changed!"
                    else "Unknown host key",
                )
            },
            text = {
                Column {
                    Text("${prompt.info.host}:${prompt.info.port}")
                    Text(prompt.info.keyType)
                    Text(prompt.info.fingerprint, style = MaterialTheme.typography.bodySmall)
                    prompt.stored?.let {
                        Text("Previously: $it", color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    sessions.respondHostKey(prompt.requestId, true)
                    hostKey = null
                }) { Text("Accept") }
            },
            dismissButton = {
                TextButton(onClick = {
                    sessions.respondHostKey(prompt.requestId, false)
                    hostKey = null
                }) { Text("Reject") }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(hostLabel, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = {
                        scope.launch {
                            sessions.disconnect()
                            onBack()
                        }
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (hasSelection) {
                        IconButton(onClick = { copySelection() }) {
                            Icon(Icons.Default.ContentCopy, contentDescription = "Copy")
                        }
                    }
                    if (scrolledBack) {
                        IconButton(onClick = {
                            sessions.scrollToBottom()
                            scrolledBack = false
                            refreshPaint()
                        }) {
                            Icon(Icons.Default.VerticalAlignBottom, contentDescription = "Bottom")
                        }
                    }
                    IconButton(onClick = { pasteClipboard() }) {
                        Icon(Icons.Default.ContentPaste, contentDescription = "Paste")
                    }
                    if (onOpenSnippets != null) {
                        IconButton(onClick = onOpenSnippets) {
                            Icon(Icons.Default.Code, contentDescription = "Snippets")
                        }
                    }
                    if (disconnectedMsg != null || (error != null && active == null)) {
                        IconButton(onClick = { doConnect() }) {
                            Icon(Icons.Default.Refresh, contentDescription = "Reconnect")
                        }
                    }
                    IconButton(onClick = { termView?.showIme() }) {
                        Icon(Icons.Default.Keyboard, contentDescription = "Keyboard")
                    }
                    IconButton(onClick = {
                        scope.launch {
                            sessions.disconnect()
                            onBack()
                        }
                    }) {
                        Icon(Icons.Default.Close, contentDescription = "Disconnect")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(Color(0xFF0B1220)),
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
                        Button(onClick = { doConnect() }) {
                            Text("Reconnect")
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(
                    factory = { ctx ->
                        TerminalHostView(ctx).also { v ->
                            termView = v
                            v.setFontSizeSp(fontSizeSp)
                            v.onFontSizeChanged = onFontSizeChanged
                            if (alreadyConnected) {
                                sessions.snapshot()?.let { v.applyFrame(it) }
                            }
                            v.onTextInput = { text ->
                                scope.launch {
                                    if (sessions.displayOffset() > 0) {
                                        sessions.scrollToBottom()
                                        scrolledBack = false
                                        refreshPaint()
                                    }
                                    if (ctrlSticky && text.length == 1) {
                                        val ch = text[0]
                                        if (ch in 'a'..'z' || ch in 'A'..'Z') {
                                            sessions.sendInput(TermKeys.ctrl(ch))
                                            ctrlSticky = false
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
                                        scrolledBack = false
                                        refreshPaint()
                                    }
                                    sessions.sendInput(bytes)
                                }
                            }
                            v.onSizeChangedCells = { c, r ->
                                if (c != lastCols || r != lastRows) {
                                    lastCols = c
                                    lastRows = r
                                    if (active != null) {
                                        scope.launch {
                                            sessions.resize(c.toUShort(), r.toUShort())
                                        }
                                    }
                                }
                            }
                            v.onScrollLines = { delta ->
                                // Finger drag down (positive y) → older history
                                sessions.scrollDisplay(delta)
                                scrolledBack = sessions.displayOffset() > 0
                                refreshPaint()
                            }
                            v.onSelectionChanged = { hasSelection = it }
                        }
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
                        Button(onClick = { doConnect() }, modifier = Modifier.padding(top = 8.dp)) {
                            Text("Retry")
                        }
                    }
                }
            }
            ExtraKeysBar(
                ctrlSticky = ctrlSticky,
                onCtrl = { ctrlSticky = !ctrlSticky },
                onBytes = { scope.launch { sessions.sendInput(it) } },
                onText = { scope.launch { sessions.sendText(it) } },
                onPaste = { pasteClipboard() },
                onCopy = { copySelection() },
                onScrollUp = {
                    sessions.scrollDisplay(5)
                    scrolledBack = true
                    refreshPaint()
                },
                onScrollDown = {
                    sessions.scrollDisplay(-5)
                    scrolledBack = sessions.displayOffset() > 0
                    refreshPaint()
                },
            )
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
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
            KeyBtn("Copy") { onCopy() }
            KeyBtn("Paste") { onPaste() }
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
