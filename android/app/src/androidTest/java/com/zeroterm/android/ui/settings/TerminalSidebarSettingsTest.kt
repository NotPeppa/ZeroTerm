package com.zeroterm.android.ui.settings

import android.graphics.Bitmap
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.zeroterm.android.data.TerminalSidebarFeature
import com.zeroterm.android.ui.terminal.labelResource
import com.zeroterm.android.ui.theme.ZeroTermTheme
import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class TerminalSidebarSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val hidden = mutableStateOf(emptySet<String>())
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun keepFixtureVisible() {
        // Only public fixture labels are shown by this test Activity; keep it
        // visible on physical devices without changing lock/security settings.
        compose.activityRule.scenario.onActivity {
            it.setShowWhenLocked(true)
            it.setTurnScreenOn(true)
            it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun show(fontScale: Float = 1f) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                ZeroTermTheme(darkTheme = true) {
                    Surface {
                        Column(Modifier.widthIn(max = if (fontScale > 1f) 320.dp else 420.dp).fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()).testTag("sidebar-settings")) {
                            TerminalSidebarSettings(hidden.value) { feature, enabled ->
                                hidden.value = if (enabled) hidden.value - feature.id else hidden.value + feature.id
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    fun allNineSwitchesAreLabeledAndTappingLabelChangesOnlyThatFeature() {
        show()
        TerminalSidebarFeature.entries.forEach { feature ->
            compose.onNodeWithText(context.getString(feature.labelResource())).performScrollTo().assertIsOn()
        }
        val ai = compose.onNodeWithText(context.getString(TerminalSidebarFeature.Ai.labelResource()))
        ai.performScrollTo().performClick().assertIsOff()
        compose.onNodeWithText(context.getString(TerminalSidebarFeature.Tmux.labelResource())).performScrollTo().assertIsOn()
        ai.performScrollTo().performClick().assertIsOn()
        compose.onNodeWithTag("sidebar-settings").captureToImage().asAndroidBitmap().let { bitmap ->
            val target = File(context.filesDir, "sidebar-settings-tests/default.png")
            target.parentFile!!.mkdirs()
            target.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test
    fun narrowScreenAndLargeFontDoNotClipLabels() {
        show(fontScale = 1.6f)
        TerminalSidebarFeature.entries.forEach { feature ->
            val label = context.getString(feature.labelResource())
            compose.onNodeWithText(label).performScrollTo()
            val results = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(label, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
            results.forEach { assertFalse("Clipped: $label", it.hasVisualOverflow) }
        }
    }
}
