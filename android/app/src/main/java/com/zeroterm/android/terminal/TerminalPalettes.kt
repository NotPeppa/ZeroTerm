package com.zeroterm.android.terminal

import androidx.annotation.StringRes
import androidx.compose.ui.graphics.Color
import com.zeroterm.android.R
import com.zeroterm.ffi.TerminalPalette
import org.json.JSONArray
import org.json.JSONObject

enum class TerminalThemeGroup {
    Light,
    Dark,
}

data class TerminalThemeDef(
    val id: String,
    val label: String,
    val group: TerminalThemeGroup,
    val palette: TerminalPalette,
    val isCustom: Boolean = false,
    val isBuiltin: Boolean = true,
) {
    val backgroundColor: Color get() = packedRgb(palette.background)
    val foregroundColor: Color get() = packedRgb(palette.foreground)
    val cursorColor: Color get() = packedRgb(palette.cursor)
    val selectionColor: Color get() = packedRgb(palette.selection)
    val accentColors: List<Color>
        get() = listOf(
            packedRgb(palette.red),
            packedRgb(palette.green),
            packedRgb(palette.yellow),
            packedRgb(palette.blue),
            packedRgb(palette.magenta),
            packedRgb(palette.cyan),
        )
}

data class CustomTerminalTheme(
    val id: String,
    val label: String,
    val group: TerminalThemeGroup,
    val palette: TerminalPalette,
)

object TerminalPalettes {
    const val DEFAULT_DARK_ID = "termark-dark"
    const val DEFAULT_LIGHT_ID = "tokyo-day"

    data class BuiltinTheme(
        val id: String,
        @StringRes val nameRes: Int,
        val group: TerminalThemeGroup,
        val palette: TerminalPalette,
    )

    val builtins: List<BuiltinTheme> = listOf(
        builtin(
            id = "tokyo-day",
            nameRes = R.string.terminal_theme_tokyo_day,
            group = TerminalThemeGroup.Light,
            background = 0xF4EFE3,
            foreground = 0x334155,
            cursor = 0x2563EB,
            selection = 0xD8E5F3,
            black = 0x2F3A4A,
            red = 0xC7444E,
            green = 0x4F7D45,
            yellow = 0xA56D24,
            blue = 0x2F6F9F,
            magenta = 0x8D5CA6,
            cyan = 0x287F7A,
            white = 0xF6F1E7,
            brightBlack = 0x7F8793,
            brightRed = 0xD85B64,
            brightGreen = 0x629657,
            brightYellow = 0xBD8438,
            brightBlue = 0x4484B6,
            brightMagenta = 0xA373BA,
            brightCyan = 0x3B9992,
            brightWhite = 0xFFFAF1,
        ),
        builtin(
            id = "catppuccin-latte",
            nameRes = R.string.terminal_theme_catppuccin_latte,
            group = TerminalThemeGroup.Light,
            background = 0xF8FAFC,
            foreground = 0x334155,
            cursor = 0x7C3AED,
            selection = 0xE3E8F4,
            black = 0x3F4560,
            red = 0xC83E4D,
            green = 0x3F8F59,
            yellow = 0xB37718,
            blue = 0x3F73D8,
            magenta = 0xB45FC5,
            cyan = 0x1F8C96,
            white = 0xF7F8FC,
            brightBlack = 0x9298AD,
            brightRed = 0xD85A67,
            brightGreen = 0x55A86E,
            brightYellow = 0xCA8F2B,
            brightBlue = 0x5B8BE5,
            brightMagenta = 0xC778D4,
            brightCyan = 0x37A3AC,
            brightWhite = 0xFFFFFF,
        ),
        builtin(
            id = "sage-light",
            nameRes = R.string.terminal_theme_sage_light,
            group = TerminalThemeGroup.Light,
            background = 0xEEF4ED,
            foreground = 0x2F3F37,
            cursor = 0x15803D,
            selection = 0xD6E4D8,
            black = 0x2E3F38,
            red = 0xB85D5B,
            green = 0x4B855F,
            yellow = 0x9A7A32,
            blue = 0x3F6F8F,
            magenta = 0x8A6695,
            cyan = 0x3D837B,
            white = 0xEEF3EC,
            brightBlack = 0x7D8A83,
            brightRed = 0xC87573,
            brightGreen = 0x62A176,
            brightYellow = 0xB08F49,
            brightBlue = 0x5687A7,
            brightMagenta = 0x9F7DAA,
            brightCyan = 0x569B93,
            brightWhite = 0xFBFFF9,
        ),
        builtin(
            id = "termark-dark",
            nameRes = R.string.terminal_theme_termark_dark,
            group = TerminalThemeGroup.Dark,
            background = 0x10151F,
            foreground = 0xD7E2F0,
            cursor = 0x7DD3FC,
            selection = 0x27384F,
            black = 0x101624,
            red = 0xFF6B7A,
            green = 0x51D88A,
            yellow = 0xF5C96B,
            blue = 0x6AA5FF,
            magenta = 0xC792EA,
            cyan = 0x57D4FF,
            white = 0xDBE7FF,
            brightBlack = 0x60708C,
            brightRed = 0xFF8793,
            brightGreen = 0x7EE6A7,
            brightYellow = 0xF8D98A,
            brightBlue = 0x8DBBFF,
            brightMagenta = 0xD7A7F4,
            brightCyan = 0x83E3FF,
            brightWhite = 0xFFFFFF,
        ),
        builtin(
            id = "kanagawa-wave",
            nameRes = R.string.terminal_theme_kanagawa_wave,
            group = TerminalThemeGroup.Dark,
            background = 0x151714,
            foreground = 0xD8D3BB,
            cursor = 0xA7C080,
            selection = 0x30382C,
            black = 0x111219,
            red = 0xD8616B,
            green = 0x8FB573,
            yellow = 0xD6B56D,
            blue = 0x7AA2E3,
            magenta = 0xB18BD6,
            cyan = 0x78B6A5,
            white = 0xE4D8B4,
            brightBlack = 0x5D6070,
            brightRed = 0xEE7B84,
            brightGreen = 0xA8C985,
            brightYellow = 0xE8CA86,
            brightBlue = 0x93B8EE,
            brightMagenta = 0xC3A0E4,
            brightCyan = 0x91C9B8,
            brightWhite = 0xFFF2C7,
        ),
        builtin(
            id = "catppuccin-mocha",
            nameRes = R.string.terminal_theme_catppuccin_mocha,
            group = TerminalThemeGroup.Dark,
            background = 0x1B1724,
            foreground = 0xE8DEF2,
            cursor = 0xC4B5FD,
            selection = 0x3A3150,
            black = 0x17131B,
            red = 0xFF7A93,
            green = 0xA6E3A1,
            yellow = 0xF6D67B,
            blue = 0x8AADFF,
            magenta = 0xF0A9DF,
            cyan = 0x91D7E3,
            white = 0xF0DFF1,
            brightBlack = 0x66566E,
            brightRed = 0xFF99AB,
            brightGreen = 0xB9EFB4,
            brightYellow = 0xF9E29D,
            brightBlue = 0xA7C1FF,
            brightMagenta = 0xF7C2EA,
            brightCyan = 0xA9E5EE,
            brightWhite = 0xFFF7FF,
        ),
    )

    /** @deprecated use [resolve] */
    val all: List<TerminalThemeDef>
        get() = resolve(emptyList(), emptySet()) { builtinLabel(it) }

    fun builtinLabel(theme: BuiltinTheme): String = when (theme.nameRes) {
        R.string.terminal_theme_tokyo_day -> "Mist Paper"
        R.string.terminal_theme_catppuccin_latte -> "Cloud Latte"
        R.string.terminal_theme_sage_light -> "Sage Field"
        R.string.terminal_theme_termark_dark -> "Midnight Slate"
        R.string.terminal_theme_kanagawa_wave -> "Ink Garden"
        R.string.terminal_theme_catppuccin_mocha -> "Violet Dusk"
        else -> theme.id
    }

    fun resolve(
        customThemes: List<CustomTerminalTheme>,
        hiddenBuiltinIds: Set<String>,
        labelForBuiltin: (BuiltinTheme) -> String,
    ): List<TerminalThemeDef> {
        val customById = customThemes.associateBy { it.id }
        val result = mutableListOf<TerminalThemeDef>()
        for (b in builtins) {
            if (hiddenBuiltinIds.contains(b.id) && customById[b.id] == null) continue
            val override = customById[b.id]
            if (override != null) {
                result += TerminalThemeDef(
                    id = override.id,
                    label = override.label.ifBlank { labelForBuiltin(b) },
                    group = override.group,
                    palette = override.palette,
                    isCustom = true,
                    isBuiltin = true,
                )
            } else {
                result += TerminalThemeDef(
                    id = b.id,
                    label = labelForBuiltin(b),
                    group = b.group,
                    palette = b.palette,
                    isCustom = false,
                    isBuiltin = true,
                )
            }
        }
        for (c in customThemes) {
            if (builtins.any { it.id == c.id }) continue
            result += TerminalThemeDef(
                id = c.id,
                label = c.label.ifBlank { c.id },
                group = c.group,
                palette = c.palette,
                isCustom = true,
                isBuiltin = false,
            )
        }
        return result
    }

    fun byId(
        id: String?,
        customThemes: List<CustomTerminalTheme> = emptyList(),
        hiddenBuiltinIds: Set<String> = emptySet(),
        labelForBuiltin: (BuiltinTheme) -> String = { builtinLabel(it) },
    ): TerminalThemeDef {
        val list = resolve(customThemes, hiddenBuiltinIds, labelForBuiltin)
        val key = id?.trim().orEmpty()
        return list.firstOrNull { it.id == key }
            ?: list.firstOrNull { it.id == DEFAULT_DARK_ID }
            ?: list.first()
    }

    fun defaultId(darkApp: Boolean): String =
        if (darkApp) DEFAULT_DARK_ID else DEFAULT_LIGHT_ID

    fun clonePalette(source: TerminalPalette): TerminalPalette = TerminalPalette(
        background = source.background,
        foreground = source.foreground,
        cursor = source.cursor,
        selection = source.selection,
        black = source.black,
        red = source.red,
        green = source.green,
        yellow = source.yellow,
        blue = source.blue,
        magenta = source.magenta,
        cyan = source.cyan,
        white = source.white,
        brightBlack = source.brightBlack,
        brightRed = source.brightRed,
        brightGreen = source.brightGreen,
        brightYellow = source.brightYellow,
        brightBlue = source.brightBlue,
        brightMagenta = source.brightMagenta,
        brightCyan = source.brightCyan,
        brightWhite = source.brightWhite,
    )

    fun withCoreColors(
        base: TerminalPalette,
        background: UInt,
        foreground: UInt,
        cursor: UInt,
        selection: UInt,
    ): TerminalPalette = TerminalPalette(
        background = background,
        foreground = foreground,
        cursor = cursor,
        selection = selection,
        black = base.black,
        red = base.red,
        green = base.green,
        yellow = base.yellow,
        blue = base.blue,
        magenta = base.magenta,
        cyan = base.cyan,
        white = base.white,
        brightBlack = base.brightBlack,
        brightRed = base.brightRed,
        brightGreen = base.brightGreen,
        brightYellow = base.brightYellow,
        brightBlue = base.brightBlue,
        brightMagenta = base.brightMagenta,
        brightCyan = base.brightCyan,
        brightWhite = base.brightWhite,
    )

    fun encodeCustomThemes(themes: List<CustomTerminalTheme>): String {
        val arr = JSONArray()
        themes.forEach { t ->
            arr.put(
                JSONObject()
                    .put("id", t.id)
                    .put("label", t.label)
                    .put("group", t.group.name)
                    .put("palette", paletteToJson(t.palette)),
            )
        }
        return arr.toString()
    }

    fun decodeCustomThemes(raw: String?): List<CustomTerminalTheme> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val id = o.optString("id").trim()
                    if (id.isEmpty()) continue
                    val group = when (o.optString("group").lowercase()) {
                        "light" -> TerminalThemeGroup.Light
                        else -> TerminalThemeGroup.Dark
                    }
                    val palette = paletteFromJson(o.optJSONObject("palette"))
                        ?: continue
                    add(
                        CustomTerminalTheme(
                            id = id,
                            label = o.optString("label").ifBlank { id },
                            group = group,
                            palette = palette,
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    fun encodeHiddenBuiltins(ids: Set<String>): String {
        val arr = JSONArray()
        ids.forEach { arr.put(it) }
        return arr.toString()
    }

    fun decodeHiddenBuiltins(raw: String?): Set<String> {
        if (raw.isNullOrBlank()) return emptySet()
        return runCatching {
            val arr = JSONArray(raw)
            buildSet {
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i).trim()
                    if (id.isNotEmpty() && builtins.any { it.id == id }) add(id)
                }
            }
        }.getOrDefault(emptySet())
    }

    private fun paletteToJson(p: TerminalPalette): JSONObject = JSONObject()
        .put("background", p.background.toLong())
        .put("foreground", p.foreground.toLong())
        .put("cursor", p.cursor.toLong())
        .put("selection", p.selection.toLong())
        .put("black", p.black.toLong())
        .put("red", p.red.toLong())
        .put("green", p.green.toLong())
        .put("yellow", p.yellow.toLong())
        .put("blue", p.blue.toLong())
        .put("magenta", p.magenta.toLong())
        .put("cyan", p.cyan.toLong())
        .put("white", p.white.toLong())
        .put("brightBlack", p.brightBlack.toLong())
        .put("brightRed", p.brightRed.toLong())
        .put("brightGreen", p.brightGreen.toLong())
        .put("brightYellow", p.brightYellow.toLong())
        .put("brightBlue", p.brightBlue.toLong())
        .put("brightMagenta", p.brightMagenta.toLong())
        .put("brightCyan", p.brightCyan.toLong())
        .put("brightWhite", p.brightWhite.toLong())

    private fun paletteFromJson(o: JSONObject?): TerminalPalette? {
        if (o == null) return null
        fun u(key: String, fallback: Long = 0): UInt = o.optLong(key, fallback).toUInt()
        return TerminalPalette(
            background = u("background"),
            foreground = u("foreground"),
            cursor = u("cursor"),
            selection = u("selection"),
            black = u("black"),
            red = u("red"),
            green = u("green"),
            yellow = u("yellow"),
            blue = u("blue"),
            magenta = u("magenta"),
            cyan = u("cyan"),
            white = u("white"),
            brightBlack = u("brightBlack"),
            brightRed = u("brightRed"),
            brightGreen = u("brightGreen"),
            brightYellow = u("brightYellow"),
            brightBlue = u("brightBlue"),
            brightMagenta = u("brightMagenta"),
            brightCyan = u("brightCyan"),
            brightWhite = u("brightWhite"),
        )
    }
}

private fun builtin(
    id: String,
    @StringRes nameRes: Int,
    group: TerminalThemeGroup,
    background: Long,
    foreground: Long,
    cursor: Long,
    selection: Long,
    black: Long,
    red: Long,
    green: Long,
    yellow: Long,
    blue: Long,
    magenta: Long,
    cyan: Long,
    white: Long,
    brightBlack: Long,
    brightRed: Long,
    brightGreen: Long,
    brightYellow: Long,
    brightBlue: Long,
    brightMagenta: Long,
    brightCyan: Long,
    brightWhite: Long,
): TerminalPalettes.BuiltinTheme = TerminalPalettes.BuiltinTheme(
    id = id,
    nameRes = nameRes,
    group = group,
    palette = TerminalPalette(
        background = background.toUInt(),
        foreground = foreground.toUInt(),
        cursor = cursor.toUInt(),
        selection = selection.toUInt(),
        black = black.toUInt(),
        red = red.toUInt(),
        green = green.toUInt(),
        yellow = yellow.toUInt(),
        blue = blue.toUInt(),
        magenta = magenta.toUInt(),
        cyan = cyan.toUInt(),
        white = white.toUInt(),
        brightBlack = brightBlack.toUInt(),
        brightRed = brightRed.toUInt(),
        brightGreen = brightGreen.toUInt(),
        brightYellow = brightYellow.toUInt(),
        brightBlue = brightBlue.toUInt(),
        brightMagenta = brightMagenta.toUInt(),
        brightCyan = brightCyan.toUInt(),
        brightWhite = brightWhite.toUInt(),
    ),
)

fun packedRgb(v: UInt): Color {
    val n = v.toLong()
    return Color(
        red = ((n shr 16) and 0xFF).toInt(),
        green = ((n shr 8) and 0xFF).toInt(),
        blue = (n and 0xFF).toInt(),
    )
}

fun colorToHex(color: Color): String {
    val r = (color.red * 255).toInt().coerceIn(0, 255)
    val g = (color.green * 255).toInt().coerceIn(0, 255)
    val b = (color.blue * 255).toInt().coerceIn(0, 255)
    return "#%02X%02X%02X".format(r, g, b)
}

fun hexToRgbUInt(hex: String): UInt? {
    val cleaned = hex.trim().removePrefix("#")
    if (cleaned.length != 6) return null
    val v = cleaned.toLongOrNull(16) ?: return null
    return v.toUInt()
}

fun packedRgb(v: Long): Color = packedRgb(v.toUInt())
