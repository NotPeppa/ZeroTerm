# Icons

Tauri requires an icon at compile time. Drop any PNG (≥ 64×64 is fine
for development) here as `icon.png` before the first `cargo tauri dev`.

For a release build, generate the full per-OS icon set from a high-res
source:

```powershell
cd desktop/src-tauri
cargo tauri icon path\to\source-1024.png
```

That command writes `icon.ico`, `icon.icns`, `32x32.png`, `128x128.png`,
`128x128@2x.png`, etc. into this directory. The same `icon.png` reference
in `tauri.conf.json` is used for the dev window.
