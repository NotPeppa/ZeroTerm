package com.zeroterm.android.data

import com.zeroterm.android.data.biometric.MasterPasswordStore
import com.zeroterm.ffi.FfiException
import com.zeroterm.ffi.HostDetail
import com.zeroterm.ffi.HostInput
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.SnippetInput
import com.zeroterm.ffi.SnippetRecord
import com.zeroterm.ffi.VaultStatus
import com.zeroterm.ffi.ZeroTerm
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
) {
    private val _unlocked = MutableStateFlow(false)
    val unlocked: StateFlow<Boolean> = _unlocked.asStateFlow()

    private val _hosts = MutableStateFlow<List<HostSummary>>(emptyList())
    val hosts: StateFlow<List<HostSummary>> = _hosts.asStateFlow()

    fun vaultStatus(): VaultStatus = zeroTerm.vaultStatus()

    fun hasCachedPassword(): Boolean = passwordStore.hasPassword()

    suspend fun unlock(password: String, remember: Boolean): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.unlock(password, false)
                if (remember) passwordStore.save(password) else passwordStore.clear()
                afterUnlock()
            }.mapFfi()
        }

    suspend fun create(password: String, remember: Boolean): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                zeroTerm.create(password, false)
                if (remember) passwordStore.save(password) else passwordStore.clear()
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
    }

    suspend fun refreshHosts(): Result<Unit> =
        withContext(Dispatchers.Default) {
            runCatching {
                _hosts.value = zeroTerm.listHosts()
            }.mapFfi()
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
    }
}

private fun <T> Result<T>.mapFfi(): Result<T> = fold(
    onSuccess = { Result.success(it) },
    onFailure = { e ->
        val msg = when (e) {
            is FfiException.AuthenticationFailed -> "Wrong password"
            is FfiException.NotInitialized -> "Vault not found"
            is FfiException.AlreadyExists -> "Vault already exists"
            is FfiException.VaultLocked -> "Vault is locked"
            is FfiException.NotFound -> e.detail.ifBlank { "Not found" }
            is FfiException.Other -> e.detail.ifBlank { e.toString() }
            else -> e.message ?: e.toString()
        }
        Result.failure(Exception(msg, e))
    },
)
