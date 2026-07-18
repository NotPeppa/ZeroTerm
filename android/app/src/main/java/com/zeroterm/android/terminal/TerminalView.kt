package com.zeroterm.android.terminal

import android.content.Context
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.magnifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.graphics.Paint as AndroidPaint
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max

/**
 * Hybrid View: Android [FrameLayout] for IME ([onCreateInputConnection]),
 * Compose Canvas for cell painting (RFC-003 scheme B).
 */
class TerminalHostView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {
    var onTextInput: ((String) -> Unit)? = null
    var onKeyBytes: ((ByteArray) -> Unit)? = null
    var onSizeChangedCells: ((cols: Int, rows: Int) -> Unit)? = null
    /** Scroll into history: positive delta = older lines. */
    var onScrollLines: ((delta: Int) -> Unit)? = null
    var onSelectionChanged: ((hasSelection: Boolean) -> Unit)? = null

    val grid = TermGridState()
    private val compose = ComposeView(context)
    private var fontSizeState = mutableFloatStateOf(13f)
    private var backgroundPathState = mutableStateOf("")
    private var backgroundOpacityState = mutableFloatStateOf(0.4f)
    private var backgroundBlurState = mutableFloatStateOf(0f)
    private var themeBackgroundState = mutableStateOf(Color(0xFF0B1220))
    private var themeCursorState = mutableStateOf(Color(0xAAD0D0D0))
    private var themeSelectionState = mutableStateOf(Color(0x665B9DFF))
    private var themeDefaultBgState = mutableStateOf(Color(0xFF0B1220))
    var onFontSizeChanged: ((Float) -> Unit)? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        // Allow AppBackground / parent glass layers to show through.
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        compose.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        addView(compose, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        compose.setContent {
            val fontSp = fontSizeState.floatValue
            TerminalCanvas(
                grid = grid,
                fontSizeSp = fontSp,
                backgroundImagePath = backgroundPathState.value,
                backgroundOpacity = backgroundOpacityState.floatValue,
                backgroundBlurDp = backgroundBlurState.floatValue,
                themeBackground = themeBackgroundState.value,
                themeCursor = themeCursorState.value,
                themeSelection = themeSelectionState.value,
                themeDefaultBackground = themeDefaultBgState.value,
                onTap = {
                    grid.clearSelection()
                    onSelectionChanged?.invoke(false)
                    requestFocus()
                    showIme()
                },
                onSizeCells = { c, r -> onSizeChangedCells?.invoke(c, r) },
                onScrollLines = { d -> onScrollLines?.invoke(d) },
                onSelectionChanged = { onSelectionChanged?.invoke(it) },
                onFontScale = { factor ->
                    val next = (fontSizeState.floatValue * factor).coerceIn(9f, 28f)
                    if (kotlin.math.abs(next - fontSizeState.floatValue) > 0.05f) {
                        fontSizeState.floatValue = next
                        onFontSizeChanged?.invoke(next)
                    }
                },
            )
        }
    }

    fun setFontSizeSp(sp: Float) {
        fontSizeState.floatValue = sp.coerceIn(9f, 28f)
        compose.invalidate()
    }

    fun fontSizeSp(): Float = fontSizeState.floatValue

    fun setBackgroundConfig(path: String, opacity: Float, blurDp: Int) {
        backgroundPathState.value = path
        backgroundOpacityState.floatValue = opacity.coerceIn(0.05f, 1f)
        backgroundBlurState.floatValue = blurDp.coerceIn(0, 30).toFloat()
        compose.invalidate()
    }

    fun setThemeColors(
        background: Color,
        cursor: Color,
        selection: Color,
        defaultCellBackground: Color = background,
    ) {
        themeBackgroundState.value = background
        themeCursorState.value = cursor
        themeSelectionState.value = selection
        themeDefaultBgState.value = defaultCellBackground
        compose.invalidate()
    }

    fun applyFrame(frame: com.zeroterm.ffi.DamageFrame) {
        grid.apply(frame)
        compose.invalidate()
    }

    fun clearSelection() {
        grid.clearSelection()
        onSelectionChanged?.invoke(false)
        compose.invalidate()
    }

    fun selectedText(): String = grid.selectedText()

    fun showIme() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = EditorInfo.TYPE_CLASS_TEXT or
            EditorInfo.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            EditorInfo.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI
        return object : BaseInputConnection(this, true) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                if (!text.isNullOrEmpty()) {
                    onTextInput?.invoke(text.toString())
                }
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action != KeyEvent.ACTION_DOWN) return true
                val bytes = keyEventToBytes(event) ?: return true
                onKeyBytes?.invoke(bytes)
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (beforeLength > 0) {
                    onKeyBytes?.invoke(byteArrayOf(0x7f))
                }
                return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val bytes = keyEventToBytes(event)
        if (bytes != null) {
            onKeyBytes?.invoke(bytes)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TerminalCanvas(
    grid: TermGridState,
    fontSizeSp: Float,
    backgroundImagePath: String = "",
    backgroundOpacity: Float = 0.4f,
    backgroundBlurDp: Float = 0f,
    themeBackground: Color = Color(0xFF0B1220),
    themeCursor: Color = Color(0xAAD0D0D0),
    themeSelection: Color = Color(0x665B9DFF),
    themeDefaultBackground: Color = Color(0xFF0B1220),
    onTap: () -> Unit,
    onSizeCells: (cols: Int, rows: Int) -> Unit,
    onScrollLines: (delta: Int) -> Unit,
    onSelectionChanged: (Boolean) -> Unit,
    onFontScale: (Float) -> Unit = {},
) {
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    val fontPx = with(density) { fontSizeSp.sp.toPx() }
    val paint = remember {
        AndroidPaint(AndroidPaint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.MONOSPACE
            textAlign = AndroidPaint.Align.LEFT
        }
    }
    paint.textSize = fontPx
    val cellW = paint.measureText("M").coerceAtLeast(1f)
    val cellH = (paint.fontSpacing * 1.15f).coerceAtLeast(1f)
    var viewSize by remember { mutableStateOf(IntSize.Zero) }
    val rev = grid.revision
    var scrollAccum by remember { mutableFloatStateOf(0f) }
    var draggingHandle by remember { mutableStateOf<SelectionHandle?>(null) }
    var handleDragCorrection by remember { mutableStateOf(Offset.Zero) }
    var magnifierSource by remember { mutableStateOf(Offset.Unspecified) }
    val handleRadiusPx = with(density) { 9.dp.toPx() }
    // Keep the visual affordance compact while meeting Android's 48dp touch target.
    val handleHitPx = with(density) { 24.dp.toPx() }

    LaunchedEffect(viewSize, cellW, cellH) {
        if (viewSize.width > 0 && viewSize.height > 0) {
            val cols = max(2, floor(viewSize.width / cellW).toInt())
            val rows = max(1, floor(viewSize.height / cellH).toInt())
            onSizeCells(cols, rows)
        }
    }

    fun cellAt(pos: Offset): Pair<Int, Int> {
        val col = floor(pos.x / cellW).toInt().coerceIn(0, (grid.cols - 1).coerceAtLeast(0))
        val row = floor(pos.y / cellH).toInt().coerceIn(0, (grid.rows - 1).coerceAtLeast(0))
        return row to col
    }

    fun handleGeometries(): Pair<SelectionHandleGeometry, SelectionHandleGeometry>? {
        val bounds = grid.orderedBounds() ?: return null
        fun geometry(row: Int, logicalX: Float, start: Boolean): SelectionHandleGeometry {
            val logical = Offset(logicalX, (row + 1) * cellH)
            val below = logical.y + handleRadiusPx * 0.75f
            val centerY = if (below + handleRadiusPx <= viewSize.height) {
                below
            } else {
                row * cellH - handleRadiusPx * 0.75f
            }
            val centerX = logical.x + handleRadiusPx * if (start) -0.45f else 0.45f
            return SelectionHandleGeometry(
                logical = logical,
                center = Offset(
                    centerX.coerceIn(handleRadiusPx, (viewSize.width - handleRadiusPx).coerceAtLeast(handleRadiusPx)),
                    centerY.coerceIn(handleRadiusPx, (viewSize.height - handleRadiusPx).coerceAtLeast(handleRadiusPx)),
                ),
            )
        }
        val start = geometry(
            row = bounds.startRow,
            logicalX = bounds.startCol * cellW,
            start = true,
        )
        val end = geometry(
            row = bounds.endRow,
            logicalX = (bounds.endCol + 1) * cellW,
            start = false,
        )
        return start to end
    }

    fun hitHandle(pos: Offset): SelectionHandle? {
        val geometries = handleGeometries() ?: return null
        val (start, end) = geometries
        val dStart = hypot(pos.x - start.center.x, pos.y - start.center.y)
        val dEnd = hypot(pos.x - end.center.x, pos.y - end.center.y)
        return when {
            dStart <= handleHitPx && dStart <= dEnd -> SelectionHandle.Start
            dEnd <= handleHitPx -> SelectionHandle.End
            else -> null
        }
    }

    fun logicalPositionFor(handle: SelectionHandle): Offset? {
        val (start, end) = handleGeometries() ?: return null
        return if (handle == SelectionHandle.Start) start.logical else end.logical
    }

    fun selectionCellAt(pos: Offset, handle: SelectionHandle): Pair<Int, Int> {
        val row = (ceil(pos.y / cellH).toInt() - 1)
            .coerceIn(0, (grid.rows - 1).coerceAtLeast(0))
        val col = when (handle) {
            SelectionHandle.Start -> floor(pos.x / cellW).toInt()
            SelectionHandle.End -> ceil(pos.x / cellW).toInt() - 1
        }.coerceIn(0, (grid.cols - 1).coerceAtLeast(0))
        return row to col
    }

    fun moveDraggedHandle(position: Offset) {
        when (draggingHandle) {
            SelectionHandle.Start -> {
                val logical = position + handleDragCorrection
                val (r, c) = selectionCellAt(logical, SelectionHandle.Start)
                if (grid.moveSelectionStart(r, c)) {
                    draggingHandle = SelectionHandle.End
                    handleDragCorrection = logicalPositionFor(SelectionHandle.End)
                        ?.minus(position) ?: Offset.Zero
                }
            }
            SelectionHandle.End -> {
                val logical = position + handleDragCorrection
                val (r, c) = selectionCellAt(logical, SelectionHandle.End)
                if (grid.moveSelectionEnd(r, c)) {
                    draggingHandle = SelectionHandle.Start
                    handleDragCorrection = logicalPositionFor(SelectionHandle.Start)
                        ?.minus(position) ?: Offset.Zero
                }
            }
            null -> Unit
        }
    }

    fun finishDrag() {
        scrollAccum = 0f
        draggingHandle = null
        handleDragCorrection = Offset.Zero
        magnifierSource = Offset.Unspecified
    }

    // AppBackground already paints the custom image under the NavHost.
    // Keep this surface transparent so it is not covered by theme fill.
    val hasCustomBackground = backgroundImagePath.isNotBlank()
    Box(
        Modifier
            .fillMaxSize()
            .background(if (hasCustomBackground) Color.Transparent else themeBackground),
    ) {
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { viewSize = it }
                .magnifier(
                    sourceCenter = { magnifierSource },
                    magnifierCenter = {
                        if (magnifierSource.isSpecified) {
                            magnifierSource - Offset(0f, 72.dp.toPx())
                        } else {
                            Offset.Unspecified
                        }
                    },
                    zoom = 1.8f,
                    size = DpSize(88.dp, 56.dp),
                    cornerRadius = 28.dp,
                    elevation = 8.dp,
                    clip = true,
                )
                // A single recognizer owns tap, scroll, long-press selection,
                // handle dragging, and pinch zoom. This prevents gesture
                // detectors from consuming each other's pointer changes.
                .pointerInput(cellW, cellH, grid.cols, grid.rows, handleHitPx, viewSize) {
                    awaitEachGesture {
                        finishDrag()
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val downPosition = down.position
                        var lastPosition = downPosition
                        var mode = TerminalGestureMode.Pending
                        var decisionEvent: androidx.compose.ui.input.pointer.PointerEvent? = null
                        val initialHandle = hitHandle(downPosition)

                        if (initialHandle != null) {
                            draggingHandle = initialHandle
                            handleDragCorrection = logicalPositionFor(initialHandle)
                                ?.minus(downPosition) ?: Offset.Zero
                            while (mode == TerminalGestureMode.Pending) {
                                val event = awaitPointerEvent()
                                decisionEvent = event
                                val pressed = event.changes.filter { it.pressed }
                                val change = event.changes.firstOrNull { it.id == down.id }
                                mode = when {
                                    pressed.size >= 2 -> TerminalGestureMode.Zoom
                                    change == null || !change.pressed -> TerminalGestureMode.Finished
                                    (change.position - downPosition).getDistance() >= viewConfiguration.touchSlop -> {
                                        magnifierSource = (change.position + handleDragCorrection)
                                            .coerceToViewport(viewSize)
                                        TerminalGestureMode.Selection
                                    }
                                    else -> TerminalGestureMode.Pending
                                }
                            }
                        } else {
                            val decided = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                                while (mode == TerminalGestureMode.Pending) {
                                    val event = awaitPointerEvent()
                                    decisionEvent = event
                                    val pressed = event.changes.filter { it.pressed }
                                    val change = event.changes.firstOrNull { it.id == down.id }
                                    mode = when {
                                        pressed.size >= 2 -> TerminalGestureMode.Zoom
                                        change == null || !change.pressed -> TerminalGestureMode.Tap
                                        (change.position - downPosition).getDistance() >= viewConfiguration.touchSlop -> {
                                            TerminalGestureMode.Scroll
                                        }
                                        else -> TerminalGestureMode.Pending
                                    }
                                }
                                true
                            }
                            if (decided == null) {
                                val (r, c) = cellAt(downPosition)
                                grid.beginSelection(r, c)
                                draggingHandle = SelectionHandle.End
                                handleDragCorrection = Offset.Zero
                                magnifierSource = downPosition.coerceToViewport(viewSize)
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                onSelectionChanged(true)
                                mode = TerminalGestureMode.Selection
                            }
                        }

                        when (mode) {
                            TerminalGestureMode.Tap -> onTap()
                            TerminalGestureMode.Scroll -> {
                                var event = decisionEvent
                                while (event != null) {
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    if (!change.pressed) break
                                    val deltaY = change.position.y - lastPosition.y
                                    lastPosition = change.position
                                    scrollAccum += deltaY
                                    val lines = floor(scrollAccum / cellH).toInt()
                                    if (lines != 0) {
                                        scrollAccum -= lines * cellH
                                        onScrollLines(lines)
                                    }
                                    change.consume()
                                    event = awaitPointerEvent()
                                }
                            }
                            TerminalGestureMode.Selection -> {
                                var event = decisionEvent
                                while (true) {
                                    if (event == null) event = awaitPointerEvent()
                                    if (event.changes.count { it.pressed } >= 2) {
                                        mode = TerminalGestureMode.Zoom
                                        decisionEvent = event
                                        break
                                    }
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    if (!change.pressed) break
                                    magnifierSource = (change.position + handleDragCorrection)
                                        .coerceToViewport(viewSize)
                                    moveDraggedHandle(change.position)
                                    change.consume()
                                    event = null
                                }
                            }
                            else -> Unit
                        }

                        if (mode == TerminalGestureMode.Zoom) {
                            var event = decisionEvent
                            while (event != null && event.changes.any { it.pressed }) {
                                val zoom = event.calculateZoom()
                                if (kotlin.math.abs(zoom - 1f) > 0.01f) onFontScale(zoom)
                                event.changes.forEach { change ->
                                    if (change.positionChanged()) change.consume()
                                }
                                event = awaitPointerEvent()
                            }
                        }
                        finishDrag()
                    }
                },
        ) {
            @Suppress("UNUSED_EXPRESSION")
            rev
            drawTermGrid(
                grid = grid,
                cellW = cellW,
                cellH = cellH,
                paint = paint,
                transparentDefaultBackground = hasCustomBackground,
                defaultBackground = themeDefaultBackground,
                selectionColor = themeSelection,
                cursorColor = themeCursor,
                handleRadius = handleRadiusPx,
                viewportSize = viewSize,
            )
        }
    }
}

private enum class SelectionHandle { Start, End }

private enum class TerminalGestureMode { Pending, Tap, Scroll, Selection, Zoom, Finished }

private fun Offset.coerceToViewport(viewport: IntSize): Offset {
    if (!isSpecified || viewport.width <= 0 || viewport.height <= 0) return Offset.Unspecified
    return Offset(
        x.coerceIn(0f, viewport.width.toFloat()),
        y.coerceIn(0f, viewport.height.toFloat()),
    )
}

private data class SelectionHandleGeometry(
    val logical: Offset,
    val center: Offset,
)

private fun isDefaultCellBackground(bg: Color, defaultBackground: Color): Boolean {
    if (bg == defaultBackground || bg == Color.Black || bg == Color(0xFF0B1220)) return true
    // Match RGB even if alpha differs (theme vs cell packing).
    return bg.red == defaultBackground.red &&
        bg.green == defaultBackground.green &&
        bg.blue == defaultBackground.blue
}

private fun DrawScope.drawTermGrid(
    grid: TermGridState,
    cellW: Float,
    cellH: Float,
    paint: AndroidPaint,
    transparentDefaultBackground: Boolean,
    defaultBackground: Color,
    selectionColor: Color,
    cursorColor: Color,
    handleRadius: Float,
    viewportSize: IntSize,
) {
    val native = drawContext.canvas.nativeCanvas
    val baseline = -paint.fontMetrics.ascent
    for (row in 0 until grid.rows) {
        for (col in 0 until grid.cols) {
            val cell = grid.cellAt(row, col)
            val x = col * cellW
            val y = row * cellH
            val w = if (cell.wide) cellW * 2 else cellW
            val isDefaultBackground = isDefaultCellBackground(cell.bg, defaultBackground)
            if (!transparentDefaultBackground || !isDefaultBackground) {
                drawRect(cell.bg, topLeft = Offset(x, y), size = Size(w, cellH))
            }
            if (grid.isSelected(row, col)) {
                drawRect(selectionColor.copy(alpha = 0.4f), topLeft = Offset(x, y), size = Size(w, cellH))
            }
            paint.color = cell.fg.toArgb()
            paint.isFakeBoldText = cell.bold
            paint.isUnderlineText = cell.underline
            val ch = cell.ch.ifEmpty { " " }
            native.drawText(ch, x, y + baseline, paint)
        }
    }
    if (grid.cursorVisible && !grid.hasSelection) {
        val cx = grid.cursorCol * cellW
        val cy = grid.cursorRow * cellH
        drawRect(
            cursorColor.copy(alpha = 0.67f),
            topLeft = Offset(cx, cy),
            size = Size(cellW, cellH),
        )
    }
    // Android-like selection handles (start + end).
    val bounds = grid.orderedBounds()
    if (bounds != null && handleRadius > 0f) {
        val handleColor = selectionColor.copy(alpha = 1f).let {
            // Prefer solid primary-ish handle over translucent selection fill.
            if (it.alpha < 0.9f) Color(0xFF5B9DFF) else it
        }
        fun center(row: Int, logicalX: Float, start: Boolean): Offset {
            val logicalY = (row + 1) * cellH
            val below = logicalY + handleRadius * 0.75f
            val y = if (below + handleRadius <= viewportSize.height) {
                below
            } else {
                row * cellH - handleRadius * 0.75f
            }
            val x = logicalX + handleRadius * if (start) -0.45f else 0.45f
            return Offset(
                x.coerceIn(handleRadius, (viewportSize.width - handleRadius).coerceAtLeast(handleRadius)),
                y.coerceIn(handleRadius, (viewportSize.height - handleRadius).coerceAtLeast(handleRadius)),
            )
        }
        val startCenter = center(bounds.startRow, bounds.startCol * cellW, start = true)
        val endCenter = center(bounds.endRow, (bounds.endCol + 1) * cellW, start = false)
        drawSelectionHandle(startCenter, handleRadius, handleColor, start = true)
        drawSelectionHandle(endCenter, handleRadius, handleColor, start = false)
    }
}

private fun DrawScope.drawSelectionHandle(
    center: Offset,
    radius: Float,
    color: Color,
    start: Boolean,
) {
    // Stem into the selection edge.
    val stemTop = center.y - radius * 0.85f
    drawRect(
        color = color,
        topLeft = Offset(center.x - radius * 0.18f, stemTop - radius * 0.35f),
        size = Size(radius * 0.36f, radius * 0.55f),
    )
    drawCircle(color = color, radius = radius, center = center)
    // Small white ring for contrast on busy terminal backgrounds.
    drawCircle(
        color = Color.White.copy(alpha = 0.92f),
        radius = radius * 0.38f,
        center = center,
    )
    // Subtle directional cue: start handle slightly left, end slightly right.
    val tipX = if (start) center.x - radius * 0.15f else center.x + radius * 0.15f
    drawCircle(color = color, radius = radius * 0.18f, center = Offset(tipX, center.y))
}

private fun Color.toArgb(): Int {
    return android.graphics.Color.argb(
        (alpha * 255).toInt(),
        (red * 255).toInt(),
        (green * 255).toInt(),
        (blue * 255).toInt(),
    )
}

fun keyEventToBytes(event: KeyEvent): ByteArray? {
    val meta = event.metaState
    val ctrl = meta and KeyEvent.META_CTRL_ON != 0
    val alt = meta and KeyEvent.META_ALT_ON != 0
    val code = event.keyCode

    if (ctrl && code in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z) {
        val c = (code - KeyEvent.KEYCODE_A + 1).toByte()
        return byteArrayOf(c)
    }
    when (code) {
        KeyEvent.KEYCODE_ENTER -> return byteArrayOf('\r'.code.toByte())
        KeyEvent.KEYCODE_DEL, KeyEvent.KEYCODE_FORWARD_DEL -> return byteArrayOf(0x7f)
        KeyEvent.KEYCODE_TAB -> return byteArrayOf('\t'.code.toByte())
        KeyEvent.KEYCODE_ESCAPE -> return byteArrayOf(0x1b)
        KeyEvent.KEYCODE_DPAD_UP -> return "\u001b[A".toByteArray()
        KeyEvent.KEYCODE_DPAD_DOWN -> return "\u001b[B".toByteArray()
        KeyEvent.KEYCODE_DPAD_RIGHT -> return "\u001b[C".toByteArray()
        KeyEvent.KEYCODE_DPAD_LEFT -> return "\u001b[D".toByteArray()
        KeyEvent.KEYCODE_MOVE_HOME -> return "\u001b[H".toByteArray()
        KeyEvent.KEYCODE_MOVE_END -> return "\u001b[F".toByteArray()
        KeyEvent.KEYCODE_PAGE_UP -> return "\u001b[5~".toByteArray()
        KeyEvent.KEYCODE_PAGE_DOWN -> return "\u001b[6~".toByteArray()
        KeyEvent.KEYCODE_F1 -> return "\u001bOP".toByteArray()
        KeyEvent.KEYCODE_F2 -> return "\u001bOQ".toByteArray()
        KeyEvent.KEYCODE_F3 -> return "\u001bOR".toByteArray()
        KeyEvent.KEYCODE_F4 -> return "\u001bOS".toByteArray()
        KeyEvent.KEYCODE_F5 -> return "\u001b[15~".toByteArray()
        KeyEvent.KEYCODE_F6 -> return "\u001b[17~".toByteArray()
        KeyEvent.KEYCODE_F7 -> return "\u001b[18~".toByteArray()
        KeyEvent.KEYCODE_F8 -> return "\u001b[19~".toByteArray()
        KeyEvent.KEYCODE_F9 -> return "\u001b[20~".toByteArray()
        KeyEvent.KEYCODE_F10 -> return "\u001b[21~".toByteArray()
        KeyEvent.KEYCODE_F11 -> return "\u001b[23~".toByteArray()
        KeyEvent.KEYCODE_F12 -> return "\u001b[24~".toByteArray()
    }
    val unicode = event.unicodeChar
    if (unicode != 0 && !ctrl) {
        val ch = unicode.toChar()
        val s = if (alt) "\u001b$ch" else ch.toString()
        return s.toByteArray(Charsets.UTF_8)
    }
    return null
}

object TermKeys {
    fun esc() = byteArrayOf(0x1b)
    fun tab() = byteArrayOf('\t'.code.toByte())
    fun ctrl(letter: Char): ByteArray {
        val c = letter.lowercaseChar()
        require(c in 'a'..'z')
        return byteArrayOf((c.code - 'a'.code + 1).toByte())
    }
    fun up() = "\u001b[A".toByteArray()
    fun down() = "\u001b[B".toByteArray()
    fun right() = "\u001b[C".toByteArray()
    fun left() = "\u001b[D".toByteArray()
    fun pgUp() = "\u001b[5~".toByteArray()
    fun pgDn() = "\u001b[6~".toByteArray()
    fun home() = "\u001b[H".toByteArray()
    fun end() = "\u001b[F".toByteArray()
}
