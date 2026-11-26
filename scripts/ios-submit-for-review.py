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

An open submission is one in READY_FOR_REVIEW *or* UNRESOLVED_ISSUES. The second
is the one that used to break this: Apple leaves a rejected submission open, will
not create another while it exists, and expects the same submission back once the
issue is fixed — so a new one was refused with a 409. This reuses it, says what
it is holding, and sends it back. A 409 that survives that (a submission in a
state this does not handle) is reported with the step it needs, not dumped.

`--dry-run` runs both gates and prints the same plan without writing anything, so
the first live submission can be read before it is sent. It exits with the status
the live run would, because a preview that cannot fail is not a preview.

    APP_STORE_CONNECT_KEY_ID=... APP_STORE_CONNECT_ISSUER_ID=... \\
      ASC_KEY_PATH=/path/AuthKey.p8 python3 scripts/ios-submit-for-review.py --version 1.0
    ... python3 scripts/ios-submit-for-review.py --version 1.0 --dry-run

Credentials are the same four repository secrets the other iOS workflows use; the
token, the check and the HTTP helpers come from scripts/ios-build-status.py,
which is loaded by path because of the hyphen in its name.

Exit status: 0 the version is submitted (or would be, on a dry run), 1 it was
refused or App Store Connect refused a call. Nothing is submitted unless both
gates pass.
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

# The two states an open submission can be in, and why the second one is here: a
# submission Apple returned with unresolved issues stays open, blocks a new one
# with a 409, and is the submission that has to be sent again once the issue is
# fixed. Looking only for READY_FOR_REVIEW tried to open a second submission and
# failed on that refusal.
READY = "READY_FOR_REVIEW"
UNRESOLVED = "UNRESOLVED_ISSUES"
OPEN_STATES = (READY, UNRESOLVED)


def send(method: str, path: str, bearer: str, payload: dict, conflict: str = "") -> dict:
    """One JSON:API write call.

    `conflict` is what a 409 or 422 means here rather than Apple's error body
    alone: every refusal this script can hit has a next step, and printing only
    the body leaves the reader with a submission they cannot get rid of.
    """
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
        if conflict and error.code in (409, 422):
            raise SystemExit(f"{conflict}\n{detail}")
        raise SystemExit(
            f"App Store Connect returned {error.code} for {method} {path}:\n{detail}"
        )


def open_submissions(bearer: str, app: str) -> list[dict]:
    """The submissions Apple has open for the app, the blocking one first.

    `filter[app]` is required by this collection; `filter[state]` is applied by
    Apple, so a submission already with App Review is not offered as open. A
    submission holding unresolved issues comes before an untouched one because it
    is the one that refuses a new submission.
    """
    payload = asc.get(
        "/v1/reviewSubmissions",
        bearer,
        {
            "filter[app]": app,
            "filter[platform]": "IOS",
            "filter[state]": ",".join(OPEN_STATES),
            "limit": "10",
        },
    )
    rows = payload.get("data") or []
    rows.sort(
        key=lambda row: (
            (row.get("attributes") or {}).get("state") != UNRESOLVED,
            (row.get("attributes") or {}).get("createdDate") or "",
        )
    )
    return rows


def items(bearer: str, submission: str) -> list[dict]:
    payload = asc.get(
        "/v1/reviewSubmissionItems",
        bearer,
        {"filter[reviewSubmission]": submission, "limit": "50"},
    )
    return payload.get("data") or []


def carries(rows: list[dict], version: str) -> bool:
    """Whether these submission items already include the version record."""
    for item in rows:
        relation = (
            (item.get("relationships") or {}).get("appStoreVersion", {}).get("data") or {}
        )
        if relation.get("id") == version:
            return True
    return False


def describe_items(rows: list[dict]) -> None:
    """What a stuck submission is holding, one line per item.

    The states are Apple's own: an item that came back REJECTED is why the
    submission is in UNRESOLVED_ISSUES, and it is the version — not this script —
    that has to change before the resubmission means anything.
    """
    for item in rows:
        state = (item.get("attributes") or {}).get("state") or "?"
        relation = (
            (item.get("relationships") or {}).get("appStoreVersion", {}).get("data") or {}
        )
        label = relation.get("id") or item.get("id")
        print(f"  item {label}  [{state}]")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--version",
        default="1.0",
        help="the marketing version to submit; it has to be the app's newest (default: 1.0)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run the gates and print what would be sent, then send nothing",
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

    # Which open submission this belongs to: the one already holding the version
    # if there is one, otherwise the submission that is blocking a new one.
    candidates = open_submissions(bearer, app)
    submission: dict | None = None
    current: list[dict] = []
    for candidate in candidates:
        current = items(bearer, candidate["id"])
        if carries(current, version["id"]):
            submission = candidate
            break
    if submission is None and candidates:
        submission = candidates[0]
        current = items(bearer, submission["id"])

    state = ""
    if submission is not None:
        state = (submission.get("attributes") or {}).get("state") or READY
        if state == UNRESOLVED:
            print(
                f"\nsubmission {submission['id']} is [{UNRESOLVED}]: Apple returned it, keeps it "
                "open, and refuses a new one while it is open."
            )
            describe_items(current)
            print(
                "Sending that submission back after the fix instead of opening a second one.\n"
            )

    has_item = submission is not None and carries(current, version["id"])

    if args.dry_run:
        target = submission["id"] if submission is not None else "a new review submission"
        print("\ndry run: nothing was sent. The live run would:")
        print(f"  1. {'reuse' if submission is not None else 'create'} {target}")
        print(
            "  2. "
            + (
                f"keep version {version['version']} as its item"
                if has_item
                else f"add version {version['version']} as an item"
            )
        )
        print("  3. submit it: PATCH the review submission with submitted: true")
        asc.note(
            f"Dry run: {version['version']} was not submitted. "
            f"{'It would reuse' if submission is not None else 'It would create'} {target}."
        )
        return 0

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
            conflict=(
                "App Store Connect refused a new review submission (409): one is already "
                "open for this app in a state this script does not resubmit. Finish or "
                "cancel it in App Store Connect, then run this again."
            ),
        )
        submission_id = (created.get("data") or {}).get("id") or ""
        if not submission_id:
            raise SystemExit("App Store Connect created no review submission")
        print(f"created review submission {submission_id}")
    else:
        submission_id = submission["id"]
        print(f"using the open review submission {submission_id} [{state or READY}]")

    if has_item:
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
        conflict=(
            f"App Store Connect refused to submit submission {submission_id}. The "
            "submission stays open until Apple accepts a resubmission, and no new one "
            "can be created while it is open: fix what the issues name in App Store "
            "Connect, then run this again."
        ),
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
    final = ((sent.get("data") or {}).get("attributes") or {}).get("state") or "?"
    print(
        f"\nversion {after['version']} is now [{after['state']}]; "
        f"submission {submission_id} is [{final}]"
    )
    asc.note(
        f"Submitted {after['version']} for App Review: the version is {after['state']}, "
        f"submission {submission_id} is {final}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
