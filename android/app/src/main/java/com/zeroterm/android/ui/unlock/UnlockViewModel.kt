package com.zeroterm.android.ui.unlock

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.zeroterm.android.data.ZeroTermRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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
)

class UnlockViewModel(
    private val repository: ZeroTermRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(UnlockUiState())
    val state: StateFlow<UnlockUiState> = _state.asStateFlow()

    init {
        refreshStatus()
    }

    fun refreshStatus() {
        val status = runCatching { repository.vaultStatus() }.getOrNull()
        _state.update {
            it.copy(
                vaultExists = status?.exists == true,
                vaultPath = status?.path.orEmpty(),
                hasCachedPassword = repository.hasCachedPassword(),
                unlocked = status?.unlocked == true || repository.unlocked.value,
            )
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
            _state.update { it.copy(error = "Password required") }
            return
        }
        if (!s.vaultExists && s.password != s.confirmPassword) {
            _state.update { it.copy(error = "Passwords do not match") }
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
                    _state.update {
                        it.copy(loading = false, unlocked = true, password = "", confirmPassword = "")
                    }
                },
                onFailure = { e ->
                    _state.update {
                        it.copy(loading = false, error = e.message ?: "Failed")
                    }
                },
            )
        }
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
                            error = e.message ?: "Biometric unlock failed",
                            hasCachedPassword = false,
                        )
                    }
                },
            )
        }
    }

    companion object {
        fun factory(repository: ZeroTermRepository): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return UnlockViewModel(repository) as T
                }
            }
    }
}
