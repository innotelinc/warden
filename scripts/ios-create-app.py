#!/usr/bin/env python3
"""Create an App Store Connect app record, and the bundle id it hangs from.

A build has nowhere to land until the app record exists, and Apple exposes no
way to create one except the API (or the website). This does the two steps, in
the order Apple requires them:

  1. the bundle id (`/v1/bundleIds`) — an identifier in the team's developer
     account, e.g. `tech.innotel.zapit`;
  2. the app record (`/v1/apps`) — the store entry, with the name that appears
     on the App Store, an SKU the account uses internally, a primary language
     and that bundle id.

Both steps are idempotent against Apple's own answers, so a re-run reports what
exists instead of failing: an identifier that is already registered is used, and
an existing app record stops the run before anything is written. That matters
because neither can be undone — an App ID cannot be renamed or deleted, and an
app record reserves its name across every account.

The name is the one thing Apple can refuse: names are unique store-wide. A 409
here is a fact about the store, not a bug, and the message says so.

Credentials are the same four repository secrets the other iOS workflows read.
The token and HTTP helpers come from scripts/ios-build-status.py, which is
already exercised against the live API, rather than being duplicated here.

    DRY_RUN=false APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-create-app.py \\
        --bundle-id tech.innotel.zapit --name ZAPIT --sku ZAPIT-IOS

Exit status: 0 the record exists (or a dry run printed the plan),
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
        if error.code == 409 and "bundle identifier" in detail.lower():
            raise SystemExit(
                "App Store Connect refused the bundle id (409). An identifier that "
                "is already registered can be reused but not re-registered:\n" + detail
            )
        if error.code == 409:
            raise SystemExit(
                "App Store Connect refused the app record (409). The usual cause is "
                "the name: App Store names are unique across every account, so pick "
                "another one (e.g. 'ZAPIT — Zap Files') and run this again.\n" + detail
            )
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Create an App Store Connect app record.")
    parser.add_argument("--bundle-id", required=True, help="e.g. tech.innotel.zapit")
    parser.add_argument("--name", required=True, help="the App Store name, unique store-wide")
    parser.add_argument("--sku", required=True, help="internal SKU, e.g. ZAPIT-IOS")
    parser.add_argument("--locale", default="en-US", help="primary language (default en-US)")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write the records; without it the plan is printed and nothing is sent",
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

    existing_id = find_bundle_id(bearer, args.bundle_id)
    if existing_id:
        print(f"ok   bundle id   already registered ({existing_id['id']})")
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
        existing_id = created.get("data") or {}
        print(f"new  bundle id   registered ({existing_id.get('id', '?')})")

    app = find_app(bearer, args.bundle_id)
    if app:
        attributes = app.get("attributes") or {}
        print(f"ok   app record  already exists: {attributes.get('name')} ({attributes.get('sku')}) {app['id']}")
    elif not args.apply:
        print("plan app record  create it against that bundle id (POST /v1/apps)")
    else:
        bundle_resource_id = (existing_id or {}).get("id")
        if not bundle_resource_id:
            raise SystemExit("the bundle id has no resource id — re-run once Apple has registered it")
        created = send(
            "POST",
            "/v1/apps",
            bearer,
            {
                "data": {
                    "type": "apps",
                    "attributes": {
                        "name": args.name,
                        "primaryLocale": args.locale,
                        "sku": args.sku,
                    },
                    "relationships": {
                        "bundleId": {"data": {"type": "bundleIds", "id": bundle_resource_id}}
                    },
                }
            },
        )
        record = created.get("data") or {}
        print(f"new  app record  created ({record.get('id', '?')})")

    if not args.apply:
        print("\nnothing was written: this was a dry run (pass --apply to create)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
