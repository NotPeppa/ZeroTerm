#!/usr/bin/env python3
"""Restore the persistent release key in CI; never generate a new identity per run."""

import base64
import json
import os
from pathlib import Path
import re
import sys


def signing_values(environment):
    bundle = environment.get("ANDROID_SIGNING_BUNDLE", "").strip()
    if bundle:
        try:
            data = json.loads(bundle)
            if type(data["version"]) is not int or data["version"] != 1:
                raise ValueError()
            values = {
                "ANDROID_KEYSTORE_BASE64": data["keystore_base64"],
                "ANDROID_KEYSTORE_PASSWORD": data["store_password"],
                "ANDROID_KEY_ALIAS": data["key_alias"],
                "ANDROID_KEY_PASSWORD": data["key_password"],
            }
            fingerprint = data.get("certificate_sha256")
            if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
                raise ValueError()
            values["ANDROID_SIGNING_CERT_SHA256"] = fingerprint
        except (ValueError, KeyError, TypeError):
            raise ValueError("ANDROID_SIGNING_BUNDLE is invalid; restore the saved signing configuration.") from None
    else:
        values = {name: environment.get(name, "") for name in (
            "ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD",
        )}
    encoded = values.pop("ANDROID_KEYSTORE_BASE64")
    if not isinstance(encoded, str) or not encoded.strip() or any(not isinstance(value, str) or not value.strip() or any(c in value for c in "\r\n\x00") for value in values.values()):
        raise ValueError("Persistent Android signing is not configured. Run scripts/setup-android-signing.py once to configure GitHub automatically.")
    try:
        keystore = base64.b64decode("".join(encoded.split()), validate=True)
    except ValueError:
        raise ValueError("Android signing keystore is not valid Base64.") from None
    if not keystore:
        raise ValueError("Android signing keystore is empty.")
    return keystore, values


def main():
    keystore, values = signing_values(os.environ)
    store = Path(os.environ["RUNNER_TEMP"]) / "zeroterm-release.jks"
    with open(os.open(store, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as stream:
        stream.write(keystore)
    os.chmod(store, 0o600)
    values["ANDROID_KEYSTORE_PATH"] = str(store)
    # GitHub masks the JSON secret, but its decoded passwords need separate masks.
    for name in ("ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_PASSWORD"):
        print(f"::add-mask::{values[name].replace('%', '%25')}")
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as stream:
        for name, value in values.items():
            stream.write(f"{name}={value}\n")
    print("Restored the persistent Android release signing key.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f"Signing restore failed: {error}", file=sys.stderr)
        sys.exit(1)
