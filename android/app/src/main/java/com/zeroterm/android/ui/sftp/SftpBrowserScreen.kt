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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.unit.dp
import com.zeroterm.android.data.HostKeyPrompt
import com.zeroterm.android.data.SftpManager
import com.zeroterm.ffi.SftpDirEntry
import com.zeroterm.ffi.SftpFileKind
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.launch

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
                    Toast.makeText(context, it.message ?: "Upload failed", Toast.LENGTH_LONG).show()
                }
                sftp.clearProgress()
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: "Upload failed", Toast.LENGTH_LONG).show()
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
                Toast.makeText(context, "Saved", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, e.message ?: "Save failed", Toast.LENGTH_LONG).show()
            }
        }
    }

    LaunchedEffect(hostId) {
        sftp.open(hostId).onFailure {
            Toast.makeText(context, it.message ?: "SFTP open failed", Toast.LENGTH_LONG).show()
        }
    }

    LaunchedEffect(Unit) {
        sftp.hostKeyPrompts.collect { hostKey = it }
    }

    DisposableEffect(Unit) {
        onDispose {
            scope.launch { sftp.close() }
        }
    }

    hostKey?.let { prompt ->
        AlertDialog(
            onDismissRequest = {
                sftp.respondHostKey(prompt.requestId, false)
                hostKey = null
            },
            title = { Text(if (prompt.stored != null) "Host key changed!" else "Unknown host key") },
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
                }) { Text("Accept") }
            },
            dismissButton = {
                TextButton(onClick = {
                    sftp.respondHostKey(prompt.requestId, false)
                    hostKey = null
                }) { Text("Reject") }
            },
        )
    }

    if (mkdirOpen) {
        AlertDialog(
            onDismissRequest = { mkdirOpen = false },
            title = { Text("New folder") },
            text = {
                OutlinedTextField(
                    value = mkdirName,
                    onValueChange = { mkdirName = it },
                    label = { Text("Name") },
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
                }) { Text("Create") }
            },
            dismissButton = {
                TextButton(onClick = { mkdirOpen = false }) { Text("Cancel") }
            },
        )
    }

    deleteConfirm?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleteConfirm = null },
            title = { Text("Delete ${entry.name}?") },
            text = {
                Text(
                    if (entry.kind == SftpFileKind.DIR) {
                        "Directory must be empty."
                    } else {
                        "This cannot be undone."
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
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleteConfirm = null }) { Text("Cancel") }
            },
        )
    }

    renameTarget?.let { entry ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("Rename") },
            text = {
                OutlinedTextField(
                    value = renameName,
                    onValueChange = { renameName = it },
                    label = { Text("New name") },
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
                }) { Text("Rename") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("Cancel") }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(hostLabel, maxLines = 1)
                        Text(
                            path,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                        )
                    }
                },
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { mkdirOpen = true }) {
                        Icon(Icons.Default.CreateNewFolder, contentDescription = "Mkdir")
                    }
                    IconButton(onClick = {
                        openDoc.launch(arrayOf("*/*"))
                    }) {
                        Icon(Icons.Default.Upload, contentDescription = "Upload")
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
                        }) { Text("Cancel") }
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
                                                Toast.makeText(
                                                    context,
                                                    it.message,
                                                    Toast.LENGTH_LONG,
                                                ).show()
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
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
        }
        IconButton(onClick = { menu = true }) {
            Icon(Icons.Default.MoreVert, contentDescription = "Menu")
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (entry.kind != SftpFileKind.DIR) {
                DropdownMenuItem(
                    text = { Text("Download") },
                    onClick = {
                        menu = false
                        onDownload()
                    },
                    leadingIcon = { Icon(Icons.Default.Download, null) },
                )
            }
            DropdownMenuItem(
                text = { Text("Rename") },
                onClick = {
                    menu = false
                    onRename()
                },
            )
            DropdownMenuItem(
                text = { Text("Delete") },
                onClick = {
                    menu = false
                    onDelete()
                },
                leadingIcon = { Icon(Icons.Default.Delete, null) },
            )
        }
    }
}

private fun formatSize(size: ULong): String {
    val n = size.toLong()
    return when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${n / 1024} KB"
        n < 1024L * 1024 * 1024 -> "${n / (1024 * 1024)} MB"
        else -> "${n / (1024L * 1024 * 1024)} GB"
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
