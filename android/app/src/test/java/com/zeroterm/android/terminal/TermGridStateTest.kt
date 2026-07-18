package com.zeroterm.android.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TermGridStateTest {
    @Test
    fun movingStartPastEndFlipsDraggedHandle() {
        val grid = TermGridState()
        grid.beginSelection(row = 2, col = 3)
        grid.extendSelection(row = 2, col = 5)

        assertTrue(grid.moveSelectionStart(row = 2, col = 7))
        assertEquals(
            TermGridState.OrderedBounds(2, 5, 2, 7),
            grid.orderedBounds(),
        )
    }

    @Test
    fun movingEndBeforeStartFlipsDraggedHandle() {
        val grid = TermGridState()
        grid.beginSelection(row = 4, col = 6)
        grid.extendSelection(row = 5, col = 2)

        assertTrue(grid.moveSelectionEnd(row = 3, col = 7))
        assertEquals(
            TermGridState.OrderedBounds(3, 7, 4, 6),
            grid.orderedBounds(),
        )
    }

    @Test
    fun movingHandleWithinBoundsDoesNotFlipIt() {
        val grid = TermGridState()
        grid.beginSelection(row = 1, col = 1)
        grid.extendSelection(row = 3, col = 3)

        assertFalse(grid.moveSelectionStart(row = 2, col = 2))
        assertFalse(grid.moveSelectionEnd(row = 3, col = 6))
        assertEquals(
            TermGridState.OrderedBounds(2, 2, 3, 6),
            grid.orderedBounds(),
        )
    }
}
