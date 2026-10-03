package com.zeroterm.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalSidebarFeatureTest {
    @Test
    fun legacyAndUnknownPreferencesKeepFeaturesEnabled() {
        assertEquals(TerminalSidebarFeature.entries, enabledTerminalSidebarFeatures(emptySet()))
        assertEquals(TerminalSidebarFeature.entries, enabledTerminalSidebarFeatures(setOf("future_feature")))
    }

    @Test
    fun hidingCurrentFeatureSelectsNextEnabledPageAndKeepsOtherSelection() {
        val enabled = enabledTerminalSidebarFeatures(setOf("snippets", "ai"))
        assertFalse(TerminalSidebarFeature.Ai in enabled)
        assertEquals(TerminalSidebarFeature.Metrics, resolveTerminalSidebarFeature(TerminalSidebarFeature.Ai, enabled))
        assertEquals(TerminalSidebarFeature.Tmux, resolveTerminalSidebarFeature(TerminalSidebarFeature.Tmux, enabled))
    }

    @Test
    fun allDisabledLeavesNoPageToOpen() {
        val enabled = enabledTerminalSidebarFeatures(TerminalSidebarFeature.entries.map { it.id }.toSet())
        assertEquals(emptyList<TerminalSidebarFeature>(), enabled)
        assertNull(resolveTerminalSidebarFeature(TerminalSidebarFeature.Snippets, enabled))
    }
}
