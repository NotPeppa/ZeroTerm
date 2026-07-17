package com.zeroterm.android

import android.app.Application
import com.zeroterm.android.data.AppContainer

class ZeroTermApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        System.loadLibrary("zeroterm_ffi")
        container = AppContainer(this)
        container.autoSync.start()
    }
}
