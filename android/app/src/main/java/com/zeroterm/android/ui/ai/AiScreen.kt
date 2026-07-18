package com.zeroterm.android.ui.ai

import androidx.compose.foundation.BorderStroke
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.data.AppSettings
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.ffi.AiChatMessage
import com.zeroterm.ffi.AiProfileInput
import com.zeroterm.ffi.AiProfileRecord
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

internal data class UiAiMessage(
    val role: String,
    val content: String,
    val reasoningContent: String = "",
    val continued: Boolean = false,
    val executedCommands: Set<String> = emptySet(),
)

@Stable
class AiConversationState internal constructor() {
    internal val messages = mutableStateListOf<UiAiMessage>()
    internal val input = mutableStateOf("")
    internal val selectedId = mutableStateOf<String?>(null)
    internal val sessionModel = mutableStateOf("")
    internal val sessionModelOptions = mutableStateOf<List<String>>(emptyList())
}

@Composable
internal fun rememberAiConversationState(): AiConversationState = remember {
    AiConversationState()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiScreen(
    repository: ZeroTermRepository,
    settings: AppSettings? = null,
    onOpenNavigation: (() -> Unit)? = null,
    onClose: (() -> Unit)? = null,
    contextLabel: String? = null,
    contextProvider: (() -> String)? = null,
    onInsertCommand: ((String) -> Unit)? = null,
    configurationOnly: Boolean = false,
    embedded: Boolean = false,
    conversationState: AiConversationState? = null,
) {
    val scope = rememberCoroutineScope()
    val retainedConversation = conversationState ?: rememberAiConversationState()
    val messages = retainedConversation.messages
    val listState = rememberLazyListState()
    var profiles by remember { mutableStateOf<List<AiProfileRecord>>(emptyList()) }
    var selectedId by retainedConversation.selectedId
    var activeProfileId by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<AiProfileRecord?>(null) }
    var creating by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<AiProfileRecord?>(null) }
    var modelOptions by remember { mutableStateOf<List<String>>(emptyList()) }
    var modelError by remember { mutableStateOf<String?>(null) }
    var input by retainedConversation.input
    var busy by remember { mutableStateOf(false) }
    var chatJob by remember { mutableStateOf<Job?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var sessionModel by retainedConversation.sessionModel
    var sessionModelOptions by retainedConversation.sessionModelOptions
    var sessionModelsBusy by remember { mutableStateOf(false) }

    fun pickDefaultProfileId(loaded: List<AiProfileRecord>, preferred: String?): String? {
        val ids = loaded.map { it.id }
        return preferred?.takeIf { it in ids } ?: selectedId?.takeIf { it in ids } ?: ids.firstOrNull()
    }

    fun reload() {
        scope.launch {
            val preferred = settings?.flow?.first()?.activeAiProfileId.orEmpty()
            repository.listAiProfiles().fold(
                onSuccess = { loaded ->
                    profiles = loaded
                    activeProfileId = preferred.takeIf { id -> loaded.any { it.id == id } }.orEmpty()
                    selectedId = pickDefaultProfileId(loaded, preferred.ifBlank { null })
                    error = null
                },
                onFailure = { error = it.message },
            )
        }
    }

    fun setActiveProfile(id: String) {
        scope.launch {
            settings?.setActiveAiProfileId(id)
            activeProfileId = id
            selectedId = id
        }
    }

    fun refreshSessionModels(profile: AiProfileRecord) {
        scope.launch {
            sessionModelsBusy = true
            repository.listAiModels(profile.id).fold(
                onSuccess = { loaded ->
                    sessionModelOptions = (listOf(profile.model) + loaded)
                        .filter { it.isNotBlank() }
                        .distinct()
                    if (sessionModel.isBlank()) sessionModel = profile.model
                },
                onFailure = {
                    sessionModel = profile.model
                    sessionModelOptions = listOf(profile.model).filter { it.isNotBlank() }
                },
            )
            sessionModelsBusy = false
        }
    }

    LaunchedEffect(Unit) { reload() }
    LaunchedEffect(selectedId, embedded) {
        if (embedded) {
            profiles.firstOrNull { it.id == selectedId }?.let { profile ->
                sessionModel = profile.model
                sessionModelOptions = listOf(profile.model).filter { it.isNotBlank() }
                refreshSessionModels(profile)
            }
        }
    }
    LaunchedEffect(messages.size, busy) {
        if (messages.isNotEmpty() || busy) {
            delay(80)
            val lastItem = listState.layoutInfo.totalItemsCount - 1
            if (lastItem >= 0) {
                listState.animateScrollToItem(lastItem, scrollOffset = 10_000)
            }
        }
    }

    fun submitAiRequest(profileId: String, requestMessages: List<AiChatMessage>) {
        if (busy) return
        chatJob = scope.launch {
            busy = true
            error = null
            try {
                val result = if (embedded) {
                    repository.aiChat(profileId, sessionModel, requestMessages)
                } else {
                    repository.aiChat(profileId, requestMessages)
                }
                result.fold(
                    onSuccess = { response ->
                        val normalized = normalizeAiResponse(
                            response.content,
                            response.reasoningContent,
                        )
                        messages += UiAiMessage(
                            role = "assistant",
                            content = normalized.content,
                            reasoningContent = normalized.reasoning,
                        )
                    },
                    onFailure = { error = it.message },
                )
            } finally {
                busy = false
                chatJob = null
            }
        }
    }

    if (creating || editing != null) {
        AiProfileDialog(
            profile = editing,
            modelOptions = modelOptions,
            modelError = modelError,
            busy = busy,
            onDismiss = {
                if (!busy) {
                    creating = false
                    editing = null
                    modelOptions = emptyList()
                    modelError = null
                }
            },
            onRefreshModels = { baseUrl, apiKey ->
                scope.launch {
                    busy = true
                    modelError = null
                    repository.listAiModels(editing?.id, baseUrl, apiKey).fold(
                        onSuccess = { modelOptions = it },
                        onFailure = { modelError = it.message },
                    )
                    busy = false
                }
            },
            onDelete = editing?.let { profile ->
                {
                    editing = null
                    pendingDelete = profile
                }
            },
            onSave = { profileInput ->
                scope.launch {
                    busy = true
                    repository.saveAiProfile(profileInput).fold(
                        onSuccess = { id ->
                            selectedId = id
                            if (activeProfileId.isBlank() || profiles.isEmpty()) {
                                settings?.setActiveAiProfileId(id)
                                activeProfileId = id
                            }
                            creating = false
                            editing = null
                            modelOptions = emptyList()
                            modelError = null
                            reload()
                        },
                        onFailure = { error = it.message },
                    )
                    busy = false
                }
            },
        )
    }

    pendingDelete?.let { profile ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.ai_delete_profile_title)) },
            text = { Text(stringResource(R.string.ai_delete_profile_message, profile.name)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    scope.launch {
                        repository.deleteAiProfile(profile.id).fold(
                            onSuccess = {
                                if (activeProfileId == profile.id) {
                                    settings?.setActiveAiProfileId("")
                                    activeProfileId = ""
                                }
                                if (selectedId == profile.id) selectedId = null
                                reload()
                            },
                            onFailure = { error = it.message },
                        )
                    }
                }) { Text(stringResource(R.string.common_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            if (!embedded) ZeroTopBar(
                title = stringResource(
                    if (configurationOnly) R.string.ai_settings_title else R.string.ai_title,
                ),
                subtitle = if (configurationOnly) stringResource(R.string.ai_settings_subtitle) else contextLabel,
                navigationIcon = {
                    when {
                        onClose != null -> IconButton(onClick = onClose) {
                            Icon(Icons.Default.Close, stringResource(R.string.common_close))
                        }
                        onOpenNavigation != null -> IconButton(onClick = onOpenNavigation) {
                            Icon(Icons.Default.Menu, stringResource(R.string.common_menu))
                        }
                    }
                },
                actions = {
                    IconButton(onClick = {
                        creating = true
                        editing = null
                        modelOptions = emptyList()
                        modelError = null
                    }) {
                        Icon(Icons.Default.Add, stringResource(R.string.ai_add_profile))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
        ) {
            if (!configurationOnly && profiles.isNotEmpty()) {
                if (embedded) {
                    SessionAiSelector(
                        profiles = profiles,
                        selectedId = selectedId,
                        selectedModel = sessionModel,
                        modelOptions = sessionModelOptions,
                        modelsBusy = sessionModelsBusy,
                        onProfileSelected = { selectedId = it },
                        onModelSelected = { sessionModel = it },
                        onRefreshModels = {
                            profiles.firstOrNull { it.id == selectedId }
                                ?.let(::refreshSessionModels)
                        },
                    )
                } else {
                    contextLabel?.let {
                        Text(
                            stringResource(R.string.ai_context_host, it),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        profiles.forEach { profile ->
                            FilterChip(
                                selected = selectedId == profile.id,
                                onClick = { selectedId = profile.id },
                                label = { Text(profile.name) },
                                modifier = Modifier.padding(end = 6.dp),
                            )
                        }
                        selectedId?.let { id ->
                            profiles.firstOrNull { it.id == id }?.let { profile ->
                                IconButton(onClick = {
                                    editing = profile
                                    modelOptions = emptyList()
                                }) {
                                    Icon(Icons.Default.Edit, stringResource(R.string.common_edit))
                                }
                            }
                        }
                    }
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
            }

            if (configurationOnly) {
                if (profiles.isEmpty()) {
                    Column(
                        Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(stringResource(R.string.ai_empty_profiles))
                        TextButton(onClick = { creating = true }) {
                            Text(stringResource(R.string.ai_add_profile))
                        }
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp),
                    ) {
                        items(profiles, key = { it.id }) { profile ->
                            val isActive = profile.id == activeProfileId ||
                                (activeProfileId.isBlank() && profile.id == selectedId)
                            Card(
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    editing = profile
                                    modelOptions = emptyList()
                                    modelError = null
                                },
                                colors = CardDefaults.cardColors(
                                    containerColor = if (isActive) {
                                        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.42f)
                                    } else {
                                        MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.52f)
                                    },
                                    contentColor = MaterialTheme.colorScheme.onSurface,
                                ),
                                elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                                border = BorderStroke(
                                    1.dp,
                                    if (isActive) {
                                        MaterialTheme.colorScheme.primary.copy(alpha = 0.55f)
                                    } else {
                                        MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f)
                                    },
                                ),
                            ) {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(
                                                profile.name,
                                                style = MaterialTheme.typography.titleMedium,
                                                modifier = Modifier.weight(1f, fill = false),
                                            )
                                            if (isActive) {
                                                Spacer(Modifier.width(8.dp))
                                                Surface(
                                                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f),
                                                    contentColor = MaterialTheme.colorScheme.primary,
                                                    shape = MaterialTheme.shapes.extraSmall,
                                                ) {
                                                    Text(
                                                        stringResource(R.string.ai_profile_active),
                                                        style = MaterialTheme.typography.labelSmall,
                                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                                    )
                                                }
                                            }
                                        }
                                        Text(
                                            profile.model,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                        Text(
                                            profile.baseUrl,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                        )
                                    }
                                    if (!isActive) {
                                        TextButton(onClick = { setActiveProfile(profile.id) }) {
                                            Text(stringResource(R.string.ai_profile_set_default))
                                        }
                                    }
                                    IconButton(onClick = {
                                        editing = profile
                                        modelOptions = emptyList()
                                        modelError = null
                                    }) {
                                        Icon(Icons.Default.Edit, stringResource(R.string.common_edit))
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (profiles.isEmpty()) {
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        stringResource(
                            if (embedded) R.string.ai_session_no_profiles
                            else R.string.ai_empty_profiles,
                        ),
                    )
                    if (!embedded) {
                        TextButton(onClick = { creating = true }) {
                            Text(stringResource(R.string.ai_add_profile))
                        }
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    itemsIndexed(messages) { index, message ->
                        val canContinue = message.role == "assistant" &&
                            hasExecutableAiCommand(message.content)
                        AiMessageCard(
                            message = message,
                            onInsertCommand = onInsertCommand?.let { execute ->
                                { command ->
                                    messages.getOrNull(index)?.let { current ->
                                        messages[index] = current.copy(
                                            executedCommands = current.executedCommands + command,
                                        )
                                    }
                                    execute(command)
                                }
                            },
                            continueEnabled = !busy && selectedId != null,
                            onContinueAnalysis = if (canContinue) {
                                {
                                    val profileId = selectedId
                                    if (profileId != null && !busy && !message.continued) {
                                        messages[index] = message.copy(continued = true)
                                        val terminalContext = contextProvider?.invoke().orEmpty()
                                        submitAiRequest(
                                            profileId,
                                            buildContinueAiMessages(
                                                messages = messages,
                                                hostLabel = contextLabel.orEmpty(),
                                                terminalContext = terminalContext,
                                            ),
                                        )
                                    }
                                }
                            } else null,
                        )
                    }
                    if (busy) {
                        item(key = "ai-pending") {
                            AiPendingMessageCard(embedded)
                        }
                    }
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text(stringResource(R.string.ai_message_hint)) },
                        maxLines = 4,
                    )
                    Spacer(Modifier.width(8.dp))
                    IconButton(
                        enabled = busy || (input.isNotBlank() && selectedId != null),
                        onClick = {
                            if (busy) {
                                chatJob?.cancel()
                                return@IconButton
                            }
                            val text = input.trim()
                            val profileId = selectedId ?: return@IconButton
                            messages += UiAiMessage("user", text)
                            input = ""
                            val requestMessages = buildInitialAiMessages(
                                messages = messages,
                                hostLabel = contextLabel.orEmpty(),
                                terminalContext = contextProvider?.invoke().orEmpty(),
                            )
                            submitAiRequest(profileId, requestMessages)
                        },
                    ) {
                        Icon(
                            imageVector = if (busy) Icons.Default.Stop else Icons.AutoMirrored.Filled.Send,
                            contentDescription = stringResource(
                                if (busy) R.string.ai_stop else R.string.ai_send,
                            ),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionAiSelector(
    profiles: List<AiProfileRecord>,
    selectedId: String?,
    selectedModel: String,
    modelOptions: List<String>,
    modelsBusy: Boolean,
    onProfileSelected: (String) -> Unit,
    onModelSelected: (String) -> Unit,
    onRefreshModels: () -> Unit,
) {
    var selectorExpanded by remember { mutableStateOf(false) }
    val selectedProfile = profiles.firstOrNull { it.id == selectedId }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 0.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ExposedDropdownMenuBox(
                expanded = selectorExpanded,
                onExpandedChange = { selectorExpanded = !selectorExpanded },
                modifier = Modifier.weight(1f),
            ) {
                Box(
                    modifier = Modifier
                        .menuAnchor()
                        .fillMaxWidth()
                        .height(48.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(40.dp),
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.16f),
                        contentColor = MaterialTheme.colorScheme.onSurface,
                        border = BorderStroke(
                            1.dp,
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.72f),
                        ),
                    ) {
                        Row(
                            modifier = Modifier.padding(start = 12.dp, end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = listOfNotNull(
                                    selectedProfile?.name,
                                    selectedModel.takeIf { it.isNotBlank() },
                                ).joinToString("  ·  "),
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            ExposedDropdownMenuDefaults.TrailingIcon(expanded = selectorExpanded)
                        }
                    }
                }
                ExposedDropdownMenu(
                    expanded = selectorExpanded,
                    onDismissRequest = { selectorExpanded = false },
                ) {
                    Text(
                        stringResource(R.string.ai_profile),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                    profiles.forEach { profile ->
                        DropdownMenuItem(
                            text = { Text(profile.name, maxLines = 1) },
                            trailingIcon = if (profile.id == selectedId) {
                                {
                                    Icon(
                                        Icons.Default.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            } else null,
                            onClick = {
                                onProfileSelected(profile.id)
                                selectorExpanded = false
                            },
                        )
                    }
                    HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    Text(
                        stringResource(R.string.ai_model),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                    modelOptions.forEach { model ->
                        DropdownMenuItem(
                            text = { Text(model, maxLines = 1) },
                            trailingIcon = if (model == selectedModel) {
                                {
                                    Icon(
                                        Icons.Default.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            } else null,
                            onClick = {
                                onModelSelected(model)
                                selectorExpanded = false
                            },
                        )
                    }
                }
            }
            IconButton(
                onClick = onRefreshModels,
                enabled = !modelsBusy && selectedProfile != null,
                modifier = Modifier
                    .width(48.dp)
                    .height(48.dp),
            ) {
                if (modelsBusy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = stringResource(R.string.ai_fetch_models),
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}

private data class NormalizedAiResponse(val content: String, val reasoning: String)

private val executableAiLanguages = setOf(
    "bash", "sh", "shell", "zsh", "fish", "powershell", "pwsh", "ps1", "cmd", "bat", "batch",
)

private val executableCommandFormatPrompt = """
    ZeroTerm executable command format:
    - If the user needs to run something, provide the exact runnable command in a fenced code block whose language is one of: bash, sh, shell, zsh, powershell, pwsh, ps1, cmd, bat, batch.
    - Short inline code is also runnable only when it is one line, 140 characters or less, starts with a command name or sudo, and is not a URL, domain, heredoc starter, or shell control keyword.
    - Do not put runnable commands in terminal, text, log, output, or txt fenced blocks; ZeroTerm treats those as non-executable output.
    - Do not mix terminal prompts, command output, explanations, or error logs inside runnable command blocks.
    - Prefer one command per runnable fenced block. Use a multi-line command block only when it must run as one script, such as heredoc, control flow, continuation, or grouped commands.
    - Use ```terminal fenced blocks only for observed terminal output, logs, or errors.
    - Do not merely say in prose that the user should run a command. When execution is needed, include the command in one of the executable formats above.
""".trimIndent()

private val defaultAiSystemPrompt =
    "你是 ZeroTerm 的 AI 助手。用户是普通用户，不一定懂命令。请先用人话解释和规划，不要假装已经执行命令。" +
        "需要用户执行命令时，一次只建议下一条最有用的命令；每个 bash/shell fenced code block 只能包含一条命令。" +
        "引用终端输出、报错或日志时必须使用 ```terminal 代码块，不要使用 bash。\n\n" +
        executableCommandFormatPrompt

private val continueAiSystemPrompt = """
    你是 ZeroTerm 的 AI 助手。用户点击了“继续分析”，但这次不一定是通过对话里的批准按钮执行命令，也可能是手动在终端里执行过。
    优先根据当前终端内容继续推进用户目标，不要假装知道用户具体执行了哪条命令。
    如果证据已经足够，必须停止继续排查，直接给出：结论、依据、影响、建议下一步。
    如果当前终端内容已经能回答问题，不要再重复建议同类检查命令。
    只有在缺少一个关键事实时，才给下一条最有用的命令。
    每次最多建议一条命令，且每个 fenced code block 只能包含一条命令。
    引用终端输出、报错或日志时必须使用 ```terminal 代码块；只有真正需要用户批准执行的命令才使用 ```bash。
    当前没有记录到通过按钮执行的命令；用户可能是在终端中手动执行后再回来继续分析。
""".trimIndent()

private fun buildInitialAiMessages(
    messages: List<UiAiMessage>,
    hostLabel: String,
    terminalContext: String,
): List<AiChatMessage> = buildList {
    add(AiChatMessage("system", defaultAiSystemPrompt))
    terminalContext.trim().takeIf { it.isNotEmpty() }?.let { terminal ->
        add(
            AiChatMessage(
                "system",
                "当前 SSH 主机：$hostLabel\n当前终端内容：\n```terminal\n$terminal\n```",
            ),
        )
    }
    addAll(
        messages.takeLast(10).map { message ->
            AiChatMessage(message.role, message.content)
        },
    )
}

private fun buildContinueAiMessages(
    messages: List<UiAiMessage>,
    hostLabel: String,
    terminalContext: String,
): List<AiChatMessage> = buildList {
    val lastUser = messages.lastOrNull { it.role == "user" }?.content
        ?.replace(Regex("```[\\s\\S]*?```"), "")
        ?.trim()
        ?.take(200)
        .orEmpty()
    val lastAssistant = messages.lastOrNull { it.role == "assistant" }?.content
        ?.replace(Regex("```[\\s\\S]*?```"), "")
        ?.trim()
        ?.take(150)
        .orEmpty()
    val summary = buildList {
        if (lastUser.isNotEmpty()) add("用户的原始问题：$lastUser")
        if (lastAssistant.isNotEmpty()) add("AI 上一步的建议摘要：$lastAssistant")
    }.joinToString("\n")
    add(
        AiChatMessage(
            "system",
            buildString {
                append(continueAiSystemPrompt)
                if (summary.isNotEmpty()) append("\n\n对话摘要：\n$summary")
                append("\n\n")
                append(executableCommandFormatPrompt)
            },
        ),
    )
    terminalContext.trim().takeIf { it.isNotEmpty() }?.let { terminal ->
        add(
            AiChatMessage(
                "system",
                "当前 SSH 主机：$hostLabel\n从当前终端获取到的最新内容：\n```terminal\n$terminal\n```",
            ),
        )
    }
    add(AiChatMessage("user", "继续分析"))
}

private fun normalizeAiResponse(content: String, reasoningContent: String): NormalizedAiResponse {
    val thinkPattern = Regex("(?is)<think>(.*?)</think>")
    val embeddedReasoning = thinkPattern.findAll(content)
        .map { it.groupValues[1].trim() }
        .filter { it.isNotEmpty() }
        .toList()
    val reasoning = (listOf(reasoningContent.trim()) + embeddedReasoning)
        .filter { it.isNotEmpty() }
        .distinct()
        .joinToString("\n\n")
    val cleanedContent = content
        .replace(thinkPattern, "")
        .replace(Regex("(?i)</?think>"), "")
        .trim()
    return NormalizedAiResponse(cleanedContent, reasoning)
}

@Composable
private fun AiPendingMessageCard(embedded: Boolean) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            text = stringResource(R.string.ai_role_assistant),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
        )
        Card(
            modifier = Modifier.fillMaxWidth(0.96f),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.54f),
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            border = BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.primary.copy(alpha = 0.24f),
            ),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                )
                Text(
                    stringResource(
                        if (embedded) R.string.ai_waiting_terminal else R.string.ai_waiting,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun AiMessageCard(
    message: UiAiMessage,
    onInsertCommand: ((String) -> Unit)?,
    continueEnabled: Boolean,
    onContinueAnalysis: (() -> Unit)?,
) {
    val isUser = message.role == "user"
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        Text(
            text = stringResource(
                if (isUser) R.string.ai_role_you else R.string.ai_role_assistant,
            ),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
        )
        Card(
            modifier = Modifier.fillMaxWidth(if (isUser) 0.88f else 0.96f),
            colors = CardDefaults.cardColors(
                containerColor = if (isUser) {
                    MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.88f)
                } else {
                    MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.62f)
                },
                contentColor = if (isUser) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            border = if (isUser) null else BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.56f),
            ),
        ) {
            if (isUser) {
                SelectionContainer {
                    Text(
                        message.content,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        lineHeight = 22.sp,
                    )
                }
            } else {
                AiAssistantContent(
                    content = message.content,
                    reasoning = message.reasoningContent,
                    executedCommands = message.executedCommands,
                    onInsertCommand = onInsertCommand,
                    continued = message.continued,
                    continueEnabled = continueEnabled,
                    onContinueAnalysis = onContinueAnalysis,
                )
            }
        }
    }
}

@Composable
private fun AiAssistantContent(
    content: String,
    reasoning: String,
    executedCommands: Set<String>,
    onInsertCommand: ((String) -> Unit)?,
    continued: Boolean,
    continueEnabled: Boolean,
    onContinueAnalysis: (() -> Unit)?,
) {
    Column(
        modifier = Modifier.padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (reasoning.isNotBlank()) {
            AiThinkingBlock(reasoning)
        }
        if (content.isNotBlank()) {
            AiMarkdownContent(content, executedCommands, onInsertCommand)
        }
        if (onContinueAnalysis != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.46f))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(
                    onClick = onContinueAnalysis,
                    enabled = continueEnabled && !continued,
                ) {
                    Text(
                        stringResource(
                            if (continued) R.string.ai_analyzed else R.string.ai_continue_analysis,
                        ),
                    )
                }
            }
        }
    }
}

@Composable
private fun AiThinkingBlock(reasoning: String) {
    var expanded by remember(reasoning) { mutableStateOf(false) }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.22f),
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.primary.copy(alpha = 0.20f),
        ),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.ai_thinking),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelMedium,
                )
                Icon(
                    if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
            }
            if (expanded) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                SelectionContainer {
                    Text(
                        markdownAnnotatedText(
                            reasoning,
                            MaterialTheme.colorScheme.primary,
                            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
                        ),
                        modifier = Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        lineHeight = 20.sp,
                    )
                }
            }
        }
    }
}

private sealed interface AiMarkdownSection {
    data class Prose(val text: String) : AiMarkdownSection
    data class Code(val language: String, val code: String) : AiMarkdownSection
}

private fun parseAiMarkdown(text: String): List<AiMarkdownSection> {
    val fence = Regex("```([A-Za-z0-9_+.-]*)[ \\t]*\\n?([\\s\\S]*?)```")
    val sections = mutableListOf<AiMarkdownSection>()
    var cursor = 0
    fence.findAll(text).forEach { match ->
        text.substring(cursor, match.range.first).trim().takeIf { it.isNotEmpty() }
            ?.let { sections += AiMarkdownSection.Prose(it) }
        match.groupValues[2].trim().takeIf { it.isNotEmpty() }?.let { code ->
            sections += AiMarkdownSection.Code(match.groupValues[1].trim(), code)
        }
        cursor = match.range.last + 1
    }
    text.substring(cursor).trim().takeIf { it.isNotEmpty() }
        ?.let { sections += AiMarkdownSection.Prose(it.replace("```", "")) }
    return sections
}

private fun hasExecutableAiCommand(text: String): Boolean = parseAiMarkdown(text).any { section ->
    section is AiMarkdownSection.Code && section.language.lowercase() in executableAiLanguages
}

@Composable
private fun AiMarkdownContent(
    content: String,
    executedCommands: Set<String>,
    onInsertCommand: ((String) -> Unit)?,
) {
    val sections = remember(content) { parseAiMarkdown(content) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        sections.forEach { section ->
            when (section) {
                is AiMarkdownSection.Prose -> SelectionContainer {
                    Text(
                        markdownAnnotatedText(
                            section.text,
                            MaterialTheme.colorScheme.primary,
                            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        lineHeight = 22.sp,
                    )
                }
                is AiMarkdownSection.Code -> AiCodeBlock(
                    section = section,
                    executed = section.code in executedCommands,
                    onInsertCommand = onInsertCommand,
                )
            }
        }
    }
}

@Composable
private fun AiCodeBlock(
    section: AiMarkdownSection.Code,
    executed: Boolean,
    onInsertCommand: ((String) -> Unit)?,
) {
    val clipboard = LocalClipboardManager.current
    val canInsert = onInsertCommand != null && section.language.lowercase() in executableAiLanguages
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.76f),
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(
            1.dp,
            MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f),
        ),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    section.language.ifBlank { "code" },
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                IconButton(onClick = { clipboard.setText(AnnotatedString(section.code)) }) {
                    Icon(
                        Icons.Default.ContentCopy,
                        contentDescription = stringResource(R.string.common_copy),
                        modifier = Modifier.size(18.dp),
                    )
                }
                if (canInsert) {
                    TextButton(
                        onClick = { onInsertCommand?.invoke(section.code) },
                        enabled = !executed,
                    ) {
                        Text(
                            stringResource(
                                if (executed) R.string.ai_executed else R.string.ai_execute_terminal,
                            ),
                        )
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.56f))
            SelectionContainer {
                Text(
                    section.code,
                    modifier = Modifier
                        .horizontalScroll(rememberScrollState())
                        .padding(12.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
            }
        }
    }
}

private fun markdownAnnotatedText(
    text: String,
    inlineCodeColor: Color,
    inlineCodeBackground: Color,
): AnnotatedString = buildAnnotatedString {
    val lines = text.replace("\r\n", "\n").lines()
    lines.forEachIndexed { index, rawLine ->
        val trimmed = rawLine.trim()
        val heading = Regex("^(#{1,4})\\s+(.+)$").matchEntire(trimmed)
        val bullet = Regex("^[-*]\\s+(.+)$").matchEntire(trimmed)
        val numbered = Regex("^(\\d+\\.)\\s+(.+)$").matchEntire(trimmed)
        when {
            heading != null -> withStyle(
                SpanStyle(fontWeight = FontWeight.Bold, fontSize = 16.sp),
            ) {
                appendInlineMarkdown(
                    heading.groupValues[2],
                    inlineCodeColor,
                    inlineCodeBackground,
                )
            }
            bullet != null -> {
                append("•  ")
                appendInlineMarkdown(
                    bullet.groupValues[1],
                    inlineCodeColor,
                    inlineCodeBackground,
                )
            }
            numbered != null -> {
                append(numbered.groupValues[1])
                append("  ")
                appendInlineMarkdown(
                    numbered.groupValues[2],
                    inlineCodeColor,
                    inlineCodeBackground,
                )
            }
            else -> appendInlineMarkdown(rawLine, inlineCodeColor, inlineCodeBackground)
        }
        if (index != lines.lastIndex) append('\n')
    }
}

private fun AnnotatedString.Builder.appendInlineMarkdown(
    value: String,
    inlineCodeColor: Color,
    inlineCodeBackground: Color,
) {
    val tokens = Regex("(\\*\\*[^*]+\\*\\*|`[^`]+`)")
    var cursor = 0
    tokens.findAll(value).forEach { match ->
        append(value.substring(cursor, match.range.first))
        val token = match.value
        if (token.startsWith("**")) {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                append(token.removePrefix("**").removeSuffix("**"))
            }
        } else {
            withStyle(
                SpanStyle(
                    fontFamily = FontFamily.Monospace,
                    color = inlineCodeColor,
                    background = inlineCodeBackground,
                ),
            ) {
                append(token.removeSurrounding("`"))
            }
        }
        cursor = match.range.last + 1
    }
    append(value.substring(cursor))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiProfileDialog(
    profile: AiProfileRecord?,
    modelOptions: List<String>,
    modelError: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onRefreshModels: (baseUrl: String, apiKey: String) -> Unit,
    onDelete: (() -> Unit)?,
    onSave: (AiProfileInput) -> Unit,
) {
    var name by remember(profile?.id) { mutableStateOf(profile?.name.orEmpty()) }
    var provider by remember(profile?.id) {
        mutableStateOf(profile?.provider ?: "openai-compatible")
    }
    var baseUrl by remember(profile?.id) {
        mutableStateOf(profile?.baseUrl.orEmpty())
    }
    var model by remember(profile?.id) { mutableStateOf(profile?.model.orEmpty()) }
    var apiKey by remember(profile?.id) { mutableStateOf("") }
    var systemPrompt by remember(profile?.id) { mutableStateOf(profile?.systemPrompt.orEmpty()) }
    var reasoningEffort by remember(profile?.id) {
        mutableStateOf(profile?.reasoningEffort.orEmpty())
    }
    var reasoningExpanded by remember { mutableStateOf(false) }
    var modelExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(modelOptions) {
        if (modelOptions.isNotEmpty()) {
            modelExpanded = true
        }
    }
    val visibleModelOptions = remember(modelOptions, model) {
        if (model.isBlank() || model in modelOptions) {
            modelOptions
        } else {
            modelOptions.filter { it.contains(model, ignoreCase = true) }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnClickOutside = false),
        title = {
            Text(
                stringResource(
                    if (profile == null) R.string.ai_add_profile else R.string.ai_edit_profile,
                ),
            )
        },
        text = {
            Column(
                Modifier
                    .heightIn(max = 560.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.common_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row {
                    FilterChip(
                        selected = provider == "openai-compatible",
                        onClick = {
                            provider = "openai-compatible"
                            if (baseUrl == "https://api.openai.com/v1") baseUrl = ""
                        },
                        label = { Text(stringResource(R.string.ai_provider_compatible)) },
                    )
                    Spacer(Modifier.width(6.dp))
                    FilterChip(
                        selected = provider == "openai",
                        onClick = {
                            provider = "openai"
                            if (baseUrl.isBlank()) baseUrl = "https://api.openai.com/v1"
                        },
                        label = { Text("OpenAI") },
                    )
                }
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = { Text(stringResource(R.string.ai_base_url)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ExposedDropdownMenuBox(
                        expanded = modelExpanded,
                        onExpandedChange = { modelExpanded = !modelExpanded },
                        modifier = Modifier.weight(1f),
                    ) {
                        OutlinedTextField(
                            value = model,
                            onValueChange = {
                                model = it
                                modelExpanded = modelOptions.isNotEmpty()
                            },
                            label = { Text(stringResource(R.string.ai_model)) },
                            trailingIcon = {
                                ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelExpanded)
                            },
                            singleLine = true,
                            modifier = Modifier
                                .menuAnchor()
                                .fillMaxWidth(),
                        )
                        ExposedDropdownMenu(
                            expanded = modelExpanded,
                            onDismissRequest = { modelExpanded = false },
                        ) {
                            visibleModelOptions.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(option) },
                                    onClick = {
                                        model = option
                                        modelExpanded = false
                                    },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    IconButton(
                        onClick = { onRefreshModels(baseUrl.trim(), apiKey) },
                        enabled = !busy && baseUrl.isNotBlank() &&
                            (apiKey.isNotBlank() || profile?.hasApiKey == true),
                        modifier = Modifier
                            .width(48.dp)
                            .height(56.dp),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(
                                Icons.Default.Refresh,
                                contentDescription = stringResource(R.string.ai_fetch_models),
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
                modelError?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = {
                        Text(
                            stringResource(
                                if (profile == null) R.string.ai_api_key
                                else R.string.ai_api_key_keep,
                            ),
                        )
                    },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = systemPrompt,
                    onValueChange = { systemPrompt = it },
                    label = { Text(stringResource(R.string.ai_system_prompt)) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                val reasoningOptions = listOf(
                    "" to stringResource(R.string.ai_reasoning_default),
                    "low" to stringResource(R.string.ai_reasoning_low),
                    "medium" to stringResource(R.string.ai_reasoning_medium),
                    "high" to stringResource(R.string.ai_reasoning_high),
                )
                ExposedDropdownMenuBox(
                    expanded = reasoningExpanded,
                    onExpandedChange = { reasoningExpanded = !reasoningExpanded },
                ) {
                    OutlinedTextField(
                        value = reasoningOptions.firstOrNull { it.first == reasoningEffort }?.second
                            ?: reasoningEffort,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.ai_reasoning_effort)) },
                        trailingIcon = {
                            ExposedDropdownMenuDefaults.TrailingIcon(expanded = reasoningExpanded)
                        },
                        singleLine = true,
                        modifier = Modifier
                            .menuAnchor()
                            .fillMaxWidth(),
                    )
                    ExposedDropdownMenu(
                        expanded = reasoningExpanded,
                        onDismissRequest = { reasoningExpanded = false },
                    ) {
                        reasoningOptions.forEach { (value, label) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    reasoningEffort = value
                                    reasoningExpanded = false
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                onDelete?.let {
                    TextButton(onClick = it, enabled = !busy) {
                        Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error)
                        Text(
                            stringResource(R.string.common_delete),
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onDismiss, enabled = !busy) {
                    Text(stringResource(R.string.common_cancel))
                }
                TextButton(
                    enabled = !busy && name.isNotBlank() && baseUrl.isNotBlank() &&
                        model.isNotBlank() && (profile != null || apiKey.isNotBlank()),
                    onClick = {
                        onSave(
                            AiProfileInput(
                                id = profile?.id,
                                name = name.trim(),
                                provider = provider,
                                baseUrl = baseUrl.trim(),
                                model = model.trim(),
                                apiKey = apiKey,
                                systemPrompt = systemPrompt,
                                reasoningEffort = reasoningEffort.trim(),
                            ),
                        )
                    },
                ) { Text(stringResource(R.string.common_save)) }
            }
        },
    )
}
