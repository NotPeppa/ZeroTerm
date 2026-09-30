"""Run with python scripts/test_release_signing.py [path/to/bash]."""

import itertools
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap


workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text(
    encoding="utf-8"
)
step = re.search(
    r"(?ms)^      - name: Check Android release signing\n(.*?)(?=^      - |\Z)",
    workflow,
).group(1)
script = textwrap.dedent(step.split("        run: |\n", 1)[1])
names = (
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)
bash = sys.argv[1] if len(sys.argv) > 1 else "bash"
secrets = {name: f"test-secret-{index}" for index, name in enumerate(names)}
cases = [
    {name: secrets[name] if present else "" for name, present in zip(names, flags)}
    for flags in itertools.product((False, True), repeat=4)
]
cases += [secrets | {name: " \t\n"} for name in names]

with tempfile.TemporaryDirectory() as temp:
    output = Path(temp) / "output"
    for case in cases:
        output.write_text("", encoding="utf-8")
        result = subprocess.run(
            [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
            env=os.environ | case | {"GITHUB_OUTPUT": output.as_posix()},
            capture_output=True,
            text=True,
            check=True,
        )
        missing = [name for name in names if not case[name].strip()]
        assert output.read_text().strip() == f"enabled={str(not missing).lower()}", case
        assert result.stdout.count("::warning::") == len(missing), case
        assert all(f"missing secret {name}" in result.stdout for name in missing), case
        assert all(value not in result.stdout + result.stderr for value in secrets.values())

print(f"Android release signing: {len(cases)} cases passed")
