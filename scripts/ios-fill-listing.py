#!/usr/bin/env python3
"""Write the App Store listing copy from mobile/store/ios/listing.json into
App Store Connect.

The copy lives in the repository so it can be reviewed and length-checked
(tests/mobile-listing.test.ts holds every field to Apple's limits). Typing it
into the web form by hand is how a live listing drifts from a reviewed one, so
this pushes the same strings through the API instead.

It sets, on the newest iOS version page of the app:

  * description, keywords, promotional text, support and marketing URL
  * the app name, the subtitle and the privacy policy URL on the app
    information record
  * the primary category
  * the age rating's unrestricted-web-access answer
  * the review notes, on the version's App Review information

It deliberately does not touch the review contact (a person's name, phone and
email are not in this repository), the screenshots (which have to be captured
from the running app) or What's New (optional for a first version).

Apple reserves app names across every account, so the name is the one attribute
here that the store can refuse. That refusal is printed and the rest of the
listing is still written.

Credentials are the same four repository secrets the iOS workflows use. The
token and HTTP helpers are taken from scripts/ios-build-status.py, which is
already exercised against the live API, rather than duplicated here — the
hyphen in its name is why it is loaded by path.

    DRY_RUN=false APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-fill-listing.py

Exit status: 0 the listing now matches the file (or a dry run finished),
1 the API refused something.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LISTING = HERE.parent / "mobile/store/ios/listing.json"

_spec = importlib.util.spec_from_file_location("asc_status", HERE / "ios-build-status.py")
asc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(asc)

API = asc.API
LOCALE = "en-US"


def send(method: str, path: str, bearer: str, payload: dict) -> dict:
    request = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = response.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit(f"App Store Connect returned {error.code} for {path}:\n{detail}")


def patch(path: str, bearer: str, payload: dict) -> dict:
    return send("PATCH", path, bearer, payload)


def post(path: str, bearer: str, payload: dict) -> dict:
    return send("POST", path, bearer, payload)


def try_patch(path: str, bearer: str, payload: dict) -> tuple[bool, str]:
    """A PATCH whose refusal is an outcome to report rather than a crash. Only
    the app name uses this: Apple reserves names across every account, so a
    taken one is a fact about the store, not a bug in the write."""
    request = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            response.read()
            return True, ""
    except urllib.error.HTTPError as error:
        return False, error.read().decode("utf-8", "replace")


def write_review_notes(bearer: str, version: dict, notes: str) -> str:
    """App Review reads the notes off the version's App Review information
    record, which App Store Connect creates empty with the version. It is
    patched when it exists and created when it does not, so a version page that
    has never held review information still ends up with them."""
    detail = version.get("review") or {}
    attributes = {"notes": notes}
    if detail.get("id"):
        patch(
            f"/v1/appStoreReviewDetails/{detail['id']}",
            bearer,
            {
                "data": {
                    "type": "appStoreReviewDetails",
                    "id": detail["id"],
                    "attributes": attributes,
                }
            },
        )
        return "updated"
    post(
        "/v1/appStoreReviewDetails",
        bearer,
        {
            "data": {
                "type": "appStoreReviewDetails",
                "attributes": attributes,
                "relationships": {
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version["id"]}
                    }
                },
            }
        },
    )
    return "created"


def version_locale(bearer: str, version: dict) -> dict:
    for localization in version["localizations"]:
        if (localization.get("attributes") or {}).get("locale") == LOCALE:
            return localization
    raise SystemExit(
        f"version {version['version']} has no {LOCALE} localization. Add the language in "
        "App Store Connect first; the API will not invent one."
    )


def category_id(bearer: str, wanted: str) -> str:
    """App categories are referenced by id, and 'Utilities' is not necessarily
    'UTILITIES', so ask Apple rather than guessing."""
    try:
        payload = asc.get(
            "/v1/appCategories",
            bearer,
            {"filter[platforms]": "IOS", "limit": "200"},
        )
    except SystemExit:
        # The filter is not guaranteed to exist on every API revision, and the
        # category list is short enough to read whole.
        payload = asc.get("/v1/appCategories", bearer, {"limit": "200"})
    for category in payload.get("data") or []:
        if (category.get("id") or "").upper() == wanted.upper():
            return category["id"]
    known = sorted(category.get("id") or "?" for category in payload.get("data") or [])
    raise SystemExit(f"no app category {wanted!r} on iOS. Known: {', '.join(known)}")


# The questionnaire mixes two kinds of answer, and sending the wrong type for
# either is a 409. Content questions are severity enums; capability questions
# are booleans. WARDEN ships no content of its own, so every severity is NONE
# and every capability is false — except unrestricted web access, which is the
# whole point of an address field and is what sets the 16+ rating.
CONTENT_QUESTIONS = {
    "alcoholTobaccoOrDrugUseOrReferences",
    "contests",
    "gamblingSimulated",
    "gunsOrOtherWeapons",
    "horrorOrFearThemes",
    "matureOrSuggestiveThemes",
    "medicalOrTreatmentInformation",
    "profanityOrCrudeHumor",
    "sexualContentGraphicAndNudity",
    "sexualContentOrNudity",
    "violenceCartoonOrFantasy",
    "violenceRealistic",
    "violenceRealisticProlongedGraphicOrSadistic",
}

CAPABILITY_QUESTIONS = {
    "advertising",
    "ageAssurance",
    # Added to the questionnaire on 16 November 2026 (App Store Connect API
    # 4.6.1), both booleans. WARDEN declares neither: the browser shares no
    # real-world location with anyone and has no dating or companion features.
    "datingAndRelationships",
    "sharedLocation",
    "gambling",
    "healthOrWellnessTopics",
    "lootBox",
    "messagingAndChat",
    "parentalControls",
    "socialMedia",
    "socialMediaAgeRestricted",
    "unrestrictedWebAccess",
    "userGeneratedContent",
}

# Answers that are not yes/no questions about content at all.
IGNORED = {
    "ageRatingOverride",
    "ageRatingOverrideV2",
    "developerAgeRatingInfoUrl",
    "gracRatingClassificationNumber",
    "kidsAgeBand",
    "koreaAgeRatingOverride",
}


def rating_answers(rating: dict) -> dict:
    """A complete questionnaire: every attribute Apple reports, answered."""
    present = set(rating.get("attributes") or {})
    unknown = present - CONTENT_QUESTIONS - CAPABILITY_QUESTIONS - IGNORED
    if unknown:
        # A new question must be answered deliberately, not defaulted away.
        raise SystemExit(
            "the age rating questionnaire has questions this script does not know: "
            + ", ".join(sorted(unknown))
        )

    answers: dict[str, object] = {}
    for question in sorted(CONTENT_QUESTIONS & present):
        answers[question] = "NONE"
    for question in sorted(CAPABILITY_QUESTIONS & present):
        answers[question] = False
    answers["unrestrictedWebAccess"] = True
    return answers


def web_access_key(rating: dict) -> str:
    """Apple's age rating attributes are named inconsistently across schema
    revisions, so find the one that means unrestricted web access."""
    for key in (rating.get("attributes") or {}):
        if "nrestrictedweb" in key.lower():
            return key
    raise SystemExit("the age rating declaration has no unrestricted-web attribute")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print the changes, write nothing")
    parser.add_argument(
        "--attach-build",
        default="",
        help="attach this TestFlight build number to the version page",
    )
    args = parser.parse_args()

    dry_run = args.dry_run or os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")

    copy = json.loads(LISTING.read_text(encoding="utf-8"))

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
    app = asc.app_id(bearer)
    version = asc.newest_version(bearer, app)
    localization = version_locale(bearer, version)
    info = asc.app_info(bearer, app)

    print(f"{asc.BUNDLE_ID}  version {version['version']}  [{version['state']}]  {LOCALE}\n")

    # --- the version page's text -------------------------------------------
    version_attributes = {
        "description": copy["description"],
        "keywords": copy["keywords"],
        "promotionalText": copy["promotionalText"],
        "supportUrl": copy["supportUrl"],
        "marketingUrl": copy["marketingUrl"],
    }
    print("version text:")
    for key, value in version_attributes.items():
        print(f"  {key:15} {len(value):5} chars  {value.splitlines()[0][:60]}")

    # --- app information ----------------------------------------------------
    info_localization = next(
        (
            item
            for item in info["localizations"]
            if (item.get("attributes") or {}).get("locale") == LOCALE
        ),
        None,
    )
    if info_localization is None:
        raise SystemExit(f"the app information record has no {LOCALE} localization.")

    info_attributes = {
        "subtitle": copy["subtitle"],
        "privacyPolicyUrl": copy["privacyPolicyUrl"],
    }
    print("\napp information:")
    for key, value in info_attributes.items():
        print(f"  {key:16} {value}")
    # Written on its own below: Apple can refuse a name another account holds,
    # and that must not stop the rest of the listing from being written.
    print(f"  {'name':16} {copy['name']}")

    utilities = category_id(bearer, "UTILITIES")
    print(f"  primary category {utilities}")

    rating = info["rating"]
    if rating is None:
        raise SystemExit("the app has no age rating declaration to answer.")
    print(
        f"  age rating       {len(rating_answers(rating))} answers, "
        "Unrestricted Web Access = yes (16+)"
    )

    notes = copy["reviewNotes"]
    print(f"  review notes     {len(notes)} chars, {len(notes.splitlines())} lines")

    attached: dict | None = None
    if args.attach_build:
        candidates = asc.builds(bearer, app, 50)
        attached = next(
            (row for row in candidates if str(row["number"]) == str(args.attach_build)), None
        )
        if attached is None:
            raise SystemExit(f"no build {args.attach_build} on {asc.BUNDLE_ID}")
        if attached["state"] != "VALID":
            raise SystemExit(
                f"build {args.attach_build} is {attached['state']}; only a VALID build "
                "can be attached to a version."
            )
        print(f"\nattach {attached['marketing']} ({attached['number']}) to version {version['version']}")

    if dry_run:
        print("\nreview notes:\n" + "\n".join("  | " + line for line in notes.splitlines()))
        print("\nage rating questionnaire:")
        for attribute, value in sorted(rating_answers(rating).items()):
            print(f"  {attribute:45} {value!r}")
        print("\ndry run: nothing was written.")
        return 0

    patch(
        f"/v1/appStoreVersionLocalizations/{localization['id']}",
        bearer,
        {"data": {"type": "appStoreVersionLocalizations", "id": localization["id"], "attributes": version_attributes}},
    )
    print("\nwrote version text")

    patch(
        f"/v1/appInfoLocalizations/{info_localization['id']}",
        bearer,
        {
            "data": {
                "type": "appInfoLocalizations",
                "id": info_localization["id"],
                "attributes": info_attributes,
            }
        },
    )
    print("wrote app information")

    name_ok, name_detail = try_patch(
        f"/v1/appInfoLocalizations/{info_localization['id']}",
        bearer,
        {
            "data": {
                "type": "appInfoLocalizations",
                "id": info_localization["id"],
                "attributes": {"name": copy["name"]},
            }
        },
    )
    if name_ok:
        print(f"set the app name to {copy['name']}")
    elif "already being used" in name_detail:
        # Apple reserves app names across every account and releases one only
        # through a trademark claim, so retrying cannot help. The screenshots,
        # review notes and build are independent of the name.
        print(
            f"app name {copy['name']!r} is already in use on another App Store Connect "
            "account, so the record keeps its current name. Apple releases a taken "
            "name only through a trademark claim; otherwise pick a variant."
        )
    else:
        raise SystemExit(f"App Store Connect refused the app name: {name_detail}")

    app_info_id = (asc.get(f"/v1/apps/{app}/appInfos", bearer, {"limit": "5"}).get("data") or [{}])[0]["id"]
    patch(
        f"/v1/appInfos/{app_info_id}",
        bearer,
        {
            "data": {
                "type": "appInfos",
                "id": app_info_id,
                "relationships": {
                    "primaryCategory": {"data": {"type": "appCategories", "id": utilities}}
                },
            }
        },
    )
    print("set the primary category")

    answers = rating_answers(rating)
    patch(
        f"/v1/ageRatingDeclarations/{rating['id']}",
        bearer,
        {"data": {"type": "ageRatingDeclarations", "id": rating["id"], "attributes": answers}},
    )
    print(
        f"answered the age rating questionnaire ({len(answers)} answers, "
        "unrestricted web access yes)"
    )

    action = write_review_notes(bearer, version, notes)
    print(f"{action} the review notes ({len(notes)} chars)")

    if attached is not None:
        patch(
            f"/v1/appStoreVersions/{version['id']}/relationships/build",
            bearer,
            {"data": {"type": "builds", "id": attached["id"]}},
        )
        print(f"attached build {attached['number']} to version {version['version']}")

    print("\nreported state is not proof; run the submission check to confirm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
