package com.zeroterm.android.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class UpdateCheckResult(
    val available: Boolean,
    val currentVersion: String,
    val latestVersion: String? = null,
    val releaseUrl: String? = null,
    val notes: String? = null,
    val apkUrl: String? = null,
    val apkName: String? = null,
    val apkSize: Long? = null,
    val error: String? = null,
)

object UpdateChecker {
    private const val LATEST_RELEASE_API =
        "https://api.github.com/repos/NotPeppa/ZeroTerm/releases/latest"

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
                apkUrl = apk?.first,
                apkName = apk?.second,
                apkSize = apk?.third,
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
            onProgress(1f)
            target
        } finally {
            conn.disconnect()
        }
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

    private fun pickApkAsset(assets: org.json.JSONArray?): Triple<String, String, Long>? {
        if (assets == null) return null
        val candidates = mutableListOf<Triple<String, String, Long>>()
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            val name = a.optString("name")
            val url = a.optString("browser_download_url")
            val size = a.optLong("size", 0L)
            if (name.endsWith(".apk", ignoreCase = true) && url.isNotBlank()) {
                candidates += Triple(url, name, size)
            }
        }
        if (candidates.isEmpty()) return null
        // Prefer arm64 / release-looking names when multiple APKs exist.
        val abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty().lowercase()
        val preferred = candidates.firstOrNull { (_, name, _) ->
            val n = name.lowercase()
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
