package com.zeroterm.android.ui.hosts

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zeroterm.android.data.ZeroTermRepository
import com.zeroterm.ffi.HostAuthInput
import com.zeroterm.ffi.HostInput
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AuthMode { Password, PrivateKey, Agent }

data class HostEditUiState(
    val isNew: Boolean = true,
    val hostId: String? = null,
    val name: String = "",
    val host: String = "",
    val port: String = "22",
    val user: String = "",
    val authMode: AuthMode = AuthMode.Password,
    val password: String = "",
    val keyPem: String = "",
    val passphrase: String = "",
    val loading: Boolean = false,
    val saving: Boolean = false,
    val error: String? = null,
    val saved: Boolean = false,
    val deleted: Boolean = false,
)

class HostEditViewModel(
    private val repository: ZeroTermRepository,
    private val editId: String?,
) : ViewModel() {
    private val _state = MutableStateFlow(
        HostEditUiState(isNew = editId == null, hostId = editId, loading = editId != null),
    )
    val state: StateFlow<HostEditUiState> = _state.asStateFlow()

    init {
        if (editId != null) {
            viewModelScope.launch {
                repository.getHost(editId).fold(
                    onSuccess = { d ->
                        val mode = when (val a = d.auth) {
                            is HostAuthInput.Password -> AuthMode.Password
                            is HostAuthInput.PrivateKey -> AuthMode.PrivateKey
                            is HostAuthInput.Agent -> AuthMode.Agent
                        }
                        val pw = (d.auth as? HostAuthInput.Password)?.value.orEmpty()
                        val key = (d.auth as? HostAuthInput.PrivateKey)?.keyPem.orEmpty()
                        val pp = (d.auth as? HostAuthInput.PrivateKey)?.passphrase.orEmpty()
                        _state.update {
                            it.copy(
                                loading = false,
                                name = d.name,
                                host = d.host,
                                port = d.port.toString(),
                                user = d.user,
                                authMode = mode,
                                password = pw,
                                keyPem = key,
                                passphrase = pp,
                            )
                        }
                    },
                    onFailure = { e ->
                        _state.update {
                            it.copy(loading = false, error = e.message ?: "Load failed")
                        }
                    },
                )
            }
        }
    }

    fun onName(v: String) = _state.update { it.copy(name = v, error = null) }
    fun onHost(v: String) = _state.update { it.copy(host = v, error = null) }
    fun onPort(v: String) = _state.update { it.copy(port = v.filter { c -> c.isDigit() }, error = null) }
    fun onUser(v: String) = _state.update { it.copy(user = v, error = null) }
    fun onAuthMode(m: AuthMode) = _state.update { it.copy(authMode = m, error = null) }
    fun onPassword(v: String) = _state.update { it.copy(password = v, error = null) }
    fun onKeyPem(v: String) = _state.update { it.copy(keyPem = v, error = null) }
    fun onPassphrase(v: String) = _state.update { it.copy(passphrase = v, error = null) }

    fun save() {
        val s = _state.value
        if (s.host.isBlank() || s.user.isBlank()) {
            _state.update { it.copy(error = "Host and user required") }
            return
        }
        val port: UShort = s.port.toUShortOrNull() ?: 22u
        val auth: HostAuthInput = when (s.authMode) {
            AuthMode.Password -> {
                if (s.password.isEmpty()) {
                    _state.update { it.copy(error = "Password required") }
                    return
                }
                HostAuthInput.Password(value = s.password)
            }
            AuthMode.PrivateKey -> {
                if (s.keyPem.isBlank()) {
                    _state.update { it.copy(error = "Private key PEM required") }
                    return
                }
                HostAuthInput.PrivateKey(
                    keyPem = s.keyPem,
                    passphrase = s.passphrase.ifBlank { null },
                )
            }
            AuthMode.Agent -> HostAuthInput.Agent
        }
        val name = s.name.ifBlank { "${s.user}@${s.host}" }
        viewModelScope.launch {
            _state.update { it.copy(saving = true, error = null) }
            val input = HostInput(
                id = s.hostId,
                name = name,
                host = s.host.trim(),
                port = port,
                user = s.user.trim(),
                auth = auth,
                groupId = null,
            )
            repository.saveHost(input).fold(
                onSuccess = { id ->
                    _state.update { it.copy(saving = false, saved = true, hostId = id) }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(saving = false, error = e.message ?: "Save failed")
                    }
                },
            )
        }
    }

    fun delete() {
        val id = _state.value.hostId ?: return
        viewModelScope.launch {
            _state.update { it.copy(saving = true, error = null) }
            repository.deleteHost(id).fold(
                onSuccess = { _state.update { it.copy(saving = false, deleted = true) } },
                onFailure = { e ->
                    _state.update {
                        it.copy(saving = false, error = e.message ?: "Delete failed")
                    }
                },
            )
        }
    }

    companion object {
        fun factory(repo: ZeroTermRepository, editId: String?): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return HostEditViewModel(repo, editId) as T
                }
            }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostEditScreen(
    repository: ZeroTermRepository,
    editId: String?,
    onDone: () -> Unit,
) {
    val vm: HostEditViewModel = viewModel(
        factory = HostEditViewModel.factory(repository, editId),
        key = editId ?: "new",
    )
    val state by vm.state.collectAsState()

    LaunchedEffect(state.saved, state.deleted) {
        if (state.saved || state.deleted) onDone()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (state.isNew) "Add host" else "Edit host") },
                navigationIcon = {
                    IconButton(onClick = onDone) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (!state.isNew) {
                        IconButton(onClick = vm::delete, enabled = !state.saving) {
                            Icon(Icons.Default.Delete, contentDescription = "Delete")
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (state.loading) {
            CircularProgressIndicator(Modifier.padding(padding).padding(24.dp))
            return@Scaffold
        }
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            OutlinedTextField(
                value = state.name,
                onValueChange = vm::onName,
                label = { Text("Name") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = state.host,
                onValueChange = vm::onHost,
                label = { Text("Host / IP") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = state.port,
                onValueChange = vm::onPort,
                label = { Text("Port") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = state.user,
                onValueChange = vm::onUser,
                label = { Text("User") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(12.dp))
            Text("Auth", style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(4.dp))
            androidx.compose.foundation.layout.Row {
                FilterChip(
                    selected = state.authMode == AuthMode.Password,
                    onClick = { vm.onAuthMode(AuthMode.Password) },
                    label = { Text("Password") },
                )
                Spacer(Modifier.padding(4.dp))
                FilterChip(
                    selected = state.authMode == AuthMode.PrivateKey,
                    onClick = { vm.onAuthMode(AuthMode.PrivateKey) },
                    label = { Text("Key") },
                )
                Spacer(Modifier.padding(4.dp))
                FilterChip(
                    selected = state.authMode == AuthMode.Agent,
                    onClick = { vm.onAuthMode(AuthMode.Agent) },
                    label = { Text("Agent") },
                )
            }
            Spacer(Modifier.height(8.dp))
            when (state.authMode) {
                AuthMode.Password -> OutlinedTextField(
                    value = state.password,
                    onValueChange = vm::onPassword,
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                AuthMode.PrivateKey -> {
                    OutlinedTextField(
                        value = state.keyPem,
                        onValueChange = vm::onKeyPem,
                        label = { Text("Private key (PEM)") },
                        modifier = Modifier.fillMaxWidth().height(160.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = state.passphrase,
                        onValueChange = vm::onPassphrase,
                        label = { Text("Passphrase (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                }
                AuthMode.Agent -> Text(
                    "Uses SSH agent on the device (limited on Android).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            state.error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = vm::save,
                enabled = !state.saving,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (state.saving) "Saving…" else "Save")
            }
        }
    }
}
