package com.zeroterm.android.data

import androidx.test.platform.app.InstrumentationRegistry
import com.zeroterm.ffi.FfiException
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TerminalSidebarPreferencesTest {
    @Test
    fun simultaneousChangesPersistAcrossSettingsInstances() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = AppSettings(context)
        val original = settings.flow.first().hiddenTerminalSidebarFeatures
        val features = listOf(TerminalSidebarFeature.Ai, TerminalSidebarFeature.Tmux)
        try {
            coroutineScope { features.forEach { feature -> launch { settings.setTerminalSidebarFeature(feature, false) } } }
            val restored = AppSettings(context).flow.first().hiddenTerminalSidebarFeatures
            features.forEach { assertTrue(it.id in restored) }
            settings.setTerminalSidebarFeature(TerminalSidebarFeature.Ai, true)
            val updated = settings.flow.first().hiddenTerminalSidebarFeatures
            assertFalse(TerminalSidebarFeature.Ai.id in updated)
            assertTrue(TerminalSidebarFeature.Tmux.id in updated)
        } finally {
            features.forEach { settings.setTerminalSidebarFeature(it, it.id !in original) }
        }
    }

    @Test
    fun sessionSftpRejectsMissingTransportWithMatchingNativeBindings() = runBlocking {
        val ffi = ZeroTerm()
        try {
            try {
                ffi.sftpOpenSession(ULong.MAX_VALUE)
                fail("Missing transport must not open SFTP")
            } catch (e: FfiException.NotFound) {
                assertTrue(e.detail.contains("session"))
            }
        } finally {
            ffi.destroy()
        }
    }
}
