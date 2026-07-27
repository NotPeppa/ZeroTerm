package com.zeroterm.android.ui.unlock

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.zeroterm.android.R
import com.zeroterm.android.data.ZeroTermRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class UnlockUiState(
    val vaultExists: Boolean = false,
    val vaultPath: String = "",
    val password: String = "",
    val confirmPassword: String = "",
    val remember: Boolean = true,
    val hasCachedPassword: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val unlocked: Boolean = false,
    /**
     * When non-null, the vault is unlocked and the user asked to be
     * remembered — the UI must run the biometric encrypt prompt to seal
     * this plaintext into [MasterPasswordStore], then call
     * [UnlockViewModel.finishBiometricEnroll]. Held transiently and
     * never displayed or logged. `unlocked` stays false until the enroll
     * step resolves so the screen doesn't navigate away mid-prompt.
     */
    val enrollPassword: String? = null,
)

class UnlockViewModel(
    private val repository: ZeroTermRepository,
    private val appContext: Context,
) : ViewModel() {
    private val _state = MutableStateFlow(UnlockUiState())
    val state: StateFlow<UnlockUiState> = _state.asStateFlow()

    init {
        refreshStatus()
    }

    fun refreshStatus() {
        // AND-8: vaultStatus() is a synchronous JNI call and hasCachedPassword()
        // touches EncryptedSharedPreferences — keep both off the main thread to
        // avoid jank/ANR, mirroring how unlock()/create() already dispatch.
        viewModelScope.launch {
            val (status, cached) = withContext(Dispatchers.IO) {
                val s = runCatching { repository.vaultStatus() }.getOrNull()
                s to repository.hasCachedPassword()
            }
            _state.update {
                it.copy(
                    vaultExists = status?.exists == true,
                    vaultPath = status?.path.orEmpty(),
                    hasCachedPassword = cached,
                    unlocked = status?.unlocked == true || repository.unlocked.value,
                )
            }
        }
    }

    fun prepareForUnlock() {
        // AND-8: reset the UI-critical fields synchronously so the unlock
        // screen, when navigated to right after locking, never observes a
        // stale unlocked=true (its LaunchedEffect would bounce straight back
        // to Hosts). The synchronous JNI vaultStatus() and the prefs-backed
        // hasCachedPassword() lookup then run off the main thread and patch in
        // their results.
        _state.update {
            it.copy(
                password = "",
                confirmPassword = "",
                loading = false,
                error = null,
                unlocked = false,
            )
        }
        viewModelScope.launch {
            val (status, cached) = withContext(Dispatchers.IO) {
                val s = runCatching { repository.vaultStatus() }.getOrNull()
                s to repository.hasCachedPassword()
            }
            _state.update {
                it.copy(
                    vaultExists = status?.exists == true,
                    vaultPath = status?.path.orEmpty(),
                    hasCachedPassword = cached,
                )
            }
        }
    }

    fun onPasswordChange(value: String) {
        _state.update { it.copy(password = value, error = null) }
    }

    fun onConfirmChange(value: String) {
        _state.update { it.copy(confirmPassword = value, error = null) }
    }

    fun onRememberChange(value: Boolean) {
        _state.update { it.copy(remember = value) }
    }

    fun submit() {
        val s = _state.value
        if (s.password.isEmpty()) {
            _state.update { it.copy(error = appContext.getString(R.string.unlock_password_required)) }
            return
        }
        if (!s.vaultExists && s.password != s.confirmPassword) {
            _state.update { it.copy(error = appContext.getString(R.string.unlock_passwords_mismatch)) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            val result = if (s.vaultExists) {
                repository.unlock(s.password, s.remember)
            } else {
                repository.create(s.password, s.remember)
            }
            result.fold(
                onSuccess = {
                    if (s.remember) {
                        // Hand the plaintext to the UI for the biometric
                        // encrypt step; don't mark unlocked until it
                        // resolves. Password field is cleared from the UI
                        // but retained in enrollPassword for sealing.
                        _state.update {
                            it.copy(
                                loading = false,
                                enrollPassword = s.password,
                                password = "",
                                confirmPassword = "",
                            )
                        }
                    } else {
                        _state.update {
                            it.copy(loading = false, unlocked = true, password = "", confirmPassword = "")
                        }
                    }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(
                            loading = false,
                            error = e.message ?: appContext.getString(R.string.common_failed),
                        )
                    }
                },
            )
        }
    }

    /**
     * Called by the UI once the biometric encrypt prompt has resolved
     * (whether it sealed the password or the user skipped/failed it).
     * Either way the vault is already unlocked, so proceed.
     */
    fun finishBiometricEnroll() {
        _state.update { it.copy(enrollPassword = null, unlocked = true) }
    }

    fun unlockWithBiometricPassword(password: String) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            repository.unlockWithCachedPassword(password).fold(
                onSuccess = {
                    _state.update { it.copy(loading = false, unlocked = true) }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(
                            loading = false,
                            error = e.message ?: appContext.getString(R.string.unlock_biometric_failed),
                            hasCachedPassword = false,
                        )
                    }
                },
            )
        }
    }

    companion object {
        fun factory(repository: ZeroTermRepository, context: Context): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return UnlockViewModel(repository, context.applicationContext) as T
                }
            }
    }
}
