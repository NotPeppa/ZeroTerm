package com.zeroterm.android.data

import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import com.zeroterm.android.BuildConfig
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class AutoSyncUiState {
    Off,
    Unconfigured,
    Idle,
    Syncing,
    Ok,
    Error,
}

data class AutoSyncSnapshot(
    val state: AutoSyncUiState = AutoSyncUiState.Unconfigured,
    val autoSyncEnabled: Boolean = true,
    val profileCount: Int = 0,
    val consecutiveFailures: Int = 0,
    val lastSuccessAtMs: Long? = null,
    val lastError: String? = null,
)

/**
 * Foreground auto-sync (RFC-003 M6/M7): while the vault is unlocked and
 * the process is in the foreground, periodically call [ZeroTerm.syncNow]
 * for every saved profile.
 */
class AutoSyncController(
    private val zeroTerm: ZeroTerm,
    private val repository: ZeroTermRepository,
    private val settings: AppSettings,
) : DefaultLifecycleObserver {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loopJob: Job? = null
    private val foreground = MutableStateFlow(true)

    private val _snapshot = MutableStateFlow(AutoSyncSnapshot())
    val snapshot: StateFlow<AutoSyncSnapshot> = _snapshot.asStateFlow()

    private var lastSuccessAtMs: Long? = null
    private var lastError: String? = null
    private var consecutiveFailures: Int = 0
    private var profileCount: Int = 0
    private var inFlight: Boolean = false
    private var autoSyncEnabled: Boolean = true

    fun start() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        scope.launch {
            combine(
                repository.unlocked,
                settings.flow,
                foreground,
            ) { unlocked, snap, fg ->
                Triple(unlocked, snap, fg)
            }.collectLatest { (unlocked, snap, fg) ->
                autoSyncEnabled = snap.autoSync
                if (unlocked) {
                    refreshProfileCount()
                } else {
                    profileCount = 0
                }
                publish()
                val loopEnabled = unlocked && snap.autoSync && fg
                if (loopEnabled) {
                    runOnce()
                }
                restartLoop(loopEnabled, snap.autoSyncIntervalMin)
            }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        foreground.value = true
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground.value = false
    }

    private fun restartLoop(enabled: Boolean, intervalMin: Int) {
        loopJob?.cancel()
        if (!enabled) {
            loopJob = null
            return
        }
        val intervalMs = intervalMin.coerceIn(5, 120) * 60_000L
        loopJob = scope.launch {
            delay(intervalMs)
            while (isActive) {
                if (foreground.value && repository.unlocked.value) {
                    runOnce()
                }
                delay(intervalMs)
            }
        }
    }

    private suspend fun refreshProfileCount() {
        runCatching {
            profileCount = zeroTerm.listSyncProfiles().size
        }
    }

    private suspend fun runOnce() {
        withContext(Dispatchers.Default) {
            inFlight = true
            publish()
            runCatching {
                val profiles = zeroTerm.listSyncProfiles()
                profileCount = profiles.size
                var anyFailure = false
                var lastFail: String? = null
                for (p in profiles) {
                    runCatching {
                        zeroTerm.syncNow(p.id)
                        // AND-6: profile names/errors are user data; keep them
                        // out of release Logcat.
                        if (BuildConfig.DEBUG) Log.d(TAG, "auto-sync ok: ${p.name}")
                    }.onFailure { e ->
                        anyFailure = true
                        lastFail = e.message
                        if (BuildConfig.DEBUG) {
                            Log.w(TAG, "auto-sync failed for ${p.name}: ${e.message}")
                        }
                    }
                }
                if (profiles.isEmpty()) {
                    consecutiveFailures = 0
                    lastError = null
                } else if (anyFailure) {
                    consecutiveFailures += 1
                    lastError = lastFail
                } else {
                    consecutiveFailures = 0
                    lastError = null
                    lastSuccessAtMs = System.currentTimeMillis()
                }
            }.onFailure { e ->
                consecutiveFailures += 1
                lastError = e.message
                if (BuildConfig.DEBUG) Log.w(TAG, "auto-sync list failed: ${e.message}")
            }
            inFlight = false
            publish()
        }
    }

    private fun publish() {
        val state = when {
            !autoSyncEnabled -> AutoSyncUiState.Off
            profileCount <= 0 -> AutoSyncUiState.Unconfigured
            inFlight -> AutoSyncUiState.Syncing
            consecutiveFailures > 0 -> AutoSyncUiState.Error
            lastSuccessAtMs != null -> AutoSyncUiState.Ok
            else -> AutoSyncUiState.Idle
        }
        _snapshot.value = AutoSyncSnapshot(
            state = state,
            autoSyncEnabled = autoSyncEnabled,
            profileCount = profileCount,
            consecutiveFailures = consecutiveFailures,
            lastSuccessAtMs = lastSuccessAtMs,
            lastError = lastError,
        )
    }

    companion object {
        private const val TAG = "ZeroTermAutoSync"
    }
}
