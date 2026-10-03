package com.zeroterm.android.data

import android.content.Context
import com.zeroterm.android.service.SessionForegroundService
import com.zeroterm.ffi.HostKeyInfo
import com.zeroterm.ffi.HostKeyPromptCallback
import com.zeroterm.ffi.PortForwardInput
import com.zeroterm.ffi.PortForwardRecord
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicInteger

private data class ForwardPrompt(val ruleId: String, val prompt: HostKeyPrompt)

/** App-scoped tunnels keep running when the user leaves the forwarding page. */
class PortForwardManager(
    private val zeroTerm: ZeroTerm,
    private val repository: ZeroTermRepository,
    private val context: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _rules = MutableStateFlow<List<PortForwardRecord>>(emptyList())
    val rules = _rules.asStateFlow()
    private val _busy = MutableStateFlow<Map<String, String>>(emptyMap())
    val busy = _busy.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    private val prompts = MutableStateFlow<List<ForwardPrompt>>(emptyList())
    private val _hostKeyPrompt = MutableStateFlow<HostKeyPrompt?>(null)
    val hostKeyPrompt = _hostKeyPrompt.asStateFlow()
    private val starting = MutableStateFlow(emptySet<String>())
    private val lastActiveCount = AtomicInteger(0)
    val isStarting: Boolean get() = starting.value.isNotEmpty()

    init {
        scope.launch {
            prompts.collect { _hostKeyPrompt.value = it.firstOrNull()?.prompt }
        }
        scope.launch {
            repository.unlocked.collectLatest { unlocked ->
                if (!unlocked) {
                    stopAll()
                    _rules.value = emptyList()
                    _error.value = null
                } else {
                    withContext(Dispatchers.Default) { runCatching { zeroTerm.migratePortForwardRules() } }
                    while (isActive) {
                        refresh()
                        delay(2_000)
                    }
                }
            }
        }
    }

    suspend fun refresh() {
        withContext(Dispatchers.Default) {
            if (repository.unlocked.value) {
                runCatching { zeroTerm.listPortForwards() }
                    .onSuccess { _rules.value = it }
                    .onFailure { _error.value = it.message }
                val count = zeroTerm.activePortForwardCount().toInt()
                if (lastActiveCount.getAndSet(count) != count) {
                    withContext(Dispatchers.Main.immediate) { updateForegroundService() }
                }
            }
        }
    }

    fun clearError() { _error.value = null }

    fun start(id: String) = operate(id, "start") {
        starting.update { it + id }
        try {
            SessionForegroundService.start(context, 0, connecting = true)
            val callback = object : HostKeyPromptCallback {
                override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
                    prompts.update { it + ForwardPrompt(id, HostKeyPrompt(requestId, info, stored)) }
                }
            }
            zeroTerm.startPortForward(id, callback)
        } finally {
            starting.update { it - id }
            prompts.update { it.filterNot { pending -> pending.ruleId == id } }
        }
    }

    fun stop(id: String) = operate(id, "stop", overrideStart = true) {
        try { zeroTerm.stopPortForward(id) } finally { clearPrompts(id) }
    }
    fun delete(id: String) = operate(id, "delete") {
        try { zeroTerm.deletePortForward(id) } finally { clearPrompts(id) }
    }

    suspend fun save(input: PortForwardInput): Result<String> {
        val key = input.id ?: "new"
        if (_busy.value.containsKey(key)) return Result.failure(IllegalStateException("Operation in progress"))
        _busy.update { it + (key to "save") }
        _error.value = null
        return try {
            val result = withContext(Dispatchers.Default) { zeroTerm.savePortForward(input) }
            refresh()
            Result.success(result)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _error.value = e.message
            Result.failure(e)
        } finally {
            input.id?.let(::clearPrompts)
            _busy.update { it - key }
            updateForegroundService()
        }
    }

    suspend fun stopAll() {
        withContext(Dispatchers.Default) { zeroTerm.stopAllPortForwards() }
        prompts.value = emptyList()
        refresh()
        updateForegroundService()
    }

    fun respondHostKey(requestId: String, accept: Boolean) {
        runCatching { zeroTerm.respondHostKey(requestId, accept) }
        prompts.update { it.filterNot { pending -> pending.prompt.requestId == requestId } }
    }

    private fun clearPrompts(id: String) { prompts.update { it.filterNot { pending -> pending.ruleId == id } } }

    private fun operate(id: String, action: String, overrideStart: Boolean = false, block: suspend () -> Unit) {
        val previous = _busy.value[id]
        if (previous != null && !(overrideStart && previous == "start")) return
        _busy.update { it + (id to action) }
        _error.value = null
        scope.launch {
            try {
                withContext(Dispatchers.Default) { block() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (_busy.value[id] == action) _error.value = e.message
            } finally {
                _busy.update { if (it[id] == action) it - id else it }
                refresh()
                updateForegroundService()
            }
        }
    }

    private fun updateForegroundService() {
        // The service combines tunnel and terminal counts; neither feature
        // should stop the other's foreground notification or wake locks.
        runCatching { SessionForegroundService.stop(context) }
            .onFailure { _error.value = it.message }
    }
}
