package com.zeroterm.android.data

/** Stable preference IDs shared by settings and the terminal tools drawer. */
enum class TerminalSidebarFeature(val id: String) {
    Snippets("snippets"),
    Ai("ai"),
    Metrics("metrics"),
    Services("services"),
    Ports("ports"),
    Docker("docker"),
    Sftp("sftp"),
    Tmux("tmux"),
    Theme("theme"),
}

fun enabledTerminalSidebarFeatures(hiddenIds: Set<String>): List<TerminalSidebarFeature> =
    TerminalSidebarFeature.entries.filterNot { it.id in hiddenIds }

fun resolveTerminalSidebarFeature(
    selected: TerminalSidebarFeature,
    enabled: List<TerminalSidebarFeature>,
): TerminalSidebarFeature? = selected.takeIf { it in enabled } ?: enabled.firstOrNull()
