package com.zeroterm.android.data

import android.content.Context
import android.net.Uri
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

enum class ThemeMode {
    System,
    Dark,
    Light,
}

/**
 * App UI language. [System] follows the device locale.
 * Tags match Android per-app locales / BCP-47.
 */
enum class AppLocale(val tag: String) {
    System(""),
    English("en"),
    ChineseSimplified("zh-CN"),
    ;

    companion object {
        fun fromTag(tag: String?): AppLocale = when (tag?.trim().orEmpty()) {
            "", "system" -> System
            "en" -> English
            "zh-CN", "zh", "zh-Hans", "zh-Hans-CN" -> ChineseSimplified
            else -> entries.firstOrNull { it.tag == tag } ?: System
        }
    }
}

data class SettingsSnapshot(
    val fontSizeSp: Float = 13f,
    val themeMode: ThemeMode = ThemeMode.System,
    val locale: AppLocale = AppLocale.System,
    /** When true, sync all profiles periodically while unlocked + in foreground. */
    val autoSync: Boolean = true,
    /** Minutes between auto-sync passes (clamped 5–120). */
    val autoSyncIntervalMin: Int = 15,
    val backgroundImagePath: String = "",
    val backgroundOpacity: Float = 0.4f,
    val backgroundBlurDp: Int = 0,
    val topBarTransparency: Float = 0.34f,
    val drawerTransparency: Float = 0.34f,
    val proxyEnabled: Boolean = false,
    val proxyUrl: String = "",
    /** Preferred AI profile id used as the default selection. */
    val activeAiProfileId: String = "",
    /** Active terminal color theme id (see TerminalPalettes). */
    val terminalThemeId: String = "",
    /** JSON array of custom terminal themes. */
    val terminalCustomThemesJson: String = "[]",
    /** JSON array of hidden builtin terminal theme ids. */
    val terminalHiddenBuiltinThemesJson: String = "[]",
)

/**
 * Persisted app preferences (font, theme, locale, auto-sync).
 */
class AppSettings(private val context: Context) {
    val flow: Flow<SettingsSnapshot> = context.dataStore.data.map { prefs ->
        SettingsSnapshot(
            fontSizeSp = prefs[KEY_FONT]?.coerceIn(MIN_FONT, MAX_FONT) ?: 13f,
            themeMode = prefs[KEY_THEME]?.let {
                runCatching { ThemeMode.valueOf(it) }.getOrDefault(ThemeMode.System)
            } ?: ThemeMode.System,
            locale = AppLocale.fromTag(prefs[KEY_LOCALE]),
            autoSync = prefs[KEY_AUTO_SYNC] ?: true,
            autoSyncIntervalMin = (prefs[KEY_AUTO_SYNC_MIN] ?: 15).coerceIn(MIN_INTERVAL, MAX_INTERVAL),
            backgroundImagePath = prefs[KEY_BACKGROUND_PATH].orEmpty(),
            backgroundOpacity = (prefs[KEY_BACKGROUND_OPACITY] ?: 0.4f).coerceIn(0.05f, 1f),
            backgroundBlurDp = (prefs[KEY_BACKGROUND_BLUR] ?: 0).coerceIn(0, 30),
            topBarTransparency = (prefs[KEY_TOP_BAR_TRANSPARENCY] ?: 0.34f).coerceIn(0f, 0.8f),
            drawerTransparency = (prefs[KEY_DRAWER_TRANSPARENCY] ?: 0.34f).coerceIn(0f, 0.8f),
            proxyEnabled = prefs[KEY_PROXY_ENABLED] ?: false,
            proxyUrl = prefs[KEY_PROXY_URL].orEmpty(),
            activeAiProfileId = prefs[KEY_ACTIVE_AI_PROFILE].orEmpty(),
            terminalThemeId = prefs[KEY_TERMINAL_THEME].orEmpty(),
            terminalCustomThemesJson = prefs[KEY_TERMINAL_CUSTOM_THEMES] ?: "[]",
            terminalHiddenBuiltinThemesJson = prefs[KEY_TERMINAL_HIDDEN_BUILTINS] ?: "[]",
        )
    }

    suspend fun setFontSize(sp: Float) {
        context.dataStore.edit { it[KEY_FONT] = sp.coerceIn(MIN_FONT, MAX_FONT) }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        context.dataStore.edit { it[KEY_THEME] = mode.name }
    }

    suspend fun setLocale(locale: AppLocale) {
        context.dataStore.edit {
            if (locale == AppLocale.System) {
                it.remove(KEY_LOCALE)
            } else {
                it[KEY_LOCALE] = locale.tag
            }
        }
        applyLocale(locale)
    }

    suspend fun setAutoSync(enabled: Boolean) {
        context.dataStore.edit { it[KEY_AUTO_SYNC] = enabled }
    }

    suspend fun setAutoSyncIntervalMin(minutes: Int) {
        context.dataStore.edit {
            it[KEY_AUTO_SYNC_MIN] = minutes.coerceIn(MIN_INTERVAL, MAX_INTERVAL)
        }
    }

    suspend fun setBackgroundImage(uri: Uri): String = withContext(Dispatchers.IO) {
        // Unique filename so path changes and UI reloads (same path would keep old bitmap).
        val target = File(context.filesDir, "$BACKGROUND_FILE_PREFIX${System.currentTimeMillis()}")
        val temporary = File(context.cacheDir, "$BACKGROUND_FILE_PREFIX.tmp")
        context.contentResolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "Unable to open selected image" }
            temporary.outputStream().use { output -> input.copyTo(output) }
        }
        temporary.copyTo(target, overwrite = true)
        temporary.delete()
        // Remove previous background files after the new one is ready.
        context.filesDir.listFiles()?.forEach { file ->
            if (
                file.isFile &&
                file.absolutePath != target.absolutePath &&
                (
                    file.name == BACKGROUND_FILE_LEGACY ||
                        file.name.startsWith(BACKGROUND_FILE_PREFIX)
                    )
            ) {
                file.delete()
            }
        }
        context.dataStore.edit { it[KEY_BACKGROUND_PATH] = target.absolutePath }
        target.absolutePath
    }

    suspend fun clearBackgroundImage() = withContext(Dispatchers.IO) {
        context.filesDir.listFiles()?.forEach { file ->
            if (
                file.isFile &&
                (
                    file.name == BACKGROUND_FILE_LEGACY ||
                        file.name.startsWith(BACKGROUND_FILE_PREFIX)
                    )
            ) {
                file.delete()
            }
        }
        context.dataStore.edit { it.remove(KEY_BACKGROUND_PATH) }
    }

    suspend fun setBackgroundOpacity(value: Float) {
        context.dataStore.edit { it[KEY_BACKGROUND_OPACITY] = value.coerceIn(0.05f, 1f) }
    }

    suspend fun setBackgroundBlurDp(value: Int) {
        context.dataStore.edit { it[KEY_BACKGROUND_BLUR] = value.coerceIn(0, 30) }
    }

    suspend fun setTopBarTransparency(value: Float) {
        context.dataStore.edit { it[KEY_TOP_BAR_TRANSPARENCY] = value.coerceIn(0f, 0.8f) }
    }

    suspend fun setDrawerTransparency(value: Float) {
        context.dataStore.edit { it[KEY_DRAWER_TRANSPARENCY] = value.coerceIn(0f, 0.8f) }
    }

    suspend fun setProxy(enabled: Boolean, url: String) {
        context.dataStore.edit {
            it[KEY_PROXY_ENABLED] = enabled
            it[KEY_PROXY_URL] = url.trim()
        }
    }

    suspend fun setActiveAiProfileId(id: String) {
        context.dataStore.edit {
            val trimmed = id.trim()
            if (trimmed.isEmpty()) {
                it.remove(KEY_ACTIVE_AI_PROFILE)
            } else {
                it[KEY_ACTIVE_AI_PROFILE] = trimmed
            }
        }
    }

    suspend fun setTerminalThemeId(id: String) {
        context.dataStore.edit {
            val trimmed = id.trim()
            if (trimmed.isEmpty()) {
                it.remove(KEY_TERMINAL_THEME)
            } else {
                it[KEY_TERMINAL_THEME] = trimmed
            }
        }
    }

    suspend fun setTerminalCustomThemesJson(json: String) {
        context.dataStore.edit { it[KEY_TERMINAL_CUSTOM_THEMES] = json }
    }

    suspend fun setTerminalHiddenBuiltinThemesJson(json: String) {
        context.dataStore.edit { it[KEY_TERMINAL_HIDDEN_BUILTINS] = json }
    }

    companion object {
        const val MIN_FONT = 9f
        const val MAX_FONT = 28f
        const val MIN_INTERVAL = 5
        const val MAX_INTERVAL = 120
        private val KEY_FONT = floatPreferencesKey("font_size_sp")
        private val KEY_THEME = stringPreferencesKey("theme_mode")
        private val KEY_LOCALE = stringPreferencesKey("locale_tag")
        private val KEY_AUTO_SYNC = booleanPreferencesKey("auto_sync")
        private val KEY_AUTO_SYNC_MIN = intPreferencesKey("auto_sync_interval_min")
        private val KEY_BACKGROUND_PATH = stringPreferencesKey("background_image_path")
        private val KEY_BACKGROUND_OPACITY = floatPreferencesKey("background_opacity")
        private val KEY_BACKGROUND_BLUR = intPreferencesKey("background_blur_dp")
        private val KEY_TOP_BAR_TRANSPARENCY = floatPreferencesKey("top_bar_transparency")
        private val KEY_DRAWER_TRANSPARENCY = floatPreferencesKey("drawer_transparency")
        private val KEY_PROXY_ENABLED = booleanPreferencesKey("network_proxy_enabled")
        private val KEY_PROXY_URL = stringPreferencesKey("network_proxy_url")
        private val KEY_ACTIVE_AI_PROFILE = stringPreferencesKey("active_ai_profile_id")
        private val KEY_TERMINAL_THEME = stringPreferencesKey("terminal_theme_id")
        private val KEY_TERMINAL_CUSTOM_THEMES = stringPreferencesKey("terminal_custom_themes_json")
        private val KEY_TERMINAL_HIDDEN_BUILTINS = stringPreferencesKey("terminal_hidden_builtin_themes_json")
        private const val BACKGROUND_FILE_LEGACY = "terminal-background-image"
        private const val BACKGROUND_FILE_PREFIX = "terminal-background-image-"

        fun applyLocale(locale: AppLocale) {
            val list = if (locale == AppLocale.System) {
                LocaleListCompat.getEmptyLocaleList()
            } else {
                LocaleListCompat.forLanguageTags(locale.tag)
            }
            AppCompatDelegate.setApplicationLocales(list)
        }
    }
}
