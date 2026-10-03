package com.zeroterm.android.terminal

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.zeroterm.ffi.DamageFrame
import com.zeroterm.ffi.DamageLine
import com.zeroterm.ffi.TermCell
import java.io.File
import kotlin.math.ceil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Pixel regressions using the device's actual Canvas and CJK fallback font. */
@RunWith(AndroidJUnit4::class)
class TerminalRenderingTest {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        textSize = 32f
    }
    private val cellW = paint.measureText("M")
    private val cellH = paint.fontSpacing * 1.15f

    @Test
    fun opaqueBackgroundPreservesBothHalvesOfChineseGlyph() {
        val bitmap = render(grid(), "opaque")
        assertChineseInkOnBothColumns(bitmap)
        assertTrue("Adjacent ASCII must still render", foregroundPixels(bitmap, 2, 3) > 0)
    }

    @Test
    fun coloredWideCellOwnsTheContinuationBackground() {
        val bitmap = render(grid(bg = 0x204060u), "colored")
        assertChineseInkOnBothColumns(bitmap)
        assertEquals("Wide-cell background must cover its second column", bitmap.getPixel(2, 1), bitmap.getPixel(ceil(cellW).toInt() + 2, 1))
        assertEquals(0xFF204060.toInt(), bitmap.getPixel(ceil(cellW).toInt() + 2, 1))
    }

    @Test
    fun selectingEitherHalfHighlightsTheWholeChineseGlyphOnce() {
        for (column in 0..1) {
            val grid = grid().apply { beginSelection(0, column) }
            val bitmap = render(grid, "selected-$column")
            assertChineseInkOnBothColumns(bitmap)
            assertEquals(bitmap.getPixel(2, 1), bitmap.getPixel(ceil(cellW).toInt() + 2, 1))
            assertTrue("Selection must be visible", bitmap.getPixel(2, 1) != android.graphics.Color.BLACK)
        }
    }

    @Test
    fun transparentDefaultBackgroundKeepsTheBackdropAndChineseGlyph() {
        val bitmap = render(grid(), "glass", transparent = true)
        assertChineseInkOnBothColumns(bitmap)
        assertEquals(0xFF121A24.toInt(), bitmap.getPixel(2, 1))
        assertEquals(bitmap.getPixel(2, 1), bitmap.getPixel(ceil(cellW).toInt() + 2, 1))
    }

    @Test
    fun renderMixedChineseAndAsciiPreview() {
        val lines = listOf("图片 1 下载完成：1698.30 KB", "中文、中英混排：ZeroTerm tmux")
        val cells = lines.map { line ->
            buildList {
                line.forEach { ch ->
                    val wide = ch.code >= 0x2E80
                    add(TermCell(ch.toString(), 0x00FF00u, 0u, (if (wide) 64 else 0).toUShort()))
                    if (wide) add(TermCell(" ", 0x00FF00u, 0u, 0u))
                }
            }
        }
        val grid = TermGridState().apply {
            apply(DamageFrame(40u, 2u, 0u, 0u, false, true, cells.mapIndexed { row, line -> DamageLine(row.toUShort(), line) }))
        }
        val bitmap = render(grid, "chinese-preview")
        assertChineseInkOnBothColumns(bitmap)
    }

    private fun grid(bg: UInt = 0u): TermGridState = TermGridState().apply {
        // Match the FFI snapshot: the wide spacer arrives as a default blank,
        // even when the leading character has a non-default background.
        apply(DamageFrame(4u, 1u, 0u, 0u, false, true, listOf(DamageLine(0u, listOf(
            TermCell("中", 0x00FF00u, bg, 64u),
            TermCell(" ", 0x00FF00u, 0u, 0u),
            TermCell("A", 0x00FF00u, 0u, 0u),
            TermCell("B", 0x00FF00u, 0u, 0u),
        )))))
    }

    private fun render(grid: TermGridState, name: String, transparent: Boolean = false): Bitmap {
        val width = ceil(grid.cols * cellW).toInt()
        val height = ceil(grid.rows * cellH).toInt()
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(if (transparent) 0xFF121A24.toInt() else android.graphics.Color.BLACK)
        CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, Canvas(android.graphics.Canvas(bitmap)), Size(width.toFloat(), height.toFloat())) {
            drawTermGrid(grid, cellW, cellH, paint, transparent, 0, Color.Blue, Color.White, 0f, IntSize(width, height))
        }
        val folder = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "terminal-rendering-tests").apply { mkdirs() }
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    private fun assertChineseInkOnBothColumns(bitmap: Bitmap) {
        assertTrue("Left half of Chinese glyph missing", foregroundPixels(bitmap, 0, 1) > 0)
        assertTrue("Right half of Chinese glyph was covered by its spacer", foregroundPixels(bitmap, 1, 2) > 0)
    }

    private fun foregroundPixels(bitmap: Bitmap, fromColumn: Int, toColumn: Int): Int {
        var count = 0
        for (y in 0 until ceil(cellH).toInt()) {
            for (x in ceil(fromColumn * cellW).toInt() until ceil(toColumn * cellW).toInt()) {
                if (bitmap.getPixel(x, y) == android.graphics.Color.GREEN) count++
            }
        }
        return count
    }
}
