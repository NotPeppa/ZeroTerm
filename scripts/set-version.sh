#!/usr/bin/env bash
# Bump in-repo package versions to match a release tag.
# Usage: scripts/set-version.sh 0.1.12
#        scripts/set-version.sh v0.1.12
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="${1:-}"
if [[ -z "$RAW" ]]; then
  echo "usage: $0 <version|tag>" >&2
  exit 1
fi

VERSION="${RAW#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$ ]]; then
  echo "invalid version: $RAW (expected x.y.z)" >&2
  exit 1
fi

# versionCode = major*10000 + minor*100 + patch  (0.1.12 -> 112)
IFS='.' read -r MAJOR MINOR PATCH_REST <<<"$VERSION"
PATCH="${PATCH_REST%%[^0-9]*}"
MAJOR="${MAJOR:-0}"
MINOR="${MINOR:-0}"
PATCH="${PATCH:-0}"
VERSION_CODE=$((10#$MAJOR * 10000 + 10#$MINOR * 100 + 10#$PATCH))

echo "Setting version=$VERSION versionCode=$VERSION_CODE"

python3 - "$ROOT" "$VERSION" "$VERSION_CODE" <<'PY'
import json, pathlib, re, sys

root = pathlib.Path(sys.argv[1])
version = sys.argv[2]
version_code = sys.argv[3]

# desktop/src-tauri/tauri.conf.json
p = root / "desktop/src-tauri/tauri.conf.json"
data = json.loads(p.read_text())
data["version"] = version
p.write_text(json.dumps(data, indent=2) + "\n")
print(f"  updated {p.relative_to(root)}")

# desktop/src-tauri/Cargo.toml — first package version
p = root / "desktop/src-tauri/Cargo.toml"
text = p.read_text()
out, n = re.subn(
    r'(?m)^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")',
    rf'\g<1>{version}\g<2>',
    text,
    count=1,
)
if n != 1:
    out, n = re.subn(r'(?m)^(version\s*=\s*")[^"]+(")', rf'\g<1>{version}\g<2>', text, count=1)
if n != 1:
    raise SystemExit(f"failed to patch {p}")
p.write_text(out)
print(f"  updated {p.relative_to(root)}")

# android/app/build.gradle.kts
p = root / "android/app/build.gradle.kts"
text = p.read_text()
text, n1 = re.subn(r'(versionCode\s*=\s*)\d+', rf'\g<1>{version_code}', text, count=1)
text, n2 = re.subn(r'(versionName\s*=\s*")[^"]+(")', rf'\g<1>{version}\g<2>', text, count=1)
if n1 != 1 or n2 != 1:
    raise SystemExit(f"failed to patch android versions (code={n1}, name={n2})")
p.write_text(text)
print(f"  updated {p.relative_to(root)}")

# core/Cargo.toml workspace.package version
p = root / "core/Cargo.toml"
if p.is_file():
    text = p.read_text()
    if "[workspace.package]" in text:
        out, n = re.subn(
            r'(?m)^(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+(")',
            rf'\g<1>{version}\g<2>',
            text,
            count=1,
        )
    else:
        out, n = re.subn(r'(?m)^(version\s*=\s*")[^"]+(")', rf'\g<1>{version}\g<2>', text, count=1)
    if n == 1:
        p.write_text(out)
        print(f"  updated {p.relative_to(root)}")
    else:
        print(f"  skip {p.relative_to(root)} (no version field matched)")

print("done")
PY
