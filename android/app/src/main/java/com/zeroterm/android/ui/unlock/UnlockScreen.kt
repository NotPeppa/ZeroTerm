package com.zeroterm.android.ui.unlock

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.zeroterm.android.R
import com.zeroterm.android.ZeroTermApp
import com.zeroterm.android.data.biometric.BiometricGate

@Composable
fun UnlockScreen(
    viewModel: UnlockViewModel,
    onUnlocked: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val activity = context as? FragmentActivity
    val app = context.applicationContext as ZeroTermApp

    var passwordVisible by remember { mutableStateOf(false) }
    var biometricAttempted by remember { mutableStateOf(false) }

    val biometricTitle = stringResource(R.string.biometric_title)
    val biometricSubtitle = stringResource(R.string.biometric_subtitle)

    LaunchedEffect(state.unlocked) {
        if (state.unlocked) onUnlocked()
    }

    // Auto-prompt biometric when cache exists
    LaunchedEffect(state.hasCachedPassword, state.vaultExists) {
        if (
            !biometricAttempted &&
            state.hasCachedPassword &&
            state.vaultExists &&
            !state.unlocked &&
            activity != null &&
            BiometricGate.canAuthenticate(activity)
        ) {
            biometricAttempted = true
            BiometricGate.authenticate(
                activity = activity,
                title = biometricTitle,
                subtitle = biometricSubtitle,
                onSuccess = {
                    val pw = app.container.passwordStore.load()
                    if (pw != null) {
                        viewModel.unlockWithBiometricPassword(pw)
                    }
                },
                onError = { /* fall through to password UI */ },
                onCancel = { /* fall through to password UI */ },
            )
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(
                painter = painterResource(R.drawable.zeroterm_desktop_logo),
                contentDescription = null,
                modifier = Modifier.size(72.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.unlock_brand),
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = if (state.vaultExists) {
                    stringResource(R.string.unlock_vault)
                } else {
                    stringResource(R.string.unlock_create_vault)
                },
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(24.dp))

            Card(
                modifier = Modifier.fillMaxWidth().widthIn(max = 480.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.60f),
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                border = BorderStroke(
                    width = 1.dp,
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f),
                ),
            ) {
                Column(Modifier.padding(20.dp)) {

            OutlinedTextField(
                value = state.password,
                onValueChange = viewModel::onPasswordChange,
                label = { Text(stringResource(R.string.unlock_master_password)) },
                singleLine = true,
                visualTransformation = if (passwordVisible) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            if (passwordVisible) Icons.Default.VisibilityOff
                            else Icons.Default.Visibility,
                            contentDescription = null,
                        )
                    }
                },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = if (state.vaultExists) ImeAction.Done else ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { viewModel.submit() },
                ),
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.loading,
            )

            if (!state.vaultExists) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = state.confirmPassword,
                    onValueChange = viewModel::onConfirmChange,
                    label = { Text(stringResource(R.string.unlock_confirm_password)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { viewModel.submit() }),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.loading,
                )
            }

            Spacer(Modifier.height(8.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Checkbox(
                    checked = state.remember,
                    onCheckedChange = viewModel::onRememberChange,
                    enabled = !state.loading,
                )
                Text(stringResource(R.string.unlock_remember_biometrics))
            }

            state.error?.let { err ->
                Spacer(Modifier.height(8.dp))
                Text(err, color = MaterialTheme.colorScheme.error)
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = viewModel::submit,
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(
                        if (state.vaultExists) {
                            stringResource(R.string.unlock_button)
                        } else {
                            stringResource(R.string.unlock_create)
                        },
                    )
                }
            }

            if (state.hasCachedPassword && state.vaultExists && activity != null) {
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        BiometricGate.authenticate(
                            activity = activity,
                            title = biometricTitle,
                            subtitle = biometricSubtitle,
                            onSuccess = {
                                val pw = app.container.passwordStore.load()
                                if (pw != null) viewModel.unlockWithBiometricPassword(pw)
                            },
                            onError = {},
                        )
                    },
                    enabled = !state.loading,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.Fingerprint, contentDescription = null)
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.unlock_use_biometrics))
                }
            }
                }
            }

            if (state.vaultPath.isNotEmpty()) {
                Spacer(Modifier.height(24.dp))
                Text(
                    text = state.vaultPath,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
    }
}
