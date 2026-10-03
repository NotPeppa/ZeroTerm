package com.zeroterm.android.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.zeroterm.android.R
import com.zeroterm.android.data.TerminalSidebarFeature
import com.zeroterm.android.ui.terminal.labelResource

@Composable
internal fun TerminalSidebarSettings(
    hiddenIds: Set<String>,
    onToggle: (TerminalSidebarFeature, Boolean) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.settings_sidebar_features), style = MaterialTheme.typography.labelLarge)
        Text(
            stringResource(R.string.settings_sidebar_features_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val fontScale = LocalDensity.current.fontScale
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = (maxWidth.value / (180f * fontScale.coerceAtLeast(1f))).toInt().coerceIn(1, 4)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TerminalSidebarFeature.entries.chunked(columns).forEach { features ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        features.forEach { feature ->
                            val checked = feature.id !in hiddenIds
                            Surface(
                                modifier = Modifier.weight(1f),
                                shape = MaterialTheme.shapes.medium,
                                color = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0.72f),
                                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            ) {
                                Row(
                                    modifier = Modifier
                                        .toggleable(checked, role = Role.Switch, onValueChange = { onToggle(feature, it) })
                                        .heightIn(min = 64.dp)
                                        .padding(horizontal = 12.dp, vertical = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        stringResource(feature.labelResource()),
                                        modifier = Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    Switch(checked = checked, onCheckedChange = null)
                                }
                            }
                        }
                        repeat(columns - features.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
    }
}
