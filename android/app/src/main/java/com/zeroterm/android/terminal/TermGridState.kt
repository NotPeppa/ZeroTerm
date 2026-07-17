package com.zeroterm.android.terminal

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import com.zeroterm.ffi.DamageFrame
import com.zeroterm.ffi.TermCell
import kotlin.math.max
import kotlin.math.min

/**
 * Mutable screen buffer for Compose Canvas. Apply [DamageFrame] from FFI.
 */
class TermGridState {
    var cols by mutableIntStateOf(80)
        private set
    var rows by mutableIntStateOf(24)
        private set
    var cursorCol by mutableIntStateOf(0)
        private set
    var cursorRow by mutableIntStateOf(0)
        private set
    var cursorVisible by mutableStateOf(true)
        private set
    /** Revision bumps trigger redraw. */
    var revision by mutableIntStateOf(0)
        private set

    /** Inclusive selection corners in cell coordinates, or null. */
    var selStartRow by mutableStateOf<Int?>(null)
        private set
    var selStartCol by mutableStateOf<Int?>(null)
        private set
    var selEndRow by mutableStateOf<Int?>(null)
        private set
    var selEndCol by mutableStateOf<Int?>(null)
        private set

    val hasSelection: Boolean
        get() = selStartRow != null && selEndRow != null

    private var cells: Array<Array<Cell>> = Array(24) { Array(80) { Cell.blank() } }

    fun cellAt(row: Int, col: Int): Cell {
        if (row !in 0 until rows || col !in 0 until cols) return Cell.blank()
        return cells[row][col]
    }

    fun apply(frame: DamageFrame) {
        val c = frame.cols.toInt().coerceAtLeast(2)
        val r = frame.rows.toInt().coerceAtLeast(1)
        if (c != cols || r != rows || frame.full) {
            cols = c
            rows = r
            cells = Array(r) { Array(c) { Cell.blank() } }
            clearSelection()
        }
        for (line in frame.lines) {
            val row = line.row.toInt()
            if (row !in 0 until rows) continue
            val src = line.cells
            val dest = cells[row]
            val n = minOf(src.size, cols)
            for (i in 0 until n) {
                dest[i] = Cell.from(src[i])
            }
        }
        cursorCol = frame.cursorCol.toInt().coerceIn(0, (cols - 1).coerceAtLeast(0))
        cursorRow = frame.cursorRow.toInt().coerceIn(0, (rows - 1).coerceAtLeast(0))
        cursorVisible = frame.cursorVisible
        revision++
    }

    fun beginSelection(row: Int, col: Int) {
        val r = row.coerceIn(0, rows - 1)
        val c = col.coerceIn(0, cols - 1)
        selStartRow = r
        selStartCol = c
        selEndRow = r
        selEndCol = c
        revision++
    }

    fun extendSelection(row: Int, col: Int) {
        if (selStartRow == null) return
        selEndRow = row.coerceIn(0, rows - 1)
        selEndCol = col.coerceIn(0, cols - 1)
        revision++
    }

    fun clearSelection() {
        if (selStartRow == null) return
        selStartRow = null
        selStartCol = null
        selEndRow = null
        selEndCol = null
        revision++
    }

    fun isSelected(row: Int, col: Int): Boolean {
        val r0 = selStartRow ?: return false
        val c0 = selStartCol ?: return false
        val r1 = selEndRow ?: return false
        val c1 = selEndCol ?: return false
        val top = min(r0, r1)
        val bottom = max(r0, r1)
        if (row !in top..bottom) return false
        if (top == bottom) {
            val left = min(c0, c1)
            val right = max(c0, c1)
            return col in left..right
        }
        // Multi-line: full lines in the middle; partial on first/last
        return when (row) {
            top -> {
                val startCol = if (r0 < r1 || (r0 == r1 && c0 <= c1)) c0 else c1
                col >= startCol
            }
            bottom -> {
                val endCol = if (r0 < r1 || (r0 == r1 && c0 <= c1)) c1 else c0
                col <= endCol
            }
            else -> true
        }
    }

    /** Selected plain text with newlines between rows. */
    fun selectedText(): String {
        val r0 = selStartRow ?: return ""
        val c0 = selStartCol ?: return ""
        val r1 = selEndRow ?: return ""
        val c1 = selEndCol ?: return ""
        val top = min(r0, r1)
        val bottom = max(r0, r1)
        val forward = r0 < r1 || (r0 == r1 && c0 <= c1)
        val sb = StringBuilder()
        for (row in top..bottom) {
            val left: Int
            val right: Int
            if (top == bottom) {
                left = min(c0, c1)
                right = max(c0, c1)
            } else if (row == top) {
                left = if (forward) c0 else c1
                right = cols - 1
            } else if (row == bottom) {
                left = 0
                right = if (forward) c1 else c0
            } else {
                left = 0
                right = cols - 1
            }
            val line = StringBuilder()
            for (col in left..right.coerceAtMost(cols - 1)) {
                if (col < 0) continue
                line.append(cellAt(row, col).ch)
            }
            var s = line.toString()
            while (s.endsWith(' ')) s = s.dropLast(1)
            sb.append(s)
            if (row < bottom) sb.append('\n')
        }
        return sb.toString()
    }

    data class Cell(
        val ch: String,
        val fg: Color,
        val bg: Color,
        val bold: Boolean,
        val underline: Boolean,
        val wide: Boolean,
    ) {
        companion object {
            fun blank() = Cell(" ", Color(0xFFD0D0D0), Color(0xFF0B1220), false, false, false)

            fun from(c: TermCell): Cell {
                val ch = c.ch.ifEmpty { " " }
                val flags = c.flags.toInt()
                return Cell(
                    ch = ch,
                    fg = rgb(c.fg),
                    bg = rgb(c.bg),
                    bold = (flags and 1) != 0,
                    underline = (flags and 8) != 0,
                    wide = (flags and 64) != 0,
                )
            }

            private fun rgb(packed: UInt): Color {
                val v = packed.toLong()
                return Color(
                    red = ((v shr 16) and 0xFF).toInt(),
                    green = ((v shr 8) and 0xFF).toInt(),
                    blue = (v and 0xFF).toInt(),
                )
            }
        }
    }
}
