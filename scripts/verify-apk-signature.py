#!/usr/bin/env python3
"""Refuse to publish an APK that is not signed with WARDEN's upload key.

The Android job builds a debug-signed APK whenever the keystore secret is missing
or does not decode — "No keystore configured" is a notice, not a failure, because
a fork without the key still deserves a build it can install. The trouble is that
this APK then looks exactly like a release one: same name, same artifact, same
Firebase release. Testers install it, and the day a release-signed build replaces
it Android refuses the update until the old app is uninstalled.

So the certificate in the APK is compared with the upload key's fingerprint before
anything is distributed. That catches all three ways this goes wrong: no keystore,
a keystore that is not the one Play knows, and a bundle built from the debug
variant.

    python3 scripts/verify-apk-signature.py build/WARDEN-0.2.11.apk

The fingerprint is pinned here rather than read from the keystore, because a check
that trusts the same file the build trusted proves nothing. It is the same value
recorded in docs/MOBILE.md; rotating the upload key means changing it in both.

Exit status: 0 the APK is signed with the upload key, 1 it is not.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import zipfile

# SHA-256 of the upload certificate, as `keytool -list -v` prints it.
UPLOAD_KEY_SHA256 = "62:EB:DA:C2:BA:2E:B9:3C:B7:51:D2:82:A9:CD:D3:BD:13:77:B7:C2:B1:E1:91:FE:FB:73:8E:C7:A7:D5:A4:8A"

PEM = re.compile(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S)


def normalised(fingerprint: str) -> str:
    return fingerprint.replace(":", "").replace(" ", "").upper()


def fail(message: str, details: list[str] | None = None) -> "SystemExit":
    print(f"::error::{message}")
    for line in details or []:
        print(line)
    return SystemExit(1)


def signature_blocks(apk: str) -> list[tuple[str, bytes]]:
    if not os.path.isfile(apk):
        raise fail(f"{apk} does not exist", ["The APK build step produced nothing to check."])

    with zipfile.ZipFile(apk) as bundle:
        names = [
            name
            for name in bundle.namelist()
            if name.startswith("META-INF/") and name.upper().endswith((".RSA", ".DSA", ".EC"))
        ]
        if not names:
            raise fail(
                f"{os.path.basename(apk)} carries no v1 signature block",
                ["An unsigned or v2-only APK cannot be checked this way, and Play will not take it."],
            )
        return [(name, bundle.read(name)) for name in names]


def signers(block: bytes) -> list[tuple[str, str]]:
    """(subject, sha256) for every certificate in one PKCS#7 signature block."""
    with tempfile.NamedTemporaryFile(suffix=".p7", delete=False) as handle:
        handle.write(block)
        path = handle.name

    try:
        decoded = subprocess.run(
            ["openssl", "pkcs7", "-inform", "DER", "-print_certs", "-in", path],
            capture_output=True,
        )
        if decoded.returncode != 0:
            raise fail(
                "could not decode the APK signature",
                [decoded.stderr.decode("utf-8", "replace").strip()],
            )
        found = []
        for pem in PEM.findall(decoded.stdout):
            der = subprocess.run(
                ["openssl", "x509", "-outform", "DER"],
                input=pem,
                capture_output=True,
            )
            subject = subprocess.run(
                ["openssl", "x509", "-noout", "-subject"],
                input=pem,
                capture_output=True,
            )
            if der.returncode != 0:
                raise fail("could not read a certificate out of the APK signature")
            digest = hashlib.sha256(der.stdout).hexdigest()
            found.append(
                (
                    subject.stdout.decode("utf-8", "replace").strip().removeprefix("subject=").strip(),
                    ":".join(digest[i : i + 2] for i in range(0, len(digest), 2)).upper(),
                )
            )
        return found
    finally:
        os.unlink(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("apk", help="the APK that is about to be published")
    args = parser.parse_args()

    expected = normalised(UPLOAD_KEY_SHA256)
    seen: list[tuple[str, str]] = []
    for name, block in signature_blocks(args.apk):
        for subject, fingerprint in signers(block):
            seen.append((subject, fingerprint))
            print(f"{name}: {subject}")
            print(f"  sha256 {fingerprint}")

    if not seen:
        raise fail(
            "the APK has no readable signer certificate",
            [f"Expected the upload key {UPLOAD_KEY_SHA256}."],
        )

    if any(normalised(fingerprint) == expected for _, fingerprint in seen):
        print(f"\nsigned with the upload key ({UPLOAD_KEY_SHA256}) — safe to publish")
        return 0

    debug = [subject for subject, _ in seen if "Android Debug" in subject]
    if debug:
        raise fail(
            "this APK is debug-signed, so it is not a build anyone should install",
            [
                *[f"  signer: {subject}" for subject in debug],
                "",
                "The keystore secret is missing or did not decode — look for \"No keystore",
                "configured\" above, and for ANDROID_KEYSTORE_BASE64 in the job environment.",
                "Android also refuses to replace a debug-signed install with a release-signed",
                "one, so publishing this costs every tester an uninstall.",
            ],
        )

    raise fail(
        "this APK was signed with a key that is not WARDEN's upload key",
        [
            *[f"  found:    {fingerprint}  ({subject})" for subject, fingerprint in seen],
            f"  expected: {UPLOAD_KEY_SHA256}",
            "",
            "Play signs releases with the upload key it was given, and a different one is",
            "rejected at upload. Restore the keystore that matches the fingerprint in",
            "docs/MOBILE.md rather than rotating it to match this build.",
        ],
    )


if __name__ == "__main__":
    sys.exit(main())
