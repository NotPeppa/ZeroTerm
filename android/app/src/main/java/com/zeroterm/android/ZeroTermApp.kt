package com.zeroterm.android

import android.app.Application
import com.zeroterm.android.data.AppContainer
import com.zeroterm.android.data.AppLocale
import com.zeroterm.android.data.AppSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class ZeroTermApp : Application() {
    lateinit var container: AppContainer
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        System.loadLibrary("zeroterm_ffi")
        container = AppContainer(this)
        appScope.launch {
            val snapshot = runCatching { container.settings.flow.first() }.getOrNull()
            AppSettings.applyLocale(snapshot?.locale ?: AppLocale.System)
            val proxy = snapshot?.takeIf { it.proxyEnabled }?.proxyUrl.orEmpty()
            runCatching { container.zeroTerm.setNetworkProxy(proxy) }
        }
        container.autoSync.start()
    }
}
