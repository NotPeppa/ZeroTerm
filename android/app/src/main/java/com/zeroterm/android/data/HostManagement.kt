package com.zeroterm.android.data

internal data class SystemService(
    val name: String,
    val scope: String,
    val loadState: String,
    val activeState: String,
    val subState: String,
    val description: String,
)

internal object ServiceCommands {
    val list = """
        command -v systemctl >/dev/null 2>&1 || { printf 'systemctl unavailable\n' >&2; exit 1; }
        rows=${'$'}(LC_ALL=C SYSTEMD_COLORS=0 systemctl list-units --type=service --all --no-legend --no-pager --plain) || exit ${'$'}?
        printf '%s\n' "${'$'}rows" | sed 's/^/system\t/'
        rows=${'$'}(LC_ALL=C SYSTEMD_COLORS=0 systemctl --user list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null) && printf '%s\n' "${'$'}rows" | sed 's/^/user\t/'
        exit 0
    """.trimIndent().replace("\\t", "\t")

    fun action(service: SystemService, action: String): String {
        require(action in setOf("start", "stop", "restart"))
        return "systemctl${scope(service)} --no-ask-password --no-pager $action -- ${target(service)}"
    }

    fun detail(service: SystemService): String =
        "SYSTEMD_COLORS=0 systemctl${scope(service)} --no-pager cat -- ${target(service)}"

    fun logs(service: SystemService): String =
        "SYSTEMD_COLORS=0 journalctl${scope(service)} --no-pager --output=short-iso --lines=300 --unit=${target(service)}"

    private fun scope(service: SystemService): String {
        require(service.scope == "system" || service.scope == "user")
        return if (service.scope == "user") " --user" else ""
    }

    private fun target(service: SystemService): String {
        require(service.name.endsWith(".service") && service.name.isNotBlank() && service.name.none { it.isISOControl() })
        return shellQuote(service.name)
    }
}

internal fun parseSystemServices(output: String): List<SystemService> = output.lineSequence().mapNotNull { line ->
    val scope = line.substringBefore('\t')
    if (scope != "system" && scope != "user") return@mapNotNull null
    val fields = line.substringAfter('\t').trim().removePrefix("●").trim().split(Regex("\\s+"), limit = 5)
    if (fields.size < 4 || !fields[0].endsWith(".service")) return@mapNotNull null
    SystemService(fields[0], scope, fields[1], fields[2], fields[3], fields.getOrElse(4) { fields[0] })
}.distinctBy { it.scope to it.name }.sortedWith(compareBy({ it.scope }, { it.name })).toList()

internal data class PortProcess(val name: String, val pid: Long)
internal data class ListeningPort(
    val protocol: String,
    val port: Int,
    val addresses: List<String>,
    val processes: List<PortProcess>,
) {
    val localOnly: Boolean get() = addresses.all { it == "::1" || it.startsWith("127.") || it.startsWith("::ffff:127.") }
}

internal object PortCommands {
    const val list = "LC_ALL=C ss -tulnp 2>/dev/null || LC_ALL=C netstat -tulnp"

    fun terminate(pids: List<Long>, force: Boolean): String {
        require(pids.isNotEmpty() && pids.all { it > 1 && it <= Int.MAX_VALUE })
        return "kill -${if (force) "KILL" else "TERM"} ${pids.distinct().joinToString(" ")}"
    }
}

internal fun parseListeningPorts(output: String): List<ListeningPort> {
    val rows = output.lineSequence().mapNotNull { line ->
        val fields = line.trim().split(Regex("\\s+"))
        if (fields.size < 5) return@mapNotNull null
        val protocol = when {
            fields[0].startsWith("tcp") -> "tcp"
            fields[0].startsWith("udp") -> "udp"
            else -> return@mapNotNull null
        }
        val netstat = fields[1].toLongOrNull() != null && fields[2].toLongOrNull() != null
        val endpoint: String
        val processes: List<PortProcess>
        if (netstat) {
            if (protocol == "tcp" && fields.getOrNull(5) != "LISTEN") return@mapNotNull null
            endpoint = fields[3]
            val process = fields.getOrNull(if (protocol == "tcp") 6 else 5).orEmpty()
            val pid = process.substringBefore('/').toLongOrNull()
            processes = if (pid != null && pid > 0 && '/' in process) listOf(PortProcess(process.substringAfter('/'), pid)) else emptyList()
        } else {
            if (fields.size < 6 || fields[1] !in setOf("LISTEN", "UNCONN")) return@mapNotNull null
            endpoint = fields[4]
            processes = Regex("\"([^\"]+)\",pid=([0-9]+)").findAll(fields.drop(6).joinToString(" ")).mapNotNull {
                it.groupValues[2].toLongOrNull()?.takeIf { pid -> pid > 0 }?.let { pid -> PortProcess(it.groupValues[1], pid) }
            }.distinctBy { it.pid }.toList()
        }
        val port = endpoint.substringAfterLast(':').toIntOrNull()?.takeIf { it in 1..65535 } ?: return@mapNotNull null
        val address = endpoint.substringBeforeLast(':').removeSurrounding("[", "]").substringBefore('%')
        ListeningPort(protocol, port, listOf(address), processes)
    }.toList()
    // First collapse SO_REUSEPORT sockets, then merge IPv4/IPv6 bindings only
    // when their owner sets match. Unknown owners stay separated by address.
    val sockets = rows.groupBy { Triple(it.protocol, it.port, it.addresses.single()) }.values.map { group ->
        group.first().copy(processes = group.flatMap { it.processes }.distinctBy { it.pid })
    }
    return sockets.groupBy {
        Triple(it.protocol, it.port, if (it.processes.isEmpty()) "@${it.addresses.single()}" else it.processes.map { p -> p.pid }.sorted().joinToString(","))
    }.values.map { group ->
        group.first().copy(addresses = group.flatMap { it.addresses }.distinct())
    }.sortedWith(compareBy({ it.port }, { it.protocol }, { it.addresses.first() }))
}

private fun shellQuote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"
