"""Exercise CI signing restore and bootstrap guards: python3 scripts/test_release_signing.py."""

import base64
import importlib.util
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


restore = load_script("restore-android-signing")
setup = load_script("setup-android-signing")
KEY_BYTES = b"synthetic-keystore-for-tests"
LEGACY = {
    "ANDROID_KEYSTORE_BASE64": base64.b64encode(KEY_BYTES).decode(),
    "ANDROID_KEYSTORE_PASSWORD": "synthetic-store-password",
    "ANDROID_KEY_ALIAS": "test-alias",
    "ANDROID_KEY_PASSWORD": "synthetic-key-password",
}
BUNDLE = json.dumps({
    "version": 1,
    "keystore_base64": LEGACY["ANDROID_KEYSTORE_BASE64"],
    "store_password": LEGACY["ANDROID_KEYSTORE_PASSWORD"],
    "key_alias": LEGACY["ANDROID_KEY_ALIAS"],
    "key_password": LEGACY["ANDROID_KEY_PASSWORD"],
    "certificate_sha256": "0" * 64,
})


class SigningRestoreTests(unittest.TestCase):
    def test_bundle_and_legacy_restore_identical_key(self):
        key, values = restore.signing_values({"ANDROID_SIGNING_BUNDLE": BUNDLE})
        self.assertEqual((key, {name: value for name, value in values.items() if name != "ANDROID_SIGNING_CERT_SHA256"}), restore.signing_values(LEGACY))
        self.assertEqual(restore.signing_values(LEGACY)[0], KEY_BYTES)

    def test_bundle_takes_priority_without_rotating_key(self):
        keystore, values = restore.signing_values(LEGACY | {"ANDROID_SIGNING_BUNDLE": BUNDLE, "ANDROID_KEY_ALIAS": "old-alias"})
        self.assertEqual(keystore, KEY_BYTES)
        self.assertEqual(values["ANDROID_KEY_ALIAS"], "test-alias")

    def test_all_partial_legacy_configurations_fail(self):
        for flags in itertools.product((False, True), repeat=4):
            if all(flags):
                continue
            environment = {name: LEGACY[name] if present else "" for name, present in zip(LEGACY, flags)}
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                restore.signing_values(environment)

    def test_invalid_bundle_never_falls_back_to_other_key(self):
        for bundle in ("bad-json", "[]", "null", '{"version":2}', '{"version":1}', BUNDLE.replace('"version": 1', '"version": true')):
            with self.subTest(bundle=bundle), self.assertRaises(ValueError):
                restore.signing_values(LEGACY | {"ANDROID_SIGNING_BUNDLE": bundle})

    def test_wrapped_legacy_base64_is_preserved(self):
        encoded = LEGACY["ANDROID_KEYSTORE_BASE64"]
        wrapped = "\n".join(encoded[index:index + 8] for index in range(0, len(encoded), 8))
        self.assertEqual(restore.signing_values(LEGACY | {"ANDROID_KEYSTORE_BASE64": wrapped})[0], KEY_BYTES)

    def test_invalid_base64_and_environment_injection_rejected(self):
        for bad_value in ("not base64", "", " \t", "ZmFrZQ==\nINJECT=1", "\x00"):
            with self.subTest(value=bad_value), self.assertRaises(ValueError):
                restore.signing_values(LEGACY | {"ANDROID_KEYSTORE_BASE64": bad_value})
        for name in LEGACY:
            with self.subTest(name=name), self.assertRaises(ValueError):
                restore.signing_values(LEGACY | {name: "value\nINJECT=1"})

    def test_restore_file_permissions_and_runtime_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            environment = {key: value for key, value in os.environ.items() if not key.startswith("ANDROID_KEY") and key != "ANDROID_SIGNING_BUNDLE"}
            env_file = Path(temp) / "github-env"
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "restore-android-signing.py")],
                env=environment | {"ANDROID_SIGNING_BUNDLE": BUNDLE, "RUNNER_TEMP": temp, "GITHUB_ENV": str(env_file)},
                capture_output=True, text=True, check=True,
            )
            store = Path(temp) / "zeroterm-release.jks"
            self.assertEqual(store.read_bytes(), KEY_BYTES)
            if os.name != "nt":
                self.assertEqual(store.stat().st_mode & 0o777, 0o600)
            values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
            self.assertEqual(values["ANDROID_KEYSTORE_PATH"], str(store))
            self.assertEqual(values["ANDROID_KEY_PASSWORD"], LEGACY["ANDROID_KEY_PASSWORD"])
            self.assertNotIn(LEGACY["ANDROID_KEYSTORE_BASE64"], result.stdout)
            for line in result.stdout.splitlines():
                if not line.startswith("::add-mask::"):
                    self.assertNotIn(LEGACY["ANDROID_KEYSTORE_PASSWORD"], line)
                    self.assertNotIn(LEGACY["ANDROID_KEY_PASSWORD"], line)

    def test_failure_does_not_write_key_or_expose_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            environment = {key: value for key, value in os.environ.items() if not key.startswith("ANDROID_KEY")}
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "restore-android-signing.py")],
                env=environment | {"ANDROID_SIGNING_BUNDLE": BUNDLE.replace('"version": 1', '"version": 99'), "RUNNER_TEMP": temp, "GITHUB_ENV": str(Path(temp) / "env")},
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(Path(temp).iterdir()), [])
            self.assertNotIn(LEGACY["ANDROID_KEYSTORE_PASSWORD"], result.stdout + result.stderr)


class SigningSetupTests(unittest.TestCase):
    def call_setup(self, names):
        response = subprocess.CompletedProcess([], 0, json.dumps([{"name": name} for name in names]), "")
        with patch.object(sys, "argv", ["setup", "--repo", "owner/repo", "--gh", "fake-gh"]), \
                patch.dict(os.environ, {"GH_TOKEN": "synthetic-auth"}), \
                patch.object(setup.subprocess, "run", return_value=response) as run:
            setup.main()
            self.assertEqual(run.call_count, 1)  # No key generation or secret overwrite.

    def test_existing_bundle_is_not_overwritten(self):
        self.call_setup({"ANDROID_SIGNING_BUNDLE"})

    def test_existing_legacy_key_is_not_overwritten(self):
        self.call_setup(setup.LEGACY_NAMES)

    def test_partial_existing_key_is_not_replaced(self):
        with self.assertRaises(ValueError):
            self.call_setup({"ANDROID_KEYSTORE_BASE64"})


if __name__ == "__main__":
    unittest.main()
