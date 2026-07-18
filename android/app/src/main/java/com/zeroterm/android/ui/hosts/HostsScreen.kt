package com.zeroterm.android.ui.hosts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.ui.components.ZeroEmptyState
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.AuthKind
import com.zeroterm.ffi.HostGroupInput
import com.zeroterm.ffi.HostGroupRecord
import com.zeroterm.ffi.HostSummary

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HostsScreen(
    viewModel: HostsViewModel,
    onHostClick: (HostSummary) -> Unit,
    onAddHost: () -> Unit,
    onEditHost: (HostSummary) -> Unit,
    onSftp: (HostSummary) -> Unit,
    onQuickConnect: () -> Unit,
    onOpenNavigation: (() -> Unit)? = null,
) {
    val state by viewModel.state.collectAsState()
    var groupEditorOpen by remember { mutableStateOf(false) }
    var editingGroup by remember { mutableStateOf<HostGroupRecord?>(null) }
    var pendingDeleteGroup by remember { mutableStateOf<HostGroupRecord?>(null) }
    var pendingDeleteHost by remember { mutableStateOf<HostSummary?>(null) }
    var addMenuOpen by remember { mutableStateOf(false) }
    var expandedGroupIds by rememberSaveable(
        stateSaver = listSaver(
            save = { it.toList() },
            restore = { it.toSet() },
        ),
    ) { mutableStateOf(emptySet<String>()) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = stringResource(R.string.hosts_title),
                subtitle = stringResource(R.string.hosts_count, state.hosts.size),
                navigationIcon = {
                    onOpenNavigation?.let {
                        IconButton(onClick = it) {
                            Icon(
                                Icons.Default.Menu,
                                contentDescription = stringResource(R.string.common_menu),
                            )
                        }
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { addMenuOpen = true }) {
                            Icon(
                                Icons.Default.Add,
                                contentDescription = stringResource(R.string.hosts_add_action),
                            )
                        }
                        DropdownMenu(
                            expanded = addMenuOpen,
                            onDismissRequest = { addMenuOpen = false },
                        ) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.hosts_add_group)) },
                                onClick = {
                                    addMenuOpen = false
                                    editingGroup = null
                                    groupEditorOpen = true
                                },
                                leadingIcon = { Icon(Icons.Default.CreateNewFolder, null) },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.hosts_add)) },
                                onClick = {
                                    addMenuOpen = false
                                    onAddHost()
                                },
                                leadingIcon = { Icon(Icons.Default.Computer, null) },
                            )
                        }
                    }
                    IconButton(onClick = onQuickConnect) {
                        Icon(
                            Icons.Default.Bolt,
                            contentDescription = stringResource(R.string.hosts_quick_connect),
                        )
                    }
                    IconButton(onClick = viewModel::refresh) {
                        Icon(
                            Icons.Default.Refresh,
                            contentDescription = stringResource(R.string.common_refresh),
                        )
                    }
                },
            )
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
                label = { Text(stringResource(R.string.common_search)) },
                leadingIcon = { Icon(Icons.Default.Search, null) },
            )
            Spacer(Modifier.height(12.dp))

            when {
                state.loading && state.hosts.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                state.hosts.isEmpty() && state.groups.isEmpty() -> {
                    ZeroEmptyState(
                        title = if (state.query.isBlank()) {
                            stringResource(R.string.hosts_empty_title)
                        } else {
                            stringResource(R.string.hosts_no_matches)
                        },
                        description = if (state.query.isBlank()) {
                            stringResource(R.string.hosts_empty_hint)
                        } else null,
                        icon = Icons.Default.Computer,
                    )
                }
                else -> {
                    val sections = hostSections(
                        hosts = state.hosts,
                        groups = state.groups,
                        ungroupedLabel = stringResource(R.string.hosts_ungrouped),
                        includeEmptyGroups = state.query.isBlank(),
                    )
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 88.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        sections.forEach { section ->
                            val expanded = section.id in expandedGroupIds
                            item(key = "group:${section.id}") {
                                var groupMenuOpen by remember { mutableStateOf(false) }
                                Box(Modifier.fillMaxWidth()) {
                                    val headerModifier = if (section.group != null) {
                                        Modifier.combinedClickable(
                                            onClick = {
                                                expandedGroupIds = if (expanded) {
                                                    expandedGroupIds - section.id
                                                } else {
                                                    expandedGroupIds + section.id
                                                }
                                            },
                                            onLongClickLabel = stringResource(
                                                R.string.hosts_group_actions,
                                            ),
                                            onLongClick = { groupMenuOpen = true },
                                        )
                                    } else {
                                        Modifier.clickable {
                                            expandedGroupIds = if (expanded) {
                                                expandedGroupIds - section.id
                                            } else {
                                                expandedGroupIds + section.id
                                            }
                                        }
                                    }
                                    Row(
                                        modifier = headerModifier
                                            .fillMaxWidth()
                                            .heightIn(min = 48.dp)
                                            .padding(
                                                start = 4.dp,
                                                top = 14.dp,
                                                end = 4.dp,
                                                bottom = 6.dp,
                                            ),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            text = section.label,
                                            style = MaterialTheme.typography.titleSmall,
                                            color = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.weight(1f),
                                        )
                                        Text(
                                            text = section.hosts.size.toString(),
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(horizontal = 8.dp),
                                        )
                                        Icon(
                                            imageVector = if (expanded) {
                                                Icons.Default.ExpandLess
                                            } else {
                                                Icons.Default.ExpandMore
                                            },
                                            contentDescription = stringResource(
                                                if (expanded) {
                                                    R.string.common_collapse
                                                } else {
                                                    R.string.common_expand
                                                },
                                            ),
                                            tint = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                    section.group?.let { group ->
                                        Box(
                                            modifier = Modifier
                                                .align(Alignment.BottomEnd)
                                                .size(1.dp),
                                        ) {
                                            DropdownMenu(
                                                expanded = groupMenuOpen,
                                                onDismissRequest = { groupMenuOpen = false },
                                            ) {
                                                DropdownMenuItem(
                                                    text = {
                                                        Text(stringResource(R.string.common_edit))
                                                    },
                                                    onClick = {
                                                        groupMenuOpen = false
                                                        editingGroup = group
                                                        groupEditorOpen = true
                                                    },
                                                    leadingIcon = { Icon(Icons.Default.Edit, null) },
                                                )
                                                DropdownMenuItem(
                                                    text = {
                                                        Text(
                                                            stringResource(R.string.common_delete),
                                                            color = MaterialTheme.colorScheme.error,
                                                        )
                                                    },
                                                    onClick = {
                                                        groupMenuOpen = false
                                                        pendingDeleteGroup = group
                                                    },
                                                    leadingIcon = {
                                                        Icon(
                                                            Icons.Default.Delete,
                                                            contentDescription = null,
                                                            tint = MaterialTheme.colorScheme.error,
                                                        )
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                            if (expanded) {
                                items(section.hosts, key = { it.id }) { host ->
                                    HostCard(
                                        host = host,
                                        onClick = { onHostClick(host) },
                                        onEdit = { onEditHost(host) },
                                        onDelete = { pendingDeleteHost = host },
                                        onSftp = { onSftp(host) },
                                    )
                                }
                            }
                        }
                    }
                }
            }

            state.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
        }
    }

    if (groupEditorOpen) {
        HostGroupEditorDialog(
            group = editingGroup,
            groups = state.groups,
            saving = state.loading,
            onDismiss = { groupEditorOpen = false },
            onSave = { name, parentId ->
                val current = editingGroup
                viewModel.saveGroup(
                    HostGroupInput(
                        id = current?.id,
                        name = name,
                        parentId = parentId,
                        sortOrder = current?.sortOrder ?: 0,
                    ),
                    onSuccess = { groupEditorOpen = false },
                )
            },
            onDelete = editingGroup?.let { group ->
                {
                    groupEditorOpen = false
                    pendingDeleteGroup = group
                }
            },
        )
    }

    pendingDeleteGroup?.let { group ->
        AlertDialog(
            onDismissRequest = { pendingDeleteGroup = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.hosts_delete_group_title)) },
            text = { Text(stringResource(R.string.hosts_delete_group_message, group.name)) },
            confirmButton = {
                TextButton(
                    enabled = !state.loading,
                    onClick = {
                        viewModel.deleteGroup(group.id) { pendingDeleteGroup = null }
                    },
                ) {
                    Text(stringResource(R.string.common_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteGroup = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    pendingDeleteHost?.let { host ->
        AlertDialog(
            onDismissRequest = { pendingDeleteHost = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.hosts_delete_host_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.hosts_delete_host_message,
                        host.name.ifBlank { host.host },
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !state.loading,
                    onClick = {
                        viewModel.deleteHost(host.id) { pendingDeleteHost = null }
                    },
                ) {
                    Text(stringResource(R.string.common_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteHost = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

private data class HostSection(
    val id: String,
    val label: String,
    val hosts: List<HostSummary>,
    val group: HostGroupRecord?,
)

private fun hostSections(
    hosts: List<HostSummary>,
    groups: List<HostGroupRecord>,
    ungroupedLabel: String,
    includeEmptyGroups: Boolean,
): List<HostSection> {
    val byId = groups.associateBy { it.id }
    val groupedHosts = hosts.groupBy { it.groupId }
    val sections = groups.mapNotNull { group ->
        val members = groupedHosts[group.id].orEmpty()
        if (!includeEmptyGroups && members.isEmpty()) {
            null
        } else {
            HostSection(group.id, hostGroupPath(group, byId), members, group)
        }
    }.sortedWith(compareBy<HostSection> { it.label.lowercase() }.thenBy { it.id })

    val ungrouped = hosts.filter { it.groupId == null || it.groupId !in byId }
    return if (ungrouped.isEmpty()) {
        sections
    } else {
        sections + HostSection("ungrouped", ungroupedLabel, ungrouped, null)
    }
}

@Composable
private fun HostGroupEditorDialog(
    group: HostGroupRecord?,
    groups: List<HostGroupRecord>,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSave: (name: String, parentId: String?) -> Unit,
    onDelete: (() -> Unit)?,
) {
    var name by remember(group?.id) { mutableStateOf(group?.name.orEmpty()) }
    var parentId by remember(group?.id) { mutableStateOf(group?.parentId) }
    val byId = groups.associateBy { it.id }
    val excluded = group?.let { descendantGroupIds(it.id, groups) + it.id }.orEmpty()
    val parentOptions = groups
        .filter { it.id !in excluded }
        .sortedBy { hostGroupPath(it, byId).lowercase() }

    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnClickOutside = false),
        title = {
            Text(
                stringResource(
                    if (group == null) R.string.hosts_add_group else R.string.hosts_edit_group,
                ),
            )
        },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.common_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.hosts_parent_group),
                    style = MaterialTheme.typography.labelLarge,
                )
                Row(Modifier.horizontalScroll(rememberScrollState())) {
                    FilterChip(
                        selected = parentId == null,
                        onClick = { parentId = null },
                        label = { Text(stringResource(R.string.hosts_root_group)) },
                    )
                    parentOptions.forEach { option ->
                        Spacer(Modifier.padding(4.dp))
                        FilterChip(
                            selected = parentId == option.id,
                            onClick = { parentId = option.id },
                            label = { Text(hostGroupPath(option, byId)) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && !saving,
                onClick = { onSave(name.trim(), parentId) },
            ) {
                Text(stringResource(R.string.common_save))
            }
        },
        dismissButton = {
            Row {
                onDelete?.let {
                    TextButton(enabled = !saving, onClick = it) {
                        Icon(Icons.Default.Delete, contentDescription = null)
                        Text(stringResource(R.string.common_delete))
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.common_cancel))
                }
            }
        },
    )
}

private fun descendantGroupIds(id: String, groups: List<HostGroupRecord>): Set<String> {
    val descendants = mutableSetOf<String>()
    var frontier = setOf(id)
    while (frontier.isNotEmpty()) {
        val children = groups
            .filter { it.parentId in frontier && it.id !in descendants }
            .mapTo(mutableSetOf()) { it.id }
        descendants += children
        frontier = children
    }
    return descendants
}

internal fun hostGroupPath(
    group: HostGroupRecord,
    byId: Map<String, HostGroupRecord>,
): String {
    val names = mutableListOf<String>()
    val visited = mutableSetOf<String>()
    var current: HostGroupRecord? = group
    while (current != null && visited.add(current.id)) {
        names += current.name
        current = current.parentId?.let(byId::get)
    }
    return names.asReversed().joinToString(" / ")
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HostCard(
    host: HostSummary,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onSftp: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = onClick,
                    onLongClickLabel = stringResource(R.string.hosts_host_actions),
                    onLongClick = { menuOpen = true },
                ),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.52f),
                contentColor = MaterialTheme.colorScheme.onSurface,
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            border = BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f),
            ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Icon(
                        Icons.Default.Computer,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(10.dp),
                    )
                }
                Column(modifier = Modifier.padding(start = 12.dp).weight(1f)) {
                    Text(
                        host.name.ifBlank { host.host },
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        "${host.user}@${host.host}:${host.port}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        authLabel(host.authKind),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(onClick = onSftp) {
                    Icon(
                        Icons.Default.FolderOpen,
                        contentDescription = stringResource(R.string.hosts_sftp),
                    )
                }
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .size(1.dp),
        ) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.common_edit)) },
                    onClick = {
                        menuOpen = false
                        onEdit()
                    },
                    leadingIcon = { Icon(Icons.Default.Edit, null) },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(R.string.common_delete),
                            color = MaterialTheme.colorScheme.error,
                        )
                    },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                    leadingIcon = {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                        )
                    },
                )
            }
        }
    }
}

@Composable
private fun authLabel(kind: AuthKind): String = when (kind) {
    AuthKind.PASSWORD -> stringResource(R.string.auth_password)
    AuthKind.PRIVATE_KEY -> stringResource(R.string.auth_private_key)
    AuthKind.AGENT -> stringResource(R.string.auth_agent)
}
