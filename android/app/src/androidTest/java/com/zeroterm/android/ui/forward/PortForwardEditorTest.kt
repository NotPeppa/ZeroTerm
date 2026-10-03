package com.zeroterm.android.ui.forward

import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.platform.app.InstrumentationRegistry
import com.zeroterm.android.R
import com.zeroterm.android.ui.theme.ZeroTermTheme
import com.zeroterm.ffi.AuthKind
import com.zeroterm.ffi.ForwardKind
import com.zeroterm.ffi.HostSummary
import com.zeroterm.ffi.PortForwardInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class PortForwardEditorTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private var saved: PortForwardInput? = null
    private fun label(resource: Int) = context.getString(resource)

    @Before
    fun showFixtureOnDevice() {
        compose.activityRule.scenario.onActivity {
            it.setShowWhenLocked(true)
            it.setTurnScreenOn(true)
            it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun show(withHost: Boolean = true) {
        val hosts = if (withHost) listOf(HostSummary("fixture", "Test host", "127.0.0.1", 22u.toUShort(), "fixture", AuthKind.PASSWORD, null)) else emptyList()
        compose.setContent { ZeroTermTheme(darkTheme = true) { ForwardEditor(null, hosts, false, onDismiss = {}, onSave = { saved = it }) } }
    }

    @Test
    fun dynamicHidesTargetsAndSavesWithoutThem() {
        show()
        compose.onNodeWithText(label(R.string.port_forward_kind_dynamic)).performScrollTo().performClick()
        compose.onNodeWithText(label(R.string.port_forward_target_port)).assertDoesNotExist()
        compose.onNodeWithText(label(R.string.common_save)).performClick()
        compose.runOnIdle {
            assertEquals(ForwardKind.DYNAMIC, saved!!.kind)
            assertEquals("", saved!!.targetHost)
            assertEquals(0u.toUShort(), saved!!.targetPort)
        }
    }

    @Test
    fun remoteLabelsUsePhoneAsTargetAndInvalidPortsCannotSave() {
        show()
        compose.onNodeWithText(label(R.string.port_forward_kind_remote)).performScrollTo().performClick()
        compose.onNodeWithText(label(R.string.port_forward_target_local)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(label(R.string.port_forward_bind_port)).performScrollTo().performTextReplacement("65536")
        compose.onNodeWithText(label(R.string.common_save)).performClick()
        compose.onNodeWithText(label(R.string.port_forward_invalid_bind_port)).performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertNull(saved) }
    }

    @Test
    fun missingHostDisablesSave() {
        show(withHost = false)
        compose.onNodeWithText(label(R.string.common_save)).assertIsNotEnabled()
        compose.onNodeWithText(label(R.string.port_forward_no_hosts)).assertIsDisplayed()
    }
}
