//! VT terminal emulator for ZeroTerm mobile clients.
//!
//! Wraps [`alacritty_terminal`] (Apache-2.0). Host UI feeds PTY bytes via
//! [`Terminal::feed`] and paints dirty cells from [`Terminal::take_damage`].
//!
//! Designed for uniffi: all public types are plain data (no third-party
//! types cross the FFI boundary).

use std::sync::Mutex;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::color::Colors as TermColors;
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Processor, Rgb};

/// Size used when constructing / resizing the inner grid.
#[derive(Debug, Clone, Copy)]
pub struct TermSize {
    pub columns: usize,
    pub screen_lines: usize,
}

impl TermSize {
    pub fn new(columns: u16, screen_lines: u16) -> Self {
        Self {
            columns: (columns as usize).max(2),
            screen_lines: (screen_lines as usize).max(1),
        }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// One cell for the host renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermCell {
    pub ch: char,
    /// Packed RGB 0x00RRGGBB (resolved against the active palette).
    pub fg: u32,
    pub bg: u32,
    /// Bit flags: 1=bold 2=dim 4=italic 8=underline 16=inverse 32=strikethrough 64=wide
    pub flags: u16,
}

/// A damaged (or full) screen line.
#[derive(Debug, Clone)]
pub struct DamageLine {
    pub row: u16,
    pub cells: Vec<TermCell>,
}

/// Snapshot returned by [`Terminal::take_damage`].
#[derive(Debug, Clone)]
pub struct DamageFrame {
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_visible: bool,
    /// When true, every line in `lines` is present (full redraw).
    pub full: bool,
    pub lines: Vec<DamageLine>,
}

/// VT terminal. Thread-safe for feed from session callbacks + paint from UI.
pub struct Terminal {
    inner: Mutex<Inner>,
}

struct Inner {
    term: Term<VoidListener>,
    parser: Processor,
    size: TermSize,
    /// Tracks whether anything changed since last take_damage (for cheap skip).
    dirty: bool,
}

impl Terminal {
    pub fn new(cols: u16, rows: u16, scrollback: u32) -> Self {
        let size = TermSize::new(cols, rows);
        let mut config = Config::default();
        config.scrolling_history = scrollback as usize;
        let term = Term::new(config, &size, VoidListener);
        Self {
            inner: Mutex::new(Inner {
                term,
                parser: Processor::new(),
                size,
                dirty: true,
            }),
        }
    }

    /// Feed raw PTY bytes (VT sequences + text).
    pub fn feed(&self, data: &[u8]) {
        let mut g = self.inner.lock().unwrap();
        // Split fields to satisfy the borrow checker (parser + term both mut).
        let Inner {
            ref mut term,
            ref mut parser,
            ref mut dirty,
            ..
        } = *g;
        for &b in data {
            parser.advance(term, b);
        }
        *dirty = true;
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let mut g = self.inner.lock().unwrap();
        let size = TermSize::new(cols, rows);
        if size.columns == g.size.columns && size.screen_lines == g.size.screen_lines {
            return;
        }
        g.term.resize(size);
        g.size = size;
        g.dirty = true;
    }

    pub fn cols(&self) -> u16 {
        self.inner.lock().unwrap().size.columns as u16
    }

    pub fn rows(&self) -> u16 {
        self.inner.lock().unwrap().size.screen_lines as u16
    }

    /// Scroll display by `delta` lines (positive = scroll up into history).
    pub fn scroll_display(&self, delta: i32) {
        let mut g = self.inner.lock().unwrap();
        if delta == 0 {
            return;
        }
        g.term.scroll_display(Scroll::Delta(delta));
        g.dirty = true;
    }

    /// Jump to the live bottom of the scrollback.
    pub fn scroll_to_bottom(&self) {
        let mut g = self.inner.lock().unwrap();
        g.term.scroll_display(Scroll::Bottom);
        g.dirty = true;
    }

    /// Current display offset (0 = live bottom; larger = scrolled into history).
    pub fn display_offset(&self) -> u32 {
        self.inner.lock().unwrap().term.grid().display_offset() as u32
    }

    /// Plain text of the current viewport (for copy-all). Trailing spaces trimmed per line.
    pub fn viewport_text(&self) -> String {
        let frame = self.snapshot();
        let mut out = String::new();
        for line in &frame.lines {
            let mut s: String = line.cells.iter().map(|c| c.ch).collect();
            while s.ends_with(' ') {
                s.pop();
            }
            out.push_str(&s);
            out.push('\n');
        }
        out
    }

    /// Collect damage since last call and reset the damage tracker.
    /// Returns `None` if nothing changed (callers can skip redraw).
    pub fn take_damage(&self) -> Option<DamageFrame> {
        let mut g = self.inner.lock().unwrap();
        let cols = g.size.columns;
        let rows = g.size.screen_lines;
        let was_dirty = g.dirty;

        // Collect damaged row indices first (damage borrows term mutably).
        let (full, mut line_rows): (bool, Vec<usize>) = {
            let damage = g.term.damage();
            match damage {
                TermDamage::Full => (true, (0..rows).collect()),
                TermDamage::Partial(it) => (false, it.map(|b| b.line).collect()),
            }
        };

        let content = g.term.renderable_content();
        let colors = content.colors;
        let cursor = content.cursor;
        let show_cursor = content.mode.contains(TermMode::SHOW_CURSOR)
            && cursor.shape != alacritty_terminal::vte::ansi::CursorShape::Hidden;
        let cursor_row = cursor.point.line.0.max(0) as usize;
        let cursor_col = cursor.point.column.0 as u16;

        if !line_rows.contains(&cursor_row) && cursor_row < rows {
            line_rows.push(cursor_row);
        }
        line_rows.sort_unstable();
        line_rows.dedup();

        if line_rows.is_empty() && !was_dirty {
            g.term.reset_damage();
            return None;
        }

        let mut viewport: Vec<Vec<TermCell>> = (0..rows)
            .map(|_| {
                (0..cols)
                    .map(|_| TermCell {
                        ch: ' ',
                        fg: resolve_color(AnsiColor::Named(NamedColor::Foreground), colors),
                        bg: resolve_color(AnsiColor::Named(NamedColor::Background), colors),
                        flags: 0,
                    })
                    .collect()
            })
            .collect();

        for indexed in content.display_iter {
            let row = indexed.point.line.0;
            let col = indexed.point.column.0;
            if row < 0 || row as usize >= rows || col >= cols {
                continue;
            }
            let cell = &indexed.cell;
            if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                continue;
            }
            viewport[row as usize][col] = cell_to_term(cell, colors);
        }

        let lines: Vec<DamageLine> = line_rows
            .into_iter()
            .filter(|&r| r < rows)
            .map(|r| DamageLine {
                row: r as u16,
                cells: viewport[r].clone(),
            })
            .collect();

        g.term.reset_damage();
        g.dirty = false;

        Some(DamageFrame {
            cols: cols as u16,
            rows: rows as u16,
            cursor_col,
            cursor_row: cursor_row as u16,
            cursor_visible: show_cursor,
            full,
            lines,
        })
    }

    /// Full viewport snapshot (ignores damage). Useful after resize.
    pub fn snapshot(&self) -> DamageFrame {
        let g = self.inner.lock().unwrap();
        let cols = g.size.columns;
        let rows = g.size.screen_lines;
        let content = g.term.renderable_content();
        let colors = content.colors;
        let cursor = content.cursor;
        let show_cursor = content.mode.contains(TermMode::SHOW_CURSOR)
            && cursor.shape != alacritty_terminal::vte::ansi::CursorShape::Hidden;

        let mut viewport: Vec<Vec<TermCell>> = (0..rows)
            .map(|_| {
                (0..cols)
                    .map(|_| TermCell {
                        ch: ' ',
                        fg: resolve_color(AnsiColor::Named(NamedColor::Foreground), colors),
                        bg: resolve_color(AnsiColor::Named(NamedColor::Background), colors),
                        flags: 0,
                    })
                    .collect()
            })
            .collect();

        for indexed in content.display_iter {
            let row = indexed.point.line.0;
            let col = indexed.point.column.0;
            if row < 0 || row as usize >= rows || col >= cols {
                continue;
            }
            let cell = &indexed.cell;
            if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                continue;
            }
            viewport[row as usize][col] = cell_to_term(cell, colors);
        }

        let lines: Vec<DamageLine> = (0..rows)
            .map(|r| DamageLine {
                row: r as u16,
                cells: viewport[r].clone(),
            })
            .collect();

        DamageFrame {
            cols: cols as u16,
            rows: rows as u16,
            cursor_col: cursor.point.column.0 as u16,
            cursor_row: cursor.point.line.0.max(0) as u16,
            cursor_visible: show_cursor,
            full: true,
            lines,
        }
    }
}

// --- color / cell helpers --------------------------------------------------

const FLAG_BOLD: u16 = 1;
const FLAG_DIM: u16 = 2;
const FLAG_ITALIC: u16 = 4;
const FLAG_UNDERLINE: u16 = 8;
const FLAG_INVERSE: u16 = 16;
const FLAG_STRIKE: u16 = 32;
const FLAG_WIDE: u16 = 64;

fn cell_to_term(cell: &alacritty_terminal::term::cell::Cell, colors: &TermColors) -> TermCell {
    let mut flags = 0u16;
    if cell.flags.contains(CellFlags::BOLD) {
        flags |= FLAG_BOLD;
    }
    if cell.flags.contains(CellFlags::DIM) {
        flags |= FLAG_DIM;
    }
    if cell.flags.contains(CellFlags::ITALIC) {
        flags |= FLAG_ITALIC;
    }
    if cell.flags.intersects(CellFlags::ALL_UNDERLINES) {
        flags |= FLAG_UNDERLINE;
    }
    if cell.flags.contains(CellFlags::INVERSE) {
        flags |= FLAG_INVERSE;
    }
    if cell.flags.contains(CellFlags::STRIKEOUT) {
        flags |= FLAG_STRIKE;
    }
    if cell.flags.contains(CellFlags::WIDE_CHAR) {
        flags |= FLAG_WIDE;
    }

    let mut fg = resolve_color(cell.fg, colors);
    let mut bg = resolve_color(cell.bg, colors);
    if cell.flags.contains(CellFlags::INVERSE) {
        std::mem::swap(&mut fg, &mut bg);
    }

    TermCell {
        ch: if cell.c == '\0' { ' ' } else { cell.c },
        fg,
        bg,
        flags,
    }
}

fn resolve_color(color: AnsiColor, colors: &TermColors) -> u32 {
    match color {
        AnsiColor::Named(n) => named_rgb(n, colors),
        AnsiColor::Spec(rgb) => pack_rgb(rgb),
        AnsiColor::Indexed(i) => indexed_rgb(i, colors),
    }
}

fn pack_rgb(rgb: Rgb) -> u32 {
    ((rgb.r as u32) << 16) | ((rgb.g as u32) << 8) | (rgb.b as u32)
}

fn named_rgb(n: NamedColor, colors: &TermColors) -> u32 {
    if let Some(rgb) = colors[n] {
        return pack_rgb(rgb);
    }
    // XTerm default 16 + specials
    match n {
        NamedColor::Black => 0x000000,
        NamedColor::Red => 0xcd0000,
        NamedColor::Green => 0x00cd00,
        NamedColor::Yellow => 0xcdcd00,
        NamedColor::Blue => 0x0000ee,
        NamedColor::Magenta => 0xcd00cd,
        NamedColor::Cyan => 0x00cdcd,
        NamedColor::White => 0xe5e5e5,
        NamedColor::BrightBlack => 0x7f7f7f,
        NamedColor::BrightRed => 0xff0000,
        NamedColor::BrightGreen => 0x00ff00,
        NamedColor::BrightYellow => 0xffff00,
        NamedColor::BrightBlue => 0x5c5cff,
        NamedColor::BrightMagenta => 0xff00ff,
        NamedColor::BrightCyan => 0x00ffff,
        NamedColor::BrightWhite => 0xffffff,
        NamedColor::Foreground => 0xd0d0d0,
        NamedColor::Background => 0x0b1220,
        NamedColor::Cursor => 0xd0d0d0,
        _ => 0xd0d0d0,
    }
}

fn indexed_rgb(i: u8, colors: &TermColors) -> u32 {
    if let Some(rgb) = colors[i as usize] {
        return pack_rgb(rgb);
    }
    match i {
        0 => 0x000000,
        1 => 0xcd0000,
        2 => 0x00cd00,
        3 => 0xcdcd00,
        4 => 0x0000ee,
        5 => 0xcd00cd,
        6 => 0x00cdcd,
        7 => 0xe5e5e5,
        8 => 0x7f7f7f,
        9 => 0xff0000,
        10 => 0x00ff00,
        11 => 0xffff00,
        12 => 0x5c5cff,
        13 => 0xff00ff,
        14 => 0x00ffff,
        15 => 0xffffff,
        16..=231 => {
            let n = i - 16;
            let r = n / 36;
            let g = (n % 36) / 6;
            let b = n % 6;
            let c = |v: u8| if v == 0 { 0 } else { 55 + 40 * v as u32 };
            (c(r) << 16) | (c(g) << 8) | c(b)
        }
        232..=255 => {
            let v = 8 + 10 * (i as u32 - 232);
            (v << 16) | (v << 8) | v
        }
    }
}

// Silence unused import warnings for types only used in docs/tests.
#[allow(dead_code)]
fn _keep_point_types() {
    let _ = Point::new(Line(0), Column(0));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_appears_in_snapshot() {
        let t = Terminal::new(40, 10, 1000);
        t.feed(b"hello");
        let frame = t.take_damage().expect("damage");
        assert!(frame.cols >= 40);
        let row0 = frame.lines.iter().find(|l| l.row == 0).expect("row 0");
        let s: String = row0.cells.iter().map(|c| c.ch).collect();
        assert!(s.starts_with("hello"), "got {s:?}");
    }

    #[test]
    fn sgr_color_does_not_panic() {
        let t = Terminal::new(80, 24, 1000);
        t.feed(b"\x1b[31mred\x1b[0m normal\n");
        let frame = t.take_damage().expect("damage");
        assert!(!frame.lines.is_empty());
    }

    #[test]
    fn resize_changes_dimensions() {
        let t = Terminal::new(40, 10, 100);
        t.resize(80, 24);
        assert_eq!(t.cols(), 80);
        assert_eq!(t.rows(), 24);
        let frame = t.snapshot();
        assert_eq!(frame.cols, 80);
        assert_eq!(frame.rows, 24);
    }

    #[test]
    fn cjk_wide_char() {
        let t = Terminal::new(20, 5, 100);
        t.feed("中".as_bytes());
        let frame = t.take_damage().expect("damage");
        let row0 = frame.lines.iter().find(|l| l.row == 0).unwrap();
        assert_eq!(row0.cells[0].ch, '中');
        assert_ne!(row0.cells[0].flags & FLAG_WIDE, 0);
    }

    #[test]
    fn scroll_and_viewport_text() {
        let t = Terminal::new(40, 5, 200);
        for i in 0..20 {
            t.feed(format!("line{i}\r\n").as_bytes());
        }
        assert_eq!(t.display_offset(), 0);
        t.scroll_display(3);
        assert!(t.display_offset() >= 1);
        let text = t.viewport_text();
        assert!(text.contains("line"), "got {text:?}");
        t.scroll_to_bottom();
        assert_eq!(t.display_offset(), 0);
    }
}
