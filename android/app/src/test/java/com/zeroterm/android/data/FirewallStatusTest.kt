package com.zeroterm.android.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FirewallStatusTest {
    @Test
    fun prefersActiveManagerAndOnlyItsRules() {
        val status = parseFirewallStatus("""
            firewalld|inactive|unknown|
            nftables|active|unknown|
            ufw|active|block|
            R|nftables|allow|tcp dport 22 accept
            R|ufw|allow|[ 1] 22/tcp ALLOW IN Anywhere
            R|ufw|block|[ 2] 3306/tcp DENY IN Anywhere
        """.trimIndent())
        assertEquals("active", status.status)
        assertEquals("UFW", status.backend)
        assertEquals("block", status.inboundPolicy)
        assertEquals(listOf("allow", "block"), status.rules.map { it.action })
        assertEquals(2, status.rules.size)
        assertFalse(status.rulesTruncated)
    }

    @Test
    fun permissionFailuresAndMalformedResponsesNeverMeanInactive() {
        val unknown = parseFirewallStatus("ufw|inactive|unknown|\nnftables|unknown|garbage|")
        assertEquals("unknown", unknown.status)
        assertEquals("nftables", unknown.backend)
        assertEquals("unknown", unknown.inboundPolicy)
        assertEquals("unavailable", parseFirewallStatus("none|unavailable|unknown|").status)
        listOf("", "permission denied", "made-up|active|allow|", "ufw|bad-status|block|").forEach {
            assertEquals("unknown", parseFirewallStatus(it).status)
        }
    }

    @Test
    fun rulesPreservePipesNormalizeWhitespaceAndHaveDisplayLimits() {
        val output = buildString {
            append("ufw|active|block|\n")
            append("R|ufw|other|  rule   0 | tcp drop  \n")
            repeat(100) { append("R|ufw|allow|${"x".repeat(600)}\n") }
        }
        val status = parseFirewallStatus(output)
        assertEquals(100, status.rules.size)
        assertTrue(status.rulesTruncated)
        assertEquals("rule 0 | tcp drop", status.rules.first().text)
        assertEquals("block", status.rules.first().action)
        assertEquals(512, status.rules.last().text.length)
    }

    @Test
    fun detectorHasValidShellSyntaxAndOnlyReadsFirewallSettings() {
        val script = File("src/main/res/raw/firewall_status.sh").absoluteFile
        assertTrue(script.isFile)
        val syntax = ProcessBuilder("/bin/sh", "-n", script.path).start()
        assertEquals(syntax.errorStream.bufferedReader().readText(), 0, syntax.waitFor())
        val dir = Files.createTempDirectory("zt-firewall-test").toFile()
        try {
            fun stub(name: String, body: String) {
                dir.resolve(name).apply { writeText("#!/bin/sh\n$body\n"); setExecutable(true) }
            }
            stub("firewall-cmd", "exit 1")
            stub("systemctl", "exit 1")
            stub("nft", "exit 0")
            stub("iptables", "printf '%s\\n' '-P INPUT ACCEPT'")
            stub("ufw", """
                printf '%s\n' "${'$'}*" >> "${'$'}ZT_CALLS"
                case "${'$'}*" in
                  'status verbose') printf '%s\n' 'Status: active' 'Default: deny (incoming), allow (outgoing)';;
                  'status numbered') printf '%s\n' '[ 1] 22/tcp ALLOW IN Anywhere';;
                  *) exit 99;;
                esac
            """.trimIndent())
            fun detect(): FirewallStatus {
                val process = ProcessBuilder("/bin/sh", script.path).apply {
                    environment()["PATH"] = "${dir.absolutePath}:/usr/bin:/bin"
                    environment()["ZT_CALLS"] = dir.resolve("calls").absolutePath
                }.start()
                val output = process.inputStream.bufferedReader().readText()
                assertEquals(process.errorStream.bufferedReader().readText(), 0, process.waitFor())
                return parseFirewallStatus(output)
            }
            val active = detect()
            assertEquals("active", active.status)
            assertEquals("block", active.inboundPolicy)
            assertEquals("allow", active.rules.single().action)
            assertEquals(listOf("status verbose", "status numbered"), dir.resolve("calls").readLines())

            stub("ufw", "printf '%s\\n' 'ERROR: You need to be root' >&2; exit 1")
            val unreadable = detect()
            assertEquals("unknown", unreadable.status)
            assertEquals("UFW", unreadable.backend)
            assertTrue(unreadable.rules.isEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }
}
