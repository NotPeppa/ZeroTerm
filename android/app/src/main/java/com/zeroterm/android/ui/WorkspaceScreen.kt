package com.zeroterm.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.AppContainer
import com.zeroterm.android.ui.hosts.HostsScreen
import com.zeroterm.android.ui.ai.AiScreen
import com.zeroterm.android.ui.hosts.HostsViewModel
import com.zeroterm.android.ui.components.LocalChromeTransparency
import com.zeroterm.android.ui.settings.WorkspaceSettingsPage
import com.zeroterm.android.ui.settings.WorkspaceSettingsPane
import com.zeroterm.android.ui.sync.SyncScreen
import com.zeroterm.ffi.HostSummary
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
    onLockAndForget: () -> Unit,
) {
    var page by rememberSaveable { mutableStateOf(WorkspacePage.Hosts) }
    val hosts by container.repository.hosts.collectAsState()
    val scope = rememberCoroutineScope()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val drawerAlpha = 1f - LocalChromeTransparency.current.drawer.coerceIn(0f, 0.8f)

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
                    NavigationDrawerItem(
                        selected = false,
                        onClick = onLock,
                        icon = { Icon(Icons.Default.Lock, null) },
                        label = { Text(stringResource(R.string.hosts_lock)) },
                        modifier = Modifier.padding(12.dp),
                    )
                    NavigationDrawerItem(
                        selected = false,
                        onClick = onLockAndForget,
                        icon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                        label = { Text(stringResource(R.string.hosts_lock_forget)) },
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
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
