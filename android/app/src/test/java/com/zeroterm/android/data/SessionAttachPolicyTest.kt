package com.zeroterm.android.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAttachPolicyTest {
    @Test
    fun recreationOfSameHostAttachesExistingSession() {
        assertTrue(shouldAttachToSession(activeHostId = "host-1", targetHostId = "host-1"))
    }

    @Test
    fun navigatingToDifferentHostDoesNotAttachExistingSession() {
        assertFalse(shouldAttachToSession(activeHostId = "host-1", targetHostId = "host-2"))
    }

    @Test
    fun directTerminalRouteAttachesCurrentSession() {
        assertTrue(shouldAttachToSession(activeHostId = "direct", targetHostId = null))
    }

    @Test
    fun missingActiveSessionNeverAttaches() {
        assertFalse(shouldAttachToSession(activeHostId = null, targetHostId = "host-1"))
    }
}
