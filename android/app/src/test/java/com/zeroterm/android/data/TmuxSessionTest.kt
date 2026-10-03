package com.zeroterm.android.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class TmuxSessionTest {
    private val commands = TmuxCommands("@zeroterm_android_test")
    private val session = TmuxSession("\$12", "work", 2, 1)

    @Test
    fun parsesMissingAndEmptyServers() {
        assertEquals(TmuxState(), parseTmuxState("M\n"))
        assertEquals(TmuxState(version = "3.4"), parseTmuxState("V\ttmux 3.4\n"))
    }

    @Test
    fun preservesNamesAndMatchesOnlyTheRecordedClient() {
        val state = parseTmuxState(
            "V\ttmux 3.4\nS\t\$12\t2\t2\t工作 | 'project'\n" +
                "O\t/dev/pts/4|42|123\n" +
                "C\t/dev/pts/3\t41\t122\t\$12\nC\t/dev/pts/4\t42\t123\t\$12\n",
        )
        assertEquals("工作 | 'project'", state.sessions.single().name)
        assertEquals(2, state.sessions.single().attachedClients)
        assertEquals("/dev/pts/4", state.currentClient?.name)
    }

    @Test
    fun reusedTtyDoesNotMatchStaleMarker() {
        assertNull(parseTmuxState(
            "V\ttmux 3.4\nO\t/dev/pts/4|42|123\nC\t/dev/pts/4\t99\t124\t\$12\n",
        ).currentClient)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsOutputWithoutVersionInsteadOfClaimingTmuxIsMissing() {
        parseTmuxState("Permission denied\n")
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsMalformedSessionRows() {
        parseTmuxState("V\ttmux 3.4\nS\twork\tbad\t0\tname\n")
    }

    @Test
    fun validatesNamesBeforeSendingCommands() {
        assertTrue(validTmuxName("工作 'name' $;|"))
        listOf("", "   ", "a.b", "a:b", "a\nb", "a\rb", "a\u0000b", "a\tb").forEach {
            assertFalse(it, validTmuxName(it))
        }
    }

    @Test
    fun shellMetacharactersArePassedAsOneLiteralArgument() {
        val name = "工作 'x' \$(printf INJECTED) `printf WRONG`; | &"
        withTmuxStub("printf '%s\\n' \"\$@\"") { path ->
            val result = shell(commands.rename(session, name), path)
            assertEquals(0, result.first)
            assertEquals(listOf("rename-session", "-t", "\$12", "--", name), result.second.trimEnd().lines())
        }
    }

    @Test
    fun trailingSemicolonIsEscapedForTmuxAndLeadingDashEndsOptionParsing() {
        withTmuxStub("printf '%s\\n' \"\$@\"") { path ->
            val result = shell(commands.rename(session, "-literal;"), path)
            assertEquals(0, result.first)
            assertEquals(listOf("rename-session", "-t", "\$12", "--", "-literal\\;"), result.second.trimEnd().lines())
        }
    }

    @Test
    fun detachAndSwitchTargetOneClientAndStableSessionId() {
        val client = TmuxClient("/dev/pts/4", 42, 123, "\$12")
        withTmuxStub("printf '%s\\n' \"\$@\"") { path ->
            assertEquals("detach-client\n-t\n/dev/pts/4\n", shell(commands.detach(client), path).second)
            assertEquals("switch-client\n-c\n/dev/pts/4\n-t\n\$12\n", shell(commands.enter(session, client), path).second)
        }
    }

    @Test
    fun attachRecordsClientContextAndCleansItUpAfterExit() {
        withTmuxStub("printf '%s\\n' \"\$@\" >> \"\$(dirname \"\$0\")/args\"; printf '[detached]\\n'") { path ->
            val prepared = shell(commands.prepareAttach(session), path)
            assertEquals(0, prepared.first)
            val script = prepared.second.trim()
            try {
                val launcher = commands.attach(script)
                assertTrue(launcher.length < 40)
                assertFalse(launcher.contains("set-option"))
                assertFalse(launcher.contains("@zeroterm"))
                val result = shell(launcher.trimEnd('\r'), path)
                assertEquals(0, result.first)
                assertEquals("", result.second)
                assertFalse(File(script).exists())
            } finally {
                File(script).delete()
            }
            val args = File(path, "args").readLines()
            assertEquals("-u", args[0])
            assertEquals("attach-session", args[1])
            assertEquals("\$12", args[3])
            assertEquals(";", args[4])
            assertEquals("#{client_name}|#{client_pid}|#{client_created}", args[8])
            assertEquals(listOf("set-option", "-gu", "@zeroterm_android_test"), args.slice(9..11))
        }
    }

    @Test
    fun failedAttachKeepsErrorAndExitCodeAndRemovesLauncher() {
        withTmuxStub("if [ \"\$1\" = '-u' ]; then printf 'attach failed\\n' >&2; exit 7; fi") { path ->
            val script = shell(commands.prepareAttach(session), path).second.trim()
            try {
                val result = shell(commands.attach(script).trimEnd('\r'), path)
                assertEquals(7, result.first)
                assertEquals("attach failed\n", result.second)
                assertFalse(File(script).exists())
            } finally {
                File(script).delete()
            }
        }
    }

    @Test
    fun abandonedLaunchersCanBeRemovedAndEachPreparationIsUnique() {
        withTmuxStub("exit 0") { path ->
            val first = shell(commands.prepareAttach(session), path).second.trim()
            val second = shell(commands.prepareAttach(session), path).second.trim()
            try {
                assertFalse(first == second)
                assertTrue(File(first).exists())
                assertTrue(File(second).exists())
                assertEquals(0, shell(commands.discardAttach(first), path).first)
                assertFalse(File(first).exists())
                assertTrue(File(second).exists())
            } finally {
                File(first).delete()
                File(second).delete()
            }
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUntrustedLauncherPaths() {
        commands.attach("/tmp/zt.abcdefghij'; printf INJECTED; '")
    }

    @Test
    fun noServerIsEmptyButPermissionFailureIsAnError() {
        listOf("no server running on /tmp/tmux-501/default" to 0, "permission denied" to 1).forEach { (message, code) ->
            withTmuxStub("""
                if [ "${'$'}1" = '-V' ]; then printf 'tmux 3.4\n'; exit 0; fi
                printf '%s\n' '$message' >&2
                exit 1
            """.trimIndent()) { path ->
                val result = shell(commands.list, path)
                assertEquals(message, code, result.first)
                if (code == 0) assertTrue(parseTmuxState(result.second).sessions.isEmpty())
            }
        }
    }

    private fun shell(command: String, path: String): Pair<Int, String> {
        val process = ProcessBuilder("/bin/sh", "-c", command).redirectErrorStream(true).apply {
            environment()["PATH"] = "$path:/usr/bin:/bin"
        }.start()
        val output = process.inputStream.bufferedReader().readText()
        return process.waitFor() to output
    }

    private fun withTmuxStub(script: String, block: (String) -> Unit) {
        assumeTrue("Shell quoting tests require a POSIX shell", File("/bin/sh").canExecute())
        val dir = Files.createTempDirectory("zeroterm-tmux-test").toFile()
        try {
            dir.resolve("tmux").apply { writeText("#!/bin/sh\n$script\n"); setExecutable(true) }
            block(dir.absolutePath)
        } finally {
            dir.deleteRecursively()
        }
    }
}
