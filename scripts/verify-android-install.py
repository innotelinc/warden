#!/usr/bin/env python3
"""Prove the APK a release published installs and launches on a clean device.

`verify-apk-signature.py` reads the signer certificate out of the file, which says
the bytes are signed and nothing about whether a phone will take them. The gap is
not academic: an APK with no launcher activity installs perfectly and is then
unreachable from the home screen, and one whose WebView dies on start looks fine
to every check that never opens it.

    python3 scripts/verify-android-install.py build/apk 0.2.12

Run on an emulator that has nothing installed on it, so this is the state a
first-time user's phone is in. The version the device reports is compared with
the one this run built, because the artifact and the published asset share a name
and a build number and only that tells them apart.

This lives in a script rather than in the workflow because the emulator action
executes `script` one line at a time in a fresh /bin/sh: a variable assigned on
one line is gone on the next, and a multi-line `if` is a syntax error.

Exit status: 0 the APK installed, launched and stayed in the foreground; 1 it did
not, with the reason printed.
"""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys
import time

# Must match applicationId in mobile/android/app/build.gradle.
PACKAGE = "us.innotel.warden"

# How long the app is given, after `am start` reports success, to appear in the
# foreground or die. Emulators are slow and a cold WebView is slower.
SETTLE_SECONDS = 8


def fail(message: str, details: list[str] | None = None) -> "SystemExit":
    print(f"::error::{message}")
    for line in details or []:
        if line:
            print(line)
    return SystemExit(1)


def adb(*args: str, check: bool = True) -> str:
    result = subprocess.run(["adb", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise fail(
            f"adb {' '.join(args)} failed",
            [result.stdout.strip(), result.stderr.strip()],
        )
    return (result.stdout or "").replace("\r", "")


def resolve_apk(target: str) -> str:
    """One APK, from a path or a directory: never an empty variable by accident."""

    if os.path.isdir(target):
        found = sorted(glob.glob(os.path.join(target, "*.apk")))
        if len(found) != 1:
            raise fail(
                f"expected exactly one .apk in {target}, found {len(found)}",
                [
                    "Checking anything else would test a file that was not published.",
                    "The artifact download produced nothing if this is zero.",
                ],
            )
        return found[0]

    if not os.path.isfile(target):
        raise fail(f"{target} does not exist", ["There is no .apk to install."])
    return target


def device() -> str:
    listing = [line.split()[0] for line in adb("devices").splitlines()[1:] if line.strip()]
    return listing[0] if listing else "no device"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("apk", help="the .apk, or a directory holding exactly one")
    parser.add_argument("version", help="the version this run built, e.g. 0.2.12")
    parser.add_argument("--package", default=PACKAGE)
    args = parser.parse_args(argv)

    apk = resolve_apk(args.apk)
    print(f"installing {os.path.basename(apk)} on {device()}, which has nothing on it")

    # A plain install, not a reinstall: the point is a device that has never had
    # WARDEN on it, which is what a new tester starts from.
    install = subprocess.run(["adb", "install", apk], capture_output=True, text=True)
    output = (install.stdout or "").replace("\r", "").strip()
    print(output or install.stderr.strip())
    if install.returncode != 0 or "Success" not in output:
        raise fail(
            "the package manager refused the APK",
            [output, install.stderr.strip()],
        )

    packages = adb("shell", "pm", "list", "packages").split()
    if f"package:{args.package}" not in packages:
        raise fail(
            f"{args.package} is not installed, although adb install reported Success",
            [f"pm list packages has {len(packages)} entries and none of them is it."],
        )

    dump = adb("shell", "dumpsys", "package", args.package)
    version = next(
        (
            line.split("=", 1)[1].strip()
            for line in dump.splitlines()
            if line.strip().startswith("versionName=")
        ),
        "",
    )
    print(f"the device reports version {version or 'nothing'}; this run built {args.version}")
    if version != args.version:
        raise fail(
            f"the device has {version or 'no version'} but this run built {args.version}",
            [
                "The installed artifact is not the one that was published, so this",
                "check would have been testing the wrong file.",
            ],
        )

    resolved = adb("shell", "cmd", "package", "resolve-activity", "--brief", args.package)
    component = resolved.strip().splitlines()[-1].strip() if resolved.strip() else ""
    print(f"launcher activity: {component or 'none'}")
    if not component.startswith(f"{args.package}/"):
        raise fail(
            "the APK has no launcher activity, so nothing happens when the icon is tapped",
            [resolved.strip()],
        )

    start = subprocess.run(
        ["adb", "shell", "am", "start", "-W", "-n", component], capture_output=True, text=True
    )
    started = (start.stdout or "").replace("\r", "").strip()
    print(started)
    if start.returncode != 0 or "Status: ok" not in started:
        raise fail(
            "the launch did not report Status: ok — this is what tapping the icon does",
            [started, (start.stderr or "").strip()],
        )

    # A launch that reports success and dies a second later is still broken.
    time.sleep(SETTLE_SECONDS)

    activities = adb("shell", "dumpsys", "activity", "activities")
    resumed = next(
        (
            line.strip()
            for line in activities.splitlines()
            if "topResumedActivity" in line or "mResumedActivity" in line
        ),
        "",
    )
    print(f"foreground: {resumed or 'nothing'}")
    if args.package not in resumed:
        raise fail(
            "WARDEN launched but is not the foreground activity",
            [resumed or "Nothing is resumed, so the app closed or was replaced."],
        )

    pid = adb("shell", "pidof", args.package, check=False).strip()
    if not pid:
        crash = adb("logcat", "-d", "-b", "crash", check=False)
        raise fail(
            f"the process was gone {SETTLE_SECONDS} seconds after launch",
            crash.strip().splitlines()[-40:],
        )

    print(f"running as pid {pid}, {SETTLE_SECONDS} seconds after a cold start")
    print(f"installed {args.version}, launched {component} and stayed in the foreground")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
