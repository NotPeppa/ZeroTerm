package com.zeroterm.android.ui.terminal

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.zeroterm.android.R
import com.zeroterm.android.data.TerminalSidebarFeature

@StringRes
internal fun TerminalSidebarFeature.labelResource(): Int = when (this) {
    TerminalSidebarFeature.Snippets -> R.string.snippets_title
    TerminalSidebarFeature.Ai -> R.string.ai_title
    TerminalSidebarFeature.Metrics -> R.string.monitor_title
    TerminalSidebarFeature.Services -> R.string.services_title
    TerminalSidebarFeature.Ports -> R.string.ports_title
    TerminalSidebarFeature.Docker -> R.string.docker_title
    TerminalSidebarFeature.Sftp -> R.string.sidebar_sftp
    TerminalSidebarFeature.Tmux -> R.string.tmux_title
    TerminalSidebarFeature.Theme -> R.string.terminal_theme_title
}

@DrawableRes
internal fun TerminalSidebarFeature.iconResource(): Int = when (this) {
    TerminalSidebarFeature.Snippets -> R.drawable.ic_terminal_tool_snippets
    TerminalSidebarFeature.Ai -> R.drawable.ic_terminal_tool_ai
    TerminalSidebarFeature.Metrics -> R.drawable.ic_terminal_tool_metrics
    TerminalSidebarFeature.Services -> R.drawable.ic_terminal_tool_services
    TerminalSidebarFeature.Ports -> R.drawable.ic_terminal_tool_ports
    TerminalSidebarFeature.Docker -> R.drawable.ic_terminal_tool_docker
    TerminalSidebarFeature.Sftp -> R.drawable.ic_terminal_tool_sftp
    TerminalSidebarFeature.Tmux -> R.drawable.ic_terminal_tool_tmux
    TerminalSidebarFeature.Theme -> R.drawable.ic_terminal_tool_theme
}
