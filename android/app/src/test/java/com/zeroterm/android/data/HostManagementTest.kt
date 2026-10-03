package com.zeroterm.android.data

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostManagementTest {
    @Test
    fun parsesScopesFailedUnitsAndDescriptionsWithoutSplittingThem() {
        val rows = parseSystemServices("""
            system	nginx.service loaded active running Web server with spaces
            system	● failed.service loaded failed failed Failed worker
            user	worker@one.service loaded activating start 用户任务
            user	bad.socket loaded active running Ignore socket
            unrelated output
        """.trimIndent())
        assertEquals(3, rows.size)
        assertEquals("failed", rows.first { it.name == "failed.service" }.activeState)
        assertEquals("Web server with spaces", rows.first { it.name == "nginx.service" }.description)
        assertEquals("user", rows.first { it.name == "worker@one.service" }.scope)
    }

    @Test
    fun serviceCommandsKeepRemoteNamesLiteralAndPreserveScope() {
        val name = "-name'\$(printf INJECTED);.service"
        val row = SystemService(name, "user", "loaded", "active", "running", "test")
        val dir = Files.createTempDirectory("zt-service-test").toFile()
        try {
            dir.resolve("systemctl").apply { writeText("#!/bin/sh\nprintf '%s\\n' \"\$@\"\n"); setExecutable(true) }
            val process = ProcessBuilder("/bin/sh", "-c", ServiceCommands.action(row, "restart")).apply {
                environment()["PATH"] = "${dir.absolutePath}:/usr/bin:/bin"
            }.start()
            val output = process.inputStream.bufferedReader().readText()
            assertEquals(0, process.waitFor())
            assertEquals(listOf("--user", "--no-ask-password", "--no-pager", "restart", "--", name), output.trimEnd().lines())
            assertTrue(ServiceCommands.logs(row).contains("journalctl --user"))
            assertTrue(ServiceCommands.detail(row).contains("cat --"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnsupportedServiceActions() {
        ServiceCommands.action(SystemService("sshd.service", "system", "loaded", "active", "running", ""), "stop; echo BAD")
    }

    @Test
    fun parsesSsAndMergesDualStackOnlyWhenOwnersMatch() {
        val rows = parseListeningPorts("""
            Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
            tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1210,fd=3))
            tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=1210,fd=4))
            udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=520,fd=13))
            tcp LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:*
            tcp LISTEN 0 4096 [::1]:6379 [::]:*
        """.trimIndent())
        assertEquals(4, rows.size)
        assertEquals(listOf("0.0.0.0", "::"), rows.first().addresses)
        assertEquals(listOf(PortProcess("sshd", 1210)), rows.first().processes)
        assertFalse(rows.first().localOnly)
        assertTrue(rows.first { it.port == 53 }.localOnly)
        assertEquals(2, rows.count { it.port == 6379 && it.processes.isEmpty() })
    }

    @Test
    fun mergesReusePortOwnersAndRejectsEstablishedConnections() {
        val rows = parseListeningPorts("""
            tcp LISTEN 0 511 *:80 *:* users:(("nginx",pid=100,fd=6))
            tcp LISTEN 0 511 *:80 *:* users:(("nginx",pid=101,fd=6))
            tcp ESTAB 0 0 127.0.0.1:8000 127.0.0.1:51234 users:(("curl",pid=200,fd=3))
        """.trimIndent())
        assertEquals(1, rows.size)
        assertEquals(listOf(100L, 101L), rows.single().processes.map { it.pid })
    }

    @Test
    fun parsesNetstatAndUnbracketedIpv6() {
        val rows = parseListeningPorts("""
            tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1210/sshd
            tcp 0 0 10.0.0.5:3306 0.0.0.0:* ESTABLISHED 99/mysqld
            tcp6 0 0 :::80 :::* LISTEN -
            udp 0 0 0.0.0.0:68 0.0.0.0:* 520/dhclient
        """.trimIndent())
        assertEquals(listOf(22, 68, 80), rows.map { it.port })
        assertEquals(listOf("::"), rows.last().addresses)
        assertEquals("dhclient", rows[1].processes.single().name)
    }

    @Test
    fun terminateTargetsOnlyValidatedPositiveProcessIds() {
        assertEquals("kill -TERM 10 20", PortCommands.terminate(listOf(10, 20, 10), false))
        assertEquals("kill -KILL 10", PortCommands.terminate(listOf(10), true))
        listOf(emptyList<Long>(), listOf(0L), listOf(1L), listOf(-10L), listOf(Long.MAX_VALUE)).forEach { invalid ->
            assertTrue(runCatching { PortCommands.terminate(invalid, false) }.isFailure)
        }
    }
}
