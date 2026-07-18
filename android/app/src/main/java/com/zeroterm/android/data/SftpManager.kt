package com.zeroterm.android.data

import android.content.Context
import com.zeroterm.ffi.HostKeyInfo
import com.zeroterm.ffi.HostKeyPromptCallback
import com.zeroterm.ffi.SftpDirEntry
import com.zeroterm.ffi.TransferListener
import com.zeroterm.ffi.TransferProgress
import com.zeroterm.ffi.ZeroTerm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Thin wrapper around FFI SFTP methods. One active channel at a time for M4.
 */
class SftpManager(
    private val zeroTerm: ZeroTerm,
    private val appContext: Context,
) {
    private var sftpId: ULong? = null
    private var currentHostId: String? = null

    private val _path = MutableStateFlow("/")
    val path: StateFlow<String> = _path.asStateFlow()

    private val _entries = MutableStateFlow<List<SftpDirEntry>>(emptyList())
    val entries: StateFlow<List<SftpDirEntry>> = _entries.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _progress = MutableStateFlow<TransferProgress?>(null)
    val progress: StateFlow<TransferProgress?> = _progress.asStateFlow()

    private val _hostKeyPrompts = MutableSharedFlow<HostKeyPrompt>(extraBufferCapacity = 4)
    val hostKeyPrompts: SharedFlow<HostKeyPrompt> = _hostKeyPrompts.asSharedFlow()

    fun isOpen(): Boolean = sftpId != null
    fun isOpenFor(hostId: String): Boolean = sftpId != null && currentHostId == hostId

    fun cacheDir(): File {
        val dir = File(appContext.cacheDir, "sftp")
        dir.mkdirs()
        return dir
    }

    suspend fun open(hostId: String): Result<Unit> = withContext(Dispatchers.Default) {
        _busy.value = true
        _error.value = null
        runCatching {
            sftpId?.let { id -> runCatching { zeroTerm.sftpClose(id) } }
            sftpId = null
            currentHostId = null
            val prompt = object : HostKeyPromptCallback {
                override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
                    _hostKeyPrompts.tryEmit(HostKeyPrompt(requestId, info, stored))
                }
            }
            val id = zeroTerm.sftpOpen(hostId, prompt)
            sftpId = id
            currentHostId = hostId
            _path.value = "/"
            val entries = zeroTerm.sftpList(id, "/")
            _entries.value = entries
        }.mapFfi().also {
            _busy.value = false
            it.exceptionOrNull()?.let { e -> _error.value = e.message }
        }.map { }
    }

    suspend fun close() = withContext(Dispatchers.Default) {
        sftpId?.let { id -> runCatching { zeroTerm.sftpClose(id) } }
        sftpId = null
        currentHostId = null
        _entries.value = emptyList()
        _path.value = "/"
        _progress.value = null
    }

    suspend fun list(path: String): Result<Unit> = withContext(Dispatchers.Default) {
        val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
        _busy.value = true
        _error.value = null
        runCatching {
            val entries = zeroTerm.sftpList(id, path)
            _path.value = path
            _entries.value = entries
        }.mapFfi().also {
            _busy.value = false
            it.exceptionOrNull()?.let { e -> _error.value = e.message }
        }
    }

    suspend fun mkdir(name: String): Result<Unit> = withContext(Dispatchers.Default) {
        val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
        val remote = joinPath(_path.value, name)
        runCatching {
            zeroTerm.sftpMkdir(id, remote)
            list(_path.value).getOrThrow()
        }.mapFfi()
    }

    suspend fun remove(name: String, isDir: Boolean): Result<Unit> =
        withContext(Dispatchers.Default) {
            val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
            val remote = joinPath(_path.value, name)
            runCatching {
                if (isDir) zeroTerm.sftpRemoveDir(id, remote)
                else zeroTerm.sftpRemove(id, remote)
                list(_path.value).getOrThrow()
            }.mapFfi()
        }

    suspend fun rename(fromName: String, toName: String): Result<Unit> =
        withContext(Dispatchers.Default) {
            val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
            val from = joinPath(_path.value, fromName)
            val to = joinPath(_path.value, toName)
            runCatching {
                zeroTerm.sftpRename(id, from, to)
                list(_path.value).getOrThrow()
            }.mapFfi()
        }

    fun cancelActiveTransfer() {
        val id = _progress.value?.transferId ?: return
        runCatching { zeroTerm.sftpCancelTransfer(id) }
    }

    suspend fun download(name: String, localFile: File, overwrite: Boolean = true): Result<File> =
        withContext(Dispatchers.Default) {
            val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
            val remote = joinPath(_path.value, name)
            val listener = object : TransferListener {
                override fun onTransfer(event: TransferProgress) {
                    _progress.value = event
                }
            }
            runCatching {
                zeroTerm.sftpDownload(id, remote, localFile.absolutePath, overwrite, listener)
                localFile
            }.mapFfi()
        }

    suspend fun upload(
        localFile: File,
        remoteName: String? = null,
        overwrite: Boolean = true,
    ): Result<Unit> = withContext(Dispatchers.Default) {
        val id = sftpId ?: return@withContext Result.failure(Exception("SFTP not open"))
        val name = remoteName ?: localFile.name
        val remote = joinPath(_path.value, name)
        val listener = object : TransferListener {
            override fun onTransfer(event: TransferProgress) {
                _progress.value = event
            }
        }
        runCatching {
            zeroTerm.sftpUpload(id, localFile.absolutePath, remote, overwrite, listener)
            list(_path.value).getOrThrow()
        }.mapFfi()
    }

    fun respondHostKey(requestId: String, accept: Boolean) {
        runCatching { zeroTerm.respondHostKey(requestId, accept) }
    }

    fun clearProgress() {
        _progress.value = null
    }

    companion object {
        fun joinPath(parent: String, name: String): String {
            if (parent == "/" || parent.isEmpty()) return "/$name".replace("//", "/")
            return "${parent.trimEnd('/')}/$name"
        }

        fun parentPath(path: String): String {
            if (path == "/" || path.isEmpty()) return "/"
            val trimmed = path.trimEnd('/')
            val idx = trimmed.lastIndexOf('/')
            return if (idx <= 0) "/" else trimmed.substring(0, idx)
        }
    }
}

private fun <T> Result<T>.mapFfi(): Result<T> = fold(
    onSuccess = { Result.success(it) },
    onFailure = { e ->
        Result.failure(Exception(e.message ?: e.toString(), e))
    },
)
