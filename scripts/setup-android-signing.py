#!/usr/bin/env python3
"""Initialize persistent Android signing and configure GitHub without copying secrets."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
LEGACY_NAMES = {
    "ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD",
}


def github_repo():
    origin = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=ROOT, text=True).strip()
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?", origin)
    if not match:
        raise ValueError("Origin is not a GitHub repository; pass --repo OWNER/REPO.")
    return match[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="GitHub OWNER/REPO (defaults to origin)")
    parser.add_argument("--gh", default=shutil.which("gh"), help="Path to GitHub CLI")
    parser.add_argument("--signing-dir", type=Path, default=Path.home() / ".zeroterm/android-signing/com.zeroterm.android")
    args = parser.parse_args()
    if not args.gh:
        raise ValueError("Install GitHub CLI and sign in with gh auth login, then run this script again.")
    repo = args.repo or github_repo()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ValueError("Repository must be OWNER/REPO.")
    gh_env = os.environ.copy()
    gh_env["GH_HOST"] = "github.com"
    # Reuse the same authentication as git when the CLI has not been configured.
    if not gh_env.get("GH_TOKEN") and not gh_env.get("GITHUB_TOKEN"):
        auth = subprocess.run([args.gh, "auth", "status"], env=gh_env, capture_output=True)
        if auth.returncode:
            credential = subprocess.run(
                ["git", "credential", "fill"], input=f"protocol=https\nhost=github.com\npath={repo}.git\n\n",
                env=gh_env | {"GIT_TERMINAL_PROMPT": "0"}, capture_output=True, text=True, timeout=15,
            )
            fields = dict(line.split("=", 1) for line in credential.stdout.splitlines() if "=" in line)
            if fields.get("password"):
                gh_env["GH_TOKEN"] = fields["password"]
    result = subprocess.run(
        [args.gh, "secret", "list", "--repo", repo, "--json", "name"],
        env=gh_env, capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError("Cannot access repository secrets. Sign in to GitHub CLI with permission to manage this repository's secrets.")
    names = {item["name"] for item in json.loads(result.stdout)}
    if "ANDROID_SIGNING_BUNDLE" in names or LEGACY_NAMES <= names:
        print(f"Android signing is already configured for {repo}; the existing key was kept.")
        return
    if LEGACY_NAMES & names:
        raise ValueError("Repository has an incomplete existing Android signing configuration. Restore its existing key instead of replacing it.")
    signing_dir = args.signing_dir.expanduser().resolve()
    gradlew = ROOT / "android" / ("gradlew.bat" if os.name == "nt" else "gradlew")
    subprocess.run(
        [str(gradlew), ":app:prepareReleaseSigning", f"-Pzeroterm.signingDir={signing_dir}", "--console=plain"],
        cwd=ROOT / "android", check=True,
    )
    identity = signing_dir / "identity"
    if os.environ.get("ANDROID_KEYSTORE_PATH"):
        store = Path(os.environ["ANDROID_KEYSTORE_PATH"]).expanduser().resolve()
        credentials = {
            "storePassword": os.environ["ANDROID_KEYSTORE_PASSWORD"],
            "keyAlias": os.environ["ANDROID_KEY_ALIAS"],
            "keyPassword": os.environ["ANDROID_KEY_PASSWORD"],
        }
    else:
        store = identity / "release.jks"
        credentials = {}
        for line in (identity / "credentials.properties").read_text(encoding="ascii").splitlines():
            if line and not line.startswith(("#", "!")):
                name, value = line.split("=", 1)
                credentials[name] = value
    keytool = Path(os.environ.get("JAVA_HOME", "")) / "bin" / ("keytool.exe" if os.name == "nt" else "keytool")
    keytool_command = str(keytool) if keytool.is_file() else shutil.which("keytool")
    if not keytool_command:
        raise ValueError("keytool was not found. Set JAVA_HOME to your JDK.")
    certificate = subprocess.run(
        [keytool_command, "-exportcert", "-keystore", str(store),
         "-alias", credentials["keyAlias"], "-storepass:env", "ZEROTERM_SIGNING_PASSWORD"],
        env=os.environ | {"ZEROTERM_SIGNING_PASSWORD": credentials["storePassword"]},
        capture_output=True,
    )
    if certificate.returncode:
        raise ValueError("Could not verify the local signing certificate.")
    fingerprint = hashlib.sha256(certificate.stdout).hexdigest()
    bundle = json.dumps({
        "version": 1,
        "keystore_base64": base64.b64encode(store.read_bytes()).decode("ascii"),
        "store_password": credentials["storePassword"],
        "key_alias": credentials["keyAlias"],
        "key_password": credentials["keyPassword"],
        "certificate_sha256": fingerprint,
    })
    result = subprocess.run(
        [args.gh, "secret", "set", "ANDROID_SIGNING_BUNDLE", "--repo", repo],
        input=bundle, env=gh_env, capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError("Could not save the signing key to GitHub. Grant Secrets write permission, then retry; the local key has been preserved.")
    print(f"Android automatic signing configured for {repo}.")
    print(f"Local signing key: {store}")
    print(f"Certificate SHA-256: {fingerprint}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(f"Signing setup failed: {error}", file=sys.stderr)
        sys.exit(1)
