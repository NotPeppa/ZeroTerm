package com.zeroterm.android.ui.sftp

import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.HostKeyPrompt
import com.zeroterm.android.data.SftpManager
import com.zeroterm.ffi.SftpDirEntry
import com.zeroterm.ffi.SftpFileKind
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.launch
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.android.ui.components.ZeroEmptyState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SftpBrowserScreen(
    hostId: String,
    hostLabel: String,
    sftp: SftpManager,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val path by sftp.path.collectAsState()
    val entries by sftp.entries.collectAsState()
    val busy by sftp.busy.collectAsState()
    val error by sftp.error.collectAsState()
    val progress by sftp.progress.collectAsState()
    var hostKey by remember { mutableStateOf<HostKeyPrompt?>(null) }
    var mkdirOpen by remember { mutableStateOf(false) }
    var mkdirName by remember { mutableStateOf("") }
    var menuEntry by remember { mutableStateOf<SftpDirEntry?>(null) }
    var deleteConfirm by remember { mutableStateOf<SftpDirEntry?>(null) }
    var renameTarget by remember { mutableStateOf<SftpDirEntry?>(null) }
    var renameName by remember { mutableStateOf("") }
    var pendingExport by remember { mutableStateOf<File?>(null) }

    val openDoc = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                val name = queryDisplayName(context, uri) ?: "upload.bin"
                val cache = File(sftp.cacheDir(), name)
                context.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(cache).use { output -> input.copyTo(output) }
                }
                sftp.upload(cache, name, overwrite = true).onFailure {
                    Toast.makeText(context, it.message ?: context.getString(R.string.sftp_upload_failed), Toast.LENGTH_LONG).show()
                }
                sftp.clearProgress()
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: context.getString(R.string.sftp_upload_failed), Toast.LENGTH_LONG).show()
            }
        }
    }

    val createDoc = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("*/*"),
    ) { uri: Uri? ->
        val file = pendingExport
        pendingExport = null
        if (uri == null || file == null) return@rememberLauncherForActivityResult
        scope.launch {
            try {
                context.contentResolver.openOutputStream(uri)?.use { out ->
                    file.inputStream().use { it.copyTo(out) }
                }
                Toast.makeText(context, context.getString(R.string.sftp_saved), Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: context.getString(R.string.sftp_save_failed), Toast.LENGTH_LONG).show()
            }
        }
    }

    LaunchedEffect(hostId) {
        if (!sftp.isOpenFor(hostId)) {
            sftp.open(hostId).onFailure {
                Toast.makeText(context, it.message ?: context.getString(R.string.sftp_open_failed), Toast.LENGTH_LONG).show()
            }
        }
    }

    LaunchedEffect(Unit) {
        sftp.hostKeyPrompts.collect { hostKey = it }
    }

    hostKey?.let { prompt ->
        AlertDialog(
            onDismissRequest = {
                sftp.respondHostKey(prompt.requestId, false)
                hostKey = null
            },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(if (prompt.stored != null) stringResource(R.string.sftp_host_key_changed) else stringResource(R.string.sftp_host_key_unknown)) },
            text = {
                Column {
                    Text("${prompt.info.host}:${prompt.info.port}")
                    Text(prompt.info.fingerprint, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    sftp.respondHostKey(prompt.requestId, true)
                    hostKey = null
                }) { Text(stringResource(R.string.common_accept)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    sftp.respondHostKey(prompt.requestId, false)
                    hostKey = null
                }) { Text(stringResource(R.string.common_reject)) }
            },
        )
    }

    if (mkdirOpen) {
        AlertDialog(
            onDismissRequest = { mkdirOpen = false },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.sftp_new_folder)) },
            text = {
                OutlinedTextField(
                    value = mkdirName,
                    onValueChange = { mkdirName = it },
                    label = { Text(stringResource(R.string.common_name)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val name = mkdirName.trim()
                    mkdirOpen = false
                    mkdirName = ""
                    if (name.isNotEmpty()) {
                        scope.launch {
                            sftp.mkdir(name).onFailure {
                                Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }) { Text(stringResource(R.string.common_create)) }
            },
            dismissButton = {
                TextButton(onClick = { mkdirOpen = false }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    deleteConfirm?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleteConfirm = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.sftp_delete_confirm, entry.name)) },
            text = {
                Text(
                    if (entry.kind == SftpFileKind.DIR) {
                        stringResource(R.string.sftp_dir_must_empty)
                    } else {
                        stringResource(R.string.sftp_cannot_undo)
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteConfirm = null
                    scope.launch {
                        sftp.remove(entry.name, entry.kind == SftpFileKind.DIR).onFailure {
                            Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                        }
                    }
                }) { Text(stringResource(R.string.common_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { deleteConfirm = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    renameTarget?.let { entry ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.common_rename)) },
            text = {
                OutlinedTextField(
                    value = renameName,
                    onValueChange = { renameName = it },
                    label = { Text(stringResource(R.string.sftp_new_name)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val to = renameName.trim()
                    val from = entry.name
                    renameTarget = null
                    if (to.isNotEmpty() && to != from) {
                        scope.launch {
                            sftp.rename(from, to).onFailure {
                                Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }) { Text(stringResource(R.string.common_rename)) }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = hostLabel,
                subtitle = path,
                navigationIcon = {
                    IconButton(onClick = {
                        if (path != "/") {
                            scope.launch { sftp.list(SftpManager.parentPath(path)) }
                        } else {
                            scope.launch {
                                sftp.close()
                                onBack()
                            }
                        }
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                actions = {
                    IconButton(onClick = { mkdirOpen = true }) {
                        Icon(Icons.Default.CreateNewFolder, contentDescription = stringResource(R.string.sftp_mkdir))
                    }
                    IconButton(onClick = {
                        openDoc.launch(arrayOf("*/*"))
                    }) {
                        Icon(Icons.Default.Upload, contentDescription = stringResource(R.string.common_upload))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            progress?.let { p ->
                if (p.status == "running" || p.status == "queued") {
                    val total = p.total?.toLong() ?: 0L
                    val frac = if (total > 0) {
                        (p.bytesDone.toLong().toFloat() / total.toFloat()).coerceIn(0f, 1f)
                    } else {
                        0f
                    }
                    LinearProgressIndicator(
                        progress = { frac },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    )
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${p.kind} ${p.status}: ${p.bytesDone}" +
                                (p.total?.let { " / $it" } ?: ""),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = {
                            sftp.cancelActiveTransfer()
                            sftp.clearProgress()
                        }) { Text(stringResource(R.string.common_cancel)) }
                    }
                }
            }
            error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(16.dp),
                )
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (busy && entries.isEmpty()) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                } else if (entries.isEmpty() && path == "/") {
                    ZeroEmptyState(
                        title = stringResource(R.string.sftp_empty_title),
                        description = stringResource(R.string.sftp_empty_hint),
                        icon = Icons.Default.Folder,
                    )
                } else {
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        if (path != "/") {
                            item {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            scope.launch {
                                                sftp.list(SftpManager.parentPath(path))
                                            }
                                        }
                                        .padding(16.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(Icons.Default.Folder, contentDescription = null)
                                    Text("..", modifier = Modifier.padding(start = 12.dp))
                                }
                            }
                        }
                        items(entries, key = { it.name }) { entry ->
                            Column {
                                SftpRow(
                                    entry = entry,
                                    onClick = {
                                        if (entry.kind == SftpFileKind.DIR) {
                                            scope.launch {
                                                sftp.list(SftpManager.joinPath(path, entry.name))
                                            }
                                        }
                                    },
                                    onDownload = {
                                        scope.launch {
                                            val dest = File(sftp.cacheDir(), entry.name)
                                            sftp.download(entry.name, dest).fold(
                                                onSuccess = { file ->
                                                    sftp.clearProgress()
                                                    pendingExport = file
                                                    createDoc.launch(entry.name)
                                                },
                                                onFailure = {
                                                    Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                                                },
                                            )
                                        }
                                    },
                                    onRename = {
                                        renameName = entry.name
                                        renameTarget = entry
                                    },
                                    onDelete = { deleteConfirm = entry },
                                )
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SftpRow(
    entry: SftpDirEntry,
    onClick: () -> Unit,
    onDownload: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (entry.kind == SftpFileKind.DIR) Icons.Default.Folder
            else Icons.Default.InsertDriveFile,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
        )
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(entry.name, style = MaterialTheme.typography.bodyLarge)
            if (entry.kind != SftpFileKind.DIR) {
                Text(
                    formatSize(entry.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        IconButton(onClick = { menu = true }) {
            Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_menu))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (entry.kind != SftpFileKind.DIR) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.common_download)) },
                    onClick = {
                        menu = false
                        onDownload()
                    },
                    leadingIcon = { Icon(Icons.Default.Download, null) },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.common_rename)) },
                onClick = {
                    menu = false
                    onRename()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.common_delete)) },
                onClick = {
                    menu = false
                    onDelete()
                },
                leadingIcon = { Icon(Icons.Default.Delete, null) },
            )
        }
    }
}

@Composable
private fun formatSize(size: ULong): String {
    val n = size.toLong()
    return when {
        n < 1024 -> stringResource(R.string.sftp_size_b, n.toInt())
        n < 1024 * 1024 -> stringResource(R.string.sftp_size_kb, (n / 1024).toInt())
        n < 1024L * 1024 * 1024 -> stringResource(R.string.sftp_size_mb, (n / (1024 * 1024)).toInt())
        else -> stringResource(R.string.sftp_size_gb, (n / (1024L * 1024 * 1024)).toInt())
    }
}

private fun queryDisplayName(context: android.content.Context, uri: Uri): String? {
    val cursor = context.contentResolver.query(uri, null, null, null, null) ?: return null
    cursor.use {
        val idx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && it.moveToFirst()) return it.getString(idx)
    }
    return null
}
