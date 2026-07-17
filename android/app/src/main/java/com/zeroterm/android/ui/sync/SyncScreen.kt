package com.zeroterm.android.ui.sync

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zeroterm.ffi.ConflictRecord
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.SyncBackendKind
import com.zeroterm.ffi.SyncOutcomeRecord
import com.zeroterm.ffi.SyncProfileInput
import com.zeroterm.ffi.SyncProfileSummary
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(
    zeroTerm: ZeroTerm,
    hosts: List<HostSummary>,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf<List<SyncProfileSummary>>(emptyList()) }
    var conflicts by remember { mutableStateOf<List<ConflictRecord>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var lastOutcome by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    fun reload() {
        scope.launch {
            withContext(Dispatchers.Default) {
                runCatching {
                    profiles = zeroTerm.listSyncProfiles()
                    conflicts = zeroTerm.listOpenConflicts()
                }.onFailure { error = it.message }
            }
        }
    }

    LaunchedEffect(Unit) { reload() }

    if (showAdd) {
        AddSyncProfileDialog(
            hosts = hosts,
            onDismiss = { showAdd = false },
            onSave = { input, createNew ->
                scope.launch {
                    busy = true
                    error = null
                    withContext(Dispatchers.Default) {
                        runCatching {
                            val id = zeroTerm.saveSyncProfile(input)
                            val pw = input.encryptionPassphrase
                            if (createNew) {
                                zeroTerm.syncCreateRepo(id, pw)
                            } else {
                                zeroTerm.syncJoinRepo(id, pw)
                            }
                        }.onFailure { error = it.message }
                            .onSuccess {
                                lastOutcome = if (createNew) "Repo created" else "Joined repo"
                            }
                    }
                    busy = false
                    showAdd = false
                    reload()
                }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sync") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showAdd = true }) {
                Icon(Icons.Default.Add, contentDescription = "Add profile")
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.padding(8.dp))
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
            }
            lastOutcome?.let {
                Text(it, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(8.dp))
            }

            if (profiles.isEmpty()) {
                Text(
                    "No sync profiles.\nAdd a WebDAV or SFTP profile to sync with desktop.",
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(profiles, key = { it.id }) { p ->
                        SyncProfileCard(
                            profile = p,
                            onSync = {
                                scope.launch {
                                    busy = true
                                    error = null
                                    withContext(Dispatchers.Default) {
                                        runCatching {
                                            val r: SyncOutcomeRecord = zeroTerm.syncNow(p.id)
                                            lastOutcome =
                                                "pulled ${r.eventsPulled}, pushed ${r.eventsPushed}, conflicts ${r.conflictsDetected}"
                                        }.onFailure { error = it.message }
                                    }
                                    busy = false
                                    reload()
                                }
                            },
                            onDelete = {
                                scope.launch {
                                    withContext(Dispatchers.Default) {
                                        runCatching { zeroTerm.deleteSyncProfile(p.id) }
                                            .onFailure { error = it.message }
                                    }
                                    reload()
                                }
                            },
                        )
                    }
                }
            }

            if (conflicts.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Text("Conflicts", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                conflicts.forEach { c ->
                    Card(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        elevation = CardDefaults.cardElevation(1.dp),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text("${c.kind} · ${c.recordId}", style = MaterialTheme.typography.bodyMedium)
                            Text(
                                "local: ${c.localPreview.take(80)}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "remote: ${c.remotePreview.take(80)}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Row {
                                TextButton(onClick = {
                                    scope.launch {
                                        withContext(Dispatchers.Default) {
                                            zeroTerm.resolveConflict(c.id, true)
                                        }
                                        reload()
                                    }
                                }) { Text("Keep local") }
                                TextButton(onClick = {
                                    scope.launch {
                                        withContext(Dispatchers.Default) {
                                            zeroTerm.resolveConflict(c.id, false)
                                        }
                                        reload()
                                    }
                                }) { Text("Keep remote") }
                            }
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
    onSync: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(1.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text(profile.name, style = MaterialTheme.typography.titleMedium)
            Text(
                backendLabel(profile),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onSync) {
                    Icon(Icons.Default.Sync, contentDescription = null)
                    Text("  Sync now")
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onDelete) {
                    Icon(Icons.Default.Delete, contentDescription = "Delete")
                }
            }
        }
    }
}

private fun backendLabel(p: SyncProfileSummary): String = when (p.backend) {
    SyncBackendKind.LOCAL_FOLDER -> "Local: ${p.root}"
    SyncBackendKind.SFTP -> "SFTP: ${p.hostRef} → ${p.remotePath}"
    SyncBackendKind.WEB_DAV -> "WebDAV: ${p.url}"
    SyncBackendKind.S3 -> "S3: ${p.bucket}"
}

@Composable
private fun AddSyncProfileDialog(
    hosts: List<HostSummary>,
    onDismiss: () -> Unit,
    onSave: (SyncProfileInput, createNew: Boolean) -> Unit,
) {
    var name by remember { mutableStateOf("Mobile") }
    var backend by remember { mutableStateOf("webdav") }
    var url by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var rootPath by remember { mutableStateOf("") }
    var hostRef by remember { mutableStateOf(hosts.firstOrNull()?.id.orEmpty()) }
    var remoteDir by remember { mutableStateOf("/zeroterm-sync") }
    var region by remember { mutableStateOf("us-east-1") }
    var bucket by remember { mutableStateOf("") }
    var prefix by remember { mutableStateOf("zeroterm-sync") }
    var endpoint by remember { mutableStateOf("") }
    var accessKeyId by remember { mutableStateOf("") }
    var forcePathStyle by remember { mutableStateOf(false) }
    var passphrase by remember { mutableStateOf("") }
    var createNew by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add sync profile") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row {
                    FilterChip(
                        selected = backend == "webdav",
                        onClick = { backend = "webdav" },
                        label = { Text("WebDAV") },
                    )
                    Spacer(Modifier.width(8.dp))
                    FilterChip(
                        selected = backend == "sftp",
                        onClick = { backend = "sftp" },
                        label = { Text("SFTP") },
                    )
                    Spacer(Modifier.width(8.dp))
                    FilterChip(
                        selected = backend == "s3",
                        onClick = { backend = "s3" },
                        label = { Text("S3") },
                    )
                }
                Spacer(Modifier.height(8.dp))
                when (backend) {
                    "webdav" -> {
                        OutlinedTextField(
                            value = url,
                            onValueChange = { url = it },
                            label = { Text("URL") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = rootPath,
                            onValueChange = { rootPath = it },
                            label = { Text("Root path (optional)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = username,
                            onValueChange = { username = it },
                            label = { Text("Username") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    "sftp" -> {
                        Text("Host", style = MaterialTheme.typography.labelMedium)
                        hosts.forEach { h ->
                            FilterChip(
                                selected = hostRef == h.id,
                                onClick = { hostRef = h.id },
                                label = { Text(h.name.ifBlank { h.host }) },
                                modifier = Modifier.padding(end = 4.dp, bottom = 4.dp),
                            )
                        }
                        OutlinedTextField(
                            value = remoteDir,
                            onValueChange = { remoteDir = it },
                            label = { Text("Remote dir") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    else -> {
                        OutlinedTextField(
                            value = region,
                            onValueChange = { region = it },
                            label = { Text("Region") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = bucket,
                            onValueChange = { bucket = it },
                            label = { Text("Bucket") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = prefix,
                            onValueChange = { prefix = it },
                            label = { Text("Prefix") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = endpoint,
                            onValueChange = { endpoint = it },
                            label = { Text("Endpoint (optional)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = accessKeyId,
                            onValueChange = { accessKeyId = it },
                            label = { Text("Access key ID") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Secret access key") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            FilterChip(
                                selected = forcePathStyle,
                                onClick = { forcePathStyle = !forcePathStyle },
                                label = { Text("Path-style") },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("Encryption passphrase") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row {
                    FilterChip(
                        selected = !createNew,
                        onClick = { createNew = false },
                        label = { Text("Join existing") },
                    )
                    Spacer(Modifier.width(8.dp))
                    FilterChip(
                        selected = createNew,
                        onClick = { createNew = true },
                        label = { Text("Create new") },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (name.isBlank() || passphrase.isBlank()) return@TextButton
                val input = SyncProfileInput(
                    id = null,
                    name = name.trim(),
                    backend = backend,
                    root = "",
                    hostRef = hostRef,
                    remoteDir = remoteDir,
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
                    sessionToken = "",
                    encryptionPassphrase = passphrase,
                )
                onSave(input, createNew)
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
