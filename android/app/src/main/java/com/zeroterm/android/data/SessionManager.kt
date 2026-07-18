package com.zeroterm.android.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.zeroterm.android.service.SessionForegroundService
import com.zeroterm.ffi.DamageFrame
import com.zeroterm.ffi.HostExecResult
import com.zeroterm.ffi.HostAuthInput
import com.zeroterm.ffi.HostKeyInfo
import com.zeroterm.ffi.HostKeyPromptCallback
import com.zeroterm.ffi.SessionListener
import com.zeroterm.ffi.Terminal
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

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

data class SessionCloseEvent(
    val sessionId: ULong,
    val message: String?,
)

private data class PendingClose(
    val exitCode: UInt?,
    val message: String?,
)

/**
 * Owns SSH sessions + VT terminals. Compose consumes [frameTick] and
 * [hostKeyPrompt]; never talks to FFI session APIs directly.
 */
class SessionManager(
    private val zeroTerm: ZeroTerm,
    private val appContext: Context,
) {
    private val sessions = ConcurrentHashMap<ULong, ActiveSession>()
    private val frameGen = AtomicLong(0)
    private val connectMutex = Mutex()
    private val sessionStateLock = Any()

    private val _active = MutableStateFlow<ActiveSession?>(null)
    val active: StateFlow<ActiveSession?> = _active.asStateFlow()

    private val _frameTick = MutableStateFlow(0L)
    val frameTick: StateFlow<Long> = _frameTick.asStateFlow()

    private val _closed = MutableStateFlow<SessionCloseEvent?>(null)
    val closed: StateFlow<SessionCloseEvent?> = _closed.asStateFlow()

    private val _hostKeyPrompt = MutableStateFlow<HostKeyPrompt?>(null)
    val hostKeyPrompt: StateFlow<HostKeyPrompt?> = _hostKeyPrompt.asStateFlow()

    private val _networkChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val networkChanged: SharedFlow<Unit> = _networkChanged.asSharedFlow()

    private val _connecting = MutableStateFlow(false)
    val connecting: StateFlow<Boolean> = _connecting.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    init {
        val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
        runCatching {
            connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onLost(network: Network) {
                    if (_active.value != null) _networkChanged.tryEmit(Unit)
                }
            })
        }
    }

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
    ): Result<ULong> = connectMutex.withLock {
        withContext(Dispatchers.Default) {
            _connecting.value = true
            _error.value = null
            _closed.value = null
            _hostKeyPrompt.value = null

            val foregroundResult = runCatching {
                SessionForegroundService.start(appContext, sessions.size.coerceAtLeast(1), connecting = true)
            }
            if (foregroundResult.isFailure) {
                val error = foregroundResult.exceptionOrNull()
                    ?: IllegalStateException("Unable to start session service")
                _connecting.value = false
                _error.value = error.message ?: error.toString()
                return@withContext Result.failure(error)
            }

            val result = runCatching {
                _active.value?.let { prev ->
                    runCatching { zeroTerm.disconnectSession(prev.sessionId) }
                    synchronized(sessionStateLock) {
                        sessions.remove(prev.sessionId)
                        if (_active.value?.sessionId == prev.sessionId) _active.value = null
                    }
                }

                val term = Terminal(cols, rows, 10_000u)
                val pendingClose = AtomicReference<PendingClose?>(null)
                val listener = object : SessionListener {
                    override fun onData(data: ByteArray) {
                        term.feed(data)
                        if (_active.value?.terminal === term) {
                            _frameTick.value = frameGen.incrementAndGet()
                        }
                    }

                    override fun onClosed(exitCode: UInt?, message: String?) {
                        val sid = synchronized(sessionStateLock) {
                            val found = sessions.entries.find { it.value.terminal === term }?.key
                            if (found == null) {
                                pendingClose.compareAndSet(null, PendingClose(exitCode, message))
                            } else {
                                sessions.remove(found)
                                if (_active.value?.sessionId == found) _active.value = null
                            }
                            found
                        }
                        if (sid != null) publishClosed(sid, exitCode, message)
                    }
                }
                val prompt = object : HostKeyPromptCallback {
                    override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
                        _hostKeyPrompt.value = HostKeyPrompt(requestId, info, stored)
                    }
                }
                val sessionId = connect(term, listener, prompt)
                val active = ActiveSession(sessionId, hostId, hostLabel, term)
                val earlyClose = synchronized(sessionStateLock) {
                    sessions[sessionId] = active
                    _active.value = active
                    pendingClose.getAndSet(null)?.also {
                        sessions.remove(sessionId)
                        _active.value = null
                    }
                }
                if (earlyClose != null) {
                    publishClosed(sessionId, earlyClose.exitCode, earlyClose.message)
                } else {
                    _frameTick.value = frameGen.incrementAndGet()
                }
                sessionId
            }

            _connecting.value = false
            result.exceptionOrNull()?.let { e -> _error.value = e.message ?: e.toString() }
            updateFgs()
            result
        }
    }

    fun respondHostKey(requestId: String, accept: Boolean) {
        runCatching { zeroTerm.respondHostKey(requestId, accept) }
        if (_hostKeyPrompt.value?.requestId == requestId) _hostKeyPrompt.value = null
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

    suspend fun execCommand(command: String): Result<HostExecResult> {
        val sid = _active.value?.sessionId
            ?: return Result.failure(IllegalStateException("No active session"))
        return withContext(Dispatchers.Default) {
            runCatching { zeroTerm.execSessionCommand(sid, command) }
        }
    }

    suspend fun resize(cols: UShort, rows: UShort) {
        val session = _active.value ?: return
        session.terminal.resize(cols, rows)
        withContext(Dispatchers.Default) {
            runCatching { zeroTerm.resizeSession(session.sessionId, cols, rows) }
        }
        _frameTick.value = frameGen.incrementAndGet()
    }

    suspend fun disconnect(sessionId: ULong? = null) = connectMutex.withLock {
        val sid = sessionId ?: _active.value?.sessionId ?: return@withLock
        withContext(Dispatchers.Default) { runCatching { zeroTerm.disconnectSession(sid) } }
        synchronized(sessionStateLock) {
            sessions.remove(sid)
            if (_active.value?.sessionId == sid) _active.value = null
        }
        updateFgs()
    }

    suspend fun disconnectAll() = withContext(NonCancellable) {
        connectMutex.withLock {
            val ids = sessions.keys.toList()
            withContext(Dispatchers.Default) {
                ids.forEach { sid -> runCatching { zeroTerm.disconnectSession(sid) } }
            }
            synchronized(sessionStateLock) {
                sessions.clear()
                _active.value = null
            }
            updateFgs()
        }
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

    fun isActiveFor(hostId: String?): Boolean {
        val current = _active.value ?: return false
        return shouldAttachToSession(current.hostId, hostId)
    }

    private fun publishClosed(sessionId: ULong, exitCode: UInt?, message: String?) {
        _closed.value = SessionCloseEvent(
            sessionId = sessionId,
            message = message ?: exitCode?.let { "exit $it" },
        )
        updateFgs()
    }

    private fun updateFgs() {
        val n = sessions.size
        if (n > 0) {
            runCatching { SessionForegroundService.start(appContext, n, connecting = false) }
                .onFailure { _error.value = it.message ?: it.toString() }
        } else {
            SessionForegroundService.stop(appContext)
        }
    }
}

internal fun shouldAttachToSession(activeHostId: String?, targetHostId: String?): Boolean =
    activeHostId != null && (targetHostId == null || activeHostId == targetHostId)
