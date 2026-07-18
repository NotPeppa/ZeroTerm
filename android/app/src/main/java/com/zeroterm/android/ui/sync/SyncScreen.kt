package com.zeroterm.android.ui.sync

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.SettingsSnapshot
import com.zeroterm.android.ui.components.ZeroEmptyState
import com.zeroterm.android.ui.components.ZeroSectionCard
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.ConflictRecord
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.SyncBackendKind
import com.zeroterm.ffi.SyncDeviceRecord
import com.zeroterm.ffi.SyncOutcomeRecord
import com.zeroterm.ffi.SyncProfileInput
import com.zeroterm.ffi.SyncProfileSummary
import com.zeroterm.ffi.SyncRepoStatsRecord
import com.zeroterm.ffi.SyncStatusRecord
import com.zeroterm.ffi.ZeroTerm
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class DeleteRequest(val profile: SyncProfileSummary, val remote: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(
    zeroTerm: ZeroTerm,
    hosts: List<HostSummary>,
    onDataChanged: () -> Unit,
    onBack: (() -> Unit)? = null,
    settings: AppSettings? = null,
    onOpenNavigation: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var profiles by remember { mutableStateOf<List<SyncProfileSummary>>(emptyList()) }
    var conflicts by remember { mutableStateOf<List<ConflictRecord>>(emptyList()) }
    val statuses = remember { mutableStateMapOf<String, SyncStatusRecord>() }
    val outcomes = remember { mutableStateMapOf<String, SyncOutcomeRecord>() }
    val devices = remember { mutableStateMapOf<String, List<SyncDeviceRecord>>() }
    val stats = remember { mutableStateMapOf<String, SyncRepoStatsRecord>() }
    var expandedProfileId by remember { mutableStateOf<String?>(null) }
    var busyProfileId by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var editingProfile by remember { mutableStateOf<SyncProfileSummary?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var deleteRequest by remember { mutableStateOf<DeleteRequest?>(null) }

    fun reload(showLoader: Boolean = false) {
        scope.launch {
            if (showLoader) loading = true
            val result = withContext(Dispatchers.Default) {
                runCatching {
                    val loadedProfiles = zeroTerm.listSyncProfiles()
                    val loadedConflicts = zeroTerm.listOpenConflicts()
                    val loadedStatuses = loadedProfiles.mapNotNull { profile ->
                        runCatching { zeroTerm.syncStatus(profile.id) }.getOrNull()?.let { profile.id to it }
                    }.toMap()
                    Triple(loadedProfiles, loadedConflicts, loadedStatuses)
                }
            }
            result.fold(
                onSuccess = { (p, c, s) ->
                    profiles = p
                    conflicts = c
                    statuses.clear()
                    statuses.putAll(s)
                },
                onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
            )
            loading = false
        }
    }

    fun syncOne(profile: SyncProfileSummary) {
        scope.launch {
            busyProfileId = profile.id
            error = null
            notice = null
            val result = withContext(Dispatchers.Default) { runCatching { zeroTerm.syncNow(profile.id) } }
            result.fold(
                onSuccess = { outcome ->
                    outcomes[profile.id] = outcome
                    notice = context.getString(
                        R.string.sync_result_detailed,
                        outcome.eventsPulled.toInt(),
                        outcome.eventsPushed.toInt(),
                        outcome.upsertsApplied.toInt(),
                        outcome.deletesApplied.toInt(),
                        outcome.conflictsDetected.toInt(),
                    )
                    onDataChanged()
                },
                onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
            )
            busyProfileId = null
            reload()
        }
    }

    fun loadDetails(profile: SyncProfileSummary) {
        scope.launch {
            busyProfileId = profile.id
            val result = withContext(Dispatchers.Default) {
                runCatching {
                    val status = zeroTerm.syncStatus(profile.id)
                    val loadedDevices = if (status.bootstrapped) zeroTerm.syncListDevices(profile.id) else emptyList()
                    val loadedStats = if (status.bootstrapped) zeroTerm.syncRepoStats(profile.id) else null
                    Triple(status, loadedDevices, loadedStats)
                }
            }
            result.fold(
                onSuccess = { (status, loadedDevices, loadedStats) ->
                    statuses[profile.id] = status
                    devices[profile.id] = loadedDevices
                    if (loadedStats != null) stats[profile.id] = loadedStats
                },
                onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
            )
            busyProfileId = null
        }
    }

    LaunchedEffect(Unit) { reload(showLoader = true) }

    if (showCreate || editingProfile != null) {
        SyncProfileDialog(
            hosts = hosts,
            initial = editingProfile,
            saving = busyProfileId == editingProfile?.id || busyProfileId == "new",
            externalError = error,
            onDismiss = {
                if (busyProfileId == null) {
                    showCreate = false
                    editingProfile = null
                    error = null
                }
            },
            onSave = { input, bootstrapMode ->
                scope.launch {
                    busyProfileId = input.id ?: "new"
                    error = null
                    notice = null
                    val result = withContext(Dispatchers.Default) {
                        runCatching {
                            val id = zeroTerm.saveSyncProfile(input)
                            when (bootstrapMode) {
                                "create" -> zeroTerm.syncCreateRepo(id, input.encryptionPassphrase)
                                "join" -> zeroTerm.syncJoinRepo(id, input.encryptionPassphrase)
                            }
                            id
                        }
                    }
                    result.fold(
                        onSuccess = {
                            notice = context.getString(
                                when (bootstrapMode) {
                                    "create" -> R.string.sync_repo_created
                                    "join" -> R.string.sync_repo_joined
                                    else -> R.string.sync_profile_updated
                                },
                            )
                            showCreate = false
                            editingProfile = null
                            onDataChanged()
                            reload()
                        },
                        onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
                    )
                    busyProfileId = null
                }
            },
        )
    }

    deleteRequest?.let { request ->
        AlertDialog(
            onDismissRequest = { if (busyProfileId == null) deleteRequest = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            icon = { Icon(if (request.remote) Icons.Default.DeleteForever else Icons.Default.Delete, null) },
            title = {
                Text(
                    stringResource(
                        if (request.remote) R.string.sync_delete_remote_title else R.string.sync_delete_profile_title,
                    ),
                )
            },
            text = {
                Text(
                    stringResource(
                        if (request.remote) R.string.sync_delete_remote_message else R.string.sync_delete_profile_message,
                        request.profile.name,
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = busyProfileId == null,
                    onClick = {
                        scope.launch {
                            busyProfileId = request.profile.id
                            val result = withContext(Dispatchers.Default) {
                                runCatching {
                                    if (request.remote) {
                                        zeroTerm.syncDeleteRemoteRepo(request.profile.id)
                                    } else {
                                        zeroTerm.deleteSyncProfile(request.profile.id)
                                    }
                                }
                            }
                            result.fold(
                                onSuccess = {
                                    notice = context.getString(
                                        if (request.remote) R.string.sync_remote_deleted else R.string.sync_profile_deleted,
                                    )
                                    deleteRequest = null
                                    reload()
                                },
                                onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
                            )
                            busyProfileId = null
                        }
                    },
                ) { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteRequest = null }, enabled = busyProfileId == null) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = stringResource(R.string.sync_title),
                subtitle = stringResource(R.string.sync_subtitle),
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back))
                        }
                    } else if (onOpenNavigation != null) {
                        IconButton(onClick = onOpenNavigation) {
                            Icon(Icons.Default.Menu, stringResource(R.string.common_menu))
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { reload(showLoader = true) }, enabled = !loading) {
                        Icon(Icons.Default.Refresh, stringResource(R.string.common_refresh))
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { error = null; showCreate = true }) {
                Icon(Icons.Default.Add, stringResource(R.string.sync_add_profile))
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp, 12.dp, 16.dp, 96.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            error?.let { message -> item { MessageCard(message, error = true, onDismiss = { error = null }) } }
            notice?.let { message -> item { MessageCard(message, error = false, onDismiss = { notice = null }) } }

            item {
                SyncOverviewCard(
                    profileCount = profiles.size,
                    connectedCount = statuses.values.count { it.bootstrapped && it.profileValid },
                    conflictCount = conflicts.size,
                    busy = busyProfileId != null,
                    onSyncAll = {
                        scope.launch {
                            error = null
                            notice = null
                            var pulled = 0
                            var pushed = 0
                            var failed = 0
                            profiles.forEach { profile ->
                                busyProfileId = profile.id
                                withContext(Dispatchers.Default) { runCatching { zeroTerm.syncNow(profile.id) } }
                                    .onSuccess {
                                        outcomes[profile.id] = it
                                        pulled += it.eventsPulled.toInt()
                                        pushed += it.eventsPushed.toInt()
                                    }
                                    .onFailure { failed++ }
                            }
                            busyProfileId = null
                            notice = context.getString(R.string.sync_all_result, pulled, pushed, failed)
                            onDataChanged()
                            reload()
                        }
                    },
                )
            }

            settings?.let { appSettings -> item { AutoSyncSettings(appSettings) } }

            item {
                Text(
                    stringResource(R.string.sync_profiles_section),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            if (!loading && profiles.isEmpty()) {
                item {
                    ZeroEmptyState(
                        title = stringResource(R.string.sync_empty_title),
                        description = stringResource(R.string.sync_empty),
                        icon = Icons.Default.Sync,
                        modifier = Modifier.fillMaxWidth().height(240.dp),
                        action = {
                            Button(onClick = { showCreate = true }) {
                                Icon(Icons.Default.Add, null)
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.sync_add_profile))
                            }
                        },
                    )
                }
            }

            items(profiles, key = { it.id }) { profile ->
                SyncProfileCard(
                    profile = profile,
                    status = statuses[profile.id],
                    outcome = outcomes[profile.id],
                    devices = devices[profile.id],
                    stats = stats[profile.id],
                    expanded = expandedProfileId == profile.id,
                    busy = busyProfileId == profile.id,
                    onSync = { syncOne(profile) },
                    onEdit = { error = null; editingProfile = profile },
                    onToggleDetails = {
                        if (expandedProfileId == profile.id) {
                            expandedProfileId = null
                        } else {
                            expandedProfileId = profile.id
                            loadDetails(profile)
                        }
                    },
                    onCompact = {
                        scope.launch {
                            busyProfileId = profile.id
                            val result = withContext(Dispatchers.Default) {
                                runCatching { zeroTerm.syncCompact(profile.id) }
                            }
                            result.fold(
                                onSuccess = {
                                    notice = context.getString(
                                        R.string.sync_compact_result,
                                        it.eventsCompacted.toInt(),
                                        it.recordsInSnapshot.toInt(),
                                    )
                                    loadDetails(profile)
                                },
                                onFailure = { error = it.message ?: context.getString(R.string.common_failed) },
                            )
                            busyProfileId = null
                        }
                    },
                    onDisconnect = {
                        scope.launch {
                            busyProfileId = profile.id
                            withContext(Dispatchers.Default) { zeroTerm.syncForgetEngine(profile.id) }
                            devices.remove(profile.id)
                            stats.remove(profile.id)
                            busyProfileId = null
                            notice = context.getString(R.string.sync_disconnected)
                            reload()
                        }
                    },
                    onDeleteRemote = { deleteRequest = DeleteRequest(profile, remote = true) },
                    onDelete = { deleteRequest = DeleteRequest(profile, remote = false) },
                )
            }

            if (conflicts.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.sync_conflicts_count, conflicts.size),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                items(conflicts, key = { it.id }) { conflict ->
                    ConflictCard(
                        conflict = conflict,
                        onResolve = { keepLocal ->
                            scope.launch {
                                busyProfileId = "conflict:${conflict.id}"
                                val result = withContext(Dispatchers.Default) {
                                    runCatching { zeroTerm.resolveConflict(conflict.id, keepLocal) }
                                }
                                result.onFailure { error = it.message ?: context.getString(R.string.common_failed) }
                                busyProfileId = null
                                reload()
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SyncOverviewCard(
    profileCount: Int,
    connectedCount: Int,
    conflictCount: Int,
    busy: Boolean,
    onSyncAll: () -> Unit,
) {
    ZeroSectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(48.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Cloud, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(30.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.sync_overview), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(R.string.sync_overview_summary, connectedCount, profileCount, conflictCount),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            FilledTonalButton(onClick = onSyncAll, enabled = profileCount > 0 && !busy) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(Icons.Default.Sync, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.sync_all))
            }
        }
    }
}

@Composable
private fun AutoSyncSettings(settings: AppSettings) {
    val snap by settings.flow.collectAsState(initial = SettingsSnapshot())
    val scope = rememberCoroutineScope()
    var intervalMenu by remember { mutableStateOf(false) }
    ZeroSectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.settings_auto_sync), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.settings_auto_sync_help),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = snap.autoSync,
                onCheckedChange = { scope.launch { settings.setAutoSync(it) } },
            )
        }
        if (snap.autoSync) {
            Spacer(Modifier.height(12.dp))
            Divider()
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings_interval), Modifier.weight(1f))
                Box {
                    TextButton(onClick = { intervalMenu = true }) {
                        Text(stringResource(R.string.settings_interval_value, snap.autoSyncIntervalMin))
                        Icon(Icons.Default.ExpandMore, null)
                    }
                    DropdownMenu(expanded = intervalMenu, onDismissRequest = { intervalMenu = false }) {
                        listOf(5, 15, 30, 60, 120).forEach { minutes ->
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.settings_interval_value, minutes)) },
                                onClick = {
                                    intervalMenu = false
                                    scope.launch { settings.setAutoSyncIntervalMin(minutes) }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SyncProfileCard(
    profile: SyncProfileSummary,
    status: SyncStatusRecord?,
    outcome: SyncOutcomeRecord?,
    devices: List<SyncDeviceRecord>?,
    stats: SyncRepoStatsRecord?,
    expanded: Boolean,
    busy: Boolean,
    onSync: () -> Unit,
    onEdit: () -> Unit,
    onToggleDetails: () -> Unit,
    onCompact: () -> Unit,
    onDisconnect: () -> Unit,
    onDeleteRemote: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(0.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().clickable(onClick = onToggleDetails).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    when (profile.backend) {
                        SyncBackendKind.SFTP -> Icons.Default.Devices
                        SyncBackendKind.S3 -> Icons.Default.Storage
                        else -> Icons.Default.Cloud
                    },
                    null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(28.dp),
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(profile.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        backendLabel(profile),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(4.dp))
                    StatusLine(status)
                }
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                IconButton(onClick = onToggleDetails) {
                    Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, stringResource(R.string.sync_details))
                }
                Box {
                    IconButton(onClick = { menuExpanded = true }) {
                        Icon(Icons.Default.MoreVert, stringResource(R.string.common_menu))
                    }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.common_edit)) },
                            leadingIcon = { Icon(Icons.Default.Edit, null) },
                            onClick = { menuExpanded = false; onEdit() },
                        )
                        if (status?.bootstrapped == true) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sync_disconnect)) },
                                leadingIcon = { Icon(Icons.Default.LinkOff, null) },
                                onClick = { menuExpanded = false; onDisconnect() },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.sync_delete_remote)) },
                                leadingIcon = { Icon(Icons.Default.DeleteForever, null, tint = MaterialTheme.colorScheme.error) },
                                onClick = { menuExpanded = false; onDeleteRemote() },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { menuExpanded = false; onDelete() },
                        )
                    }
                }
            }

            Divider()
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                outcome?.let {
                    Text(
                        stringResource(R.string.sync_last_result, it.eventsPulled.toInt(), it.eventsPushed.toInt()),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                } ?: Spacer(Modifier.weight(1f))
                Button(onClick = onSync, enabled = !busy && status?.profileValid != false) {
                    Icon(Icons.Default.Sync, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.sync_now))
                }
            }

            if (expanded) {
                Divider()
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.sync_details), style = MaterialTheme.typography.titleSmall)
                    DetailRow(stringResource(R.string.sync_head_clock), status?.headClock?.toString() ?: "—")
                    DetailRow(stringResource(R.string.sync_vault_id), status?.vaultId?.takeIf { it.isNotBlank() } ?: "—")
                    stats?.let {
                        DetailRow(stringResource(R.string.sync_repo_size), formatBytes(it.totalBytes))
                        DetailRow(stringResource(R.string.sync_repo_objects), stringResource(R.string.sync_repo_objects_value, it.eventCount.toInt(), it.snapshotCount.toInt()))
                    }
                    devices?.let { list ->
                        Text(stringResource(R.string.sync_devices_count, list.size), style = MaterialTheme.typography.titleSmall)
                        if (list.isEmpty()) {
                            Text(stringResource(R.string.sync_devices_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            list.forEach { device ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Devices, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Spacer(Modifier.width(8.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(device.name.ifBlank { device.deviceId.take(12) })
                                        Text(
                                            formatDate(device.lastSeenAt),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    if (device.isCurrent) Text(stringResource(R.string.sync_current_device), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                    if (status?.bootstrapped == true) {
                        OutlinedButton(onClick = onCompact, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Default.Storage, null)
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.sync_compact))
                        }
                    } else {
                        Text(
                            stringResource(R.string.sync_not_connected_help),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusLine(status: SyncStatusRecord?) {
    val valid = status?.profileValid != false
    val connected = status?.bootstrapped == true
    Icon(
        when {
            !valid -> Icons.Default.Warning
            connected -> Icons.Default.CheckCircle
            else -> Icons.Default.LinkOff
        },
        null,
        modifier = Modifier.size(15.dp),
        tint = when {
            !valid -> MaterialTheme.colorScheme.error
            connected -> MaterialTheme.colorScheme.primary
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
    Spacer(Modifier.width(4.dp))
    Text(
        when {
            !valid -> stringResource(R.string.sync_status_invalid)
            connected -> stringResource(R.string.sync_status_connected)
            else -> stringResource(R.string.sync_status_disconnected)
        },
        style = MaterialTheme.typography.labelSmall,
        color = if (!valid) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ConflictCard(conflict: ConflictRecord, onResolve: (Boolean) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f),
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.35f)),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.width(8.dp))
                Text("${conflict.kind} · ${conflict.recordId}", style = MaterialTheme.typography.titleSmall)
            }
            Text(stringResource(R.string.sync_local_preview, conflict.localPreview.take(160)), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.sync_remote_preview, conflict.remotePreview.take(160)), style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { onResolve(false) }) { Text(stringResource(R.string.sync_keep_remote)) }
                TextButton(onClick = { onResolve(true) }) { Text(stringResource(R.string.sync_keep_local)) }
            }
        }
    }
}

@Composable
private fun MessageCard(message: String, error: Boolean, onDismiss: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (error) Icons.Default.Warning else Icons.Default.CheckCircle, null)
            Spacer(Modifier.width(8.dp))
            Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) }
        }
    }
}

@Composable
private fun backendLabel(profile: SyncProfileSummary): String = when (profile.backend) {
    SyncBackendKind.LOCAL_FOLDER -> stringResource(R.string.sync_backend_local, profile.root)
    SyncBackendKind.SFTP -> stringResource(R.string.sync_backend_sftp, profile.hostRef, profile.remotePath)
    SyncBackendKind.WEB_DAV -> stringResource(R.string.sync_backend_webdav, profile.url)
    SyncBackendKind.S3 -> stringResource(R.string.sync_backend_s3, profile.bucket)
}

@Composable
private fun SyncProfileDialog(
    hosts: List<HostSummary>,
    initial: SyncProfileSummary?,
    saving: Boolean,
    externalError: String?,
    onDismiss: () -> Unit,
    onSave: (SyncProfileInput, bootstrapMode: String) -> Unit,
) {
    val editing = initial != null
    var name by remember(initial?.id) { mutableStateOf(initial?.name.orEmpty()) }
    val defaultName = stringResource(R.string.sync_default_name)
    LaunchedEffect(initial?.id) { if (!editing && name.isBlank()) name = defaultName }
    var backend by remember(initial?.id) { mutableStateOf(initial?.backend?.backendKey() ?: "webdav") }
    var backendMenu by remember { mutableStateOf(false) }
    var hostMenu by remember { mutableStateOf(false) }
    var url by remember(initial?.id) { mutableStateOf(initial?.url.orEmpty()) }
    var username by remember(initial?.id) { mutableStateOf(if (initial?.backend == SyncBackendKind.WEB_DAV) initial.username else "") }
    var password by remember(initial?.id) { mutableStateOf("") }
    var rootPath by remember(initial?.id) { mutableStateOf(if (initial?.backend == SyncBackendKind.WEB_DAV) initial.remotePath else "") }
    var hostRef by remember(initial?.id) { mutableStateOf(initial?.hostRef ?: hosts.firstOrNull()?.id.orEmpty()) }
    var remoteDir by remember(initial?.id) { mutableStateOf(if (initial?.backend == SyncBackendKind.SFTP) initial.remotePath else "/zeroterm-sync") }
    var region by remember(initial?.id) { mutableStateOf(initial?.region?.ifBlank { "us-east-1" } ?: "us-east-1") }
    var bucket by remember(initial?.id) { mutableStateOf(initial?.bucket.orEmpty()) }
    var prefix by remember(initial?.id) { mutableStateOf(if (initial?.backend == SyncBackendKind.S3) initial.remotePath else "") }
    var endpoint by remember(initial?.id) { mutableStateOf(initial?.endpoint.orEmpty()) }
    var accessKeyId by remember(initial?.id) { mutableStateOf(if (initial?.backend == SyncBackendKind.S3) initial.username else "") }
    var sessionToken by remember(initial?.id) { mutableStateOf("") }
    var forcePathStyle by remember(initial?.id) { mutableStateOf(initial?.forcePathStyle ?: false) }
    var passphrase by remember(initial?.id) { mutableStateOf("") }
    var bootstrapMode by remember { mutableStateOf("join") }
    var formError by remember { mutableStateOf<String?>(null) }

    val errorName = stringResource(R.string.sync_err_name_required)
    val errorPassphrase = stringResource(R.string.sync_err_passphrase_required)
    val errorUrl = stringResource(R.string.sync_err_url_required)
    val errorHost = stringResource(R.string.sync_err_host_required)
    val errorBucket = stringResource(R.string.sync_err_bucket_required)
    val errorAccessKey = stringResource(R.string.sync_err_access_key_required)

    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnClickOutside = false),
        title = { Text(stringResource(if (editing) R.string.sync_edit_title else R.string.sync_add_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                (formError ?: externalError)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it; formError = null },
                    label = { Text(stringResource(R.string.common_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(stringResource(R.string.sync_backend), style = MaterialTheme.typography.labelMedium)
                Box(Modifier.fillMaxWidth()) {
                    OutlinedButton(onClick = { backendMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(backendDisplayName(backend), Modifier.weight(1f))
                        Icon(Icons.Default.ExpandMore, null)
                    }
                    DropdownMenu(expanded = backendMenu, onDismissRequest = { backendMenu = false }) {
                        listOf("webdav", "sftp", "s3").forEach { key ->
                            DropdownMenuItem(
                                text = { Text(backendDisplayName(key)) },
                                onClick = { backend = key; backendMenu = false; formError = null },
                            )
                        }
                    }
                }
                when (backend) {
                    "webdav" -> {
                        SyncTextField(url, { url = it }, R.string.common_url)
                        SyncTextField(rootPath, { rootPath = it }, R.string.sync_root_path)
                        SyncTextField(username, { username = it }, R.string.common_username)
                        SecretField(password, { password = it }, R.string.common_password, editing)
                    }
                    "sftp" -> {
                        Text(stringResource(R.string.sync_host), style = MaterialTheme.typography.labelMedium)
                        Box(Modifier.fillMaxWidth()) {
                            OutlinedButton(onClick = { hostMenu = true }, modifier = Modifier.fillMaxWidth()) {
                                Text(hosts.firstOrNull { it.id == hostRef }?.let { it.name.ifBlank { it.host } } ?: stringResource(R.string.sync_select_host), Modifier.weight(1f))
                                Icon(Icons.Default.ExpandMore, null)
                            }
                            DropdownMenu(expanded = hostMenu, onDismissRequest = { hostMenu = false }) {
                                hosts.forEach { host ->
                                    DropdownMenuItem(
                                        text = { Text(host.name.ifBlank { host.host }) },
                                        onClick = { hostRef = host.id; hostMenu = false },
                                    )
                                }
                            }
                        }
                        SyncTextField(remoteDir, { remoteDir = it }, R.string.sync_remote_dir)
                    }
                    "s3" -> {
                        SyncTextField(region, { region = it }, R.string.sync_region)
                        SyncTextField(bucket, { bucket = it }, R.string.sync_bucket)
                        SyncTextField(prefix, { prefix = it }, R.string.sync_prefix)
                        SyncTextField(endpoint, { endpoint = it }, R.string.sync_endpoint)
                        SyncTextField(accessKeyId, { accessKeyId = it }, R.string.sync_access_key)
                        SecretField(password, { password = it }, R.string.sync_secret_key, editing)
                        SecretField(sessionToken, { sessionToken = it }, R.string.sync_session_token, editing)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.sync_path_style))
                                Text(stringResource(R.string.sync_path_style_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(checked = forcePathStyle, onCheckedChange = { forcePathStyle = it })
                        }
                    }
                }
                Divider()
                SecretField(passphrase, { passphrase = it }, R.string.sync_encryption_passphrase, editing)
                if (!editing) {
                    Text(stringResource(R.string.sync_bootstrap_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { bootstrapMode = "join" },
                            modifier = Modifier.weight(1f),
                            border = BorderStroke(1.dp, if (bootstrapMode == "join") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                        ) { Text(stringResource(R.string.sync_join_existing)) }
                        OutlinedButton(
                            onClick = { bootstrapMode = "create" },
                            modifier = Modifier.weight(1f),
                            border = BorderStroke(1.dp, if (bootstrapMode == "create") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                        ) { Text(stringResource(R.string.sync_create_new)) }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !saving,
                onClick = {
                    formError = when {
                        name.isBlank() -> errorName
                        !editing && passphrase.isBlank() -> errorPassphrase
                        backend == "webdav" && url.isBlank() -> errorUrl
                        backend == "sftp" && hostRef.isBlank() -> errorHost
                        backend == "s3" && bucket.isBlank() -> errorBucket
                        backend == "s3" && accessKeyId.isBlank() -> errorAccessKey
                        else -> null
                    }
                    if (formError != null) return@TextButton
                    onSave(
                        SyncProfileInput(
                            id = initial?.id,
                            name = name.trim(),
                            backend = backend,
                            root = "",
                            hostRef = hostRef,
                            remoteDir = remoteDir.trim(),
                            url = url.trim(),
                            rootPath = rootPath.trim(),
                            username = username.trim(),
                            password = password,
                            region = region.trim(),
                            bucket = bucket.trim(),
                            prefix = prefix.trim(),
                            endpoint = endpoint.trim(),
                            forcePathStyle = forcePathStyle,
                            accessKeyId = accessKeyId.trim(),
                            sessionToken = sessionToken,
                            encryptionPassphrase = passphrase,
                        ),
                        if (editing) "none" else bootstrapMode,
                    )
                },
            ) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(stringResource(R.string.common_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text(stringResource(R.string.common_cancel)) } },
    )
}

@Composable
private fun SyncTextField(value: String, onValueChange: (String) -> Unit, label: Int) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(label)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun SecretField(value: String, onValueChange: (String) -> Unit, label: Int, optionalOnEdit: Boolean) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(label)) },
        supportingText = if (optionalOnEdit) ({ Text(stringResource(R.string.sync_secret_unchanged)) }) else null,
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun backendDisplayName(key: String): String = when (key) {
    "sftp" -> stringResource(R.string.sync_sftp)
    "s3" -> stringResource(R.string.sync_s3)
    else -> stringResource(R.string.sync_webdav)
}

private fun SyncBackendKind.backendKey(): String = when (this) {
    SyncBackendKind.SFTP -> "sftp"
    SyncBackendKind.S3 -> "s3"
    SyncBackendKind.LOCAL_FOLDER -> "local_folder"
    SyncBackendKind.WEB_DAV -> "webdav"
}

private fun formatBytes(bytes: ULong): String {
    val value = bytes.toDouble()
    return when {
        value >= 1024 * 1024 * 1024 -> "%.1f GB".format(value / (1024 * 1024 * 1024))
        value >= 1024 * 1024 -> "%.1f MB".format(value / (1024 * 1024))
        value >= 1024 -> "%.1f KB".format(value / 1024)
        else -> "$bytes B"
    }
}

private fun formatDate(timestampMs: Long): String = if (timestampMs <= 0) {
    "—"
} else {
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(timestampMs))
}
