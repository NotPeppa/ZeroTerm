package com.zeroterm.android.data

import android.content.Context
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

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

enum class ThemeMode {
    System,
    Dark,
    Light,
}

data class SettingsSnapshot(
    val fontSizeSp: Float = 13f,
    val themeMode: ThemeMode = ThemeMode.System,
    /** When true, sync all profiles periodically while unlocked + in foreground. */
    val autoSync: Boolean = true,
    /** Minutes between auto-sync passes (clamped 5–120). */
    val autoSyncIntervalMin: Int = 15,
)

/**
 * Persisted app preferences (font, theme, auto-sync).
 */
class AppSettings(private val context: Context) {
    val flow: Flow<SettingsSnapshot> = context.dataStore.data.map { prefs ->
        SettingsSnapshot(
            fontSizeSp = prefs[KEY_FONT]?.coerceIn(MIN_FONT, MAX_FONT) ?: 13f,
            themeMode = prefs[KEY_THEME]?.let {
                runCatching { ThemeMode.valueOf(it) }.getOrDefault(ThemeMode.System)
            } ?: ThemeMode.System,
            autoSync = prefs[KEY_AUTO_SYNC] ?: true,
            autoSyncIntervalMin = (prefs[KEY_AUTO_SYNC_MIN] ?: 15).coerceIn(MIN_INTERVAL, MAX_INTERVAL),
        )
    }

    suspend fun setFontSize(sp: Float) {
        context.dataStore.edit { it[KEY_FONT] = sp.coerceIn(MIN_FONT, MAX_FONT) }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        context.dataStore.edit { it[KEY_THEME] = mode.name }
    }

    suspend fun setAutoSync(enabled: Boolean) {
        context.dataStore.edit { it[KEY_AUTO_SYNC] = enabled }
    }

    suspend fun setAutoSyncIntervalMin(minutes: Int) {
        context.dataStore.edit {
            it[KEY_AUTO_SYNC_MIN] = minutes.coerceIn(MIN_INTERVAL, MAX_INTERVAL)
        }
    }

    companion object {
        const val MIN_FONT = 9f
        const val MAX_FONT = 28f
        const val MIN_INTERVAL = 5
        const val MAX_INTERVAL = 120
        private val KEY_FONT = floatPreferencesKey("font_size_sp")
        private val KEY_THEME = stringPreferencesKey("theme_mode")
        private val KEY_AUTO_SYNC = booleanPreferencesKey("auto_sync")
        private val KEY_AUTO_SYNC_MIN = intPreferencesKey("auto_sync_interval_min")
    }
}
