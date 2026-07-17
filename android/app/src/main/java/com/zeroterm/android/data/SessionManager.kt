package com.zeroterm.android.data

import android.content.Context
import com.zeroterm.android.service.SessionForegroundService
import com.zeroterm.ffi.DamageFrame
import com.zeroterm.ffi.HostAuthInput
import com.zeroterm.ffi.HostKeyInfo
import com.zeroterm.ffi.HostKeyPromptCallback
import com.zeroterm.ffi.SessionListener
import com.zeroterm.ffi.Terminal
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

data class HostKeyPrompt(
    val requestId: String,
    val info: HostKeyInfo,
    val stored: String?,
)

data class ActiveSession(
    val sessionId: ULong,
    val hostId: String,
    val hostLabel: String,
    val terminal: Terminal,
)

/**
 * Owns SSH sessions + VT terminals. Compose consumes [frameTick] and
 * [hostKeyPrompts]; never talks to FFI session APIs directly.
 */
class SessionManager(
    private val zeroTerm: ZeroTerm,
    private val appContext: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sessions = ConcurrentHashMap<ULong, ActiveSession>()
    private val frameGen = AtomicLong(0)

    private val _active = MutableStateFlow<ActiveSession?>(null)
    val active: StateFlow<ActiveSession?> = _active.asStateFlow()

    private val _frameTick = MutableStateFlow(0L)
    val frameTick: StateFlow<Long> = _frameTick.asStateFlow()

    private val _closed = MutableSharedFlow<Pair<ULong, String?>>(extraBufferCapacity = 8)
    val closed: SharedFlow<Pair<ULong, String?>> = _closed.asSharedFlow()

    private val _hostKeyPrompts = MutableSharedFlow<HostKeyPrompt>(extraBufferCapacity = 4)
    val hostKeyPrompts: SharedFlow<HostKeyPrompt> = _hostKeyPrompts.asSharedFlow()

    private val _connecting = MutableStateFlow(false)
    val connecting: StateFlow<Boolean> = _connecting.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun connect(
        hostId: String,
        hostLabel: String,
        cols: UShort,
        rows: UShort,
    ): Result<ULong> = openSession(hostId, hostLabel, cols, rows) { term, listener, prompt ->
        zeroTerm.connectHost(hostId, cols, rows, listener, prompt)
    }

    suspend fun connectDirect(
        host: String,
        port: UShort,
        user: String,
        auth: HostAuthInput,
        hostLabel: String,
        cols: UShort,
        rows: UShort,
    ): Result<ULong> = openSession("direct", hostLabel, cols, rows) { _, listener, prompt ->
        zeroTerm.connectDirect(host, port, user, auth, cols, rows, listener, prompt)
    }

    private suspend fun openSession(
        hostId: String,
        hostLabel: String,
        cols: UShort,
        rows: UShort,
        connect: suspend (Terminal, SessionListener, HostKeyPromptCallback) -> ULong,
    ): Result<ULong> = withContext(Dispatchers.Default) {
        _active.value?.let { prev ->
            runCatching { zeroTerm.disconnectSession(prev.sessionId) }
            sessions.remove(prev.sessionId)
            _active.value = null
        }
        _connecting.value = true
        _error.value = null
        runCatching {
            val term = Terminal(cols, rows, 10_000u)
            val listener = object : SessionListener {
                override fun onData(data: ByteArray) {
                    term.feed(data)
                    if (_active.value?.terminal === term) {
                        _frameTick.value = frameGen.incrementAndGet()
                    }
                }

                override fun onClosed(exitCode: UInt?, message: String?) {
                    val sid = sessions.entries.find { it.value.terminal === term }?.key
                    if (sid != null) {
                        sessions.remove(sid)
                        if (_active.value?.sessionId == sid) {
                            _active.value = null
                        }
                        updateFgs()
                        scope.launch {
                            _closed.emit(sid to (message ?: exitCode?.let { "exit $it" }))
                        }
                    }
                }
            }
            val prompt = object : HostKeyPromptCallback {
                override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
                    scope.launch {
                        _hostKeyPrompts.emit(HostKeyPrompt(requestId, info, stored))
                    }
                }
            }
            val sessionId = connect(term, listener, prompt)
            val active = ActiveSession(sessionId, hostId, hostLabel, term)
            sessions[sessionId] = active
            _active.value = active
            _frameTick.value = frameGen.incrementAndGet()
            updateFgs()
            sessionId
        }.also {
            _connecting.value = false
            it.exceptionOrNull()?.let { e ->
                _error.value = e.message ?: e.toString()
            }
        }
    }

    fun respondHostKey(requestId: String, accept: Boolean) {
        runCatching { zeroTerm.respondHostKey(requestId, accept) }
    }

    suspend fun sendInput(data: ByteArray) {
        val sid = _active.value?.sessionId ?: return
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.sendInput(sid, data) }
        }
    }

    suspend fun sendText(text: String) {
        sendInput(text.toByteArray(Charsets.UTF_8))
    }

    suspend fun resize(cols: UShort, rows: UShort) {
        val session = _active.value ?: return
        session.terminal.resize(cols, rows)
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.resizeSession(session.sessionId, cols, rows) }
        }
        _frameTick.value = frameGen.incrementAndGet()
    }

    suspend fun disconnect(sessionId: ULong? = null) {
        val sid = sessionId ?: _active.value?.sessionId ?: return
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.disconnectSession(sid) }
        }
        sessions.remove(sid)
        if (_active.value?.sessionId == sid) {
            _active.value = null
        }
        updateFgs()
    }

    fun takeDamage(): DamageFrame? {
        val term = _active.value?.terminal ?: return null
        return term.takeDamage()
    }

    fun snapshot(): DamageFrame? = _active.value?.terminal?.snapshot()

    fun scrollDisplay(delta: Int) {
        val term = _active.value?.terminal ?: return
        term.scrollDisplay(delta)
        // Always full repaint after scroll
        _frameTick.value = frameGen.incrementAndGet()
    }

    fun scrollToBottom() {
        val term = _active.value?.terminal ?: return
        term.scrollToBottom()
        _frameTick.value = frameGen.incrementAndGet()
    }

    fun displayOffset(): Int =
        _active.value?.terminal?.displayOffset()?.toInt() ?: 0

    fun viewportText(): String =
        _active.value?.terminal?.viewportText().orEmpty()

    fun sessionCount(): Int = sessions.size

    private fun updateFgs() {
        val n = sessions.size
        if (n > 0) {
            SessionForegroundService.start(appContext, n)
        } else {
            SessionForegroundService.stop(appContext)
        }
    }
}
