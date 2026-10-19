package com.zeroterm.android.data

import android.content.Context
import com.zeroterm.android.R
import com.zeroterm.android.data.biometric.MasterPasswordStore
import com.zeroterm.ffi.FfiException
import com.zeroterm.ffi.AiChatMessage
import com.zeroterm.ffi.AiChatResponse
import com.zeroterm.ffi.AiProfileInput
import com.zeroterm.ffi.AiProfileRecord
import com.zeroterm.ffi.HostDetail
import com.zeroterm.ffi.HostExecResult
import com.zeroterm.ffi.HostGroupInput
import com.zeroterm.ffi.HostGroupRecord
import com.zeroterm.ffi.HostInput
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.SnippetInput
import com.zeroterm.ffi.SnippetRecord
import com.zeroterm.ffi.VaultStatus
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * Wraps the uniffi [ZeroTerm] object. All FFI calls go through here so
 * Compose never imports crypto/SSH types directly (RFC-001 / RFC-003).
 */
class ZeroTermRepository(
    private val zeroTerm: ZeroTerm,
    private val passwordStore: MasterPasswordStore,
    private val appContext: Context,
) {
    private val _unlocked = MutableStateFlow(false)
    val unlocked: StateFlow<Boolean> = _unlocked.asStateFlow()

    private val _hosts = MutableStateFlow<List<HostSummary>>(emptyList())
    val hosts: StateFlow<List<HostSummary>> = _hosts.asStateFlow()

    private val _hostGroups = MutableStateFlow<List<HostGroupRecord>>(emptyList())
    val hostGroups: StateFlow<List<HostGroupRecord>> = _hostGroups.asStateFlow()

    fun vaultStatus(): VaultStatus = zeroTerm.vaultStatus()

    fun hasCachedPassword(): Boolean = passwordStore.hasPassword()

    // NOTE on `remember`: caching the master password now requires a
    // biometric-authenticated encrypt cipher (AND-1), which only the UI
    // can drive via BiometricPrompt. So unlock/create no longer persist
    // the password themselves — they only ensure any stale cache is
    // dropped. When `remember` is set, the UnlockScreen runs the
    // biometric enroll step (MasterPasswordStore.encryptCipher +
    // finishSave) after a successful unlock.
    suspend fun unlock(password: String, remember: Boolean): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.unlock(password, false)
                passwordStore.clear()
                afterUnlock()
            }.mapFfi()
        }

    suspend fun create(password: String, remember: Boolean): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.create(password, false)
                passwordStore.clear()
                afterUnlock()
            }.mapFfi()
        }

    suspend fun unlockWithCachedPassword(password: String): Result<Boolean> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.unlock(password, false)
                afterUnlock()
                true
            }.mapFfi()
        }

    fun lock(clearCache: Boolean = false) {
        zeroTerm.lock()
        if (clearCache) passwordStore.clear()
        _unlocked.value = false
        _hosts.value = emptyList()
        _hostGroups.value = emptyList()
    }

    suspend fun refreshHosts(): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                _hosts.value = zeroTerm.listHosts()
                _hostGroups.value = zeroTerm.listHostGroups()
            }.mapFfi()
        }

    suspend fun listHostGroups(): Result<List<HostGroupRecord>> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.listHostGroups() }.mapFfi()
        }

    suspend fun saveHostGroup(input: HostGroupInput): Result<String> =
        withContext(Dispatchers.Default) {
            runCatching {
                val id = zeroTerm.saveHostGroup(input)
                _hostGroups.value = zeroTerm.listHostGroups()
                id
            }.mapFfi()
        }

    suspend fun deleteHostGroup(id: String): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.deleteHostGroup(id)
                _hostGroups.value = zeroTerm.listHostGroups()
            }.mapFfi()
        }

    suspend fun listAiProfiles(): Result<List<AiProfileRecord>> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.listAiProfiles() }.mapFfi()
        }

    suspend fun saveAiProfile(input: AiProfileInput): Result<String> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.saveAiProfile(input) }.mapFfi()
        }

    suspend fun deleteAiProfile(id: String): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.deleteAiProfile(id) }.mapFfi()
        }

    suspend fun listAiModels(profileId: String): Result<List<String>> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.listAiModels(profileId) }.mapFfi()
        }

    suspend fun listAiModels(
        profileId: String?,
        baseUrl: String,
        apiKey: String,
    ): Result<List<String>> = withContext(Dispatchers.Default) {
        runCatching {
            zeroTerm.listAiModelsWithConfig(profileId, baseUrl, apiKey)
        }.mapFfi()
    }

    suspend fun aiChat(
        profileId: String,
        messages: List<AiChatMessage>,
    ): Result<AiChatResponse> = withContext(Dispatchers.Default) {
        try {
            Result.success(zeroTerm.aiChat(profileId, messages))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Result.failure<AiChatResponse>(error).mapFfi()
        }
    }

    suspend fun aiChat(
        profileId: String,
        modelOverride: String,
        messages: List<AiChatMessage>,
    ): Result<AiChatResponse> = withContext(Dispatchers.Default) {
        try {
            Result.success(zeroTerm.aiChatWithModel(profileId, modelOverride, messages))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Result.failure<AiChatResponse>(error).mapFfi()
        }
    }

    suspend fun execHostCommand(hostId: String, command: String): Result<HostExecResult> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.execHostCommand(hostId, command) }.mapFfi()
        }

    suspend fun getHost(id: String): Result<HostDetail> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.getHost(id) }.mapFfi()
        }

    suspend fun saveHost(input: HostInput): Result<String> =
        withContext(Dispatchers.Default) {
            runCatching {
                val id = zeroTerm.saveHost(input)
                _hosts.value = zeroTerm.listHosts()
                id
            }.mapFfi()
        }

    suspend fun deleteHost(id: String): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.deleteHost(id)
                _hosts.value = zeroTerm.listHosts()
            }.mapFfi()
        }

    suspend fun listSnippets(): Result<List<SnippetRecord>> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.listSnippets() }.mapFfi()
        }

    suspend fun saveSnippet(input: SnippetInput): Result<String> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.saveSnippet(input) }.mapFfi()
        }

    suspend fun deleteSnippet(id: String): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.deleteSnippet(id) }.mapFfi()
        }

    private fun afterUnlock() {
        _unlocked.value = true
        _hosts.value = runCatching { zeroTerm.listHosts() }.getOrDefault(emptyList())
        _hostGroups.value = runCatching { zeroTerm.listHostGroups() }.getOrDefault(emptyList())
    }

    private fun <T> Result<T>.mapFfi(): Result<T> = fold(
        onSuccess = { Result.success(it) },
        onFailure = { e ->
            val msg = when (e) {
                is FfiException.AuthenticationFailed ->
                    appContext.getString(R.string.error_wrong_password)
                is FfiException.NotInitialized ->
                    appContext.getString(R.string.error_vault_not_found)
                is FfiException.AlreadyExists ->
                    appContext.getString(R.string.error_vault_exists)
                is FfiException.VaultLocked ->
                    appContext.getString(R.string.error_vault_locked)
                is FfiException.NotFound ->
                    e.detail.ifBlank { appContext.getString(R.string.common_not_found) }
                is FfiException.Other -> e.detail.ifBlank { e.toString() }
                else -> e.message ?: e.toString()
            }
            Result.failure(Exception(msg, e))
        },
    )
}
