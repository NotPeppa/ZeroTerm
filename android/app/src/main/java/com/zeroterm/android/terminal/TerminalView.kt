package com.zeroterm.android.terminal

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.draw.blur
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.graphics.Paint as AndroidPaint
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.floor
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
    var onFontSizeChanged: ((Float) -> Unit)? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        addView(compose, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        compose.setContent {
            val fontSp = fontSizeState.floatValue
            TerminalCanvas(
                grid = grid,
                fontSizeSp = fontSp,
                backgroundImagePath = backgroundPathState.value,
                backgroundOpacity = backgroundOpacityState.floatValue,
                backgroundBlurDp = backgroundBlurState.floatValue,
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

@Composable
fun TerminalCanvas(
    grid: TermGridState,
    fontSizeSp: Float,
    backgroundImagePath: String = "",
    backgroundOpacity: Float = 0.4f,
    backgroundBlurDp: Float = 0f,
    onTap: () -> Unit,
    onSizeCells: (cols: Int, rows: Int) -> Unit,
    onScrollLines: (delta: Int) -> Unit,
    onSelectionChanged: (Boolean) -> Unit,
    onFontScale: (Float) -> Unit = {},
) {
    val density = LocalDensity.current
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
    var selecting by remember { mutableStateOf(false) }

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

    var backgroundBitmap by remember(backgroundImagePath) {
        mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)
    }
    LaunchedEffect(backgroundImagePath) {
        backgroundBitmap = withContext(Dispatchers.IO) {
            if (backgroundImagePath.isBlank()) null
            else runCatching {
                BitmapFactory.decodeFile(File(backgroundImagePath).absolutePath)?.asImageBitmap()
            }.getOrNull()
        }
    }

    Box(Modifier.fillMaxSize().background(Color(0xFF0B1220))) {
        backgroundBitmap?.let { image ->
            Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                alpha = backgroundOpacity,
                modifier = Modifier
                    .fillMaxSize()
                    .blur(backgroundBlurDp.dp),
            )
        }
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { viewSize = it }
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, zoom, _ ->
                        if (kotlin.math.abs(zoom - 1f) > 0.01f) {
                            onFontScale(zoom)
                        }
                    }
                }
                .pointerInput(cellW, cellH, grid.cols, grid.rows) {
                    detectTapGestures(
                        onTap = {
                            selecting = false
                            onTap()
                        },
                        onLongPress = { offset ->
                            selecting = true
                            val (r, c) = cellAt(offset)
                            grid.beginSelection(r, c)
                            onSelectionChanged(true)
                        },
                    )
                }
                .pointerInput(cellW, cellH, grid.cols, grid.rows) {
                    detectDragGestures(
                        onDragStart = { offset ->
                            if (selecting) {
                                val (r, c) = cellAt(offset)
                                grid.extendSelection(r, c)
                            }
                        },
                        onDrag = { change, dragAmount ->
                            change.consume()
                            if (selecting) {
                                val (r, c) = cellAt(change.position)
                                grid.extendSelection(r, c)
                            } else {
                                scrollAccum += dragAmount.y
                                val lines = floor(scrollAccum / cellH).toInt()
                                if (lines != 0) {
                                    scrollAccum -= lines * cellH
                                    onScrollLines(lines)
                                }
                            }
                        },
                        onDragEnd = { scrollAccum = 0f },
                        onDragCancel = { scrollAccum = 0f },
                    )
                },
        ) {
            @Suppress("UNUSED_EXPRESSION")
            rev
            drawTermGrid(
                grid = grid,
                cellW = cellW,
                cellH = cellH,
                paint = paint,
                transparentDefaultBackground = backgroundBitmap != null,
            )
        }
    }
}

private fun DrawScope.drawTermGrid(
    grid: TermGridState,
    cellW: Float,
    cellH: Float,
    paint: AndroidPaint,
    transparentDefaultBackground: Boolean,
) {
    val native = drawContext.canvas.nativeCanvas
    val baseline = -paint.fontMetrics.ascent
    val selColor = Color(0x665B9DFF)
    for (row in 0 until grid.rows) {
        for (col in 0 until grid.cols) {
            val cell = grid.cellAt(row, col)
            val x = col * cellW
            val y = row * cellH
            val w = if (cell.wide) cellW * 2 else cellW
            val isDefaultBackground = cell.bg == Color(0xFF0B1220) || cell.bg == Color.Black
            if (!transparentDefaultBackground || !isDefaultBackground) {
                drawRect(cell.bg, topLeft = Offset(x, y), size = Size(w, cellH))
            }
            if (grid.isSelected(row, col)) {
                drawRect(selColor, topLeft = Offset(x, y), size = Size(w, cellH))
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
            Color(0xAAD0D0D0),
            topLeft = Offset(cx, cy),
            size = Size(cellW, cellH),
        )
    }
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
