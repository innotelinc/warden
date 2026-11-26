#!/usr/bin/env python3
"""Send the current App Store version to App Review — once, and only when it is ready.

The console's Submit for Review button is the last step of the release, and both
ways to get it wrong are silent there: a version with one field still empty is
refused after the click, and a version already in review is not refused at all.
So the click is made from a runner instead, with its two gates in front of it:

  * the named version is the app's newest, and its state is
    PREPARE_FOR_SUBMISSION
  * the submission check reports zero gaps

Both are read from App Store Connect in this process, not taken from a flag, so
`--version 1.0` on a version still missing its review contact stops with the
check's own table printed and nothing written.

The submission itself is the review-submission API, which replaced the
deprecated appStoreVersionSubmissions resource:

  1. use the submission Apple already has open for the app, or create one
  2. add the version as an item, unless the open submission holds it
  3. PATCH the submission with `submitted: true`

An open submission is the one in READY_FOR_REVIEW; submitting it is what moves
the version to WAITING_FOR_REVIEW. That makes a re-run after a failed PATCH pick
the same submission up instead of opening a second one, and a re-run after a
successful submit stop at the state gate.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-submit-for-review.py --version 1.0

Credentials are the same four repository secrets the other iOS workflows use; the
token, the check and the HTTP helpers come from scripts/ios-build-status.py,
which is loaded by path because of the hyphen in its name.

Exit status: 0 the version is submitted, 1 it was refused or App Store Connect
refused a call. Nothing is submitted unless both gates pass.
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

# The state a version must be in for a submission to be allowed. Anything else
# is either already with App Review or held up by something that has to be fixed
# in the console first, and submitting through it would blur which happened.
SUBMITTABLE = "PREPARE_FOR_SUBMISSION"
# An open submission, as opposed to one already sent: Apple calls the shell it
# leaves behind READY_FOR_REVIEW, not READY_FOR_SUBMISSION.
OPEN = "READY_FOR_REVIEW"


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
        raise SystemExit(
            f"App Store Connect returned {error.code} for {method} {path}:\n{detail}"
        )


def open_submission(bearer: str, app: str) -> dict | None:
    """The submission waiting to be sent, if the console or an earlier run made one.

    Creating a second submission for the same version is how a version ends up in
    review twice, so the open one is reused rather than replaced. `filter[app]`
    is required by this collection; the platform filter is what keeps an iOS
    version out of a macOS submission.
    """
    payload = asc.get(
        "/v1/reviewSubmissions",
        bearer,
        {
            "filter[app]": app,
            "filter[platform]": "IOS",
            "filter[state]": OPEN,
            "limit": "10",
        },
    )
    rows = payload.get("data") or []
    return rows[0] if rows else None


def holds_version(bearer: str, submission: str, version: str) -> bool:
    """Whether this submission already carries the version as an item.

    A run that added the item and then failed at the PATCH leaves exactly this
    state, and adding the item again is refused rather than harmless.
    """
    payload = asc.get(
        "/v1/reviewSubmissionItems",
        bearer,
        {"filter[reviewSubmission]": submission, "limit": "50"},
    )
    for item in payload.get("data") or []:
        relation = (
            (item.get("relationships") or {}).get("appStoreVersion", {}).get("data") or {}
        )
        if relation.get("id") == version:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--version",
        default="1.0",
        help="the marketing version to submit; it has to be the app's newest (default: 1.0)",
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

    bearer = asc.token(key_id, issuer_id, key_path)
    app = asc.app_id(bearer)
    version = asc.newest_version(bearer, app)

    # The API submits the version record it has, not the string a caller names, so
    # a version flag that does not match is a mistake worth stopping for: it would
    # otherwise submit whichever version happened to be newest.
    if version["version"] != args.version:
        print(
            f"the newest iOS version is {version['version']} [{version['state']}], "
            f"not {args.version}."
        )
        print("Pass the version App Store Connect holds, or create it in the console first.")
        return 1

    if version["state"] != SUBMITTABLE:
        print(f"version {version['version']} is [{version['state']}], not {SUBMITTABLE}.")
        if version["state"] in ("WAITING_FOR_REVIEW", "IN_REVIEW"):
            print("App Review already has it — there is nothing to submit.")
        else:
            print(
                "A version can only be sent from PREPARE_FOR_SUBMISSION; finish the "
                "state it is in first."
            )
        return 1

    print(f"version {version['version']} is {SUBMITTABLE}")

    # The same function the status workflow reports with, so the gate and the
    # report can never disagree about what "ready" means. It prints its own rows.
    gaps = asc.submission_report(bearer, app)
    if gaps != 0:
        print(
            "\n::error::not submitted: the version is still missing fields the check "
            "above lists."
        )
        asc.note("Not submitted: the submission check still reports gaps.")
        return 1

    submission = open_submission(bearer, app)
    if submission is None:
        # No platform attribute: Apple derives it from the app and the items, and
        # current API versions no longer take it on create.
        created = send(
            "POST",
            "/v1/reviewSubmissions",
            bearer,
            {
                "data": {
                    "type": "reviewSubmissions",
                    "relationships": {
                        "app": {"data": {"type": "apps", "id": app}},
                    },
                }
            },
        )
        submission_id = (created.get("data") or {}).get("id") or ""
        if not submission_id:
            raise SystemExit("App Store Connect created no review submission")
        print(f"created review submission {submission_id}")
    else:
        submission_id = submission["id"]
        state = (submission.get("attributes") or {}).get("state") or OPEN
        print(f"using the open review submission {submission_id} [{state}]")

    if holds_version(bearer, submission_id, version["id"]):
        print(f"{version['version']} is already an item of submission {submission_id}")
    else:
        send(
            "POST",
            "/v1/reviewSubmissionItems",
            bearer,
            {
                "data": {
                    "type": "reviewSubmissionItems",
                    "relationships": {
                        "reviewSubmission": {
                            "data": {
                                "type": "reviewSubmissions",
                                "id": submission_id,
                            }
                        },
                        "appStoreVersion": {
                            "data": {"type": "appStoreVersions", "id": version["id"]}
                        },
                    },
                }
            },
        )
        print(f"added version {version['version']} to submission {submission_id}")

    # This is the submit. Everything above only prepared the shell.
    send(
        "PATCH",
        f"/v1/reviewSubmissions/{submission_id}",
        bearer,
        {
            "data": {
                "type": "reviewSubmissions",
                "id": submission_id,
                "attributes": {"submitted": True},
            }
        },
    )
    print(f"submitted review submission {submission_id}")

    # What Apple says now, not what the request returned: the version's state is
    # the answer the next runbook step depends on.
    after = asc.newest_version(bearer, app)
    sent = asc.get(
        f"/v1/reviewSubmissions/{submission_id}",
        bearer,
        {"fields[reviewSubmissions]": "state,submitted"},
    )
    state = ((sent.get("data") or {}).get("attributes") or {}).get("state") or "?"
    print(
        f"\nversion {after['version']} is now [{after['state']}]; "
        f"submission {submission_id} is [{state}]"
    )
    asc.note(
        f"Submitted {after['version']} for App Review: the version is {after['state']}, "
        f"submission {submission_id} is {state}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
