package com.zeroterm.android.ui.forward

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.ForwardFormProblem
import com.zeroterm.android.data.PortForwardDraft
import com.zeroterm.android.data.PortForwardManager
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.android.data.forwardEndpoint
import com.zeroterm.android.ui.components.ZeroEmptyState
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.ForwardKind
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.PortForwardInput
import com.zeroterm.ffi.PortForwardRecord
import kotlinx.coroutines.launch

@Composable
fun PortForwardScreen(manager: PortForwardManager, repository: ZeroTermRepository, onOpenNavigation: () -> Unit) {
    val rules by manager.rules.collectAsState()
    val hosts by repository.hosts.collectAsState()
    val busy by manager.busy.collectAsState()
    val error by manager.error.collectAsState()
    val scope = rememberCoroutineScope()
    var search by rememberSaveable { mutableStateOf("") }
    var editing by remember { mutableStateOf<PortForwardRecord?>(null) }
    var editorOpen by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<PortForwardRecord?>(null) }
    var collapsedHostIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
    LaunchedEffect(manager) { manager.refresh() }
    val filtered = rules.filter {
        search.isBlank() || "${it.hostName} ${it.bindAddr} ${it.bindPort} ${it.targetHost} ${it.targetPort} ${it.kind}".contains(search.trim(), ignoreCase = true)
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        topBar = {
            ZeroTopBar(
                title = stringResource(R.string.port_forward_title),
                navigationIcon = { IconButton(onClick = onOpenNavigation) { Icon(Icons.Default.Menu, stringResource(R.string.common_menu)) } },
                actions = { IconButton(onClick = { scope.launch { repository.refreshHosts(); manager.refresh() } }) { Icon(Icons.Default.Refresh, stringResource(R.string.common_refresh)) } },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { editing = null; editorOpen = true; manager.clearError() }) {
                Icon(Icons.Default.Add, stringResource(R.string.port_forward_create))
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(start = 16.dp, top = 16.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.port_forward_subtitle), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(search, { search = it }, label = { Text(stringResource(R.string.common_search)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            error?.let { message ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    IconButton(onClick = manager::clearError) { Icon(Icons.Default.Close, stringResource(R.string.common_close)) }
                }
            }
            if (filtered.isEmpty()) ZeroEmptyState(
                title = stringResource(if (rules.isEmpty()) R.string.port_forward_empty else R.string.port_forward_no_match),
                description = stringResource(if (rules.isEmpty()) R.string.port_forward_empty_hint else R.string.port_forward_no_match_hint),
                icon = Icons.Default.SwapHoriz,
            ) else LazyColumn(contentPadding = PaddingValues(bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                filtered.groupBy { it.hostId }.entries.sortedBy { it.value.first().hostName }.forEach { (hostId, hostRules) ->
                    val expanded = hostId !in collapsedHostIds
                    item(key = "host:$hostId") {
                        Row(
                            Modifier.fillMaxWidth().clickable(
                                role = Role.Button,
                                onClickLabel = stringResource(if (expanded) R.string.common_collapse else R.string.common_expand),
                            ) { collapsedHostIds = if (expanded) collapsedHostIds + hostId else collapsedHostIds - hostId }
                                .heightIn(min = 48.dp).padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
                            Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                                Text(hostRules.first().hostName.ifBlank { hosts.firstOrNull { it.id == hostId }?.host.orEmpty() }, style = MaterialTheme.typography.titleSmall)
                                Text(stringResource(R.string.port_forward_group_summary, hostRules.size, hostRules.count { it.state != "stopped" }), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    items(if (expanded) hostRules else emptyList(), key = { it.id }) { rule ->
                        ForwardCard(rule, busy[rule.id], onStart = { manager.start(rule.id) }, onStop = { manager.stop(rule.id) },
                            onEdit = { editing = rule; editorOpen = true; manager.clearError() }, onDelete = { deleting = rule })
                    }
                }
            }
        }
    }
    if (editorOpen) ForwardEditor(
        rule = editing, hosts = hosts, saving = busy[editing?.id ?: "new"] == "save", error = error,
        onDismiss = { editorOpen = false },
        onSave = { input -> scope.launch { if (manager.save(input).isSuccess) editorOpen = false } },
    )
    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(R.string.port_forward_delete_title)) },
            text = { Text(stringResource(R.string.port_forward_delete_hint)) },
            confirmButton = { TextButton(onClick = { deleting = null; manager.delete(rule.id) }) { Text(stringResource(R.string.common_delete)) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

@Composable
private fun ForwardCard(rule: PortForwardRecord, operation: String?, onStart: () -> Unit, onStop: () -> Unit, onEdit: () -> Unit, onDelete: () -> Unit) {
    val active = rule.state != "stopped"
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(kindLabel(rule.kind), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(stringResource(when {
                    !rule.enabled -> R.string.port_forward_disabled
                    rule.state == "active" -> R.string.port_forward_active
                    rule.state == "reconnecting" -> R.string.port_forward_reconnecting
                    rule.state == "starting" -> R.string.port_forward_starting
                    else -> R.string.port_forward_stopped
                }), style = MaterialTheme.typography.labelMedium, color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val bind = forwardEndpoint(rule.bindAddr, rule.bindPort)
            val target = forwardEndpoint(rule.targetHost, rule.targetPort)
            Text(stringResource(when (rule.kind) {
                ForwardKind.LOCAL -> R.string.port_forward_route_local
                ForwardKind.REMOTE -> R.string.port_forward_route_remote
                ForwardKind.DYNAMIC -> R.string.port_forward_route_dynamic
            }, bind, target), style = MaterialTheme.typography.bodySmall)
            rule.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(
                    onClick = if (active) onStop else onStart,
                    enabled = rule.enabled && (operation == null || (active && operation == "start")),
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(if (active) R.string.port_forward_stop else R.string.port_forward_start)) }
                IconButton(onClick = onEdit, enabled = operation == null) { Icon(Icons.Default.Edit, stringResource(R.string.common_edit)) }
                IconButton(onClick = onDelete, enabled = operation == null) { Icon(Icons.Default.Delete, stringResource(R.string.common_delete)) }
            }
        }
    }
}

@Composable
internal fun ForwardEditor(rule: PortForwardRecord?, hosts: List<HostSummary>, saving: Boolean, error: String? = null, onDismiss: () -> Unit, onSave: (PortForwardInput) -> Unit) {
    var hostId by rememberSaveable(rule?.id) { mutableStateOf(rule?.hostId ?: hosts.firstOrNull()?.id.orEmpty()) }
    var kind by rememberSaveable(rule?.id) { mutableStateOf(rule?.kind ?: ForwardKind.LOCAL) }
    var bind by rememberSaveable(rule?.id) { mutableStateOf(rule?.bindAddr ?: "127.0.0.1") }
    var bindPort by rememberSaveable(rule?.id) { mutableStateOf(rule?.bindPort?.toString() ?: "8080") }
    var target by rememberSaveable(rule?.id) { mutableStateOf(rule?.targetHost?.takeIf { it.isNotBlank() } ?: "127.0.0.1") }
    var targetPort by rememberSaveable(rule?.id) { mutableStateOf(rule?.targetPort?.takeIf { it > 0u }?.toString() ?: "80") }
    var enabled by rememberSaveable(rule?.id) { mutableStateOf(rule?.enabled ?: true) }
    var attempted by remember { mutableStateOf(false) }
    var hostMenu by remember { mutableStateOf(false) }
    val draft = PortForwardDraft(rule?.id, hostId, kind, bind, bindPort, target, targetPort, enabled)
    val problem = draft.problem()
    AlertDialog(
        modifier = Modifier.testTag("forward-editor"),
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text(stringResource(if (rule == null) R.string.port_forward_create else R.string.port_forward_edit)) },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.port_forward_host), style = MaterialTheme.typography.labelMedium)
                Column {
                    OutlinedButton(onClick = { hostMenu = true }, enabled = !saving, modifier = Modifier.fillMaxWidth()) {
                        Text(hosts.firstOrNull { it.id == hostId }?.let { it.name.ifBlank { "${it.user}@${it.host}" } } ?: stringResource(R.string.port_forward_choose_host), modifier = Modifier.weight(1f))
                        Icon(Icons.Default.ExpandMore, null)
                    }
                    DropdownMenu(expanded = hostMenu, onDismissRequest = { hostMenu = false }) {
                        hosts.forEach { host -> DropdownMenuItem(text = { Text(host.name.ifBlank { "${host.user}@${host.host}" }) }, onClick = { hostId = host.id; hostMenu = false }) }
                    }
                }
                if (hosts.isEmpty()) Text(stringResource(R.string.port_forward_no_hosts), color = MaterialTheme.colorScheme.error)
                ForwardKind.entries.forEach { option ->
                    Row(Modifier.fillMaxWidth().selectable(selected = kind == option, enabled = !saving, role = Role.RadioButton, onClick = { kind = option }), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = kind == option, onClick = null, enabled = !saving)
                        Text(kindLabel(option), modifier = Modifier.padding(start = 8.dp))
                    }
                }
                Text(stringResource(when (kind) {
                    ForwardKind.LOCAL -> R.string.port_forward_hint_local
                    ForwardKind.REMOTE -> R.string.port_forward_hint_remote
                    ForwardKind.DYNAMIC -> R.string.port_forward_hint_dynamic
                }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(bind, { bind = it }, label = { Text(stringResource(if (kind == ForwardKind.REMOTE) R.string.port_forward_bind_remote else R.string.port_forward_bind_local)) }, singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(bindPort, { bindPort = it }, label = { Text(stringResource(R.string.port_forward_bind_port)) }, singleLine = true, enabled = !saving, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                if (kind != ForwardKind.DYNAMIC) {
                    OutlinedTextField(target, { target = it }, label = { Text(stringResource(if (kind == ForwardKind.REMOTE) R.string.port_forward_target_local else R.string.port_forward_target_remote)) }, singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(targetPort, { targetPort = it }, label = { Text(stringResource(R.string.port_forward_target_port)) }, singleLine = true, enabled = !saving, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                }
                Row(Modifier.fillMaxWidth().toggleable(value = enabled, enabled = !saving, role = Role.Checkbox, onValueChange = { enabled = it }), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enabled, onCheckedChange = null, enabled = !saving)
                    Text(stringResource(R.string.port_forward_enabled), modifier = Modifier.padding(start = 8.dp))
                }
                if (rule?.state != null && rule.state != "stopped") Text(stringResource(R.string.port_forward_edit_running), style = MaterialTheme.typography.bodySmall)
                if (attempted && problem != null) Text(stringResource(when (problem) {
                    ForwardFormProblem.Host -> R.string.port_forward_choose_host
                    ForwardFormProblem.BindAddress -> R.string.port_forward_invalid_bind
                    ForwardFormProblem.BindPort -> R.string.port_forward_invalid_bind_port
                    ForwardFormProblem.TargetAddress -> R.string.port_forward_invalid_target
                    ForwardFormProblem.TargetPort -> R.string.port_forward_invalid_target_port
                }), color = MaterialTheme.colorScheme.error)
                if (problem == null) error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(enabled = !saving && hosts.isNotEmpty(), onClick = { attempted = true; if (problem == null) onSave(draft.input()) }) { Text(stringResource(R.string.common_save)) } },
        dismissButton = { TextButton(enabled = !saving, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

@Composable
private fun kindLabel(kind: ForwardKind): String = stringResource(when (kind) {
    ForwardKind.LOCAL -> R.string.port_forward_kind_local
    ForwardKind.REMOTE -> R.string.port_forward_kind_remote
    ForwardKind.DYNAMIC -> R.string.port_forward_kind_dynamic
})

@Composable
fun ForwardHostKeyDialog(manager: PortForwardManager) {
    val prompt by manager.hostKeyPrompt.collectAsState()
    prompt?.let { key ->
        AlertDialog(
            onDismissRequest = { manager.respondHostKey(key.requestId, false) },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(if (key.stored == null) R.string.terminal_host_key_unknown else R.string.terminal_host_key_changed)) },
            text = { Column {
                Text("${key.info.host}:${key.info.port}")
                Text(key.info.keyType)
                Text(key.info.fingerprint, style = MaterialTheme.typography.bodySmall)
                key.stored?.let { Text(stringResource(R.string.terminal_previously, it), color = MaterialTheme.colorScheme.error) }
            } },
            confirmButton = { TextButton(onClick = { manager.respondHostKey(key.requestId, true) }) { Text(stringResource(R.string.common_accept)) } },
            dismissButton = { TextButton(onClick = { manager.respondHostKey(key.requestId, false) }) { Text(stringResource(R.string.common_reject)) } },
        )
    }
}
