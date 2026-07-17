package com.zeroterm.android.ui.snippets

import android.widget.Toast
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.ffi.SnippetInput
import com.zeroterm.ffi.SnippetRecord
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SnippetsScreen(
    repository: ZeroTermRepository,
    /** When set, tapping a snippet inserts into the terminal and pops. */
    onInsert: ((String) -> Unit)? = null,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var snippets by remember { mutableStateOf<List<SnippetRecord>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var edit by remember { mutableStateOf<SnippetRecord?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleteId by remember { mutableStateOf<String?>(null) }

    fun reload() {
        scope.launch {
            repository.listSnippets().fold(
                onSuccess = { snippets = it; error = null },
                onFailure = { error = it.message },
            )
        }
    }

    LaunchedEffect(Unit) { reload() }

    if (creating || edit != null) {
        SnippetEditDialog(
            initial = edit,
            onDismiss = { creating = false; edit = null },
            onSave = { input ->
                scope.launch {
                    repository.saveSnippet(input).fold(
                        onSuccess = {
                            creating = false
                            edit = null
                            reload()
                        },
                        onFailure = {
                            Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                        },
                    )
                }
            },
        )
    }

    deleteId?.let { id ->
        AlertDialog(
            onDismissRequest = { deleteId = null },
            title = { Text("Delete snippet?") },
            confirmButton = {
                TextButton(onClick = {
                    deleteId = null
                    scope.launch {
                        repository.deleteSnippet(id).onSuccess { reload() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleteId = null }) { Text("Cancel") }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(if (onInsert != null) "Insert snippet" else "Snippets")
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
        floatingActionButton = {
            if (onInsert == null) {
                FloatingActionButton(onClick = { creating = true }) {
                    Icon(Icons.Default.Add, contentDescription = "Add")
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
        ) {
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            if (snippets.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No snippets yet.",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
            } else {
                val grouped = snippets.groupBy { it.group.ifBlank { "Ungrouped" } }
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 88.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    grouped.toSortedMap().forEach { (group, items) ->
                        item {
                            Text(
                                group,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        items(items, key = { it.id }) { snip ->
                            SnippetRow(
                                snip = snip,
                                pickMode = onInsert != null,
                                onClick = {
                                    if (onInsert != null) {
                                        onInsert(snip.command)
                                    } else {
                                        edit = snip
                                    }
                                },
                                onEdit = { edit = snip },
                                onDelete = { deleteId = snip.id },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SnippetRow(
    snip: SnippetRecord,
    pickMode: Boolean,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Code, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(snip.title, style = MaterialTheme.typography.titleMedium)
            Text(
                snip.command.lines().firstOrNull().orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
            )
        }
        if (!pickMode) {
            IconButton(onClick = onEdit) {
                Icon(Icons.Default.Edit, contentDescription = "Edit")
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete")
            }
        }
    }
}

@Composable
private fun SnippetEditDialog(
    initial: SnippetRecord?,
    onDismiss: () -> Unit,
    onSave: (SnippetInput) -> Unit,
) {
    var title by remember { mutableStateOf(initial?.title.orEmpty()) }
    var command by remember { mutableStateOf(initial?.command.orEmpty()) }
    var group by remember { mutableStateOf(initial?.group.orEmpty()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "New snippet" else "Edit snippet") },
        text = {
            Column {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = group,
                    onValueChange = { group = it },
                    label = { Text("Group (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = command,
                    onValueChange = { command = it },
                    label = { Text("Command") },
                    modifier = Modifier.fillMaxWidth().height(140.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (title.isBlank() || command.isBlank()) return@TextButton
                onSave(
                    SnippetInput(
                        id = initial?.id,
                        title = title.trim(),
                        command = command,
                        group = group.trim(),
                        sortOrder = initial?.sortOrder ?: 0,
                    ),
                )
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
