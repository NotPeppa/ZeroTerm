package com.zeroterm.android.data

import android.content.Context
import com.zeroterm.android.data.biometric.MasterPasswordStore
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * Hand-rolled DI root (RFC-003: no Hilt in v1).
 * Owns the long-lived FFI [ZeroTerm] instance and platform helpers.
 */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val zeroTerm: ZeroTerm = ZeroTerm().also { zt ->
        val dataDir = appContext.filesDir.absolutePath
        zt.setDataDir(dataDir)
        // Explicit vault path matches RFC-003 §6.1
        zt.setVaultPath("$dataDir/zeroterm.vault")
    }

    val passwordStore = MasterPasswordStore(appContext)

    val settings = AppSettings(appContext)

    val repository = ZeroTermRepository(
        zeroTerm = zeroTerm,
        passwordStore = passwordStore,
        appContext = appContext,
    )

    val sessions = SessionManager(
        zeroTerm = zeroTerm,
        appContext = appContext,
    )

    val sftp = SftpManager(
        zeroTerm = zeroTerm,
        appContext = appContext,
    )

    val autoSync = AutoSyncController(
        zeroTerm = zeroTerm,
        repository = repository,
        settings = settings,
    )

    private val openActiveSessionChannel = Channel<Unit>(Channel.CONFLATED)
    val openActiveSessionRequests = openActiveSessionChannel.receiveAsFlow()

    fun requestOpenActiveSession() {
        openActiveSessionChannel.trySend(Unit)
    }
}
