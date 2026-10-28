#!/usr/bin/env python3
"""Fail when the ad hoc ipa Xcode just signed cannot be installed on the phones
that are registered for testing.

A successful export has only proven that Xcode found *a* profile. It will happily
sign with one that names no phone — a cached profile from before the device was
registered, or one narrowed to a single UDID — and the run goes green while the
phone says "Unable to Install" when the tester taps the invite. So the profile is
read back out of the ipa that will actually be uploaded, and compared with the
devices the developer account has.

    python3 scripts/verify-adhoc-profile.py build/WARDEN-0.2.11.ipa

The profile is a CMS envelope around a plist; `openssl smime` unwraps it and
`plistlib` reads the result, so the runner installs nothing. The account's
devices come from the App Store Connect API with the same key the build uses.

Exit status: 0 every enabled device is named by the profile, 1 something is
missing and the build should not be published.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import plistlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API = "https://api.appstoreconnect.apple.com"


def fail(message: str, details: list[str] | None = None) -> "SystemExit":
    """Report the way a GitHub runner makes it readable, then stop."""
    print(f"::error::{message}")
    for line in details or []:
        print(line)
    return SystemExit(1)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def der_signature_to_raw(der: bytes) -> bytes:
    """openssl writes an ECDSA signature as DER; JWT wants R and S, 32 bytes each."""
    index = 2
    if der[1] & 0x80:  # long-form length on the outer SEQUENCE
        index = 2 + (der[1] & 0x7F)
    if der[index] != 0x02:
        raise SystemExit("unexpected DER signature: no INTEGER for R")

    r_length = der[index + 1]
    r = der[index + 2 : index + 2 + r_length]
    index += 2 + r_length

    if der[index] != 0x02:
        raise SystemExit("unexpected DER signature: no INTEGER for S")
    s_length = der[index + 1]
    s = der[index + 2 : index + 2 + s_length]

    return r.rjust(32, b"\x00")[-32:] + s.rjust(32, b"\x00")[-32:]


def token(key_id: str, issuer_id: str, key_path: str) -> str:
    issued = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    claims = {"iss": issuer_id, "iat": issued, "exp": issued + 1200, "aud": "appstoreconnect-v1"}

    signing_input = ".".join(
        b64url(json.dumps(part, separators=(",", ":")).encode("utf-8")) for part in (header, claims)
    )

    signed = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path, "-binary"],
        input=signing_input.encode("ascii"),
        capture_output=True,
    )
    if signed.returncode != 0:
        raise fail(
            "could not sign an App Store Connect token — the .p8 at ASC_KEY_PATH was unreadable",
            [signed.stderr.decode("utf-8", "replace").strip()],
        )

    return f"{signing_input}.{b64url(der_signature_to_raw(signed.stdout))}"


def enabled_devices(key_id: str, issuer_id: str, key_path: str) -> list[dict]:
    bearer = token(key_id, issuer_id, key_path)
    found: list[dict] = []
    path = "/v1/devices?" + urllib.parse.urlencode(
        {"limit": "200", "fields[devices]": "name,udid,status", "filter[status]": "ENABLED"}
    )

    while path:
        request = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {bearer}"})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                page = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise fail(
                f"could not list the registered devices (HTTP {error.code})",
                ["The check cannot prove the profile covers the account without them.", detail],
            )
        found.extend(page.get("data", []))
        next_link = page.get("links", {}).get("next")
        path = next_link[len(API) :] if next_link else ""

    return found


def profile_from(ipa: str) -> dict:
    try:
        with zipfile.ZipFile(ipa) as bundle:
            for name in bundle.namelist():
                parts = name.split("/")
                if (
                    len(parts) == 3
                    and parts[0] == "Payload"
                    and parts[1].endswith(".app")
                    and parts[2] == "embedded.mobileprovision"
                ):
                    signed = bundle.read(name)
                    break
            else:
                raise fail(
                    f"{os.path.basename(ipa)} has no embedded.mobileprovision",
                    ["An unsigned or development build is not what App Distribution installs."],
                )
    except FileNotFoundError:
        raise fail(f"{ipa} does not exist", ["The ad hoc export step wrote no ipa."])

    decoded = subprocess.run(
        ["openssl", "smime", "-inform", "der", "-verify", "-noverify"],
        input=signed,
        capture_output=True,
    )
    if decoded.returncode != 0:
        raise fail(
            "could not decode the provisioning profile inside the ipa",
            [decoded.stderr.decode("utf-8", "replace").strip()],
        )

    return plistlib.loads(decoded.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("ipa", help="the ad hoc ipa that is about to be published")
    args = parser.parse_args()

    key_id = os.environ.get("APP_STORE_CONNECT_KEY_ID", "").strip()
    issuer_id = os.environ.get("APP_STORE_CONNECT_ISSUER_ID", "").strip()
    key_path = os.environ.get("ASC_KEY_PATH", "").strip()
    if not key_id or not issuer_id or not key_path or not os.path.isfile(key_path):
        raise fail(
            "the App Store Connect key is not configured, so the profile cannot be checked",
            ["Pass APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID and ASC_KEY_PATH."],
        )

    profile = profile_from(args.ipa)
    name = profile.get("Name", "(unnamed profile)")
    listed = sorted({udid.upper() for udid in profile.get("ProvisionedDevices", [])})
    entitlement = (profile.get("Entitlements") or {}).get("get-task-allow")

    print(f"profile: {name}")
    print(f"names {len(listed)} device(s): {', '.join(listed) if listed else '(none)'}")

    # An App Store profile has no device list at all, and a development one is
    # installable on a registered phone but not distributable. Neither is what
    # App Distribution needs, and both can come back from the wrong method.
    if not listed:
        raise fail(
            "the profile names no devices, so no phone can install this build",
            [
                f"profile: {name}",
                "This is what an App Store or enterprise-signed export looks like. The export",
                "must use <key>method</key><string>ad-hoc</string> with automatic signing.",
            ],
        )
    if entitlement is not False:
        raise fail(
            "the embedded profile is a development one, not ad hoc",
            [f"profile: {name}", f"get-task-allow: {entitlement!r} (expected False)"],
        )
    if profile.get("ProvisionsAllDevices"):
        raise fail(
            "the embedded profile is an enterprise profile, not ad hoc",
            [f"profile: {name}"],
        )

    devices = enabled_devices(key_id, issuer_id, key_path)
    registered = {row["attributes"]["udid"].upper(): row["attributes"].get("name", "") for row in devices}
    missing = {udid: label for udid, label in registered.items() if udid not in listed}

    if missing:
        raise fail(
            f"the ad hoc profile does not name {len(missing)} registered device(s)",
            [
                *(f"  missing: {label} ({udid})" for udid, label in sorted(missing.items())),
                f"  profile names: {', '.join(listed)}",
                "",
                "The export reused a profile made before those devices were registered, or the",
                "registration has not reached the account yet. Fix: add the device with",
                "`gh workflow run ios-register-device.yml -f udid=<UDID>` and re-run this build —",
                "`-allowProvisioningUpdates` then recreates the profile with every device.",
            ],
        )

    print(f"every registered device is named ({len(registered)} checked) — safe to publish")
    return 0


if __name__ == "__main__":
    sys.exit(main())
