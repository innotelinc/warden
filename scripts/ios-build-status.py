#!/usr/bin/env python3
"""Report what App Store Connect says about WARDEN's uploaded iOS builds.

An upload that printed "Upload succeeded" is not yet a build a tester can
install: App Store Connect processes it for 5-15 minutes and only then does it
show up in TestFlight as VALID. This asks the API directly, so the answer comes
from Apple rather than from a green export step.

Credentials are the same repository secrets the iOS build workflow uses; only
the key id and issuer id are needed for the token, and the .p8 is read from
disk rather than taken as an argument so it never lands in a process list.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-build-status.py

The token is signed here with `openssl`, so the runner installs nothing.

Exit status: 0 everything looked fine, 1 the API call or configuration failed,
2 a build ended up FAILED or INVALID, 3 still processing when the wait ran out.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = "us.innotel.warden"

# What each state means to somebody waiting for a tester to install it.
MEANING = {
    "PROCESSING": "processing — App Store Connect is still reading the build",
    "VALID": "ready — it can be added to a TestFlight group",
    "FAILED": "processing failed — Apple emails the reason to the account holder",
    "INVALID": "invalid — App Store Connect rejected it, see the email or the API",
}


def utc(value: str) -> str:
    """App Store Connect timestamps carry an offset; the first 16 characters do
    not, and slicing them reports the upload in the account's local time."""
    try:
        return (
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            .astimezone(timezone.utc)
            .strftime("%Y-%m-%d %H:%M UTC")
        )
    except ValueError:
        return value


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def der_signature_to_raw(der: bytes) -> bytes:
    """openssl writes an ECDSA signature as DER; JWT wants R and S, 32 bytes each."""
    index = 2
    if der[1] & 0x80:  # long-form length on the outer SEQUENCE
        index = 2 + (der[1] & 0x7F)
    if der[index] != 0x02:
        raise ValueError("unexpected signature encoding")

    r_length = der[index + 1]
    r = der[index + 2 : index + 2 + r_length]
    index += 2 + r_length

    if der[index] != 0x02:
        raise ValueError("unexpected signature encoding")
    s_length = der[index + 1]
    s = der[index + 2 : index + 2 + s_length]

    return int.from_bytes(r, "big").to_bytes(32, "big") + int.from_bytes(s, "big").to_bytes(32, "big")


def token(key_id: str, issuer_id: str, key_path: str) -> str:
    """An App Store Connect JWT, valid for twenty minutes."""
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
        raise SystemExit(
            "could not sign the token with the .p8 at that path — "
            "is it the App Store Connect key, and is the file readable?\n"
            + signed.stderr.decode("utf-8", "replace").strip()
        )

    return f"{signing_input}.{b64url(der_signature_to_raw(signed.stdout))}"


def get(path: str, bearer: str, params: dict[str, str] | None = None) -> dict:
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)

    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {bearer}"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        if error.code == 401:
            raise SystemExit(
                "App Store Connect refused the token (401). The key id, the issuer id "
                "or the key itself is wrong, or the key has been revoked.\n" + body
            )
        raise SystemExit(f"App Store Connect returned {error.code} for {path}:\n{body}")


def app_id(bearer: str) -> str:
    found = get("/v1/apps", bearer, {"filter[bundleId]": BUNDLE_ID, "fields[apps]": "bundleId"})
    data = found.get("data") or []
    if not data:
        raise SystemExit(
            f"no app record for {BUNDLE_ID} in App Store Connect. Create it under Apps -> "
            "+ -> New App before a build has anywhere to land."
        )
    return data[0]["id"]


def builds(bearer: str, app: str, limit: int) -> list[dict]:
    """The most recent builds, newest first, with the marketing version attached."""
    payload = get(
        "/v1/builds",
        bearer,
        {
            "filter[app]": app,
            "sort": "-uploadedDate",
            "limit": str(limit),
            "include": "preReleaseVersion",
            "fields[builds]": "version,uploadedDate,processingState,expired,preReleaseVersion",
        },
    )

    marketing = {
        item["id"]: item["attributes"].get("version")
        for item in payload.get("included") or []
        if item.get("type") == "preReleaseVersions"
    }

    rows = []
    for build in payload.get("data") or []:
        attributes = build["attributes"]
        relation = (build.get("relationships") or {}).get("preReleaseVersion", {}).get("data") or {}
        rows.append(
            {
                "marketing": marketing.get(relation.get("id"), "?"),
                "number": attributes.get("version") or "?",
                "state": attributes.get("processingState") or "?",
                "uploaded": utc(attributes.get("uploadedDate") or "?"),
                "expired": bool(attributes.get("expired")),
            }
        )
    return rows


def describe(rows: list[dict]) -> str:
    width = max((len(f"{r['marketing']} ({r['number']})") for r in rows), default=0)
    lines = []
    for row in rows:
        label = f"{row['marketing']} ({row['number']})".ljust(width)
        expired = "  [expired: installs disabled]" if row["expired"] else ""
        lines.append(f"{label}  {row['uploaded']}  {row['state']}{expired}")
        lines.append(f"{' ' * width}  {MEANING.get(row['state'], 'unknown state')}")
    return "\n".join(lines)


def summarise(rows: list[dict], wait_minutes: int) -> None:
    """The same table in the run's summary page, where it is easier to read."""
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target or not rows:
        return
    with open(target, "a", encoding="utf-8") as summary:
        summary.write("| Version | Uploaded | State | Means |\n| --- | --- | --- | --- |\n")
        for row in rows:
            summary.write(
                f"| {row['marketing']} ({row['number']}) | {row['uploaded']} "
                f"| {row['state']} | {MEANING.get(row['state'], 'unknown state')} |\n"
            )
        if wait_minutes:
            summary.write(f"\nWaited up to {wait_minutes} minutes for processing to finish.\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wait-minutes", type=int, default=0, help="poll until the build leaves PROCESSING")
    parser.add_argument("--build-version", default="", help="only report this marketing version")
    parser.add_argument(
        "--build-number",
        default="",
        help="follow this build number, waiting even before Apple lists it",
    )
    parser.add_argument("--limit", type=int, default=5, help="how many builds to list")
    args = parser.parse_args()

    key_id = os.environ.get("APP_STORE_CONNECT_KEY_ID", "").strip()
    issuer_id = os.environ.get("APP_STORE_CONNECT_ISSUER_ID", "").strip()
    key_path = os.environ.get("ASC_KEY_PATH", "").strip()

    missing = [
        name
        for name, value in (
            ("APP_STORE_CONNECT_KEY_ID", key_id),
            ("APP_STORE_CONNECT_ISSUER_ID", issuer_id),
            ("ASC_KEY_PATH", key_path),
        )
        if not value
    ]
    if missing:
        raise SystemExit(
            "missing " + ", ".join(missing) + " — set the App Store Connect secrets first."
        )
    if not os.path.exists(key_path):
        raise SystemExit(f"no key at {key_path}")

    bearer = token(key_id, issuer_id, key_path)
    app = app_id(bearer)

    deadline = time.monotonic() + args.wait_minutes * 60
    target: dict | None = None
    while True:
        rows = builds(bearer, app, args.limit)
        if args.build_version:
            rows = [row for row in rows if row["marketing"] == args.build_version]

        if not rows:
            print(f"no builds uploaded yet for {BUNDLE_ID}" + (f" {args.build_version}" if args.build_version else ""))
            return 1

        print(describe(rows))

        # Which build is being asked about? A named one if the caller named one,
        # otherwise the newest — the one somebody just uploaded. An older build
        # of the same version being VALID says nothing about the new one, and
        # treating it as the answer reports yesterday's state.
        wanted = [row for row in rows if row["number"] == str(args.build_number)]
        target = wanted[0] if args.build_number else rows[0]

        if target is None:
            # Apple lists a build only once it has begun processing it, so a
            # build that was just uploaded is missing rather than failed.
            if not args.wait_minutes or time.monotonic() >= deadline:
                print(f"\nbuild {args.build_number} is not listed yet.")
                return 3
            print(f"\nbuild {args.build_number} is not listed yet, checking again in 60s…\n")
            time.sleep(60)
            continue

        if target["state"] != "PROCESSING" or time.monotonic() >= deadline or not args.wait_minutes:
            break
        print(
            f"\n{target['marketing']} ({target['number']}) is still processing, "
            "checking again in 60s…\n"
        )
        time.sleep(60)

    summarise(rows, args.wait_minutes)

    if target is None or target["state"] == "PROCESSING":
        print("\nStill processing. Run this again in a few minutes, or with --wait-minutes.")
        return 3
    if target["state"] in ("FAILED", "INVALID"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
