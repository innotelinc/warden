#!/usr/bin/env python3
"""Write the App Store listing copy from mobile/store/ios/listing.json into
App Store Connect.

The copy lives in the repository so it can be reviewed and length-checked
(tests/mobile-listing.test.ts holds every field to Apple's limits). Typing it
into the web form by hand is how a live listing drifts from a reviewed one, so
this pushes the same strings through the API instead.

It sets, on the newest iOS version page of the app:

  * subtitle, description, keywords, promotional text, support and marketing URL
  * the privacy policy URL on the app information record
  * the primary category
  * the age rating's unrestricted-web-access answer

It deliberately does not touch the app name, the review contact (a person's
name, phone and email are not in this repository), the screenshots (which have
to be captured from the running app) or What's New (optional for a first
version).

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


def patch(path: str, bearer: str, payload: dict) -> dict:
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
            body = response.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise SystemExit(f"App Store Connect returned {error.code} for {path}:\n{detail}")


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

    utilities = category_id(bearer, "UTILITIES")
    print(f"  primary category {utilities}")

    rating = info["rating"]
    if rating is None:
        raise SystemExit("the app has no age rating declaration to answer.")
    key = web_access_key(rating)
    print(f"  age rating       {key} = true (Unrestricted Web Access)")

    if dry_run:
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

    patch(
        f"/v1/ageRatingDeclarations/{rating['id']}",
        bearer,
        {"data": {"type": "ageRatingDeclarations", "id": rating["id"], "attributes": {key: True}}},
    )
    print("answered unrestricted web access")

    print("\nreported state is not proof; run the submission check to confirm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
