package com.zeroterm.android.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.ActiveSession
import com.zeroterm.android.data.SessionManager
import com.zeroterm.android.data.TmuxCommands
import com.zeroterm.android.data.TmuxSession
import com.zeroterm.android.data.TmuxState
import com.zeroterm.android.data.parseTmuxState
import com.zeroterm.android.data.validTmuxName
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun TmuxPanel(sessions: SessionManager, visible: Boolean, onEntered: () -> Unit) {
    val active by sessions.active.collectAsState()
    key(active?.sessionId) {
        val session = active
        if (session == null) {
            Text(stringResource(R.string.tmux_disconnected), modifier = Modifier.padding(24.dp))
        } else {
            ConnectedTmuxPanel(sessions, session, visible, onEntered)
        }
    }
}

@Composable
private fun ConnectedTmuxPanel(
    sessions: SessionManager,
    session: ActiveSession,
    visible: Boolean,
    onEntered: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val commands = remember { TmuxCommands(session.tmuxClientOption) }
    var state by remember { mutableStateOf<TmuxState?>(null) }
    var loading by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var nameDialog by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<TmuxSession?>(null) }
    var name by remember { mutableStateOf("") }
    var killTarget by remember { mutableStateOf<TmuxSession?>(null) }
    val commandFailed = stringResource(R.string.tmux_command_failed)
    val enterFailed = stringResource(R.string.tmux_enter_failed)

    suspend fun execute(command: String): String {
        val result = sessions.execCommand(command, session.sessionId).getOrThrow()
        check(result.code == 0) {
            result.stderr.trim().ifBlank { result.stdout.trim() }.ifBlank { commandFailed }
        }
        return result.stdout
    }

    suspend fun readState(): TmuxState = parseTmuxState(execute(commands.list))

    suspend fun refresh() {
        if (loading || busy) return
        loading = true
        try {
            state = readState()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failed refresh must not leave stale actions available.
            state = null
            error = e.message ?: commandFailed
        } finally {
            loading = false
        }
    }

    fun runAction(action: suspend () -> Unit) {
        if (busy || loading) return
        busy = true
        error = null
        scope.launch {
            try {
                action()
                state = readState()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: commandFailed
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(visible) {
        if (visible) refresh()
    }

    val enabled = state?.version?.isNotEmpty() == true && !busy && !loading
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.tmux_title), style = MaterialTheme.typography.titleLarge)
                Text(
                    state?.version?.takeIf { it.isNotEmpty() }?.let { "tmux $it" }
                        ?: stringResource(if (state == null) R.string.tmux_subtitle else R.string.tmux_missing),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (loading || busy) {
                CircularProgressIndicator(Modifier.padding(12.dp).size(24.dp))
            } else {
                IconButton(onClick = { scope.launch { refresh() } }) {
                    Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.common_refresh))
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { renameTarget = null; name = ""; nameDialog = true },
                enabled = enabled,
            ) { Text(stringResource(R.string.tmux_new)) }
            TextButton(
                onClick = {
                    runAction {
                        val current = readState().currentClient
                            ?: throw IllegalStateException(commandFailed)
                        execute(commands.detach(current))
                    }
                },
                enabled = enabled && state?.currentClient != null,
            ) { Text(stringResource(R.string.tmux_detach)) }
        }
        error?.let {
            Text(
                stringResource(R.string.tmux_error, it),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(16.dp),
            )
        }
        val current = state
        if (current != null && current.version.isEmpty()) {
            Text(stringResource(R.string.tmux_missing_hint), modifier = Modifier.padding(24.dp))
        } else if (current != null) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    Text(
                        stringResource(R.string.tmux_shell_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(4.dp),
                    )
                }
                if (current.sessions.isEmpty()) item {
                    Text(stringResource(R.string.tmux_empty), modifier = Modifier.padding(12.dp))
                }
                items(current.sessions, key = { it.id }) { tmux ->
                    TmuxSessionCard(
                        session = tmux,
                        current = current.currentClient?.sessionId == tmux.id,
                        enabled = enabled,
                        onEnter = {
                            runAction {
                                val fresh = readState()
                                if (fresh.currentClient != null) {
                                    execute(commands.enter(tmux, fresh.currentClient))
                                } else {
                                    val script = execute(commands.prepareAttach(tmux)).trim()
                                    try {
                                        sessions.sendSessionText(session.sessionId, commands.attach(script)).getOrThrow()
                                        var attached = false
                                        for (attempt in 0 until 10) {
                                            delay(200)
                                            val updated = readState()
                                            state = updated
                                            if (updated.currentClient?.sessionId == tmux.id) {
                                                attached = true
                                                break
                                            }
                                        }
                                        check(attached) { enterFailed }
                                    } finally {
                                        // Also remove an unconsumed launcher after a failed send
                                        // or navigation away during attach.
                                        withContext(NonCancellable) {
                                            runCatching { execute(commands.discardAttach(script)) }
                                        }
                                    }
                                }
                                onEntered()
                            }
                        },
                        onRename = { renameTarget = tmux; name = tmux.name; nameDialog = true },
                        onKill = { killTarget = tmux },
                    )
                }
            }
        }
    }

    if (nameDialog) {
        val valid = validTmuxName(name.trim())
        AlertDialog(
            onDismissRequest = { nameDialog = false },
            title = { Text(stringResource(if (renameTarget == null) R.string.tmux_new else R.string.common_rename)) },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.tmux_name)) },
                    singleLine = true,
                    isError = name.isNotEmpty() && !valid,
                    supportingText = { Text(stringResource(R.string.tmux_name_hint)) },
                )
            },
            confirmButton = {
                TextButton(
                    enabled = valid && enabled,
                    onClick = {
                        val target = renameTarget
                        val newName = name.trim()
                        nameDialog = false
                        runAction { execute(if (target == null) commands.create(newName) else commands.rename(target, newName)) }
                    },
                ) { Text(stringResource(if (renameTarget == null) R.string.common_create else R.string.common_save)) }
            },
            dismissButton = {
                TextButton(onClick = { nameDialog = false }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
    killTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { killTarget = null },
            title = { Text(stringResource(R.string.tmux_kill)) },
            text = { Text(stringResource(R.string.tmux_kill_confirm, target.name)) },
            confirmButton = {
                TextButton(
                    enabled = enabled,
                    onClick = { killTarget = null; runAction { execute(commands.kill(target)) } },
                ) { Text(stringResource(R.string.tmux_kill), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { killTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
}

@Composable
private fun TmuxSessionCard(
    session: TmuxSession,
    current: Boolean,
    enabled: Boolean,
    onEnter: () -> Unit,
    onRename: () -> Unit,
    onKill: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(session.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(R.string.tmux_windows, session.windows) + " · " +
                    stringResource(
                        when {
                            current -> R.string.tmux_current
                            session.attachedClients > 0 -> R.string.tmux_attached
                            else -> R.string.tmux_detached
                        },
                    ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onEnter, enabled = enabled && !current, modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.tmux_enter))
                }
                Column {
                    IconButton(onClick = { menuOpen = true }, enabled = enabled) {
                        Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.tmux_actions, session.name))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.common_rename)) },
                            enabled = enabled,
                            onClick = { menuOpen = false; onRename() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.tmux_kill), color = MaterialTheme.colorScheme.error) },
                            enabled = enabled,
                            onClick = { menuOpen = false; onKill() },
                        )
                    }
                }
            }
        }
    }
}
