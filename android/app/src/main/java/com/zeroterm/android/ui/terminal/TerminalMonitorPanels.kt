package com.zeroterm.android.ui.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.SessionManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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

private data class DockerContainer(
    val id: String,
    val name: String,
    val image: String,
    val state: String,
    val status: String,
    val ports: String,
    val project: String,
)

@Composable
internal fun DockerPanel(
    sessions: SessionManager,
    onTerminalCommand: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var containers by remember { mutableStateOf<List<DockerContainer>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var logs by remember { mutableStateOf<Pair<String, String>?>(null) }
    var pendingDelete by remember { mutableStateOf<DockerContainer?>(null) }

    fun execute(command: String, after: ((String) -> Unit)? = null) {
        scope.launch {
            loading = true
            sessions.execCommand(command).fold(
                onSuccess = { result ->
                    val message = (result.stderr.ifBlank { result.stdout }).trim()
                    if (result.code == 0) {
                        error = null
                        after?.invoke(result.stdout)
                    } else error = message.ifBlank { "Exit ${result.code}" }
                },
                onFailure = { error = it.message },
            )
            loading = false
        }
    }

    fun reload() {
        execute("docker ps -a --no-trunc --format '{{json .}}'") { output ->
            containers = parseDockerRows(output)
        }
    }

    LaunchedEffect(Unit) { reload() }

    pendingDelete?.let { container ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.docker_delete_title)) },
            text = { Text(stringResource(R.string.docker_delete_message, container.name)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    execute("docker rm -f ${container.id}") { reload() }
                }) { Text(stringResource(R.string.common_delete)) }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    logs?.let { (name, text) ->
        AlertDialog(
            onDismissRequest = { logs = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.docker_logs_title, name)) },
            text = { SelectionContainer { Text(text, style = MaterialTheme.typography.bodySmall) } },
            confirmButton = { TextButton(onClick = { logs = null }) { Text(stringResource(R.string.common_close)) } },
        )
    }

    Column(Modifier.fillMaxSize()) {
        PanelHeader(
            title = stringResource(R.string.docker_title),
            subtitle = stringResource(R.string.docker_subtitle),
            loading = loading,
            onRefresh = { reload() },
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        if (!loading && containers.isEmpty() && error == null) {
            EmptyPanel(stringResource(R.string.docker_empty))
        } else {
            val groups = containers.groupBy { it.project.ifBlank { "~" } }.toSortedMap()
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            ) {
                groups.forEach { (project, rows) ->
                    item {
                        Text(
                            if (project == "~") stringResource(R.string.hosts_ungrouped) else project,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    items(rows, key = { it.id }) { c ->
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(c.name.ifBlank { c.id.take(12) }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                    Text(c.state, color = if (c.state == "running") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(c.image, style = MaterialTheme.typography.bodySmall)
                                Text(c.status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (c.ports.isNotBlank()) Text(c.ports, style = MaterialTheme.typography.labelSmall)
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    if (c.state == "running") {
                                        TextButton(onClick = { execute("docker stop ${c.id}") { reload() } }) { Text(stringResource(R.string.docker_stop)) }
                                        TextButton(onClick = { execute("docker restart ${c.id}") { reload() } }) { Text(stringResource(R.string.docker_restart)) }
                                        TextButton(onClick = { onTerminalCommand("docker exec -it ${c.id} sh") }) { Text(stringResource(R.string.docker_terminal)) }
                                    } else {
                                        TextButton(onClick = { execute("docker start ${c.id}") { reload() } }) { Text(stringResource(R.string.docker_start)) }
                                    }
                                }
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    TextButton(onClick = {
                                        execute("docker logs --tail 300 ${c.id}") { output -> logs = c.name to output.ifBlank { "(empty)" } }
                                    }) { Text(stringResource(R.string.docker_logs)) }
                                    TextButton(onClick = { pendingDelete = c }) { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
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
        val o = JSONObject(line)
        val labels = o.optString("Labels").split(',').mapNotNull { pair ->
            val at = pair.indexOf('='); if (at > 0) pair.substring(0, at) to pair.substring(at + 1) else null
        }.toMap()
        DockerContainer(
            id = o.optString("ID", o.optString("Id")),
            name = o.optString("Names", o.optString("Name")),
            image = o.optString("Image"), state = o.optString("State").lowercase(),
            status = o.optString("Status"), ports = o.optString("Ports"),
            project = labels["com.docker.compose.project"].orEmpty(),
        )
    }.getOrNull()
}.toList()

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
awk '/^MemTotal:/ {mt=${DOLLAR}2*1024} /^MemAvailable:/ {ma=${DOLLAR}2*1024} /^SwapTotal:/ {st=${DOLLAR}2*1024} /^SwapFree:/ {sf=${DOLLAR}2*1024} END {printf "%d %d %d %d\n", mt, mt-ma, st, st-sf}' /proc/meminfo 2>/dev/null
df -P -B1 -T 2>/dev/null | awk 'NR>1 && ${DOLLAR}3 ~ /^[0-9]+${DOLLAR}/ {fstype=${DOLLAR}2; mount=${DOLLAR}7; if (fstype ~ /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup2?)${DOLLAR}/) next; print "D|" mount "|" ${DOLLAR}3 "|" ${DOLLAR}4}' | head -n 8
awk 'NR>2 {gsub(":", "", ${DOLLAR}1); print "A|" ${DOLLAR}1 "|" ${DOLLAR}2 "|" ${DOLLAR}10}' /proc/net/dev 2>/dev/null
sleep 1
awk 'NR>2 {gsub(":", "", ${DOLLAR}1); print "B|" ${DOLLAR}1 "|" ${DOLLAR}2 "|" ${DOLLAR}10}' /proc/net/dev 2>/dev/null"""
