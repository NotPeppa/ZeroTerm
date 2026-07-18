package com.zeroterm.android.ui.quick

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.SessionManager
import com.zeroterm.android.ui.components.ZeroSectionCard
import com.zeroterm.android.ui.components.ZeroTopBar
import com.zeroterm.android.ui.hosts.AuthMode
import com.zeroterm.ffi.HostAuthInput
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickConnectScreen(
    sessions: SessionManager,
    onConnected: (label: String) -> Unit,
    onBack: () -> Unit,
) {
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var user by remember { mutableStateOf("") }
    var authMode by remember { mutableStateOf(AuthMode.Password) }
    var password by remember { mutableStateOf("") }
    var keyPem by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.48f),
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            ZeroTopBar(
                title = stringResource(R.string.quick_connect_title),
                subtitle = stringResource(R.string.quick_connect_subtitle),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            ZeroSectionCard(title = stringResource(R.string.quick_connect_destination)) {
                OutlinedTextField(
                value = host,
                onValueChange = { host = it; error = null },
                label = { Text(stringResource(R.string.common_host_ip)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
                OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter { c -> c.isDigit() }; error = null },
                label = { Text(stringResource(R.string.common_port)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
                OutlinedTextField(
                value = user,
                onValueChange = { user = it; error = null },
                label = { Text(stringResource(R.string.common_user)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            }
            Spacer(Modifier.height(16.dp))
            ZeroSectionCard(title = stringResource(R.string.quick_connect_authentication)) {
                Row {
                AuthMode.entries.forEach { mode ->
                    FilterChip(
                        selected = authMode == mode,
                        onClick = { authMode = mode },
                        label = {
                            Text(
                                when (mode) {
                                    AuthMode.Password -> stringResource(R.string.quick_connect_auth_password)
                                    AuthMode.PrivateKey -> stringResource(R.string.quick_connect_auth_key)
                                    AuthMode.Agent -> stringResource(R.string.quick_connect_auth_agent)
                                },
                            )
                        },
                        modifier = Modifier.padding(end = 6.dp),
                    )
                }
            }
                when (authMode) {
                AuthMode.Password -> OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.common_password)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                AuthMode.PrivateKey -> {
                    OutlinedTextField(
                        value = keyPem,
                        onValueChange = { keyPem = it },
                        label = { Text(stringResource(R.string.host_edit_key_pem)) },
                        modifier = Modifier.fillMaxWidth().height(140.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = passphrase,
                        onValueChange = { passphrase = it },
                        label = { Text(stringResource(R.string.host_edit_passphrase)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                }
                AuthMode.Agent -> Text(
                    stringResource(R.string.quick_connect_agent_help),
                    style = MaterialTheme.typography.bodySmall,
                )
                }
            }
            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = {
                    if (host.isBlank() || user.isBlank()) {
                        error = context.getString(R.string.host_edit_host_user_required)
                        return@Button
                    }
                    val auth = when (authMode) {
                        AuthMode.Password -> {
                            if (password.isEmpty()) {
                                error = context.getString(R.string.host_edit_password_required)
                                return@Button
                            }
                            HostAuthInput.Password(value = password)
                        }
                        AuthMode.PrivateKey -> {
                            if (keyPem.isBlank()) {
                                error = context.getString(R.string.quick_connect_key_required)
                                return@Button
                            }
                            HostAuthInput.PrivateKey(
                                keyPem = keyPem,
                                passphrase = passphrase.ifBlank { null },
                            )
                        }
                        AuthMode.Agent -> HostAuthInput.Agent
                    }
                    val p = port.toUShortOrNull() ?: 22u
                    val label = "${user.trim()}@${host.trim()}"
                    scope.launch {
                        loading = true
                        error = null
                        sessions.connectDirect(
                            host = host.trim(),
                            port = p,
                            user = user.trim(),
                            auth = auth,
                            hostLabel = label,
                            cols = 80u,
                            rows = 24u,
                        ).fold(
                            onSuccess = {
                                loading = false
                                onConnected(label)
                            },
                            onFailure = { e ->
                                loading = false
                                error = e.message ?: context.getString(R.string.quick_connect_failed)
                            },
                        )
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (loading) {
                        stringResource(R.string.common_connecting)
                    } else {
                        stringResource(R.string.common_connect)
                    },
                )
            }
        }
    }
}
