package com.zeroterm.android.ui.hosts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zeroterm.ffi.AuthKind
import com.zeroterm.ffi.HostSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(
    viewModel: HostsViewModel,
    onHostClick: (HostSummary) -> Unit,
    onAddHost: () -> Unit,
    onEditHost: (HostSummary) -> Unit,
    onSftp: (HostSummary) -> Unit,
    onQuickConnect: () -> Unit,
    onSnippets: () -> Unit,
    onSync: () -> Unit,
    onSettings: () -> Unit,
    onLock: () -> Unit,
    onLockAndForget: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    var menuOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Hosts") },
                actions = {
                    IconButton(onClick = onQuickConnect) {
                        Icon(Icons.Default.Bolt, contentDescription = "Quick Connect")
                    }
                    IconButton(onClick = viewModel::refresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Menu")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Snippets") },
                            onClick = {
                                menuOpen = false
                                onSnippets()
                            },
                            leadingIcon = { Icon(Icons.Default.Code, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Sync") },
                            onClick = {
                                menuOpen = false
                                onSync()
                            },
                            leadingIcon = { Icon(Icons.Default.Sync, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Settings") },
                            onClick = {
                                menuOpen = false
                                onSettings()
                            },
                            leadingIcon = { Icon(Icons.Default.Settings, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Lock") },
                            onClick = {
                                menuOpen = false
                                onLock()
                            },
                            leadingIcon = { Icon(Icons.Default.Lock, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Lock & forget password") },
                            onClick = {
                                menuOpen = false
                                onLockAndForget()
                            },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                        )
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAddHost) {
                Icon(Icons.Default.Add, contentDescription = "Add host")
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
        ) {
            OutlinedTextField(
                value = state.query,
                onValueChange = viewModel::onQueryChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Search") },
                leadingIcon = { Icon(Icons.Default.Search, null) },
            )
            Spacer(Modifier.height(12.dp))

            when {
                state.loading && state.hosts.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                state.hosts.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            text = if (state.query.isBlank()) {
                                "No hosts yet.\nTap + to add one."
                            } else {
                                "No matches"
                            },
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                    }
                }
                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 88.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(state.hosts, key = { it.id }) { host ->
                            HostCard(
                                host = host,
                                onClick = { onHostClick(host) },
                                onEdit = { onEditHost(host) },
                                onSftp = { onSftp(host) },
                            )
                        }
                    }
                }
            }

            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun HostCard(
    host: HostSummary,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onSftp: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Computer,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Column(modifier = Modifier.padding(start = 12.dp).weight(1f)) {
                Text(host.name.ifBlank { host.host }, style = MaterialTheme.typography.titleMedium)
                Text(
                    "${host.user}@${host.host}:${host.port}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                Text(
                    authLabel(host.authKind),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                )
            }
            IconButton(onClick = onSftp) {
                Icon(Icons.Default.FolderOpen, contentDescription = "SFTP")
            }
            IconButton(onClick = onEdit) {
                Icon(Icons.Default.Edit, contentDescription = "Edit")
            }
        }
    }
}

private fun authLabel(kind: AuthKind): String = when (kind) {
    AuthKind.PASSWORD -> "password"
    AuthKind.PRIVATE_KEY -> "private key"
    AuthKind.AGENT -> "agent"
}
