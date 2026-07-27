package com.zeroterm.android.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class UpdateCheckResult(
    val available: Boolean,
    val currentVersion: String,
    val latestVersion: String? = null,
    val releaseUrl: String? = null,
    val notes: String? = null,
    val apkUrl: String? = null,
    val apkName: String? = null,
    val apkSize: Long? = null,
    /** Lowercase hex SHA-256 of the APK asset, when the feed advertises one. */
    val apkSha256: String? = null,
    val error: String? = null,
)

object UpdateChecker {
    private const val TAG = "ZeroTermUpdate"

    /** GitHub Releases — same repo used by the desktop updater endpoint. */
    const val GITHUB_REPO = "NotPeppa/ZeroTerm"
    const val LATEST_RELEASE_API =
        "https://api.github.com/repos/NotPeppa/ZeroTerm/releases/latest"
    const val LATEST_RELEASE_PAGE =
        "https://github.com/NotPeppa/ZeroTerm/releases/latest"

    suspend fun check(currentVersion: String): UpdateCheckResult = withContext(Dispatchers.IO) {
        runCatching {
            val body = httpGet(LATEST_RELEASE_API)
            val json = JSONObject(body)
            val tag = json.optString("tag_name").ifBlank { json.optString("name") }
            val latest = normalizeVersion(tag)
            val current = normalizeVersion(currentVersion)
            val available = isNewer(latest, current)
            val apk = pickApkAsset(json.optJSONArray("assets"))
            UpdateCheckResult(
                available = available,
                currentVersion = current,
                latestVersion = latest,
                releaseUrl = json.optString("html_url").ifBlank { null },
                notes = json.optString("body").ifBlank { null },
                apkUrl = apk?.url,
                apkName = apk?.name,
                apkSize = apk?.size,
                apkSha256 = apk?.sha256,
            )
        }.getOrElse {
            UpdateCheckResult(
                available = false,
                currentVersion = currentVersion,
                error = it.message ?: "network error",
            )
        }
    }

    /**
     * Download APK to cache and return the local file.
     * [onProgress] receives 0f..1f when total size is known, otherwise -1f.
     */
    suspend fun downloadApk(
        context: Context,
        url: String,
        fileName: String,
        expectedSize: Long? = null,
        expectedSha256: String? = null,
        onProgress: (Float) -> Unit = {},
    ): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        // Clean older downloads.
        dir.listFiles()?.forEach { it.delete() }
        val safeName = fileName.ifBlank { "zeroterm-update.apk" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
        val target = File(dir, safeName)
        val tmp = File(dir, "$safeName.part")
        if (tmp.exists()) tmp.delete()

        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            requestMethod = "GET"
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "ZeroTerm-Android")
            setRequestProperty("Accept", "application/octet-stream")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) error("HTTP $code")
            val total = when {
                expectedSize != null && expectedSize > 0 -> expectedSize
                conn.contentLengthLong > 0 -> conn.contentLengthLong
                else -> -1L
            }
            conn.inputStream.use { input ->
                tmp.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var readTotal = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        readTotal += n
                        if (total > 0) {
                            onProgress((readTotal.toFloat() / total.toFloat()).coerceIn(0f, 1f))
                        } else {
                            onProgress(-1f)
                        }
                    }
                    output.flush()
                }
            }
            if (target.exists()) target.delete()
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
            // AND-5: verify the downloaded APK before it reaches the installer.
            val expected = expectedSha256?.trim()?.lowercase()
            if (!expected.isNullOrBlank()) {
                val actual = sha256Hex(target)
                if (actual != expected) {
                    target.delete()
                    error("APK integrity check failed (SHA-256 mismatch)")
                }
            } else {
                // The current GitHub release feed does not always advertise an
                // asset digest. We fall back to TLS + the platform's same-signer
                // update check, but surface that we could not independently
                // verify integrity so a silent install never looks trusted.
                // TODO: publish a SHA-256 (or signature) with every release asset
                // and make this verification mandatory (reject the install when
                // absent), which also closes the AND-4 debug-signing gap.
                Log.w(TAG, "APK downloaded without an integrity hash; SHA-256 not verified")
            }
            onProgress(1f)
            target
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun canInstallPackages(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    fun installPermissionSettingsIntent(context: Context): Intent {
        return Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        )
    }

    fun installApk(context: Context, apk: File) {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apk,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
    }

    private data class ApkAsset(
        val url: String,
        val name: String,
        val size: Long,
        /** Lowercase hex SHA-256 parsed from the GitHub asset `digest`, if any. */
        val sha256: String?,
    )

    private fun pickApkAsset(assets: org.json.JSONArray?): ApkAsset? {
        if (assets == null) return null
        val candidates = mutableListOf<ApkAsset>()
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            val name = a.optString("name")
            val url = a.optString("browser_download_url")
            val size = a.optLong("size", 0L)
            // GitHub asset `digest` is formatted "sha256:<hex>" when present.
            val sha256 = a.optString("digest")
                .substringAfter("sha256:", "")
                .trim()
                .lowercase()
                .ifBlank { null }
            if (name.endsWith(".apk", ignoreCase = true) && url.isNotBlank()) {
                candidates += ApkAsset(url, name, size, sha256)
            }
        }
        if (candidates.isEmpty()) return null
        // Prefer arm64 / release-looking names when multiple APKs exist.
        val abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty().lowercase()
        val preferred = candidates.firstOrNull { asset ->
            val n = asset.name.lowercase()
            when {
                abi.contains("arm64") -> n.contains("arm64") || n.contains("aarch64")
                abi.contains("armeabi") -> n.contains("armeabi") || n.contains("armv7")
                abi.contains("x86_64") -> n.contains("x86_64") || n.contains("x64")
                else -> false
            }
        }
        return preferred ?: candidates.first()
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000
            readTimeout = 12_000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "ZeroTerm-Android")
        }
        try {
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            if (code !in 200..299) error("HTTP $code")
            return body
        } finally {
            conn.disconnect()
        }
    }

    private fun normalizeVersion(raw: String): String =
        raw.trim().removePrefix("v").removePrefix("V")

    private fun isNewer(latest: String, current: String): Boolean {
        if (latest.isBlank() || current.isBlank()) return false
        val a = latest.split('.', '-', '+').mapNotNull { it.toIntOrNull() }
        val b = current.split('.', '-', '+').mapNotNull { it.toIntOrNull() }
        val n = maxOf(a.size, b.size)
        for (i in 0 until n) {
            val lv = a.getOrElse(i) { 0 }
            val cv = b.getOrElse(i) { 0 }
            if (lv != cv) return lv > cv
        }
        return false
    }
}
