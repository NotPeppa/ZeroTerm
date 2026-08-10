package com.zeroterm.android.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.SessionManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

private data class MetricDisk(val mount: String, val total: Long, val used: Long)
private data class MetricNetwork(val name: String, val rx: Long, val tx: Long)
private data class HostMetrics(
    val host: String,
    val os: String,
    val arch: String,
    val uptime: Long,
    val cores: Int,
    val cpu: Float,
    val memoryTotal: Long,
    val memoryUsed: Long,
    val swapTotal: Long,
    val swapUsed: Long,
    val disks: List<MetricDisk>,
    val networks: List<MetricNetwork>,
)

@Composable
internal fun MetricsPanel(sessions: SessionManager) {
    val scope = rememberCoroutineScope()
    var metrics by remember { mutableStateOf<HostMetrics?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    suspend fun refresh(silent: Boolean) {
        if (!silent) loading = true
        sessions.execCommand(METRICS_SCRIPT).fold(
            onSuccess = { result ->
                runCatching { parseMetrics(result.stdout) }.fold(
                    onSuccess = { metrics = it; error = null },
                    onFailure = { error = it.message },
                )
            },
            onFailure = { error = it.message },
        )
        loading = false
    }

    LaunchedEffect(Unit) {
        refresh(false)
        while (true) {
            delay(5_000)
            refresh(true)
        }
    }

    Column(Modifier.fillMaxSize()) {
        PanelHeader(
            title = stringResource(R.string.monitor_title),
            subtitle = stringResource(R.string.monitor_subtitle),
            loading = loading,
            onRefresh = { scope.launch { refresh(false) } },
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        val currentMetrics = metrics
        if (currentMetrics != null) {
            val m = currentMetrics
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            ) {
                item {
                    MetricCard(stringResource(R.string.monitor_system)) {
                        MetricTextRow(stringResource(R.string.monitor_host), m.host)
                        MetricTextRow(stringResource(R.string.monitor_os), "${m.os} · ${m.arch}")
                        MetricTextRow(stringResource(R.string.monitor_uptime), formatUptime(m.uptime))
                    }
                }
                item {
                    MetricCard(stringResource(R.string.monitor_cpu, m.cores)) {
                        MetricBar(stringResource(R.string.monitor_usage), m.cpu)
                    }
                }
                item {
                    MetricCard(stringResource(R.string.monitor_memory)) {
                        MetricBar(
                            stringResource(R.string.monitor_ram),
                            percent(m.memoryUsed, m.memoryTotal),
                            "${formatBytes(m.memoryUsed)} / ${formatBytes(m.memoryTotal)}",
                        )
                        MetricBar(
                            stringResource(R.string.monitor_swap),
                            percent(m.swapUsed, m.swapTotal),
                            "${formatBytes(m.swapUsed)} / ${formatBytes(m.swapTotal)}",
                        )
                    }
                }
                if (m.networks.isNotEmpty()) item {
                    MetricCard(stringResource(R.string.monitor_network)) {
                        m.networks.take(6).forEach {
                            MetricTextRow(it.name, "↑ ${formatBytes(it.tx)}/s  ↓ ${formatBytes(it.rx)}/s")
                        }
                    }
                }
                if (m.disks.isNotEmpty()) item {
                    MetricCard(stringResource(R.string.monitor_disk)) {
                        m.disks.take(8).forEach {
                            MetricBar(it.mount, percent(it.used, it.total), "${formatBytes(it.used)} / ${formatBytes(it.total)}")
                        }
                    }
                }
            }
        } else if (loading) {
            CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(32.dp))
        }
    }
}

private const val DOCKER_UNGROUPED = "::ungrouped"

private enum class DockerStateTone { Ok, Warn, Muted }

private data class DockerContainer(
    val id: String,
    val name: String,
    val image: String,
    val state: String,
    val status: String,
    val ports: String,
    val project: String,
    val service: String = "",
    val configFiles: String = "",
)

private data class DockerInspectDetail(
    val ips: List<String> = emptyList(),
    val compose: String = "",
    val created: String = "",
    val image: String = "",
    val restartPolicy: String = "",
    val cmd: String = "",
    val mounts: List<String> = emptyList(),
    val error: String? = null,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DockerPanel(
    sessions: SessionManager,
    onTerminalCommand: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var containers by remember { mutableStateOf<List<DockerContainer>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var logs by remember { mutableStateOf<Triple<String, String, String>?>(null) }
    var pendingDelete by remember { mutableStateOf<DockerContainer?>(null) }
    var expandedGroups by remember { mutableStateOf(setOf<String>()) }
    var expandedIds by remember { mutableStateOf(setOf<String>()) }
    var details by remember { mutableStateOf<Map<String, DockerInspectDetail>>(emptyMap()) }

    fun shellQuote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"

    fun dockerCmd(args: List<String>): String =
        "docker " + args.joinToString(" ") { shellQuote(it) }

    fun friendlyDockerError(message: String): String {
        return if (
            message.contains("not found", ignoreCase = true) ||
            message.contains("command not found", ignoreCase = true) ||
            message.contains("not recognized", ignoreCase = true) ||
            message.contains("docker daemon", ignoreCase = true) ||
            message.contains("Cannot connect", ignoreCase = true) ||
            message.contains("permission denied", ignoreCase = true)
        ) {
            // resolved at call sites with stringResource when needed; keep raw marker
            "DOCKER_MISSING:$message"
        } else {
            message
        }
    }

    fun execute(
        args: List<String>,
        silent: Boolean = false,
        after: ((String) -> Unit)? = null,
    ) {
        scope.launch {
            if (!silent || containers.isEmpty()) loading = true
            busy = true
            sessions.execCommand(dockerCmd(args)).fold(
                onSuccess = { result ->
                    val message = (result.stderr.ifBlank { result.stdout }).trim()
                    if (result.code == 0) {
                        error = null
                        after?.invoke(result.stdout)
                    } else {
                        error = friendlyDockerError(message.ifBlank { "Exit ${result.code}" })
                    }
                },
                onFailure = { error = it.message },
            )
            loading = false
            busy = false
        }
    }

    fun reload(silent: Boolean = false) {
        execute(listOf("ps", "-a", "--no-trunc", "--format", "{{json .}}"), silent = silent) { output ->
            containers = parseDockerRows(output)
        }
    }

    fun loadDetail(id: String) {
        scope.launch {
            details = details + (id to DockerInspectDetail(error = null))
            sessions.execCommand(dockerCmd(listOf("inspect", "--format", "{{json .}}", id))).fold(
                onSuccess = { result ->
                    if (!expandedIds.contains(id)) return@fold
                    if (result.code != 0) {
                        val msg = (result.stderr.ifBlank { result.stdout }).trim()
                        details = details + (id to DockerInspectDetail(error = msg.ifBlank { "inspect failed" }))
                    } else {
                        details = details + (id to parseDockerInspect(result.stdout))
                    }
                },
                onFailure = {
                    if (expandedIds.contains(id)) {
                        details = details + (id to DockerInspectDetail(error = it.message))
                    }
                },
            )
        }
    }

    fun toggleDetail(id: String) {
        if (expandedIds.contains(id)) {
            expandedIds = expandedIds - id
            details = details - id
        } else {
            expandedIds = expandedIds + id
            loadDetail(id)
        }
    }

    fun toggleGroup(key: String) {
        expandedGroups = if (expandedGroups.contains(key)) expandedGroups - key else expandedGroups + key
    }

    fun groupAction(project: String, op: String) {
        val ids = containers.filter { it.project == project && it.id.isNotBlank() }.map { it.id }
        if (ids.isEmpty()) return
        execute(listOf(op) + ids, silent = true) { reload(silent = true) }
    }

    LaunchedEffect(Unit) { reload() }

    val missingError = stringResource(R.string.docker_error_missing)
    val listErrorTitle = stringResource(R.string.docker_error_list)
    val displayError = error?.let {
        if (it.startsWith("DOCKER_MISSING:")) missingError else it
    }

    pendingDelete?.let { container ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.docker_delete_title)) },
            text = { Text(stringResource(R.string.docker_delete_message, container.name.ifBlank { container.id.take(12) })) },
            confirmButton = {
                TextButton(onClick = {
                    val id = container.id
                    pendingDelete = null
                    expandedIds = expandedIds - id
                    details = details - id
                    execute(listOf("rm", "-f", id), silent = true) { reload(silent = true) }
                }) { Text(stringResource(R.string.common_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    logs?.let { (name, cmd, text) ->
        DockerLogsDialog(
            name = name,
            command = cmd,
            text = text,
            onDismiss = { logs = null },
        )
    }

    Column(Modifier.fillMaxSize()) {
        PanelHeader(
            title = stringResource(R.string.docker_title),
            subtitle = stringResource(R.string.docker_subtitle),
            loading = loading || busy,
            onRefresh = { reload() },
        )
        displayError?.let {
            Text(
                if (error?.startsWith("DOCKER_MISSING:") == true) {
                    "$listErrorTitle\n$it"
                } else {
                    it
                },
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (!loading && containers.isEmpty() && error == null) {
            EmptyPanel(stringResource(R.string.docker_empty))
        } else if (containers.isNotEmpty()) {
            val groups = linkedMapOf<String, List<DockerContainer>>()
            val projectKeys = containers.map { it.project.ifBlank { DOCKER_UNGROUPED } }
                .filter { it != DOCKER_UNGROUPED }
                .distinct()
                .sorted()
            projectKeys.forEach { key ->
                groups[key] = containers.filter { it.project == key }
            }
            val ungrouped = containers.filter { it.project.isBlank() }
            if (ungrouped.isNotEmpty()) groups[DOCKER_UNGROUPED] = ungrouped
            val onlyUngrouped = groups.size == 1 && groups.containsKey(DOCKER_UNGROUPED)

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            ) {
                if (onlyUngrouped) {
                    items(groups[DOCKER_UNGROUPED].orEmpty(), key = { it.id }) { c ->
                        DockerContainerCard(
                            container = c,
                            expanded = expandedIds.contains(c.id),
                            detail = details[c.id],
                            onToggleDetail = { toggleDetail(c.id) },
                            onStart = { execute(listOf("start", c.id), silent = true) { reload(true) } },
                            onStop = { execute(listOf("stop", c.id), silent = true) { reload(true) } },
                            onRestart = { execute(listOf("restart", c.id), silent = true) { reload(true) } },
                            onTerminal = { onTerminalCommand("docker exec -it ${shellQuote(c.id)} sh") },
                            onLogs = {
                                execute(listOf("logs", "--tail", "300", c.id), silent = true) { output ->
                                    logs = Triple(
                                        c.name.ifBlank { c.id.take(12) },
                                        "docker logs --tail 300 ${c.name.ifBlank { c.id.take(12) }}",
                                        output.ifBlank { "(empty)" },
                                    )
                                }
                            },
                            onDelete = { pendingDelete = c },
                        )
                    }
                } else {
                    groups.forEach { (key, rows) ->
                        item(key = "group-$key") {
                            DockerGroupSection(
                                projectKey = key,
                                containers = rows,
                                expanded = expandedGroups.contains(key),
                                expandedIds = expandedIds,
                                details = details,
                                onToggleGroup = { toggleGroup(key) },
                                onGroupStart = { groupAction(key, "start") },
                                onGroupRestart = { groupAction(key, "restart") },
                                onGroupStop = { groupAction(key, "stop") },
                                onToggleDetail = ::toggleDetail,
                                onStart = { id -> execute(listOf("start", id), silent = true) { reload(true) } },
                                onStop = { id -> execute(listOf("stop", id), silent = true) { reload(true) } },
                                onRestart = { id -> execute(listOf("restart", id), silent = true) { reload(true) } },
                                onTerminal = { id -> onTerminalCommand("docker exec -it ${shellQuote(id)} sh") },
                                onLogs = { c ->
                                    execute(listOf("logs", "--tail", "300", c.id), silent = true) { output ->
                                        logs = Triple(
                                            c.name.ifBlank { c.id.take(12) },
                                            "docker logs --tail 300 ${c.name.ifBlank { c.id.take(12) }}",
                                            output.ifBlank { "(empty)" },
                                        )
                                    }
                                },
                                onDelete = { pendingDelete = it },
                            )
                        }
                    }
                }
            }
        } else if (loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
    }
}

@Composable
private fun DockerGroupSection(
    projectKey: String,
    containers: List<DockerContainer>,
    expanded: Boolean,
    expandedIds: Set<String>,
    details: Map<String, DockerInspectDetail>,
    onToggleGroup: () -> Unit,
    onGroupStart: () -> Unit,
    onGroupRestart: () -> Unit,
    onGroupStop: () -> Unit,
    onToggleDetail: (String) -> Unit,
    onStart: (String) -> Unit,
    onStop: (String) -> Unit,
    onRestart: (String) -> Unit,
    onTerminal: (String) -> Unit,
    onLogs: (DockerContainer) -> Unit,
    onDelete: (DockerContainer) -> Unit,
) {
    val ungrouped = projectKey == DOCKER_UNGROUPED
    val total = containers.size
    val running = containers.count { it.state == "running" }
    val tone = when {
        running == 0 -> DockerStateTone.Muted
        running == total -> DockerStateTone.Ok
        else -> DockerStateTone.Warn
    }
    val label = if (ungrouped) stringResource(R.string.hosts_ungrouped) else projectKey
    val configFiles = containers.firstOrNull { it.configFiles.isNotBlank() }?.configFiles.orEmpty()
    var menuOpen by remember { mutableStateOf(false) }

    val groupShape = RoundedCornerShape(12.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(groupShape)
            .border(
                width = 1.5.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.72f),
                shape = groupShape,
            )
            .background(MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.58f)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggleGroup)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(6.dp))
            DockerStateDot(tone)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (configFiles.isNotBlank()) {
                    Text(
                        text = configFiles,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Text(
                text = stringResource(R.string.docker_group_count, running, total),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!ungrouped) {
                Box {
                    IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(32.dp)) {
                        Icon(
                            Icons.Default.MoreVert,
                            contentDescription = stringResource(R.string.docker_group_menu),
                        )
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docker_group_start_all)) },
                            onClick = { menuOpen = false; onGroupStart() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docker_group_restart_all)) },
                            onClick = { menuOpen = false; onGroupRestart() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docker_group_stop_all)) },
                            onClick = { menuOpen = false; onGroupStop() },
                        )
                    }
                }
            }
        }
        if (expanded) {
            Column(
                modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                containers.forEach { c ->
                    DockerContainerCard(
                        container = c,
                        expanded = expandedIds.contains(c.id),
                        detail = details[c.id],
                        onToggleDetail = { onToggleDetail(c.id) },
                        onStart = { onStart(c.id) },
                        onStop = { onStop(c.id) },
                        onRestart = { onRestart(c.id) },
                        onTerminal = { onTerminal(c.id) },
                        onLogs = { onLogs(c) },
                        onDelete = { onDelete(c) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DockerContainerCard(
    container: DockerContainer,
    expanded: Boolean,
    detail: DockerInspectDetail?,
    onToggleDetail: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRestart: () -> Unit,
    onTerminal: () -> Unit,
    onLogs: () -> Unit,
    onDelete: () -> Unit,
) {
    val running = container.state == "running"
    val tone = dockerStateTone(container.state)
    val shape = RoundedCornerShape(12.dp)
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.55f),
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggleDetail),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DockerStateDot(tone)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = container.name.ifBlank { container.id.take(12) },
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                text = container.image,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = container.status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (container.ports.isNotBlank()) {
                Text(
                    text = container.ports,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (running) {
                    DockerActionChip(stringResource(R.string.docker_stop), onClick = onStop)
                    DockerActionChip(stringResource(R.string.docker_restart), onClick = onRestart)
                    DockerActionChip(stringResource(R.string.docker_terminal), onClick = onTerminal)
                } else {
                    DockerActionChip(
                        stringResource(R.string.docker_start),
                        onClick = onStart,
                        success = true,
                    )
                }
                DockerActionChip(stringResource(R.string.docker_logs), onClick = onLogs)
                DockerActionChip(
                    stringResource(R.string.common_delete),
                    onClick = onDelete,
                    danger = true,
                )
            }
            if (expanded) {
                DockerInspectSection(detail)
            }
        }
    }
}

@Composable
private fun DockerInspectSection(detail: DockerInspectDetail?) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.65f))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        when {
            detail == null -> Text(
                stringResource(R.string.docker_detail_loading),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            detail.error != null -> Text(
                detail.error,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
            else -> {
                val none = stringResource(R.string.docker_detail_none)
                DockerDetailRow(
                    stringResource(R.string.docker_detail_ip),
                    detail.ips.joinToString(" · ").ifBlank { none },
                )
                if (detail.compose.isNotBlank()) {
                    DockerDetailRow(stringResource(R.string.docker_detail_compose), detail.compose)
                }
                if (detail.created.isNotBlank()) {
                    DockerDetailRow(stringResource(R.string.docker_detail_created), detail.created)
                }
                if (detail.image.isNotBlank()) {
                    DockerDetailRow(stringResource(R.string.docker_detail_image), detail.image)
                }
                if (detail.restartPolicy.isNotBlank()) {
                    DockerDetailRow(stringResource(R.string.docker_detail_restart), detail.restartPolicy)
                }
                if (detail.cmd.isNotBlank()) {
                    DockerDetailRow(stringResource(R.string.docker_detail_cmd), detail.cmd)
                }
                if (detail.mounts.isNotEmpty()) {
                    Text(
                        stringResource(R.string.docker_detail_mounts),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    detail.mounts.forEach { mount ->
                        Text(
                            text = mount,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DockerDetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(72.dp),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DockerActionChip(
    label: String,
    onClick: () -> Unit,
    success: Boolean = false,
    danger: Boolean = false,
) {
    val contentColor = when {
        danger -> MaterialTheme.colorScheme.error
        success -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurface
    }
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = contentColor.copy(alpha = 0.10f),
        contentColor = contentColor,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun DockerStateDot(tone: DockerStateTone) {
    val color = when (tone) {
        DockerStateTone.Ok -> Color(0xFF34D399)
        DockerStateTone.Warn -> Color(0xFFFBBF24)
        DockerStateTone.Muted -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
    }
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun DockerLogsDialog(
    name: String,
    command: String,
    text: String,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.96f)
                .heightIn(max = 560.dp),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 4.dp,
        ) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.docker_logs_title, name),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = command,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp, bottom = 10.dp),
                )
                SelectionContainer {
                    Text(
                        text = text,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            lineHeight = 15.sp,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 180.dp, max = 420.dp)
                            .verticalScroll(rememberScrollState())
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainerLow)
                            .padding(10.dp),
                    )
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) {
                        Text(stringResource(R.string.common_close))
                    }
                }
            }
        }
    }
}

private fun dockerStateTone(state: String): DockerStateTone = when (state) {
    "running" -> DockerStateTone.Ok
    "paused", "restarting", "created" -> DockerStateTone.Warn
    else -> DockerStateTone.Muted
}

@Composable
private fun PanelHeader(title: String, subtitle: String, loading: Boolean, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (loading) CircularProgressIndicator(Modifier.padding(12.dp))
        else OutlinedButton(onClick = onRefresh) { Text(stringResource(R.string.common_refresh)) }
    }
}

@Composable
private fun EmptyPanel(message: String) {
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MetricCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun MetricTextRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value)
    }
}

@Composable
private fun MetricBar(label: String, value: Float, detail: String = "") {
    val safe = value.coerceIn(0f, 100f)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label)
            Text("${safe.roundToInt()}%")
        }
        LinearProgressIndicator(progress = { safe / 100f }, modifier = Modifier.fillMaxWidth())
        if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun percent(used: Long, total: Long): Float = if (total > 0) used.toFloat() / total * 100f else 0f

private fun formatBytes(bytes: Long): String {
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.coerceAtLeast(0).toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.lastIndex) { value /= 1024; unit++ }
    return if (value >= 10 || unit == 0) "%.0f %s".format(value, units[unit]) else "%.1f %s".format(value, units[unit])
}

private fun formatUptime(seconds: Long): String {
    val days = seconds / 86_400
    val hours = seconds % 86_400 / 3_600
    return if (days > 0) "${days}d ${hours}h" else "${hours}h"
}

private fun parseMetrics(text: String): HostMetrics {
    val lines = text.lineSequence().iterator()
    require(lines.hasNext() && lines.next().trim() == "ZT_METRICS_V1") { "Unexpected metrics response" }
    fun next() = if (lines.hasNext()) lines.next().trim() else ""
    val host = next(); val os = next(); val arch = next()
    val uptime = next().toLongOrNull() ?: 0
    val cores = (next().toIntOrNull() ?: 1).coerceAtLeast(1)
    fun cpu(line: String): Pair<Long, Long> {
        val p = line.split(Regex("\\s+")); return (p.getOrNull(0)?.toLongOrNull() ?: 0) to (p.getOrNull(1)?.toLongOrNull() ?: 0)
    }
    val first = cpu(next()); val second = cpu(next())
    val dt = (second.first - first.first).coerceAtLeast(0); val di = (second.second - first.second).coerceAtLeast(0)
    val cpuUsage = if (dt > 0) (dt - di).coerceAtLeast(0).toFloat() / dt * 100f else 0f
    val mem = next().split(Regex("\\s+")).map { it.toLongOrNull() ?: 0 }
    val disks = mutableListOf<MetricDisk>(); val firstNetworks = mutableMapOf<String, Pair<Long, Long>>(); val networks = mutableListOf<MetricNetwork>()
    while (lines.hasNext()) {
        val p = lines.next().split('|'); if (p.isEmpty()) continue
        when (p[0]) {
            "D" -> if (p.size >= 4) disks += MetricDisk(p[1], p[2].toLongOrNull() ?: 0, p[3].toLongOrNull() ?: 0)
            "A" -> if (p.size >= 4) firstNetworks[p[1]] = (p[2].toLongOrNull() ?: 0) to (p[3].toLongOrNull() ?: 0)
            "B" -> if (p.size >= 4) {
                val rx = p[2].toLongOrNull() ?: 0; val tx = p[3].toLongOrNull() ?: 0; val old = firstNetworks[p[1]] ?: (rx to tx)
                networks += MetricNetwork(p[1], (rx - old.first).coerceAtLeast(0), (tx - old.second).coerceAtLeast(0))
            }
        }
    }
    return HostMetrics(host, os, arch, uptime, cores, cpuUsage, mem.getOrElse(0) { 0 }, mem.getOrElse(1) { 0 }, mem.getOrElse(2) { 0 }, mem.getOrElse(3) { 0 }, disks, networks)
}

private fun parseDockerRows(text: String): List<DockerContainer> = text.lineSequence().mapNotNull { line ->
    runCatching {
        val o = JSONObject(line.trim())
        val labels = o.optString("Labels").split(',').mapNotNull { pair ->
            val at = pair.indexOf('=')
            if (at > 0) pair.substring(0, at).trim() to pair.substring(at + 1) else null
        }.toMap()
        DockerContainer(
            id = o.optString("ID", o.optString("Id")),
            name = o.optString("Names", o.optString("Name")),
            image = o.optString("Image"),
            state = o.optString("State").lowercase(),
            status = o.optString("Status"),
            ports = o.optString("Ports"),
            project = labels["com.docker.compose.project"].orEmpty(),
            service = labels["com.docker.compose.service"].orEmpty(),
            configFiles = labels["com.docker.compose.project.config_files"].orEmpty(),
        )
    }.getOrNull()
}.toList()

private fun parseDockerInspect(stdout: String): DockerInspectDetail {
    return runCatching {
        val raw = stdout.trim()
        val info = when {
            raw.startsWith("[") -> JSONArray(raw).optJSONObject(0)
            else -> JSONObject(raw)
        } ?: return DockerInspectDetail(error = "empty inspect")

        val ips = mutableListOf<String>()
        val networks = info.optJSONObject("NetworkSettings")?.optJSONObject("Networks")
        if (networks != null) {
            val keys = networks.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                val ip = networks.optJSONObject(name)?.optString("IPAddress").orEmpty()
                if (ip.isNotBlank()) ips += "$name: $ip"
            }
        }
        val topIp = info.optJSONObject("NetworkSettings")?.optString("IPAddress").orEmpty()
        if (topIp.isNotBlank() && ips.isEmpty()) ips += topIp

        val created = info.optString("Created")
            .replace('T', ' ')
            .take(19)

        val cmdArr = info.optJSONObject("Config")?.optJSONArray("Cmd")
        val cmd = buildString {
            if (cmdArr != null) {
                for (i in 0 until cmdArr.length()) {
                    if (i > 0) append(' ')
                    append(cmdArr.optString(i))
                }
            }
        }

        val restart = info.optJSONObject("HostConfig")
            ?.optJSONObject("RestartPolicy")
            ?.optString("Name")
            .orEmpty()

        val mounts = mutableListOf<String>()
        val mountsArr = info.optJSONArray("Mounts")
        if (mountsArr != null) {
            for (i in 0 until mountsArr.length()) {
                val m = mountsArr.optJSONObject(i) ?: continue
                val src = m.optString("Source").ifBlank { m.optString("Name") }
                val dst = m.optString("Destination")
                if (src.isNotBlank() || dst.isNotBlank()) mounts += "$src → $dst"
            }
        }

        val labels = info.optJSONObject("Config")?.optJSONObject("Labels")
        val composeProject = labels?.optString("com.docker.compose.project").orEmpty()
        val composeService = labels?.optString("com.docker.compose.service").orEmpty()
        val compose = when {
            composeProject.isBlank() -> ""
            composeService.isBlank() -> composeProject
            else -> "$composeProject / $composeService"
        }

        DockerInspectDetail(
            ips = ips,
            compose = compose,
            created = created,
            image = info.optJSONObject("Config")?.optString("Image").orEmpty(),
            restartPolicy = restart,
            cmd = cmd,
            mounts = mounts,
        )
    }.getOrElse {
        DockerInspectDetail(error = it.message ?: "inspect parse failed")
    }
}

private const val DOLLAR = '$'

private const val METRICS_SCRIPT = """printf 'ZT_METRICS_V1\n'
hostname 2>/dev/null || uname -n
uname -s 2>/dev/null || printf 'unknown\n'
uname -m 2>/dev/null || printf 'unknown\n'
awk '{print int(${DOLLAR}1)}' /proc/uptime 2>/dev/null || printf '0\n'
nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1\n'
awk 'NR==1{total=${DOLLAR}2+${DOLLAR}3+${DOLLAR}4+${DOLLAR}5+${DOLLAR}6+${DOLLAR}7+${DOLLAR}8; idle=${DOLLAR}5+${DOLLAR}6; print total, idle}' /proc/stat 2>/dev/null
sleep 0.25
awk 'NR==1{total=${DOLLAR}2+${DOLLAR}3+${DOLLAR}4+${DOLLAR}5+${DOLLAR}6+${DOLLAR}7+${DOLLAR}8; idle=${DOLLAR}5+${DOLLAR}6; print total, idle}' /proc/stat 2>/dev/null
awk '/^MemTotal:/ {mt=${DOLLAR}2*1024} /^MemAvailable:/ {ma=${DOLLAR}2*1024} /^SwapTotal:/ {st=${DOLLAR}2*1024} /^SwapFree:/ {sf=${DOLLAR}2*1024} END {printf "%.0f %.0f %.0f %.0f\n", mt, mt-ma, st, st-sf}' /proc/meminfo 2>/dev/null
df -P -B1 -T 2>/dev/null | awk 'NR>1 && ${DOLLAR}3 ~ /^[0-9]+${DOLLAR}/ {fstype=${DOLLAR}2; mount=${DOLLAR}7; if (fstype ~ /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup2?)${DOLLAR}/) next; print "D|" mount "|" ${DOLLAR}3 "|" ${DOLLAR}4}' | head -n 8
awk 'NR>2 {gsub(":", "", ${DOLLAR}1); print "A|" ${DOLLAR}1 "|" ${DOLLAR}2 "|" ${DOLLAR}10}' /proc/net/dev 2>/dev/null
sleep 1
awk 'NR>2 {gsub(":", "", ${DOLLAR}1); print "B|" ${DOLLAR}1 "|" ${DOLLAR}2 "|" ${DOLLAR}10}' /proc/net/dev 2>/dev/null"""
