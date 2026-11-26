#!/usr/bin/env python3
"""Put the captured App Store screenshots into App Store Connect.

The screenshots this repository cares about are taken from the running build by
scripts/ios-capture-screenshots.py and arrive as a `warden-ios-screenshots`
artifact. They still have to be dragged into two slots in a web form, which is
how the wrong set ends up in the 6.9-inch slot and the refusal arrives at
submission instead of here. This writes the same files through the API:

  * `APP_IPHONE_67` (the 6.9-inch slot) gets every `iphone-6.9-*.png`
  * `APP_IPAD_PRO_3GEN_129` (the 13-inch slot) gets every `ipad-13-*.png`

A file that is not a portrait PNG of its slot's width is refused here rather
than by Apple, and so is a set with fewer than the three shots the slots
require. Nothing is drawn, cropped or resized: the pixels are the capture's.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 \\
      python3 scripts/ios-upload-screenshots.py --directory /tmp/shots

The upload is the three-step protocol App Store Connect documents, not one
request: reserve a screenshot record (`POST /v1/appScreenshots`), send the
bytes to the URLs it answers with, then confirm the record with the file's MD5
(`PATCH ... {"uploaded": true}`). A record that is reserved but never confirmed
sits in the slot as an empty image, so each one is followed until Apple reports
the asset `COMPLETE`.

A slot that already holds screenshots is not touched unless `--replace` is
passed; then those screenshots are deleted first, because a stale capture mixed
into the set is what a reviewer sees. The version has to be editable: one that
is waiting for review must be removed from review in App Store Connect before
its screenshots can change, and Apple says so with an error rather than this
script guessing.

Credentials are the same four repository secrets the other iOS workflows use;
the token and read helpers come from scripts/ios-build-status.py.

Exit status: 0 the slots hold these files (or a dry run finished), 1 App Store
Connect refused something.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("asc_status", HERE / "ios-build-status.py")
asc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(asc)

API = asc.API
LOCALE = "en-US"

# The upload host is not the API host, so the bytes go somewhere this script has
# not seen before. Apple answers a slow chunk as a failed chunk, hence the wider
# timeout than a JSON call needs.
DOWNLOAD_TIMEOUT = 90
UPLOAD_TIMEOUT = 180
# How long to give Apple to read an uploaded asset before calling it stuck.
SETTLE_SECONDS = 120

# The two slots, by the API's own display-type names, with the widths each one
# accepts and the prefix the capture script names its files with. The names lag
# the store's labels: the "6.9-inch display" is APP_IPHONE_67, which takes all
# three 6.9-inch widths; the 13-inch slot is APP_IPAD_PRO_3GEN_129.
SLOTS: tuple[tuple[str, str, str, tuple[int, ...]], ...] = (
    ("iphone-6.9", '6.9-inch iPhone', "APP_IPHONE_67", (1260, 1290, 1320)),
    ("ipad-13", '13-inch iPad', "APP_IPAD_PRO_3GEN_129", (2048, 2064)),
)


def request(
    method: str,
    url: str,
    *,
    bearer: str = "",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = DOWNLOAD_TIMEOUT,
) -> dict:
    merged = dict(headers or {})
    if bearer:
        merged["Authorization"] = f"Bearer {bearer}"
    if data is not None:
        # urllib would otherwise label every body as a form post, and the asset
        # upload expects the type Apple asked for in its request headers.
        merged.setdefault("Content-Type", "application/octet-stream")
    prepared = urllib.request.Request(url, data=data, headers=merged, method=method)
    try:
        with urllib.request.urlopen(prepared, timeout=timeout) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        # The upload URLs carry a signature in the query string; the path is
        # enough to say where the refusal came from.
        raise SystemExit(
            f"App Store Connect returned {error.code} for {method} {url.split('?')[0]}:\n{detail}"
        )


def call(method: str, path: str, bearer: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    return request(method, API + path, bearer=bearer, headers=headers, data=data)


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"::error::{path.name} is not a PNG")
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(directory: Path, key: str, label: str, display: str, widths: tuple[int, ...]) -> list[Path]:
    """The files for one slot, checked against what that slot accepts.

    A file the console would refuse must fail here: an upload that half works
    leaves a slot with two shots in it, which reads as a filled slot to the
    submission check and is not.
    """
    found = sorted(directory.glob(f"{key}-*.png"))
    if not found:
        raise SystemExit(
            f"::error::no {key}-*.png in {directory}. The capture script names each "
            f"file for its slot; check the artifact holds the PNGs at its root."
        )

    sizes = " or ".join(str(value) for value in widths)
    seen: dict[str, str] = {}
    for path in found:
        width, height = png_size(path)
        if width not in widths or height <= width:
            raise SystemExit(
                f"::error::{path.name} is {width}x{height}. The {label} slot "
                f"({display}) needs a portrait PNG {sizes} wide."
            )
        earlier = seen.get(digest(path))
        if earlier is not None:
            raise SystemExit(
                f"::error::{path.name} is identical to {earlier}: the app never reached "
                "that screen, so uploading both would put the same picture in twice."
            )
        seen[digest(path)] = path.name

    if len(found) < asc.MIN_SHOTS_PER_SIZE:
        raise SystemExit(
            f"::error::{label} has {len(found)} file(s); App Store Connect needs at "
            f"least {asc.MIN_SHOTS_PER_SIZE} in {display}."
        )
    return found


def localization(bearer: str) -> tuple[dict, dict]:
    """The version page the screenshots belong to, and its en-US text."""
    app = asc.app_id(bearer)
    version = asc.newest_version(bearer, app)
    for entry in version["localizations"]:
        if (entry.get("attributes") or {}).get("locale") == LOCALE:
            return version, entry
    raise SystemExit(
        f"version {version['version']} has no {LOCALE} localization. Add the language "
        "in App Store Connect first; the API will not invent one."
    )


def screenshot_sets(bearer: str, localization_id: str) -> dict[str, dict]:
    payload = call(
        "GET", f"/v1/appStoreVersionLocalizations/{localization_id}/appScreenshotSets?limit=50", bearer
    )
    return {
        (row.get("attributes") or {}).get("screenshotDisplayType"): row
        for row in payload.get("data") or []
    }


def screenshots_in(bearer: str, set_id: str) -> list[dict]:
    payload = call("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots?limit=50", bearer)
    return payload.get("data") or []


def ensure_set(bearer: str, localization_id: str, display: str) -> str:
    found = screenshot_sets(bearer, localization_id).get(display)
    if found is not None:
        return found["id"]
    created = call(
        "POST",
        "/v1/appScreenshotSets",
        bearer,
        {
            "data": {
                "type": "appScreenshotSets",
                "attributes": {"screenshotDisplayType": display},
                "relationships": {
                    "appStoreVersionLocalization": {
                        "data": {"type": "appStoreVersionLocalizations", "id": localization_id}
                    }
                },
            }
        },
    )
    set_id = (created.get("data") or {}).get("id")
    if not set_id:
        raise SystemExit(f"App Store Connect created no {display} set")
    return set_id


def reserve(bearer: str, set_id: str, path: Path) -> tuple[str, list[dict]]:
    size = path.stat().st_size
    created = call(
        "POST",
        "/v1/appScreenshots",
        bearer,
        {
            "data": {
                "type": "appScreenshots",
                "attributes": {"fileName": path.name, "fileSize": size},
                "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": set_id}}},
            }
        },
    )
    data = created.get("data") or {}
    if not data.get("id"):
        raise SystemExit(f"App Store Connect reserved no screenshot for {path.name}")
    operations = (data.get("attributes") or {}).get("uploadOperations") or []
    if not operations:
        raise SystemExit(f"App Store Connect returned no upload operations for {path.name}")
    return data["id"], operations


def send_bytes(path: Path, operations: list[dict]) -> str:
    """Upload the file in the chunks Apple asked for and return its MD5."""
    raw = path.read_bytes()
    for operation in operations:
        offset = int(operation.get("offset", 0))
        length = int(operation.get("length", 0))
        chunk = raw[offset : offset + length]
        headers = {
            header.get("name", ""): header.get("value", "")
            for header in operation.get("requestHeaders") or []
            if header.get("name")
        }
        request(
            operation.get("method") or "PUT",
            operation["url"],
            headers=headers,
            data=chunk,
            timeout=UPLOAD_TIMEOUT,
        )
    return hashlib.md5(raw).hexdigest()


def confirm(bearer: str, shot_id: str, checksum: str) -> None:
    """Without this the record exists and the slot is empty."""
    call(
        "PATCH",
        f"/v1/appScreenshots/{shot_id}",
        bearer,
        {
            "data": {
                "type": "appScreenshots",
                "id": shot_id,
                "attributes": {"uploaded": True, "sourceFileChecksum": checksum},
            }
        },
    )


def await_assets(bearer: str, shots: list[tuple[str, str]]) -> None:
    """Wait until Apple has read every uploaded file.

    A record can be confirmed and still fail to decode; the only place that shows
    up is `assetDeliveryState`, and an image that failed there is a blank in the
    store.
    """
    deadline = time.monotonic() + SETTLE_SECONDS
    while True:
        states: dict[str, str] = {}
        for name, shot_id in shots:
            payload = call(
                "GET",
                f"/v1/appScreenshots/{shot_id}?fields[appScreenshots]=assetDeliveryState",
                bearer,
            )
            attributes = (payload.get("data") or {}).get("attributes") or {}
            states[name] = (attributes.get("assetDeliveryState") or {}).get("state") or "?"
        pending = {name: state for name, state in states.items() if state != "COMPLETE"}
        if not pending:
            return
        if any(state in ("FAILED", "INVALID") for state in pending.values()):
            detail = ", ".join(f"{name}={state}" for name, state in pending.items())
            raise SystemExit(f"::error::App Store Connect could not read {detail}")
        if time.monotonic() >= deadline:
            detail = ", ".join(f"{name}={state}" for name, state in pending.items())
            raise SystemExit(
                f"::error::still not delivered after {SETTLE_SECONDS}s: {detail}. "
                "Run this again to see the state; do not upload the same file twice."
            )
        time.sleep(5)


def slot_report(bearer: str, localization_id: str) -> None:
    """What each slot holds now, from Apple rather than from what was sent."""
    counts = {
        row["display"]: row["count"] for row in asc.screenshots(bearer, localization_id)
    }
    for _, label, display, _ in SLOTS:
        print(f"  {label:16} {display:24} {counts.get(display, 0)} shot(s)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--directory",
        default="shots",
        help="where the captured PNGs are (default: shots)",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="delete the screenshots already in the two slots before uploading",
    )
    parser.add_argument("--dry-run", action="store_true", help="check the files, write nothing")
    args = parser.parse_args()

    dry_run = args.dry_run or os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")

    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        raise SystemExit(f"no directory at {directory}")

    # Check the files before touching the API: a refused upload halfway through
    # a slot is worse than one that never started.
    planned = {
        display: collect(directory, key, label, display, widths)
        for key, label, display, widths in SLOTS
    }
    for key, label, display, widths in SLOTS:
        print(f"{label} ({display}): {len(planned[display])} file(s)")
        for path in planned[display]:
            width, height = png_size(path)
            print(f"  {path.name:28} {width}x{height}")

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
        raise SystemExit("missing " + ", ".join(missing) + " — set the App Store Connect secrets first.")
    if not os.path.exists(key_path):
        raise SystemExit(f"no key at {key_path}")

    bearer = asc.token(key_id, issuer_id, key_path)
    version, text = localization(bearer)
    print(f"\n{asc.BUNDLE_ID}  version {version['version']}  [{version['state']}]  {LOCALE}")

    existing = screenshot_sets(bearer, text["id"])
    for _, label, display, _ in SLOTS:
        held = screenshots_in(bearer, existing[display]["id"]) if display in existing else []
        if held and not args.replace:
            raise SystemExit(
                f"{label} ({display}) already holds {len(held)} screenshot(s). Pass "
                "--replace to delete them first, so the slot is this capture and not "
                "a mix of two."
            )

    if dry_run:
        print("\ndry run: nothing was written. Slots now:")
        slot_report(bearer, text["id"])
        return 0

    uploaded: list[tuple[str, str]] = []
    for _, label, display, _ in SLOTS:
        set_id = ensure_set(bearer, text["id"], display)
        if args.replace:
            for shot in screenshots_in(bearer, set_id):
                name = (shot.get("attributes") or {}).get("fileName") or shot["id"]
                call("DELETE", f"/v1/appScreenshots/{shot['id']}", bearer)
                print(f"removed {name} from {label}")
        for path in planned[display]:
            shot_id, operations = reserve(bearer, set_id, path)
            checksum = send_bytes(path, operations)
            confirm(bearer, shot_id, checksum)
            uploaded.append((path.name, shot_id))
            print(f"uploaded {path.name} -> {label} ({display})")

    print("\nwaiting for App Store Connect to read the files")
    await_assets(bearer, uploaded)

    print("\nslots now:")
    slot_report(bearer, text["id"])
    print("\nreported state is not proof; run the submission check to confirm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
