package com.zeroterm.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.zeroterm.android.data.AppContainer
import com.zeroterm.android.ui.hosts.HostEditScreen
import com.zeroterm.android.ui.hosts.HostsViewModel
import com.zeroterm.android.ui.quick.QuickConnectScreen
import com.zeroterm.android.ui.settings.SettingsScreen
import com.zeroterm.android.ui.sftp.SftpBrowserScreen
import com.zeroterm.android.ui.snippets.SnippetsScreen
import com.zeroterm.android.ui.sync.SyncScreen
import com.zeroterm.android.ui.terminal.TerminalScreen
import com.zeroterm.android.ui.unlock.UnlockScreen
import com.zeroterm.android.ui.unlock.UnlockViewModel
import com.zeroterm.android.ui.components.AppBackground
import com.zeroterm.android.ui.components.ChromeTransparency
import com.zeroterm.android.ui.components.LocalChromeTransparency
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.launch

object Routes {
    const val Unlock = "unlock"
    const val Hosts = "hosts"
    const val HostNew = "host/new"
    const val HostEdit = "host/edit/{hostId}"
    const val Terminal = "terminal/{hostId}/{hostLabel}"
    const val TerminalDirect = "terminal_direct/{hostLabel}"
    const val QuickConnect = "quick"
    const val Settings = "settings"
    const val Snippets = "snippets"
    const val SnippetPick = "snippet_pick"
    const val Sync = "sync"
    const val Sftp = "sftp/{hostId}/{hostLabel}"

    fun hostEdit(hostId: String): String {
        val enc = URLEncoder.encode(hostId, StandardCharsets.UTF_8.toString())
        return "host/edit/$enc"
    }

    fun terminal(hostId: String, hostLabel: String): String {
        val encId = URLEncoder.encode(hostId, StandardCharsets.UTF_8.toString())
        val encLabel = URLEncoder.encode(hostLabel, StandardCharsets.UTF_8.toString())
        return "terminal/$encId/$encLabel"
    }

    fun terminalDirect(hostLabel: String): String {
        val encLabel = URLEncoder.encode(hostLabel, StandardCharsets.UTF_8.toString())
        return "terminal_direct/$encLabel"
    }

    fun sftp(hostId: String, hostLabel: String): String {
        val encId = URLEncoder.encode(hostId, StandardCharsets.UTF_8.toString())
        val encLabel = URLEncoder.encode(hostLabel, StandardCharsets.UTF_8.toString())
        return "sftp/$encId/$encLabel"
    }
}

@Composable
fun ZeroTermNav(container: AppContainer) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val unlockVm: UnlockViewModel = viewModel(
        factory = UnlockViewModel.factory(container.repository, context),
    )
    val unlocked by container.repository.unlocked.collectAsState()
    val settings by container.settings.flow.collectAsState(
        initial = com.zeroterm.android.data.SettingsSnapshot(),
    )

    val start = if (unlocked) Routes.Hosts else Routes.Unlock

    fun persistFont(sp: Float) {
        scope.launch { container.settings.setFontSize(sp) }
    }

    androidx.compose.runtime.LaunchedEffect(container) {
        container.openActiveSessionRequests.collect {
            val active = container.sessions.active.value ?: return@collect
            val route = if (active.hostId == "direct") {
                Routes.terminalDirect(active.hostLabel)
            } else {
                Routes.terminal(active.hostId, active.hostLabel)
            }
            nav.navigate(route) { launchSingleTop = true }
        }
    }

    AppBackground(
        imagePath = settings.backgroundImagePath,
        opacity = settings.backgroundOpacity,
        blurDp = settings.backgroundBlurDp,
    ) {
    CompositionLocalProvider(
        LocalChromeTransparency provides ChromeTransparency(
            topBar = settings.topBarTransparency,
            drawer = settings.drawerTransparency,
        ),
    ) {
    NavHost(navController = nav, startDestination = start) {
        composable(Routes.Unlock) {
            UnlockScreen(
                viewModel = unlockVm,
                onUnlocked = {
                    nav.navigate(Routes.Hosts) {
                        popUpTo(Routes.Unlock) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.Hosts) {
            val hostsVm: HostsViewModel = viewModel(
                factory = HostsViewModel.factory(container.repository),
            )
            WorkspaceScreen(
                container = container,
                hostsViewModel = hostsVm,
                onHostClick = { host ->
                    val label = host.name.ifBlank { "${host.user}@${host.host}" }
                    nav.navigate(Routes.terminal(host.id, label))
                },
                onAddHost = { nav.navigate(Routes.HostNew) },
                onEditHost = { host -> nav.navigate(Routes.hostEdit(host.id)) },
                onSftp = { host ->
                    val label = host.name.ifBlank { "${host.user}@${host.host}" }
                    nav.navigate(Routes.sftp(host.id, label))
                },
                onQuickConnect = { nav.navigate(Routes.QuickConnect) },
                onLock = {
                    scope.launch {
                        container.sessions.disconnectAll()
                        container.sftp.close()
                        container.repository.lock(clearCache = false)
                        unlockVm.prepareForUnlock()
                        nav.navigate(Routes.Unlock) {
                            popUpTo(Routes.Hosts) { inclusive = true }
                            launchSingleTop = true
                        }
                    }
                },
            )
        }
        composable(Routes.HostNew) {
            HostEditScreen(
                repository = container.repository,
                editId = null,
                onDone = { nav.popBackStack() },
            )
        }
        composable(
            route = Routes.HostEdit,
            arguments = listOf(navArgument("hostId") { type = NavType.StringType }),
        ) { entry ->
            val hostId = URLDecoder.decode(
                entry.arguments?.getString("hostId").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            HostEditScreen(
                repository = container.repository,
                editId = hostId,
                onDone = { nav.popBackStack() },
            )
        }
        composable(Routes.QuickConnect) {
            QuickConnectScreen(
                sessions = container.sessions,
                onConnected = { label ->
                    nav.navigate(Routes.terminalDirect(label)) {
                        popUpTo(Routes.QuickConnect) { inclusive = true }
                    }
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.Settings) {
            SettingsScreen(
                settings = container.settings,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.Snippets) {
            SnippetsScreen(
                repository = container.repository,
                onInsert = null,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.Sync) {
            val hosts by container.repository.hosts.collectAsState()
            SyncScreen(
                zeroTerm = container.zeroTerm,
                hosts = hosts,
                onDataChanged = {
                    scope.launch { container.repository.refreshHosts() }
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.SnippetPick) {
            SnippetsScreen(
                repository = container.repository,
                onInsert = { cmd ->
                    // Stash for terminal to pick up via previousBackStackEntry
                    nav.previousBackStackEntry
                        ?.savedStateHandle
                        ?.set("snippet_cmd", cmd)
                    nav.popBackStack()
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = Routes.Sftp,
            arguments = listOf(
                navArgument("hostId") { type = NavType.StringType },
                navArgument("hostLabel") { type = NavType.StringType },
            ),
        ) { entry ->
            val hostId = URLDecoder.decode(
                entry.arguments?.getString("hostId").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            val hostLabel = URLDecoder.decode(
                entry.arguments?.getString("hostLabel").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            SftpBrowserScreen(
                hostId = hostId,
                hostLabel = hostLabel,
                sftp = container.sftp,
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = Routes.Terminal,
            arguments = listOf(
                navArgument("hostId") { type = NavType.StringType },
                navArgument("hostLabel") { type = NavType.StringType },
            ),
        ) { entry ->
            val hostId = URLDecoder.decode(
                entry.arguments?.getString("hostId").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            val hostLabel = URLDecoder.decode(
                entry.arguments?.getString("hostLabel").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            TerminalScreen(
                hostId = hostId,
                hostLabel = hostLabel,
                alreadyConnected = false,
                sessions = container.sessions,
                repository = container.repository,
                settings = container.settings,
                fontSizeSp = settings.fontSizeSp,
                backgroundImagePath = settings.backgroundImagePath,
                backgroundOpacity = settings.backgroundOpacity,
                backgroundBlurDp = settings.backgroundBlurDp,
                onFontSizeChanged = ::persistFont,
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = Routes.TerminalDirect,
            arguments = listOf(
                navArgument("hostLabel") { type = NavType.StringType },
            ),
        ) { entry ->
            val hostLabel = URLDecoder.decode(
                entry.arguments?.getString("hostLabel").orEmpty(),
                StandardCharsets.UTF_8.toString(),
            )
            TerminalScreen(
                hostId = null,
                hostLabel = hostLabel,
                alreadyConnected = true,
                sessions = container.sessions,
                repository = container.repository,
                settings = container.settings,
                fontSizeSp = settings.fontSizeSp,
                backgroundImagePath = settings.backgroundImagePath,
                backgroundOpacity = settings.backgroundOpacity,
                backgroundBlurDp = settings.backgroundBlurDp,
                onFontSizeChanged = ::persistFont,
                onBack = { nav.popBackStack() },
            )
        }
    }
    }
    }
}
