package com.zeroterm.android.data

internal data class TmuxSession(
    val id: String,
    val name: String,
    val windows: Int,
    val attachedClients: Int,
)

internal data class TmuxClient(val name: String, val pid: Long, val created: Long, val sessionId: String)

internal data class TmuxState(
    val version: String = "",
    val sessions: List<TmuxSession> = emptyList(),
    val currentClient: TmuxClient? = null,
)

/** Commands run on the existing SSH transport, except the initial interactive attach. */
internal class TmuxCommands(private val clientOption: String) {
    init {
        require(clientOption.matches(Regex("@zeroterm_android_[a-zA-Z0-9_]+")))
    }

    val list: String = """
        if ! command -v tmux >/dev/null 2>&1; then printf 'M\n'; exit 0; fi
        version=${'$'}(tmux -V) || exit ${'$'}?
        printf 'V\t%s\n' "${'$'}version"
        rows=${'$'}(LC_ALL=C tmux -u list-sessions -F 'S\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_name}' 2>&1)
        code=${'$'}?
        if [ "${'$'}code" -eq 0 ]; then
            printf '%s\n' "${'$'}rows"
        elif printf '%s' "${'$'}rows" | LC_ALL=C grep -Eq '^no server running|^no sessions|^error connecting.*No such file'; then
            exit 0
        else
            printf '%s\n' "${'$'}rows" >&2; exit "${'$'}code"
        fi
        marker=${'$'}(tmux show-options -gqv ${quote(clientOption)}) || exit ${'$'}?
        printf 'O\t%s\n' "${'$'}marker"
        tmux -u list-clients -F 'C\t#{client_name}\t#{client_pid}\t#{client_created}\t#{session_id}'
    """.trimIndent().replace("\\t", "\t")

    fun create(name: String): String {
        require(validTmuxName(name))
        return "tmux new-session -d -s ${quote(name)}"
    }

    fun rename(session: TmuxSession, name: String): String {
        require(validTmuxName(name))
        return "tmux rename-session -t ${target(session.id)} -- ${quote(name)}"
    }

    fun kill(session: TmuxSession): String = "tmux kill-session -t ${target(session.id)}"

    fun enter(session: TmuxSession, client: TmuxClient): String =
        "tmux switch-client -c ${quote(client.name)} -t ${target(session.id)}"

    fun detach(client: TmuxClient): String = "tmux detach-client -t ${quote(client.name)}"

    // Prepare bookkeeping over the SSH exec channel so the interactive shell
    // only echoes a short launcher. The private, one-use script removes itself
    // before attaching. tmux draws through its stdin TTY; redirecting stdout
    // suppresses its normal detach notice while keeping errors on stderr.
    fun prepareAttach(session: TmuxSession): String {
        val script = """
            rm -f -- "${'$'}0"
            tmux -u attach-session -t ${target(session.id)} \; set-option -gF ${quote(clientOption)} '#{client_name}|#{client_pid}|#{client_created}' >/dev/null
            status=${'$'}?
            tmux set-option -gu ${quote(clientOption)} >/dev/null 2>&1
            exit "${'$'}status"
        """.trimIndent()
        return """
            umask 077
            script=${'$'}(mktemp /tmp/zt.XXXXXXXXXX) || exit ${'$'}?
            if ! printf '%s\n' ${quote(script)} > "${'$'}script"; then
                rm -f -- "${'$'}script"; exit 1
            fi
            printf '%s\n' "${'$'}script"
        """.trimIndent()
    }

    fun attach(scriptPath: String): String = "sh ${scriptTarget(scriptPath)}\r"

    fun discardAttach(scriptPath: String): String = "rm -f -- ${scriptTarget(scriptPath)}"

    private fun scriptTarget(path: String): String {
        require(path.matches(Regex("/tmp/zt\\.[a-zA-Z0-9]{10}"))) { "Invalid tmux launcher path" }
        return quote(path)
    }

    private fun target(id: String): String {
        require(id.matches(Regex("\\$[0-9]+")))
        return quote(id)
    }

    private fun quote(value: String): String {
        // tmux also parses argv: an unescaped trailing semicolon separates
        // commands even when the shell supplied a single quoted argument.
        val argument = if (value.endsWith(';')) value.dropLast(1) + "\\;" else value
        return "'" + argument.replace("'", "'\"'\"'") + "'"
    }
}

internal fun validTmuxName(name: String): Boolean =
    name.isNotBlank() && name.none { it.isISOControl() || it == ':' || it == '.' }

internal fun parseTmuxState(text: String): TmuxState {
    var version: String? = null
    var missing = false
    var marker = ""
    val sessions = mutableListOf<TmuxSession>()
    val clients = mutableListOf<TmuxClient>()
    text.lineSequence().forEach { raw ->
        val line = raw.removeSuffix("\r")
        when {
            line == "M" -> missing = true
            line.startsWith("V\t") -> version = line.substring(2).removePrefix("tmux ").trim()
            line.startsWith("O\t") -> marker = line.substring(2)
            line.startsWith("S\t") -> {
                val fields = line.split('\t', limit = 5)
                require(fields.size == 5 && fields[1].matches(Regex("\\$[0-9]+"))) { "Invalid tmux session data" }
                val windows = fields[2].toIntOrNull()
                val attached = fields[3].toIntOrNull()
                require(windows != null && windows > 0 && attached != null && attached >= 0) { "Invalid tmux session counts" }
                sessions += TmuxSession(fields[1], fields[4], windows, attached)
            }
            line.startsWith("C\t") -> {
                val fields = line.split('\t')
                if (fields.size == 5) {
                    val pid = fields[2].toLongOrNull()
                    val created = fields[3].toLongOrNull()
                    if (pid != null && created != null) clients += TmuxClient(fields[1], pid, created, fields[4])
                }
            }
        }
    }
    if (missing) return TmuxState()
    require(!version.isNullOrBlank()) { "Invalid tmux response" }
    val current = clients.firstOrNull { "${it.name}|${it.pid}|${it.created}" == marker }
    return TmuxState(version!!, sessions, current)
}
