#!/usr/bin/env python3
"""Register an app's bundle id, and get its App Store Connect record created.

Two steps are needed before a build has anywhere to land:

  1. the bundle id (`/v1/bundleIds`) — an identifier in the team's developer
     account, e.g. `tech.innotel.zapit`;
  2. the app record (`/v1/apps`) — the store entry, with the name that appears
     on the App Store, an SKU the account uses internally, a primary language
     and that bundle id.

Step 1 is done here. **Step 2 cannot be done by any API key.** Apple's public
API refuses `CREATE` on `apps` for every role — an Admin key gets the same
`403 FORBIDDEN_ERROR: The resource 'apps' does not allow 'CREATE'. Allowed
operations are: GET_COLLECTION, GET_INSTANCE, UPDATE` that an App Manager key
gets, and Apple's own forum has that answer. Raising the key's role does not
change it. The app record is created in App Store Connect, in a browser, and
this script prints exactly what to type there:

    https://appstoreconnect.apple.com/apps  ->  +  ->  New App

So this is not a one-shot that silently half-finishes: it registers the bundle
id if it is missing, then reports whether the app record exists, and prints the
form when it does not. Run it again after creating the record to confirm the
two line up.

An identifier that is already registered is reused rather than re-registered,
so a re-run is safe. An App ID cannot be renamed or deleted afterwards, which
is why the dry run is the default.

Credentials are the same four repository secrets the other iOS workflows read.
The token and HTTP helpers come from scripts/ios-build-status.py, which is
already exercised against the live API, rather than being duplicated here.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-create-app.py \
        --bundle-id tech.innotel.zapit --name 'ZAPIT File Transfer' --sku ZAPIT-IOS

Exit status: 0 the bundle id exists (or a dry run printed the plan),
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

_spec = importlib.util.spec_from_file_location("asc_status", HERE / "ios-build-status.py")
asc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(asc)

API = asc.API


def send(method: str, path: str, bearer: str, payload: dict | None = None) -> dict:
    """A write, with Apple's own error body printed when it refuses."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        API + path,
        data=data,
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
        raise SystemExit(f"App Store Connect returned {error.code} for {method} {path}:\n{detail}")


def find_bundle_id(bearer: str, identifier: str) -> dict | None:
    payload = asc.get("/v1/bundleIds", bearer, {"filter[identifier]": identifier, "limit": "5"})
    for row in payload.get("data") or []:
        if (row.get("attributes") or {}).get("identifier") == identifier:
            return row
    return None


def find_app(bearer: str, bundle_id: str) -> dict | None:
    payload = asc.get("/v1/apps", bearer, {"filter[bundleId]": bundle_id, "limit": "5"})
    data = payload.get("data") or []
    return data[0] if data else None


def print_record_steps(name: str, bundle_id: str, sku: str, locale: str) -> None:
    """The app-record form, because only a browser can submit it."""
    print()
    print("The app record does not exist yet. No API key can create one:")
    print("Apple refuses CREATE on apps for every role, Admin included. Create it")
    print("in App Store Connect — https://appstoreconnect.apple.com/apps -> + -> New App")
    print()
    print("  Platform        iOS")
    print(f"  Name            {name}")
    print(f"  Primary language   {locale}")
    print(f"  Bundle ID       {bundle_id}   (already registered, pick it from the list)")
    print(f"  SKU             {sku}")
    print("  User access     Full Access")
    print()
    print("Then run this again: it should report the record as existing.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Register a bundle id and report the app record.")
    parser.add_argument("--bundle-id", required=True, help="e.g. tech.innotel.zapit")
    parser.add_argument("--name", required=True, help="the App Store name, unique store-wide")
    parser.add_argument("--sku", required=True, help="internal SKU, e.g. ZAPIT-IOS")
    parser.add_argument("--locale", default="en-US", help="primary language (default en-US)")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="register the bundle id; without it the plan is printed and nothing is sent",
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
        print("missing credential(s): " + ", ".join(missing) + " — see docs/MOBILE.md", file=sys.stderr)
        return 1

    bearer = asc.token(key_id, issuer_id, key_path)

    print(f"app       {args.name}")
    print(f"bundle id {args.bundle_id}")
    print(f"sku       {args.sku}")
    print(f"locale    {args.locale}")
    print()

    bundle = find_bundle_id(bearer, args.bundle_id)
    if bundle:
        print(f"ok   bundle id   already registered ({bundle['id']})")
    elif not args.apply:
        print("plan bundle id   register it with Apple (POST /v1/bundleIds)")
    else:
        created = send(
            "POST",
            "/v1/bundleIds",
            bearer,
            {
                "data": {
                    "type": "bundleIds",
                    "attributes": {
                        "identifier": args.bundle_id,
                        "name": args.name,
                        "platform": "IOS",
                    },
                }
            },
        )
        bundle = created.get("data") or {}
        print(f"new  bundle id   registered ({bundle.get('id', '?')})")

    app = find_app(bearer, args.bundle_id)
    if app:
        attributes = app.get("attributes") or {}
        print(f"ok   app record  exists: {attributes.get('name')} ({attributes.get('sku')}) {app['id']}")
        return 0

    print("todo app record  missing — it has to be created in App Store Connect")
    print_record_steps(args.name, args.bundle_id, args.sku, args.locale)
    if not args.apply:
        print("nothing was written: this was a dry run (pass --apply to register the bundle id)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
