package com.zeroterm.android.data

import androidx.test.platform.app.InstrumentationRegistry
import com.zeroterm.ffi.HostAuthInput
import com.zeroterm.ffi.HostKeyInfo
import com.zeroterm.ffi.HostKeyPromptCallback
import com.zeroterm.ffi.SessionListener
import com.zeroterm.ffi.TransferListener
import com.zeroterm.ffi.TransferProgress
import com.zeroterm.ffi.ZeroTerm
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Optional live smoke test; only uses an explicitly supplied disposable server. */
class LiveSessionSftpTest {
    @Test
    fun quickConnectTransfersFilesAndClosingSftpPreservesTerminal() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Supply disposable SSH fixture arguments", args.containsKey("ssh_test_port"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = Files.createTempDirectory(context.cacheDir.toPath(), "session-sftp-").toFile()
        val ffi = ZeroTerm()
        var sessionId: ULong? = null
        var sftpId: ULong? = null
        val closed = CompletableDeferred<Unit>()
        val ptyAlive = CompletableDeferred<Unit>()
        val received = StringBuilder()
        try {
            ffi.setDataDir(dir.absolutePath)
            ffi.create("disposable-test-vault", false)
            val listener = object : SessionListener {
                override fun onData(data: ByteArray) {
                    synchronized(received) {
                        received.append(data.toString(Charsets.UTF_8))
                        if (received.contains("SFTP_PTY_ALIVE")) ptyAlive.complete(Unit)
                    }
                }
                override fun onClosed(exitCode: UInt?, message: String?) { closed.complete(Unit) }
            }
            val prompt = object : HostKeyPromptCallback {
                override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
                    ffi.respondHostKey(requestId, info.fingerprint == args.getString("ssh_test_fingerprint"))
                }
            }
            withTimeout(20_000) {
                val connected = ffi.connectDirect(
                    "127.0.0.1", args.getString("ssh_test_port")!!.toUShort(),
                    args.getString("ssh_test_user")!!,
                    HostAuthInput.PrivateKey(File(context.cacheDir, "zt-sidebar-test-key").readText(), null),
                    80u, 24u, listener, prompt,
                )
                sessionId = connected
                val channel = ffi.sftpOpenSession(connected)
                sftpId = channel
                val remote = args.getString("ssh_test_directory")!!
                ffi.sftpMkdir(channel, "$remote/from_phone")
                ffi.sftpRename(channel, "$remote/from_phone", "$remote/renamed")
                assertTrue(ffi.sftpList(channel, remote).any { it.name == "renamed" })
                ffi.sftpRemoveDir(channel, "$remote/renamed")
                val uploaded = File(dir, "upload.txt").apply { writeText("中文 SFTP transfer test") }
                val transfer = object : TransferListener { override fun onTransfer(event: TransferProgress) {} }
                ffi.sftpUpload(channel, uploaded.absolutePath, "$remote/payload.txt", true, transfer)
                val downloaded = File(dir, "download.txt")
                ffi.sftpDownload(channel, "$remote/payload.txt", downloaded.absolutePath, true, transfer)
                assertEquals(uploaded.readText(), downloaded.readText())
                ffi.sftpRemove(channel, "$remote/payload.txt")
                ffi.sftpClose(channel)
                sftpId = null
                assertEquals("EXEC_ALIVE", ffi.execSessionCommand(connected, "printf EXEC_ALIVE").stdout)
                ffi.sendInput(connected, "printf 'SFTP_%s\\n' 'PTY_ALIVE'\r".toByteArray())
                ptyAlive.await()
            }
        } finally {
            sftpId?.let { runCatching { ffi.sftpClose(it) } }
            sessionId?.let { runCatching { ffi.disconnectSession(it); withTimeout(3_000) { closed.await() } } }
            ffi.destroy()
            dir.deleteRecursively()
        }
    }
}
