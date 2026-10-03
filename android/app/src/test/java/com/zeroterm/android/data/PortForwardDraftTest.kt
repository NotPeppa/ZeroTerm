package com.zeroterm.android.data

import com.zeroterm.ffi.ForwardKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PortForwardDraftTest {
    private val draft = PortForwardDraft(null, "fixture", ForwardKind.LOCAL, "127.0.0.1", "8080", "db.internal", "5432")

    @Test
    fun validatesPortsBeforeConvertingToUnsignedValues() {
        listOf("0", "65536", "-1", "", "1.5", "99999999999").forEach {
            assertEquals(ForwardFormProblem.BindPort, draft.copy(bindPort = it).problem())
            assertEquals(ForwardFormProblem.TargetPort, draft.copy(targetPort = it).problem())
        }
        assertNull(draft.copy(bindPort = "65535", targetPort = "1").problem())
        assertEquals(65535u.toUShort(), draft.copy(bindPort = "65535").input().bindPort)
    }

    @Test
    fun dynamicRequestsDoNotCarryHiddenTargetsFromAnotherType() {
        val input = draft.copy(kind = ForwardKind.DYNAMIC, targetAddress = "", targetPort = "bad").input()
        assertEquals("", input.targetHost)
        assertEquals(0u.toUShort(), input.targetPort)
        assertEquals(ForwardKind.DYNAMIC, input.kind)
    }

    @Test
    fun retainsRuleIdentityAndRemoteDirectionAndTrimsAddresses() {
        val input = draft.copy(id = "rule", kind = ForwardKind.REMOTE, bindAddress = " 0.0.0.0 ", targetAddress = " ::1 ", enabled = false).input()
        assertEquals("rule", input.id)
        assertEquals("fixture", input.hostId)
        assertEquals(ForwardKind.REMOTE, input.kind)
        assertEquals("0.0.0.0", input.bindAddr)
        assertEquals("::1", input.targetHost)
        assertEquals(false, input.enabled)
    }

    @Test
    fun rejectsMissingHostsAndInvalidAddressesAndFormatsIpv6Endpoints() {
        assertEquals(ForwardFormProblem.Host, draft.copy(hostId = "").problem())
        assertEquals(ForwardFormProblem.BindAddress, draft.copy(bindAddress = "bad host").problem())
        assertEquals(ForwardFormProblem.TargetAddress, draft.copy(targetAddress = "bad\nhost").problem())
        assertEquals("[::1]:8080", forwardEndpoint("::1", 8080u.toUShort()))
        assertEquals("[::1]:8080", forwardEndpoint("[::1]", 8080u.toUShort()))
    }
}
