#!/usr/bin/env python3
"""Add a test device to the Apple developer account, so an ad hoc build can be
installed on it.

App Distribution is the only way a build reaches an iPhone without TestFlight,
and Apple will not sign an ad hoc build whose provisioning profile does not name
the installing device — the export fails with "no devices from which to generate
a provisioning profile". Registering the device is one API call, but it needs the
App Store Connect key, which is a repository secret and stays on the runner.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-register-device.py \\
      --udid 00008150-00084d5e0190c01c --name 'Darnel iPhone'

Registering is once per device: a UDID that is already on the account is
reported and left alone, so a re-run is not an error. `--list` reports the
account's devices without adding one.

The token is signed here with `openssl`, so the runner installs nothing.

Exit status: 0 the device is on the account (now or already), 1 the call failed.
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

API = "https://api.appstoreconnect.apple.com"

# Apple caps registered devices per product family (100 per year, and a device
# that is removed still counts against the year). Worth saying out loud before
# somebody registers a lab full of phones.
DEVICE_LIMIT_NOTE = (
    "Apple allows 100 devices per product family per membership year, and a "
    "device removed mid-year still counts."
)


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


def call(method: str, path: str, bearer: str, payload: dict | None = None) -> dict:
    url = API + path
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {bearer}"}
    if body is not None:
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        if error.code == 409:
            # "The provided entity includes an attribute with a value that has
            # already been taken" — the UDID is on the account, which is the
            # outcome this script wants.
            return {"data": None, "duplicate": True, "detail": detail}
        if error.code in (401, 403):
            raise SystemExit(
                "App Store Connect refused the key (HTTP "
                f"{error.code}). Device registration needs a key with the Admin role; "
                "an App Manager key can build but not manage devices.\n" + detail
            )
        raise SystemExit(f"App Store Connect returned {error.code} for {method} {path}:\n{detail}")


def devices(bearer: str) -> list[dict]:
    """Every device on the account, following Apple's paging."""
    found: list[dict] = []
    path = "/v1/devices?" + urllib.parse.urlencode(
        {"limit": "200", "fields[devices]": "name,udid,platform,status,deviceClass,addedDate"}
    )
    while path:
        page = call("GET", path, bearer)
        found.extend(page.get("data", []))
        next_link = page.get("links", {}).get("next")
        path = next_link[len(API) :] if next_link else ""
    return found


def describe(rows: list[dict]) -> str:
    if not rows:
        return "  (none — this account has no registered devices)"

    width = max(len(row["attributes"].get("name", "")) for row in rows)
    return "\n".join(
        f"  {row['attributes'].get('name', '').ljust(width)}  "
        f"{row['attributes'].get('udid', '')}  "
        f"{row['attributes'].get('status', '')}"
        for row in sorted(rows, key=lambda row: row["attributes"].get("name", ""))
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--udid", help="the device UDID, as iOS shows it")
    parser.add_argument("--name", default="WARDEN tester", help="name to show in the portal")
    parser.add_argument("--list", action="store_true", help="report the devices and exit")
    args = parser.parse_args()

    key_id = os.environ.get("APP_STORE_CONNECT_KEY_ID", "").strip()
    issuer_id = os.environ.get("APP_STORE_CONNECT_ISSUER_ID", "").strip()
    key_path = os.environ.get("ASC_KEY_PATH", "").strip()
    if not key_id or not issuer_id:
        raise SystemExit("APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID must be set.")
    if not key_path or not os.path.isfile(key_path):
        raise SystemExit("ASC_KEY_PATH must point at the .p8 for that key id.")
    if not args.list and not args.udid:
        raise SystemExit("--udid is required unless --list is given.")

    bearer = token(key_id, issuer_id, key_path)

    if args.list:
        rows = devices(bearer)
        print(f"{len(rows)} device(s) on the account\n{describe(rows)}\n\n{DEVICE_LIMIT_NOTE}")
        return 0

    udid = args.udid.strip().upper()
    existing = [row for row in devices(bearer) if row["attributes"].get("udid", "").upper() == udid]
    if existing:
        print(f"already registered: {existing[0]['attributes'].get('name', '')} ({udid})")
        print(f"\n{describe(devices(bearer))}\n\n{DEVICE_LIMIT_NOTE}")
        return 0

    created = call(
        "POST",
        "/v1/devices",
        bearer,
        {
            "data": {
                "type": "devices",
                "attributes": {"name": args.name, "platform": "IOS", "udid": udid},
            }
        },
    )

    if created.get("duplicate"):
        print(f"already registered: {udid} (App Store Connect reported a duplicate)")
    else:
        device = created.get("data", {}).get("attributes", {})
        print(
            f"registered: {device.get('name', args.name)} ({device.get('udid', udid)}) "
            f"status={device.get('status', '?')}"
        )

    rows = devices(bearer)
    print(f"\n{describe(rows)}\n\n{DEVICE_LIMIT_NOTE}")
    print(
        "\nThe ad hoc profile is created on the next Mobile (iOS) run: its export "
        "uses -allowProvisioningUpdates, which now has a device to name."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
