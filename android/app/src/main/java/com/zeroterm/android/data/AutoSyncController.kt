package com.zeroterm.android.data

import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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

    fun start() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        scope.launch {
            combine(
                repository.unlocked,
                settings.flow,
                foreground,
            ) { unlocked, snap, fg ->
                Triple(unlocked && snap.autoSync && fg, snap.autoSyncIntervalMin, unlocked && fg)
            }.collectLatest { (loopEnabled, intervalMin, kickNow) ->
                if (kickNow && loopEnabled) {
                    runOnce()
                }
                restartLoop(loopEnabled, intervalMin)
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

    private suspend fun runOnce() {
        withContext(Dispatchers.Default) {
            runCatching {
                val profiles = zeroTerm.listSyncProfiles()
                for (p in profiles) {
                    runCatching {
                        zeroTerm.syncNow(p.id)
                        Log.d(TAG, "auto-sync ok: ${p.name}")
                    }.onFailure { e ->
                        Log.w(TAG, "auto-sync failed for ${p.name}: ${e.message}")
                    }
                }
            }.onFailure { e ->
                Log.w(TAG, "auto-sync list failed: ${e.message}")
            }
        }
    }

    companion object {
        private const val TAG = "ZeroTermAutoSync"
    }
}
