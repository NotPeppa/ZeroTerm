package com.zeroterm.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BrightnessAuto
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.AppContainer
import com.zeroterm.android.data.AutoSyncSnapshot
import com.zeroterm.android.data.AutoSyncUiState
import com.zeroterm.android.data.SettingsSnapshot
import com.zeroterm.android.data.ThemeMode
import com.zeroterm.android.ui.ai.AiScreen
import com.zeroterm.android.ui.components.LocalChromeTransparency
import com.zeroterm.android.ui.hosts.HostsScreen
import com.zeroterm.android.ui.hosts.HostsViewModel
import com.zeroterm.android.ui.settings.WorkspaceSettingsPage
import com.zeroterm.android.ui.settings.WorkspaceSettingsPane
import com.zeroterm.android.ui.sync.SyncScreen
import com.zeroterm.ffi.HostSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private enum class WorkspacePage { Hosts, General, Terminal, Ai, Sync, About }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    container: AppContainer,
    hostsViewModel: HostsViewModel,
    onHostClick: (HostSummary) -> Unit,
    onAddHost: () -> Unit,
    onEditHost: (HostSummary) -> Unit,
    onSftp: (HostSummary) -> Unit,
    onQuickConnect: () -> Unit,
    onLock: () -> Unit,
) {
    var page by rememberSaveable { mutableStateOf(WorkspacePage.Hosts) }
    val hosts by container.repository.hosts.collectAsState()
    val settingsSnap by container.settings.flow.collectAsState(initial = SettingsSnapshot())
    val syncSnap by container.autoSync.snapshot.collectAsState()
    val scope = rememberCoroutineScope()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val drawerAlpha = 1f - LocalChromeTransparency.current.drawer.coerceIn(0f, 0.8f)
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }

    LaunchedEffect(Unit) {
        while (isActive) {
            delay(15_000)
            nowMs = System.currentTimeMillis()
        }
    }

    fun selectPage(selected: WorkspacePage) {
        page = selected
        scope.launch { drawerState.close() }
    }

    val openDrawer: () -> Unit = {
        scope.launch { drawerState.open() }
        Unit
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = true,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier.width(304.dp),
                drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = drawerAlpha),
                drawerContentColor = MaterialTheme.colorScheme.onSurface,
            ) {
                Column(Modifier.fillMaxHeight()) {
                    Row(
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Image(
                            painter = painterResource(R.drawable.zeroterm_desktop_logo),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(44.dp),
                        )
                        Text(
                            "ZeroTerm",
                            style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.padding(start = 12.dp),
                        )
                    }
                    Text(
                        stringResource(R.string.workspace_navigation),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 28.dp, vertical = 8.dp),
                    )
                    WorkspacePage.entries.forEach { item ->
                        WorkspaceDrawerItem(
                            page = item,
                            selected = page == item,
                            onClick = { selectPage(item) },
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                    DrawerFooter(
                        themeMode = settingsSnap.themeMode,
                        syncSnap = syncSnap,
                        nowMs = nowMs,
                        onThemeModeChange = { mode ->
                            scope.launch { container.settings.setThemeMode(mode) }
                        },
                        onSyncClick = { selectPage(WorkspacePage.Sync) },
                        onLock = onLock,
                    )
                }
            }
        },
    ) {
        when (page) {
            WorkspacePage.Hosts -> HostsScreen(
                viewModel = hostsViewModel,
                onHostClick = onHostClick,
                onAddHost = onAddHost,
                onEditHost = onEditHost,
                onSftp = onSftp,
                onQuickConnect = onQuickConnect,
                onOpenNavigation = openDrawer,
            )

            WorkspacePage.General -> WorkspaceSettingsPane(
                settings = container.settings,
                zeroTerm = container.zeroTerm,
                page = WorkspaceSettingsPage.General,
                onOpenNavigation = openDrawer,
            )

            WorkspacePage.Terminal -> WorkspaceSettingsPane(
                settings = container.settings,
                zeroTerm = container.zeroTerm,
                page = WorkspaceSettingsPage.Terminal,
                onOpenNavigation = openDrawer,
            )

            WorkspacePage.Ai -> AiScreen(
                repository = container.repository,
                settings = container.settings,
                onOpenNavigation = openDrawer,
                configurationOnly = true,
            )

            WorkspacePage.Sync -> SyncScreen(
                zeroTerm = container.zeroTerm,
                hosts = hosts,
                settings = container.settings,
                onOpenNavigation = openDrawer,
                onDataChanged = {
                    scope.launch { container.repository.refreshHosts() }
                },
            )

            WorkspacePage.About -> WorkspaceSettingsPane(
                settings = container.settings,
                zeroTerm = container.zeroTerm,
                page = WorkspaceSettingsPage.About,
                onOpenNavigation = openDrawer,
            )
        }
    }
}

@Composable
private fun DrawerFooter(
    themeMode: ThemeMode,
    syncSnap: AutoSyncSnapshot,
    nowMs: Long,
    onThemeModeChange: (ThemeMode) -> Unit,
    onSyncClick: () -> Unit,
    onLock: () -> Unit,
) {
    var themeMenuOpen by remember { mutableStateOf(false) }
    val syncLabel = syncStatusLabel(syncSnap, nowMs)

    // Desktop vault-sidebar-footer:
    // [left action] .............. [theme button] [sync colored dot]
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconButton(onClick = onLock) {
            Icon(
                Icons.Default.Lock,
                contentDescription = stringResource(R.string.hosts_lock),
            )
        }
        Text(
            text = stringResource(R.string.hosts_lock),
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier
                .clickable(onClick = onLock)
                .padding(end = 4.dp),
        )
        Spacer(Modifier.weight(1f))
        Box {
            IconButton(onClick = { themeMenuOpen = true }) {
                Icon(
                    imageVector = themeModeIcon(themeMode),
                    contentDescription = stringResource(R.string.drawer_theme_mode),
                )
            }
            DropdownMenu(
                expanded = themeMenuOpen,
                onDismissRequest = { themeMenuOpen = false },
            ) {
                ThemeMode.entries.forEach { mode ->
                    DropdownMenuItem(
                        text = { Text(themeModeLabel(mode)) },
                        leadingIcon = {
                            Icon(themeModeIcon(mode), contentDescription = null)
                        },
                        onClick = {
                            themeMenuOpen = false
                            onThemeModeChange(mode)
                        },
                    )
                }
            }
        }
        // Desktop-style compact colored sync indicator.
        Box(
            modifier = Modifier
                .padding(end = 8.dp)
                .size(28.dp)
                .clip(CircleShape)
                .clickable(
                    onClick = onSyncClick,
                    onClickLabel = syncLabel,
                ),
            contentAlignment = Alignment.Center,
        ) {
            SyncStatusDot(state = syncSnap.state)
        }
    }
}

@Composable
private fun SyncStatusDot(state: AutoSyncUiState) {
    val color = when (state) {
        AutoSyncUiState.Ok -> Color(0xFF10B981)
        AutoSyncUiState.Syncing -> Color(0xFF3B82F6)
        AutoSyncUiState.Error -> Color(0xFFEF4444)
        AutoSyncUiState.Idle -> Color(0xFF6B7280)
        AutoSyncUiState.Off, AutoSyncUiState.Unconfigured -> Color(0xFF4B5563).copy(alpha = 0.55f)
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Composable
private fun syncStatusLabel(snap: AutoSyncSnapshot, nowMs: Long): String = when (snap.state) {
    AutoSyncUiState.Off -> stringResource(R.string.sync_indicator_auto_off)
    AutoSyncUiState.Unconfigured -> stringResource(R.string.sync_indicator_no_profile)
    AutoSyncUiState.Syncing -> stringResource(R.string.sync_indicator_syncing)
    AutoSyncUiState.Error -> stringResource(
        R.string.sync_indicator_failed,
        snap.consecutiveFailures.coerceAtLeast(1),
    )
    AutoSyncUiState.Ok -> stringResource(
        R.string.sync_indicator_ok,
        relativeTimeLabel(snap.lastSuccessAtMs, nowMs),
    )
    AutoSyncUiState.Idle -> stringResource(R.string.sync_indicator_idle)
}

@Composable
private fun relativeTimeLabel(atMs: Long?, nowMs: Long): String {
    if (atMs == null) return stringResource(R.string.sync_indicator_just_now)
    val sec = ((nowMs - atMs).coerceAtLeast(0L) / 1000L).toInt()
    return when {
        sec < 10 -> stringResource(R.string.sync_indicator_just_now)
        sec < 60 -> stringResource(R.string.sync_indicator_seconds_ago, sec)
        sec < 3600 -> stringResource(R.string.sync_indicator_minutes_ago, (sec / 60).coerceAtLeast(1))
        else -> stringResource(R.string.sync_indicator_hours_ago, (sec / 3600).coerceAtLeast(1))
    }
}

@Composable
private fun themeModeIcon(mode: ThemeMode): ImageVector = when (mode) {
    ThemeMode.System -> Icons.Default.BrightnessAuto
    ThemeMode.Dark -> Icons.Default.DarkMode
    ThemeMode.Light -> Icons.Default.LightMode
}

@Composable
private fun themeModeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.System -> stringResource(R.string.settings_theme_system)
    ThemeMode.Dark -> stringResource(R.string.settings_theme_dark)
    ThemeMode.Light -> stringResource(R.string.settings_theme_light)
}

@Composable
private fun WorkspaceDrawerItem(
    page: WorkspacePage,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val icon: ImageVector = when (page) {
        WorkspacePage.Hosts -> Icons.Default.Computer
        WorkspacePage.General -> Icons.Default.Settings
        WorkspacePage.Terminal -> Icons.Default.Keyboard
        WorkspacePage.Ai -> Icons.Default.AutoAwesome
        WorkspacePage.Sync -> Icons.Default.Sync
        WorkspacePage.About -> Icons.Default.Info
    }
    val label = when (page) {
        WorkspacePage.Hosts -> stringResource(R.string.hosts_title)
        WorkspacePage.General -> stringResource(R.string.settings_general)
        WorkspacePage.Terminal -> stringResource(R.string.settings_terminal)
        WorkspacePage.Ai -> stringResource(R.string.ai_settings_title)
        WorkspacePage.Sync -> stringResource(R.string.sync_title)
        WorkspacePage.About -> stringResource(R.string.settings_about)
    }
    NavigationDrawerItem(
        selected = selected,
        onClick = onClick,
        icon = { Icon(icon, contentDescription = null) },
        label = { Text(label) },
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
        shape = MaterialTheme.shapes.medium,
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
            selectedIconColor = MaterialTheme.colorScheme.primary,
            selectedTextColor = MaterialTheme.colorScheme.onPrimaryContainer,
        ),
    )
}
