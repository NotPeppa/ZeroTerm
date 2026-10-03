package com.zeroterm.android.ui.terminal

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.FirewallStatus
import com.zeroterm.android.data.PortCommands
import com.zeroterm.android.data.ServiceCommands
import com.zeroterm.android.data.SessionManager
import com.zeroterm.android.data.SystemService
import com.zeroterm.android.data.parseFirewallStatus
import com.zeroterm.android.data.parseListeningPorts
import com.zeroterm.android.data.parseSystemServices
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private class HostPanelState(
    private val sessions: SessionManager,
    private val sessionId: ULong?,
    private val listCommand: String,
    private val failure: String,
) {
    var output by mutableStateOf("")
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    private suspend fun execute(command: String): String {
        check(sessionId != null) { failure }
        val result = sessions.execCommand(command, sessionId).getOrThrow()
        check(result.code == 0) { result.stderr.trim().ifBlank { result.stdout.trim() }.ifBlank { failure } }
        return result.stdout
    }

    suspend fun refresh() = perform(listCommand, refreshAfter = false) { output = it }

    suspend fun perform(command: String, refreshAfter: Boolean = true, onOutput: (String) -> Unit = {}) {
        if (busy) return
        busy = true
        error = null
        try {
            onOutput(execute(command))
            if (refreshAfter) {
                delay(300)
                output = execute(listCommand)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: failure
        } finally {
            busy = false
        }
    }
}

@Composable
private fun rememberHostPanelState(sessions: SessionManager, visible: Boolean, command: String): HostPanelState {
    val active by sessions.active.collectAsState()
    val failure = stringResource(R.string.host_management_failed)
    val state = remember(active?.sessionId, command) { HostPanelState(sessions, active?.sessionId, command, failure) }
    LaunchedEffect(state, visible) { if (visible) state.refresh() }
    return state
}

@Composable
internal fun ServicesPanel(sessions: SessionManager, visible: Boolean) {
    val scope = rememberCoroutineScope()
    val panel = rememberHostPanelState(sessions, visible, ServiceCommands.list)
    var query by remember { mutableStateOf("") }
    var userServicesExpanded by rememberSaveable { mutableStateOf(false) }
    var systemServicesExpanded by rememberSaveable { mutableStateOf(false) }
    var confirmation by remember { mutableStateOf<Pair<SystemService, String>?>(null) }
    var detail by remember { mutableStateOf<Pair<String, String>?>(null) }
    val rows = remember(panel.output) { parseSystemServices(panel.output) }
    val filtered = rows.filter { query.isBlank() || "${it.name} ${it.description} ${it.activeState}".contains(query.trim(), ignoreCase = true) }
    val emptyOutput = stringResource(R.string.host_management_no_output)

    Column(Modifier.fillMaxSize()) {
        ManagementHeader(stringResource(R.string.services_title), stringResource(R.string.services_subtitle), panel) { scope.launch { panel.refresh() } }
        OutlinedTextField(
            query, { query = it }, label = { Text(stringResource(R.string.common_search)) },
            singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        )
        panel.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (filtered.isEmpty() && !panel.busy && panel.error == null) item { Text(stringResource(R.string.services_empty)) }
            listOf("user", "system").forEach { group ->
                val groupRows = filtered.filter { it.scope == group }
                val expanded = if (group == "user") userServicesExpanded else systemServicesExpanded
                if (groupRows.isNotEmpty()) item(key = "service-group:$group") {
                    ManagementGroupHeader(
                        title = stringResource(if (group == "user") R.string.services_user else R.string.services_system),
                        count = groupRows.size,
                        expanded = expanded,
                    ) {
                        if (group == "user") userServicesExpanded = !expanded
                        else systemServicesExpanded = !expanded
                    }
                }
                items(if (expanded) groupRows else emptyList(), key = { "${it.scope}:${it.name}" }) { service ->
                    var menu by remember { mutableStateOf(false) }
                    Card(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(service.name.removeSuffix(".service"), style = MaterialTheme.typography.titleSmall)
                                Text(service.description, style = MaterialTheme.typography.bodySmall)
                                val running = service.activeState == "active"
                                val failed = service.activeState == "failed"
                                Text(
                                    stringResource(if (running) R.string.services_running else if (failed) R.string.services_failed else R.string.services_stopped) + " · ${service.subState}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                )
                            }
                            Column {
                                IconButton(onClick = { menu = true }, enabled = !panel.busy) {
                                    Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_more))
                                }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    val actions = if (service.activeState == "active") listOf("restart", "stop") else listOf("start")
                                    actions.forEach { action ->
                                        DropdownMenuItem(text = { Text(serviceActionLabel(action)) }, onClick = {
                                            menu = false
                                            if (action == "start") scope.launch { panel.perform(ServiceCommands.action(service, action)) }
                                            else confirmation = service to action
                                        })
                                    }
                                    DropdownMenuItem(text = { Text(stringResource(R.string.services_logs)) }, onClick = {
                                        menu = false
                                        scope.launch { panel.perform(ServiceCommands.logs(service), false) { detail = service.name to it.ifBlank { emptyOutput } } }
                                    })
                                    DropdownMenuItem(text = { Text(stringResource(R.string.services_details)) }, onClick = {
                                        menu = false
                                        scope.launch { panel.perform(ServiceCommands.detail(service), false) { detail = service.name to it.ifBlank { emptyOutput } } }
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    confirmation?.let { (service, action) ->
        val label = serviceActionLabel(action)
        AlertDialog(
            onDismissRequest = { confirmation = null },
            title = { Text(label) },
            text = { Text(stringResource(R.string.services_confirm_action, label, service.name)) },
            confirmButton = { TextButton(onClick = { confirmation = null; scope.launch { panel.perform(ServiceCommands.action(service, action)) } }) { Text(label) } },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    detail?.let { (title, content) ->
        AlertDialog(
            onDismissRequest = { detail = null },
            title = { Text(title) },
            text = { SelectionContainer { Text(content, fontFamily = FontFamily.Monospace, modifier = Modifier.verticalScroll(rememberScrollState())) } },
            confirmButton = { TextButton(onClick = { detail = null }) { Text(stringResource(R.string.common_close)) } },
        )
    }
}

@Composable
private fun serviceActionLabel(action: String): String = stringResource(when (action) {
    "start" -> R.string.services_start
    "stop" -> R.string.services_stop
    else -> R.string.services_restart
})

@Composable
internal fun PortsPanel(sessions: SessionManager, visible: Boolean) {
    val scope = rememberCoroutineScope()
    val panel = rememberHostPanelState(sessions, visible, PortCommands.list)
    val context = LocalContext.current
    val firewallCommand = remember(context) {
        context.resources.openRawResource(R.raw.firewall_status).bufferedReader().use { it.readText() }
    }
    val firewall = rememberHostPanelState(sessions, visible, firewallCommand)
    val firewallStatus = remember(firewall.output, firewall.error) {
        if (firewall.error != null) FirewallStatus() else parseFirewallStatus(firewall.output)
    }
    var query by remember { mutableStateOf("") }
    var tcpExpanded by rememberSaveable { mutableStateOf(true) }
    var udpExpanded by rememberSaveable { mutableStateOf(true) }
    var confirmation by remember { mutableStateOf<Pair<List<Long>, Boolean>?>(null) }
    val rows = remember(panel.output) { parseListeningPorts(panel.output) }
    val filtered = rows.filter { query.isBlank() || "${it.protocol} ${it.port} ${it.addresses.joinToString()} ${it.processes.joinToString { p -> "${p.name} ${p.pid}" }}".contains(query.trim(), ignoreCase = true) }

    Column(Modifier.fillMaxSize()) {
        ManagementHeader(stringResource(R.string.ports_title), stringResource(R.string.ports_subtitle), panel, busy = panel.busy || firewall.busy) {
            scope.launch { panel.refresh() }
            scope.launch { firewall.refresh() }
        }
        OutlinedTextField(
            query, { query = it }, label = { Text(stringResource(R.string.common_search)) },
            singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        )
        panel.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item(key = "firewall") { FirewallCard(firewallStatus, firewall.busy) }
            if (filtered.isEmpty() && !panel.busy && panel.error == null) item { Text(stringResource(R.string.ports_empty)) }
            listOf("tcp", "udp").forEach { protocol ->
                val groupRows = filtered.filter { it.protocol == protocol }
                val expanded = if (protocol == "tcp") tcpExpanded else udpExpanded
                if (groupRows.isNotEmpty()) item(key = "port-group:$protocol") {
                    ManagementGroupHeader(protocol.uppercase(), groupRows.size, expanded) {
                        if (protocol == "tcp") tcpExpanded = !expanded else udpExpanded = !expanded
                    }
                }
                items(if (expanded) groupRows else emptyList(), key = { "${it.protocol}:${it.port}:${it.addresses.joinToString()}" }) { port ->
                    var menu by remember { mutableStateOf(false) }
                    Card(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("${port.protocol.uppercase()} :${port.port}", style = MaterialTheme.typography.titleSmall)
                                Text(port.addresses.joinToString(" · "), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                                Text(stringResource(if (port.localOnly) R.string.ports_local else R.string.ports_public), style = MaterialTheme.typography.labelMedium)
                                Text(
                                    port.processes.joinToString("\n") { "${it.name} · PID ${it.pid}" }.ifBlank { stringResource(R.string.ports_unknown_process) },
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            val pids = port.processes.map { it.pid }.filter { it > 1 && it <= Int.MAX_VALUE }
                            if (pids.isNotEmpty()) Column {
                                IconButton(onClick = { menu = true }, enabled = !panel.busy) {
                                    Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_more))
                                }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    DropdownMenuItem(text = { Text(stringResource(R.string.ports_terminate)) }, onClick = { menu = false; confirmation = pids to false })
                                    DropdownMenuItem(text = { Text(stringResource(R.string.ports_force_terminate)) }, onClick = { menu = false; confirmation = pids to true })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    confirmation?.let { (pids, force) ->
        AlertDialog(
            onDismissRequest = { confirmation = null },
            title = { Text(stringResource(if (force) R.string.ports_force_terminate else R.string.ports_terminate)) },
            text = { Text(stringResource(R.string.ports_confirm_terminate, pids.joinToString(", "))) },
            confirmButton = { TextButton(onClick = { confirmation = null; scope.launch { panel.perform(PortCommands.terminate(pids, force)) } }) { Text(stringResource(R.string.common_confirm)) } },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

@Composable
private fun ManagementGroupHeader(title: String, count: Int, expanded: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(
                role = Role.Button,
                onClickLabel = stringResource(if (expanded) R.string.common_collapse else R.string.common_expand),
                onClick = onToggle,
            )
            .heightIn(min = 48.dp)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun FirewallCard(firewall: FirewallStatus, busy: Boolean) {
    var rulesExpanded by rememberSaveable { mutableStateOf(false) }
    val statusLabel = stringResource(when (firewall.status) {
        "active" -> R.string.firewall_active
        "inactive" -> R.string.firewall_inactive
        "unavailable" -> R.string.firewall_unavailable
        else -> R.string.firewall_unknown
    })
    val description = when (firewall.status) {
        "active" -> when (firewall.inboundPolicy) {
            "block" -> stringResource(R.string.firewall_policy_block)
            "allow" -> stringResource(R.string.firewall_policy_allow)
            else -> stringResource(R.string.firewall_active_hint)
        }
        "inactive" -> stringResource(R.string.firewall_inactive_hint)
        "unavailable" -> stringResource(R.string.firewall_unavailable_hint)
        else -> stringResource(R.string.firewall_unknown_hint)
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.firewall_title), style = MaterialTheme.typography.titleSmall)
                    if (firewall.backend.isNotBlank() && !busy) {
                        Text(firewall.backend, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (busy) CircularProgressIndicator(Modifier.size(20.dp))
                else Text(
                    statusLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (firewall.status == "active") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                if (busy) stringResource(R.string.firewall_loading) else description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!busy && firewall.status == "active") {
                ManagementGroupHeader(stringResource(R.string.firewall_rules), firewall.rules.size, rulesExpanded) { rulesExpanded = !rulesExpanded }
                if (rulesExpanded) {
                    if (firewall.rules.isEmpty()) Text(stringResource(R.string.firewall_rules_empty), style = MaterialTheme.typography.bodySmall)
                    else SelectionContainer {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            firewall.rules.forEach { rule ->
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(
                                        stringResource(when (rule.action) {
                                            "allow" -> R.string.firewall_rule_allow
                                            "block" -> R.string.firewall_rule_block
                                            else -> R.string.firewall_rule_other
                                        }),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (rule.action == "block") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                    )
                                    Text(rule.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                    if (firewall.rulesTruncated) Text(stringResource(R.string.firewall_rules_truncated, firewall.rules.size), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ManagementHeader(title: String, subtitle: String, panel: HostPanelState, busy: Boolean = panel.busy, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (busy) CircularProgressIndicator(Modifier.padding(12.dp).size(24.dp))
        else IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.common_refresh)) }
    }
}
