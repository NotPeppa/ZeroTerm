package com.zeroterm.android.ui.terminal

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.zeroterm.android.R
import com.zeroterm.android.terminal.CustomTerminalTheme
import com.zeroterm.android.terminal.TerminalPalettes
import com.zeroterm.android.terminal.TerminalThemeDef
import com.zeroterm.android.terminal.TerminalThemeGroup
import com.zeroterm.android.terminal.colorToHex
import com.zeroterm.android.terminal.packedRgb
import com.zeroterm.ffi.TerminalPalette

@Composable
fun TerminalThemePanel(
    selectedThemeId: String,
    themes: List<TerminalThemeDef>,
    onThemeSelected: (String) -> Unit,
    onSaveTheme: (CustomTerminalTheme) -> Unit,
    onDeleteTheme: (TerminalThemeDef) -> Unit,
    modifier: Modifier = Modifier,
) {
    val light = themes.filter { it.group == TerminalThemeGroup.Light && it.isBuiltin }
    val dark = themes.filter { it.group == TerminalThemeGroup.Dark && it.isBuiltin }
    val pureCustom = themes.filter { !it.isBuiltin }
    val defaultNewName = stringResource(R.string.terminal_theme_new_name)

    var editing by remember { mutableStateOf<TerminalThemeDef?>(null) }
    var pendingDelete by remember { mutableStateOf<TerminalThemeDef?>(null) }
    var deleteBlocked by remember { mutableStateOf(false) }

    fun openCreateTheme() {
        val source = themes.firstOrNull { it.id == selectedThemeId } ?: themes.firstOrNull() ?: return
        editing = TerminalThemeDef(
            id = "custom-${System.currentTimeMillis()}",
            label = defaultNewName,
            group = source.group,
            palette = TerminalPalettes.clonePalette(source.palette),
            isCustom = true,
            isBuiltin = false,
        )
    }

    if (deleteBlocked) {
        AlertDialog(
            onDismissRequest = { deleteBlocked = false },
            title = { Text(stringResource(R.string.terminal_theme_delete)) },
            text = { Text(stringResource(R.string.terminal_theme_delete_current)) },
            confirmButton = {
                TextButton(onClick = { deleteBlocked = false }) {
                    Text(stringResource(R.string.common_close))
                }
            },
        )
    }

    pendingDelete?.let { theme ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            properties = DialogProperties(dismissOnClickOutside = false),
            title = { Text(stringResource(R.string.terminal_theme_delete)) },
            text = { Text(stringResource(R.string.terminal_theme_delete_message, theme.label)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    onDeleteTheme(theme)
                }) {
                    Text(
                        stringResource(R.string.common_delete),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    editing?.let { theme ->
        ThemeEditDialog(
            theme = theme,
            onDismiss = { editing = null },
            onSave = { label, palette ->
                editing = null
                onSaveTheme(
                    CustomTerminalTheme(
                        id = theme.id,
                        label = label,
                        group = theme.group,
                        palette = palette,
                    ),
                )
            },
        )
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.terminal_theme_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stringResource(R.string.terminal_theme_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { openCreateTheme() }) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = stringResource(R.string.terminal_theme_add),
                )
            }
        }

        ThemeSection(
            title = stringResource(R.string.terminal_theme_dark_section),
            themes = dark,
            selectedThemeId = selectedThemeId,
            onThemeSelected = onThemeSelected,
            onEdit = { editing = it },
            onDelete = { theme ->
                if (theme.id == selectedThemeId) deleteBlocked = true
                else pendingDelete = theme
            },
        )
        ThemeSection(
            title = stringResource(R.string.terminal_theme_light_section),
            themes = light,
            selectedThemeId = selectedThemeId,
            onThemeSelected = onThemeSelected,
            onEdit = { editing = it },
            onDelete = { theme ->
                if (theme.id == selectedThemeId) deleteBlocked = true
                else pendingDelete = theme
            },
        )
        if (pureCustom.isNotEmpty()) {
            ThemeSection(
                title = stringResource(R.string.terminal_theme_custom_section),
                themes = pureCustom,
                selectedThemeId = selectedThemeId,
                onThemeSelected = onThemeSelected,
                onEdit = { editing = it },
                onDelete = { theme ->
                    if (theme.id == selectedThemeId) deleteBlocked = true
                    else pendingDelete = theme
                },
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
    }
}

@Composable
private fun ThemeSection(
    title: String,
    themes: List<TerminalThemeDef>,
    selectedThemeId: String,
    onThemeSelected: (String) -> Unit,
    onEdit: (TerminalThemeDef) -> Unit,
    onDelete: (TerminalThemeDef) -> Unit,
) {
    if (themes.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        themes.forEach { theme ->
            ThemeCard(
                theme = theme,
                selected = theme.id == selectedThemeId,
                onClick = { onThemeSelected(theme.id) },
                onEdit = { onEdit(theme) },
                onDelete = { onDelete(theme) },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ThemeCard(
    theme: TerminalThemeDef,
    selected: Boolean,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(14.dp)
    val borderColor = if (selected) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.72f)
    }

    Box(Modifier.fillMaxWidth()) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = onClick,
                    onLongClickLabel = stringResource(R.string.terminal_theme_long_press_hint),
                    onLongClick = { menuOpen = true },
                ),
            shape = shape,
            colors = CardDefaults.cardColors(
                containerColor = theme.backgroundColor,
                contentColor = theme.foregroundColor,
            ),
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            border = BorderStroke(
                width = if (selected) 2.dp else 1.dp,
                color = borderColor,
            ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = theme.label,
                        color = theme.foregroundColor,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        theme.accentColors.forEach { color ->
                            Box(
                                modifier = Modifier
                                    .size(12.dp)
                                    .clip(CircleShape)
                                    .background(color),
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "ls  vim  git  $",
                        color = theme.foregroundColor.copy(alpha = 0.78f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (selected) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Default.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .size(1.dp),
        ) {
            DropdownMenu(
                expanded = menuOpen,
                onDismissRequest = { menuOpen = false },
            ) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.common_edit)) },
                    onClick = {
                        menuOpen = false
                        onEdit()
                    },
                    leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                )
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(R.string.common_delete),
                            color = MaterialTheme.colorScheme.error,
                        )
                    },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                    leadingIcon = {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                        )
                    },
                )
            }
        }
    }
}

@Composable
private fun ThemeEditDialog(
    theme: TerminalThemeDef,
    onDismiss: () -> Unit,
    onSave: (label: String, palette: TerminalPalette) -> Unit,
) {
    var name by remember(theme.id) { mutableStateOf(theme.label) }
    var bg by remember(theme.id) { mutableStateOf(theme.backgroundColor) }
    var fg by remember(theme.id) { mutableStateOf(theme.foregroundColor) }
    var cursor by remember(theme.id) { mutableStateOf(theme.cursorColor) }
    var selection by remember(theme.id) { mutableStateOf(theme.selectionColor) }
    var picking by remember { mutableStateOf<ColorSlot?>(null) }

    fun toPacked(c: Color): UInt = (c.toArgb().toLong() and 0xFFFFFFL).toUInt()

    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
        modifier = Modifier
            .fillMaxWidth(0.94f)
            .padding(8.dp),
        title = { Text(stringResource(R.string.terminal_theme_edit)) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(60) },
                    label = { Text(stringResource(R.string.terminal_theme_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(bg)
                        .padding(12.dp),
                ) {
                    Column {
                        Text(
                            text = "root@zeroterm$ ls",
                            color = fg,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        )
                        Text(
                            text = "drwxr-xr-x 1 root boot\ndrwxr-xr-x 1 root data",
                            color = fg.copy(alpha = 0.85f),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        )
                        Box(
                            modifier = Modifier
                                .padding(top = 6.dp)
                                .size(width = 48.dp, height = 10.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(selection),
                        )
                        Box(
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .size(width = 8.dp, height = 14.dp)
                                .background(cursor),
                        )
                    }
                }
                ThemeColorField(
                    label = stringResource(R.string.terminal_theme_bg),
                    color = bg,
                    onClick = { picking = ColorSlot.Background },
                )
                ThemeColorField(
                    label = stringResource(R.string.terminal_theme_fg),
                    color = fg,
                    onClick = { picking = ColorSlot.Foreground },
                )
                ThemeColorField(
                    label = stringResource(R.string.terminal_theme_cursor),
                    color = cursor,
                    onClick = { picking = ColorSlot.Cursor },
                )
                ThemeColorField(
                    label = stringResource(R.string.terminal_theme_selection),
                    color = selection,
                    onClick = { picking = ColorSlot.Selection },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val palette = TerminalPalettes.withCoreColors(
                        base = theme.palette,
                        background = toPacked(bg),
                        foreground = toPacked(fg),
                        cursor = toPacked(cursor),
                        selection = toPacked(selection),
                    )
                    onSave(name.trim().ifBlank { theme.label }, palette)
                },
            ) {
                Text(stringResource(R.string.common_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )

    picking?.let { slot ->
        val current = when (slot) {
            ColorSlot.Background -> bg
            ColorSlot.Foreground -> fg
            ColorSlot.Cursor -> cursor
            ColorSlot.Selection -> selection
        }
        val title = when (slot) {
            ColorSlot.Background -> stringResource(R.string.terminal_theme_bg)
            ColorSlot.Foreground -> stringResource(R.string.terminal_theme_fg)
            ColorSlot.Cursor -> stringResource(R.string.terminal_theme_cursor)
            ColorSlot.Selection -> stringResource(R.string.terminal_theme_selection)
        }
        ColorPickerDialog(
            title = title,
            initial = current,
            onDismiss = { picking = null },
            onConfirm = { color ->
                when (slot) {
                    ColorSlot.Background -> bg = color
                    ColorSlot.Foreground -> fg = color
                    ColorSlot.Cursor -> cursor = color
                    ColorSlot.Selection -> selection = color
                }
                picking = null
            },
        )
    }
}

private enum class ColorSlot { Background, Foreground, Cursor, Selection }

@Composable
private fun ThemeColorField(
    label: String,
    color: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(color)
                .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.45f), RoundedCornerShape(8.dp)),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Text(
                colorToHex(color),
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ColorPickerDialog(
    title: String,
    initial: Color,
    onDismiss: () -> Unit,
    onConfirm: (Color) -> Unit,
) {
    val hsv = remember(initial) { colorToHsv(initial) }
    var hue by remember { mutableFloatStateOf(hsv[0]) }
    var sat by remember { mutableFloatStateOf(hsv[1]) }
    var value by remember { mutableFloatStateOf(hsv[2]) }
    val color = Color.hsv(hue.coerceIn(0f, 360f), sat.coerceIn(0f, 1f), value.coerceIn(0f, 1f))

    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
        modifier = Modifier
            .fillMaxWidth(0.94f)
            .padding(8.dp),
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(color)
                        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f), RoundedCornerShape(12.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        colorToHex(color),
                        color = if (value > 0.55f) Color.Black else Color.White,
                        style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace),
                    )
                }

                ColorSlider(
                    label = stringResource(R.string.terminal_theme_color_hue),
                    value = hue,
                    valueRange = 0f..360f,
                    brush = Brush.horizontalGradient(
                        listOf(
                            Color.Red, Color.Yellow, Color.Green,
                            Color.Cyan, Color.Blue, Color.Magenta, Color.Red,
                        ),
                    ),
                    onValueChange = { hue = it },
                )
                ColorSlider(
                    label = stringResource(R.string.terminal_theme_color_sat),
                    value = sat,
                    valueRange = 0f..1f,
                    brush = Brush.horizontalGradient(
                        listOf(
                            Color.hsv(hue, 0f, value.coerceAtLeast(0.2f)),
                            Color.hsv(hue, 1f, value.coerceAtLeast(0.2f)),
                        ),
                    ),
                    onValueChange = { sat = it },
                )
                ColorSlider(
                    label = stringResource(R.string.terminal_theme_color_value),
                    value = value,
                    valueRange = 0f..1f,
                    brush = Brush.horizontalGradient(
                        listOf(Color.Black, Color.hsv(hue, sat, 1f)),
                    ),
                    onValueChange = { value = it },
                )

                // Quick presets for common terminal-ish colors
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf(
                        Color(0xFF0B1220),
                        Color(0xFF10151F),
                        Color(0xFFF4EFE3),
                        Color(0xFFD0D0D0),
                        Color(0xFF7DD3FC),
                        Color(0xFF34D399),
                        Color(0xFFFBBF24),
                        Color(0xFFEF4444),
                    ).forEach { preset ->
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(preset)
                                .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f), CircleShape)
                                .clickable {
                                    val p = colorToHsv(preset)
                                    hue = p[0]
                                    sat = p[1]
                                    value = p[2]
                                },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(color) }) {
                Text(stringResource(R.string.common_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
private fun ColorSlider(
    label: String,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    brush: Brush,
    onValueChange: (Float) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(18.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(brush),
        )
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            colors = SliderDefaults.colors(
                thumbColor = MaterialTheme.colorScheme.primary,
                activeTrackColor = Color.Transparent,
                inactiveTrackColor = Color.Transparent,
            ),
        )
    }
}

private fun colorToHsv(color: Color): FloatArray {
    val hsv = FloatArray(3)
    android.graphics.Color.colorToHSV(color.toArgb(), hsv)
    return hsv
}
