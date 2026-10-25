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

A build that is VALID still reaches nobody until a TestFlight group holds it, so
`--groups` reports which groups exist and what they contain, and `--add-build-to`
puts the build in one. `hasAccessToAllBuilds` is Apple's "Enable automatic
distribution": when it is set, an upload joins the group on its own.

    ... python3 scripts/ios-build-status.py --build-number 10 --groups
    ... python3 scripts/ios-build-status.py --build-number 10 --add-build-to 'Internal'

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
                "id": build["id"],
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


def post(path: str, bearer: str, payload: dict) -> None:
    request = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45):
            return
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        if error.code == 409:
            raise SystemExit(
                "App Store Connect refused the change (409): the build is already in "
                "that group, or it is not VALID yet.\n" + body
            )
        raise SystemExit(f"App Store Connect returned {error.code} for {path}:\n{body}")


def beta_groups(bearer: str, app: str) -> list[dict]:
    """TestFlight groups, each with the build numbers currently assigned to it.

    `hasAccessToAllBuilds` is the API's name for "Enable automatic distribution":
    with it set, an upload reaches the group without anyone adding it by hand.
    """
    payload = get(
        "/v1/betaGroups",
        bearer,
        {
            "filter[app]": app,
            "limit": "50",
            "include": "builds",
            "fields[builds]": "version",
            "limit[builds]": "50",
        },
    )

    numbered = {
        item["id"]: item["attributes"].get("version")
        for item in payload.get("included") or []
        if item.get("type") == "builds"
    }

    groups = []
    for group in payload.get("data") or []:
        attributes = group["attributes"]
        assigned = (group.get("relationships") or {}).get("builds", {}).get("data") or []
        groups.append(
            {
                "id": group["id"],
                "name": attributes.get("name") or "?",
                "internal": bool(attributes.get("isInternalGroup")),
                "all_builds": bool(attributes.get("hasAccessToAllBuilds")),
                "builds": sorted(
                    (numbered.get(item["id"], "?") for item in assigned),
                    key=lambda value: (len(value), value),
                ),
            }
        )
    return groups


def testers(bearer: str, group: str) -> list[str]:
    """The people in a group. Only App Store Connect users can be internal
    testers, and a build reaches nobody whose Apple ID is not on this list."""
    payload = get(
        f"/v1/betaGroups/{group}/betaTesters",
        bearer,
        {"limit": "200", "fields[betaTesters]": "email,firstName,lastName"},
    )
    people = []
    for person in payload.get("data") or []:
        attributes = person["attributes"]
        name = " ".join(filter(None, [attributes.get("firstName"), attributes.get("lastName")]))
        email = attributes.get("email") or "?"
        people.append(f"{name} <{email}>" if name else email)
    return sorted(people)


def describe_groups(groups: list[dict]) -> str:
    if not groups:
        return (
            "no TestFlight groups yet. TestFlight -> Internal Testing -> + creates one; "
            "without a group no build is visible in the TestFlight app."
        )
    lines = []
    for group in groups:
        kind = "internal" if group["internal"] else "external"
        if group["all_builds"]:
            delivery = "automatic (every build joins it on its own)"
        else:
            delivery = "manual (builds must be added)"
        assigned = ", ".join(group["builds"]) if group["builds"] else "none"
        lines.append(f"{group['name']}  [{kind}]")
        lines.append(f"  distribution: {delivery}")
        lines.append(f"  builds: {assigned}")
        people = group.get("testers") or []
        lines.append("  testers: " + (", ".join(people) if people else "none — nobody can install it yet"))
    return "\n".join(lines)


def assign_to_group(groups: list[dict], name: str, build: dict, bearer: str) -> None:
    wanted = [group for group in groups if group["name"].casefold() == name.casefold()]
    if not wanted:
        known = ", ".join(group["name"] for group in groups) or "none"
        raise SystemExit(f"no TestFlight group called {name!r}. Existing groups: {known}")
    group = wanted[0]
    if group["all_builds"] or build["number"] in group["builds"]:
        print(f"{build['marketing']} ({build['number']}) is already in {group['name']}.")
        return
    post(
        f"/v1/betaGroups/{group['id']}/relationships/builds",
        bearer,
        {"data": [{"type": "builds", "id": build["id"]}]},
    )
    print(f"Added {build['marketing']} ({build['number']}) to {group['name']}.")


def select_target(rows: list[dict], build_number: str) -> dict | None:
    """The build the caller is asking about, or None if it is not listed yet."""
    if not build_number:
        return rows[0] if rows else None
    wanted = [row for row in rows if str(row["number"]) == str(build_number)]
    return wanted[0] if wanted else None


# The screenshots a universal app needs before Apple lets a version be
# submitted: one set for the largest iPhone and one for the largest iPad.
RECOMMENDED_SHOTS = 3

def newest_version(bearer: str, app: str) -> dict:
    """The version page a submission is made against, with its build, its
    per-language text and its review notes attached."""
    payload = get(
        "/v1/appStoreVersions",
        bearer,
        {
            "filter[app]": app,
            "filter[platform]": "IOS",
            "sort": "-createdDate",
            "limit": "1",
            "include": "build,appStoreVersionLocalizations,appStoreReviewDetail",
        },
    )
    data = payload.get("data") or []
    if not data:
        raise SystemExit(
            "no iOS version page exists yet. App Store Connect -> Apps -> WARDEN -> "
            "the iOS version must exist before a build can be attached to it."
        )
    version = data[0]
    included = payload.get("included") or []

    def first(kind: str) -> dict | None:
        return next((item for item in included if item.get("type") == kind), None)

    return {
        "id": version["id"],
        "version": version["attributes"].get("versionString") or "?",
        "state": version["attributes"].get("appStoreState") or "?",
        "build": first("builds"),
        "review": first("appStoreReviewDetails"),
        "localizations": [item for item in included if item.get("type") == "appStoreVersionLocalizations"],
    }


def screenshots(bearer: str, localization: str) -> list[dict]:
    sets = get(
        f"/v1/appStoreVersionLocalizations/{localization}/appScreenshotSets",
        bearer,
        {"limit": "50"},
    )
    rows = []
    for shot_set in sets.get("data") or []:
        shots = get(
            f"/v1/appScreenshotSets/{shot_set['id']}/appScreenshots",
            bearer,
            {"limit": "50"},
        )
        rows.append(
            {
                "display": shot_set["attributes"].get("screenshotDisplayType") or "?",
                "count": len(shots.get("data") or []),
            }
        )
    return rows


def app_info(bearer: str, app: str) -> dict:
    payload = get(
        "/v1/appInfos",
        bearer,
        {
            "filter[app]": app,
            "limit": "5",
            "include": "appInfoLocalizations,primaryCategory,ageRatingDeclaration",
        },
    )
    included = payload.get("included") or []
    info = (payload.get("data") or [{}])[0]
    return {
        "category": next((i for i in included if i.get("type") == "appCategories"), None),
        "localizations": [i for i in included if i.get("type") == "appInfoLocalizations"],
        "rating": next((i for i in included if i.get("type") == "ageRatingDeclarations"), None),
        "state": (info.get("attributes") or {}).get("appStoreState") if info else None,
    }


def unrestricted_web(rating: dict | None) -> tuple[str, bool]:
    """The age-rating answer a browser lives or dies by, whatever Apple calls it."""
    if not rating:
        return "not answered yet", False
    for key, value in (rating.get("attributes") or {}).items():
        if "nrestrictedweb" in key.lower():
            return ("yes" if value else "no"), True
    return "not exposed by the API", True


def submission_report(bearer: str, app: str) -> int:
    version = newest_version(bearer, app)
    info = app_info(bearer, app)

    rows: list[tuple[str, bool, str]] = []

    # --- text, per language -------------------------------------------------
    for localization in version["localizations"]:
        attributes = localization.get("attributes") or {}
        language = attributes.get("locale") or "?"
        for field, label in (
            ("description", "description"),
            ("keywords", "keywords"),
            ("supportUrl", "support URL"),
            ("marketingUrl", "marketing URL"),
            ("promotionalText", "promotional text"),
            ("whatsNew", "what's new"),
        ):
            value = attributes.get(field) or ""
            rows.append((f"{language} {label}", bool(value), value[:40] or "empty"))

        # --- screenshots ----------------------------------------------------
        shots = screenshots(bearer, localization["id"])
        kinds = ", ".join(f"{row['display']}={row['count']}" for row in shots) or "none"
        has_iphone = any(row["display"].startswith("APP_IPHONE") for row in shots)
        has_ipad = any(row["display"].startswith("APP_IPAD") for row in shots)
        enough = all(row["count"] >= RECOMMENDED_SHOTS for row in shots) if shots else False
        rows.append((f"{language} iPhone screenshots", has_iphone, kinds))
        rows.append((f"{language} iPad screenshots", has_ipad, kinds))
        rows.append((f"{language} {RECOMMENDED_SHOTS}+ per size", enough, kinds))

    # --- app information ----------------------------------------------------
    for localization in info["localizations"]:
        attributes = localization.get("attributes") or {}
        language = attributes.get("locale") or "?"
        for field in ("name", "subtitle", "privacyPolicyUrl"):
            value = attributes.get(field) or ""
            rows.append((f"{language} {field}", bool(value), value[:40] or "empty"))

    category = (info["category"] or {}).get("attributes") or {}
    # appCategories has no attributes; the id itself is the platform category.
    rows.append(("primary category", bool(info["category"]), category.get("name") or (info["category"] or {}).get("id") or "not set"))

    answer, rated = unrestricted_web(info["rating"])
    rows.append(("age rating answered", rated, answer))

    # --- the version page ---------------------------------------------------
    build = version["build"]
    rows.append(("build attached", build is not None, (build or {}).get("attributes", {}).get("version") or "none"))
    review = (version["review"] or {}).get("attributes") or {}
    rows.append(("review notes", bool(review.get("notes")), (review.get("notes") or "empty")[:40]))
    rows.append(("review contact", bool(review.get("contactEmail")), review.get("contactEmail") or "empty"))

    width = max((len(row[0]) for row in rows), default=0)
    print(f"App Store submission for {version['version']}  [{version['state']}]\n")
    for label, ok, detail in rows:
        print(f"{'ok  ' if ok else 'GAP '} {label.ljust(width)}  {detail}")

    gaps = [label for label, ok, _ in rows if not ok]
    print()
    if gaps:
        print(f"{len(gaps)} field(s) still needed before this version can be submitted:")
        for gap in gaps:
            print(f"  - {gap}")
        return 1
    print("nothing missing that the API reports; the version can be submitted.")
    return 0


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
    parser.add_argument(
        "--submission",
        action="store_true",
        help="report what the current iOS version still needs before it can be submitted",
    )
    parser.add_argument(
        "--groups",
        action="store_true",
        help="also report the TestFlight groups and which builds they hold",
    )
    parser.add_argument(
        "--add-build-to",
        default="",
        help="add the reported build to this TestFlight group (needs a VALID build)",
    )
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

    if args.submission:
        return submission_report(bearer, app)

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
        target = select_target(rows, args.build_number)

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

    # A VALID build is only installable once a TestFlight group holds it, so the
    # group is where the answer to "can a tester see it yet" actually lives.
    if args.add_build_to:
        if target is None or target["state"] != "VALID":
            label = args.build_number or (target["number"] if target else "newest")
            state = target["state"] if target else "not listed"
            raise SystemExit(f"build {label} is {state}; only a VALID build can join a group.")
        groups = beta_groups(bearer, app)
        assign_to_group(groups, args.add_build_to, target, bearer)
        groups = beta_groups(bearer, app)
    elif args.groups:
        groups = beta_groups(bearer, app)
    else:
        groups = []

    if groups:
        for group in groups:
            group["testers"] = testers(bearer, group["id"])
        print("\n" + describe_groups(groups))

    summarise(rows, args.wait_minutes)

    if target is None or target["state"] == "PROCESSING":
        print("\nStill processing. Run this again in a few minutes, or with --wait-minutes.")
        return 3
    if target["state"] in ("FAILED", "INVALID"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
