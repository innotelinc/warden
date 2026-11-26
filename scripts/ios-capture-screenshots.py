#!/usr/bin/env python3
"""Capture the App Store screenshots from the build itself, on a Mac.

App Store Connect wants a set for the 6.9-inch iPhone and a set for the 13-inch
iPad, three or more each, and they have to be of the running app: a mockup of a
UI that does not exist is a 2.3 rejection, and this repository holds no devices.
So this builds the same source for the simulator, boots one device of each size,
installs the app, walks it through the three screens the listing shows, and
keeps the PNGs — named for the slot each one belongs to.

    python3 scripts/ios-capture-screenshots.py \
      --project mobile/ios/App --out "$RUNNER_TEMP/screenshots"

The walk is not UI automation. `simctl` cannot tap, so the shell answers two
`warden://` addresses and `simctl openurl` sends them:

    warden://browse?url=https://example.com    the page in WARDEN's own surface
    warden://scry?url=https://example.com      Scry's report of that page

Screen one needs neither: it is the app on launch, which is the posture screen.

Every capture is checked before it is kept: a portrait PNG 1260, 1290 or 1320
pixels wide for the phone (the API's APP_IPHONE_67 slot, which App Store Connect
labels "6.9-inch display") and 2048 or 2064 wide for the tablet
(APP_IPAD_PRO_3GEN_129, the 13-inch slot). A file that does not fit its slot is a
failure here rather than at upload.

The waits are wall-clock — a page load, plus the Scry capture — so `--settle`
raises them on a slow machine or a slow page. macOS only: `simctl` and
`xcodebuild` do not exist anywhere else.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

BUNDLE_ID = "us.innotel.warden"

# The page every screenshot shows. It is the one the review notes tell a reviewer
# to type, and it loads without a login, an ad or a cookie wall.
EXAMPLE = "https://example.com"


@dataclass(frozen=True)
class Slot:
    """One App Store screenshot slot, and the simulator sizes that fill it."""

    key: str
    label: str
    display_type: str
    widths: tuple[int, ...]
    devices: tuple[str, ...]


SLOTS: tuple[Slot, ...] = (
    Slot(
        key="iphone-6.9",
        label='6.9-inch iPhone',
        # Apple labels this slot "6.9-inch display" in App Store Connect, but the
        # API value is still the 6.7-inch name; it accepts all three 6.9" sizes.
        display_type="APP_IPHONE_67",
        widths=(1260, 1290, 1320),
        devices=(
            "iPhone 17 Pro Max",
            "iPhone 16 Pro Max",
            "iPhone Air",
            "iPhone 16 Plus",
            "iPhone 15 Pro Max",
        ),
    ),
    Slot(
        key="ipad-13",
        label='13-inch iPad',
        display_type="APP_IPAD_PRO_3GEN_129",
        widths=(2048, 2064),
        devices=(
            "iPad Pro 13-inch (M5)",
            "iPad Pro 13-inch (M4)",
            "iPad Pro 12.9-inch (6th generation)",
            "iPad Pro 12.9-inch (5th generation)",
        ),
    ),
)


def tour_link(screen: str) -> str:
    return f"warden://{screen}?url={urllib.parse.quote(EXAMPLE, safe='')}"


# The three screens, in the order the store shows them. `None` means "the app as
# it launches": the posture screen, which needs no address.
STEPS: tuple[tuple[str, str | None, str], ...] = (
    ("posture", None, "the posture screen on launch"),
    ("browse", tour_link("browse"), "a page in WARDEN's own surface"),
    ("scry", tour_link("scry"), "Scry's report of that page"),
)


def run(command: list[str], capture: bool = False) -> str:
    print("$ " + " ".join(command), flush=True)
    result = subprocess.run(command, text=True, capture_output=capture)
    if result.returncode != 0:
        if capture:
            print(result.stdout or "", result.stderr or "", sep="")
        raise SystemExit(
            f"::error::{command[0]} failed ({result.returncode}): " + " ".join(command)
        )
    return (result.stdout or "") if capture else ""


def simctl(*args: str, capture: bool = False) -> str:
    return run(["xcrun", "simctl", *args], capture=capture)


def quiet(command: list[str]) -> None:
    """Best-effort cleanup: a device that is already gone is not a failure."""
    subprocess.run(command, text=True, capture_output=True)


def runtime_identifier() -> str:
    """The newest installed iOS runtime, by version rather than by name."""
    payload = json.loads(simctl("list", "runtimes", "--json", capture=True))
    usable = [
        entry
        for entry in payload.get("runtimes") or []
        if entry.get("isAvailable")
        and str(entry.get("identifier", "")).startswith(
            "com.apple.CoreSimulator.SimRuntime.iOS-"
        )
    ]
    if not usable:
        raise SystemExit(
            "::error::no iOS simulator runtime is installed. "
            "`xcodebuild -downloadPlatform iOS` installs one."
        )

    def version(entry: dict) -> tuple[int, ...]:
        tail = entry["identifier"].split("iOS-", 1)[-1]
        return tuple(int(part) for part in re.findall(r"\d+", tail))

    return max(usable, key=version)["identifier"]


def device_type(known: list[dict], slot: Slot) -> tuple[str, str]:
    """The first simulator this script knows about that the machine has."""
    by_name = {entry["name"]: entry["identifier"] for entry in known}
    for name in slot.devices:
        if name in by_name:
            return name, by_name[name]
    installed = ", ".join(sorted(by_name)[:24])
    raise SystemExit(
        f"::error::no {slot.label} simulator is installed. This script knows "
        f"{', '.join(slot.devices)}; the machine has: {installed}"
    )


def build_for_simulator(project: Path, derived: Path) -> Path:
    """One build, installed on both devices: only the devices differ."""
    workspace = project / "App.xcworkspace"
    if not workspace.exists():
        raise SystemExit(
            f"::error::no {workspace}. Run `npx cap sync ios` and `pod install` first."
        )
    run(
        [
            "xcodebuild",
            "-workspace",
            str(workspace),
            "-scheme",
            "App",
            "-configuration",
            "Release",
            "-sdk",
            "iphonesimulator",
            "-destination",
            "generic/platform=iOS Simulator",
            "-derivedDataPath",
            str(derived),
            "CODE_SIGNING_ALLOWED=NO",
            "build",
        ],
        capture=True,
    )
    app = derived / "Build" / "Products" / "Release-iphonesimulator" / "App.app"
    if not app.exists():
        raise SystemExit(f"::error::the simulator build produced no {app}")
    return app


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"::error::{path.name} is not a PNG")
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def check_slot(path: Path, slot: Slot) -> tuple[int, int]:
    """A file App Store Connect will refuse is a failure here, not at upload."""
    width, height = png_size(path)
    if width not in slot.widths or height <= width:
        sizes = " or ".join(str(value) for value in slot.widths)
        raise SystemExit(
            f"::error::{path.name} is {width}x{height}. The {slot.label} slot "
            f"({slot.display_type}) needs a portrait PNG {sizes} wide."
        )
    return width, height


def capture(slot: Slot, app: Path, runtime: str, known: list[dict], out: Path, settle: float) -> None:
    device_name, type_id = device_type(known, slot)
    print(f"\n{slot.label}: {device_name} on {runtime}")

    udid = simctl("create", f"WARDEN {slot.key} shots", type_id, runtime, capture=True).strip()
    if not udid:
        raise SystemExit("::error::simctl created no device")
    try:
        simctl("boot", udid)
        simctl("bootstatus", udid, "-b")
        simctl("install", udid, str(app))
        simctl("launch", udid, BUNDLE_ID)
        time.sleep(settle)

        for index, (name, link, description) in enumerate(STEPS, start=1):
            if link is not None:
                simctl("openurl", udid, link)
                time.sleep(settle)
            target = out / f"{slot.key}-{index}-{name}.png"
            simctl("io", udid, "screenshot", str(target))
            width, height = check_slot(target, slot)
            print(f"  {target.name}  {width}x{height}  -> {slot.display_type}  ({description})")
    finally:
        quiet(["xcrun", "simctl", "shutdown", udid])
        quiet(["xcrun", "simctl", "delete", udid])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--project",
        default="mobile/ios/App",
        help="the Xcode project directory (contains App.xcworkspace)",
    )
    parser.add_argument(
        "--out",
        default="mobile/store/ios/screenshots",
        help="where the PNGs are written",
    )
    parser.add_argument(
        "--settle",
        type=float,
        default=15.0,
        help="seconds to wait after launch and after each address (default 15)",
    )
    parser.add_argument(
        "--only",
        default="",
        choices=["", *(slot.key for slot in SLOTS)],
        help="capture one slot instead of both",
    )
    args = parser.parse_args()

    if sys.platform != "darwin":
        raise SystemExit("::error::simctl and xcodebuild only exist on macOS")

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    print("checking the simulator runtimes and devices")
    runtime = runtime_identifier()
    known = json.loads(simctl("list", "devicetypes", "--json", capture=True)).get("devicetypes") or []

    # Derived data is build output, so it belongs in a temporary directory and
    # not beside the screenshots: the repository is what this script writes to.
    print(f"\nbuilding {args.project} for the simulator")
    derived = Path(tempfile.mkdtemp(prefix="warden-ios-shots-"))
    try:
        app = build_for_simulator(Path(args.project), derived)
        for slot in SLOTS:
            if args.only and slot.key != args.only:
                continue
            capture(slot, app, runtime, known, out, args.settle)
    finally:
        shutil.rmtree(derived, ignore_errors=True)

    print(f"\n{out}")
    for slot in SLOTS:
        files = sorted(out.glob(f"{slot.key}-*.png"))
        if files:
            print(f"  {slot.label} ({slot.display_type}): {len(files)} file(s)")
    print(
        "\nApp Store Connect -> the version -> App Previews and Screenshots, and put\n"
        "each set in its own slot: 'iPhone 6.9\" Display' and 'iPad 13\" Display'.\n"
        "Then re-run ios-build-status.yml with submission=true."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
