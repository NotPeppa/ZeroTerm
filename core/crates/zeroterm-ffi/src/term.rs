//! FFI surface for the VT terminal (`zeroterm-term`).

use std::sync::Arc;

use zeroterm_term::{DamageFrame as CoreFrame, Terminal as CoreTerminal};

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
