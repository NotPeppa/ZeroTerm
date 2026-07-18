//! FFI surface for the VT terminal (`zeroterm-term`).

use std::sync::Arc;

use zeroterm_term::{
    DamageFrame as CoreFrame, Terminal as CoreTerminal, TerminalPalette as CorePalette,
};

/// One cell for the host Canvas renderer.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TermCell {
    pub ch: String,
    /// Packed 0x00RRGGBB.
    pub fg: u32,
    pub bg: u32,
    /// Bit flags: 1=bold 2=dim 4=italic 8=underline 16=inverse 32=strike 64=wide
    pub flags: u16,
}

/// Host-selected terminal color palette (packed 0x00RRGGBB).
#[derive(Debug, Clone, uniffi::Record)]
pub struct TerminalPalette {
    pub background: u32,
    pub foreground: u32,
    pub cursor: u32,
    pub selection: u32,
    pub black: u32,
    pub red: u32,
    pub green: u32,
    pub yellow: u32,
    pub blue: u32,
    pub magenta: u32,
    pub cyan: u32,
    pub white: u32,
    pub bright_black: u32,
    pub bright_red: u32,
    pub bright_green: u32,
    pub bright_yellow: u32,
    pub bright_blue: u32,
    pub bright_magenta: u32,
    pub bright_cyan: u32,
    pub bright_white: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct DamageLine {
    pub row: u16,
    pub cells: Vec<TermCell>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct DamageFrame {
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_visible: bool,
    pub full: bool,
    pub lines: Vec<DamageLine>,
}

/// VT terminal object. Create one per SSH session / local shell.
#[derive(uniffi::Object)]
pub struct Terminal {
    inner: CoreTerminal,
}

#[uniffi::export]
impl Terminal {
    #[uniffi::constructor]
    pub fn new(cols: u16, rows: u16, scrollback: u32) -> Arc<Self> {
        Arc::new(Self {
            inner: CoreTerminal::new(cols.max(2), rows.max(1), scrollback.max(100)),
        })
    }

    pub fn feed(&self, data: Vec<u8>) {
        self.inner.feed(&data);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.inner.resize(cols.max(2), rows.max(1));
    }

    pub fn cols(&self) -> u16 {
        self.inner.cols()
    }

    pub fn rows(&self) -> u16 {
        self.inner.rows()
    }

    /// Scroll display: positive = into history (up), negative = toward bottom.
    pub fn scroll_display(&self, delta: i32) {
        self.inner.scroll_display(delta);
    }

    pub fn scroll_to_bottom(&self) {
        self.inner.scroll_to_bottom();
    }

    pub fn display_offset(&self) -> u32 {
        self.inner.display_offset()
    }

    /// Plain text of the current viewport (trailing spaces trimmed per line).
    pub fn viewport_text(&self) -> String {
        self.inner.viewport_text()
    }

    /// Dirty lines since last call, or empty frame if nothing changed.
    pub fn take_damage(&self) -> Option<DamageFrame> {
        self.inner.take_damage().map(convert_frame)
    }

    /// Full viewport (after resize or first paint).
    pub fn snapshot(&self) -> DamageFrame {
        convert_frame(self.inner.snapshot())
    }

    /// Apply a color palette and force a full redraw on next damage poll.
    pub fn set_palette(&self, palette: TerminalPalette) {
        self.inner.set_palette(CorePalette {
            background: palette.background,
            foreground: palette.foreground,
            cursor: palette.cursor,
            selection: palette.selection,
            black: palette.black,
            red: palette.red,
            green: palette.green,
            yellow: palette.yellow,
            blue: palette.blue,
            magenta: palette.magenta,
            cyan: palette.cyan,
            white: palette.white,
            bright_black: palette.bright_black,
            bright_red: palette.bright_red,
            bright_green: palette.bright_green,
            bright_yellow: palette.bright_yellow,
            bright_blue: palette.bright_blue,
            bright_magenta: palette.bright_magenta,
            bright_cyan: palette.bright_cyan,
            bright_white: palette.bright_white,
        });
    }

    pub fn palette(&self) -> TerminalPalette {
        let p = self.inner.palette();
        TerminalPalette {
            background: p.background,
            foreground: p.foreground,
            cursor: p.cursor,
            selection: p.selection,
            black: p.black,
            red: p.red,
            green: p.green,
            yellow: p.yellow,
            blue: p.blue,
            magenta: p.magenta,
            cyan: p.cyan,
            white: p.white,
            bright_black: p.bright_black,
            bright_red: p.bright_red,
            bright_green: p.bright_green,
            bright_yellow: p.bright_yellow,
            bright_blue: p.bright_blue,
            bright_magenta: p.bright_magenta,
            bright_cyan: p.bright_cyan,
            bright_white: p.bright_white,
        }
    }
}

fn convert_frame(f: CoreFrame) -> DamageFrame {
    DamageFrame {
        cols: f.cols,
        rows: f.rows,
        cursor_col: f.cursor_col,
        cursor_row: f.cursor_row,
        cursor_visible: f.cursor_visible,
        full: f.full,
        lines: f
            .lines
            .into_iter()
            .map(|l| DamageLine {
                row: l.row,
                cells: l
                    .cells
                    .into_iter()
                    .map(|c| TermCell {
                        ch: c.ch.to_string(),
                        fg: c.fg,
                        bg: c.bg,
                        flags: c.flags,
                    })
                    .collect(),
            })
            .collect(),
    }
}
