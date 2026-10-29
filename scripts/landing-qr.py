#!/usr/bin/env python3
"""landing-qr.py — draw the download code for the release the page advertises.

The code a phone scans used to encode the rolling link
(`releases/latest/download/WARDEN-android.apk`), while the buttons beside it were
pinned to one tag. Those two agree most of the time and disagree exactly when it
matters: while a new tag's APK is uploading, the page can still be showing the
previous release in its caption and its installer link, and the code would hand
the phone the newer APK. One page, two releases.

So the image is drawn from web/landing/release.json — the same file that pins the
buttons — when the site is deployed. The bytes on the page then contain the tag
printed in the caption, by construction rather than by discipline.

Usage:
  python scripts/landing-qr.py            # manifest -> web/landing/android-apk-qr.svg
  python scripts/landing-qr.py --check    # exit 1 if the drawn code names another URL

`--check` reads the SVG rather than re-rendering it, so it needs no `segno` and
runs anywhere — CI uses it to prove the committed image and the committed
manifest are the same release.

Requires `segno` (pure Python) to draw:
  python -m pip install segno
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'web' / 'landing' / 'release.json'
OUT = ROOT / 'web' / 'landing' / 'android-apk-qr.svg'

# The card's own colours, so the image sits in the panel rather than on a white
# rectangle of its own.
DARK = '#0b0e12'
LIGHT = '#ffffff'


def manifest_url(path: Path) -> tuple[str, str]:
    """The tag and the APK URL the page is advertising."""
    try:
        manifest = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise SystemExit(f'no manifest at {path}')
    except json.JSONDecodeError as error:
        raise SystemExit(f'{path} is not valid JSON: {error}')

    url = (manifest.get('android') or {}).get('apk')
    if not isinstance(url, str) or not url.startswith('https://'):
        raise SystemExit(f'{path} has no android.apk URL to encode')
    return str(manifest.get('tag') or ''), url


def drawn_url(path: Path) -> str:
    """The URL baked into the committed SVG, read out of its own <desc>."""
    try:
        svg = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        raise SystemExit(f'no QR image at {path}')
    match = re.search(r'<desc>(.*?)</desc>', svg, re.S)
    if not match:
        raise SystemExit(f'{path} carries no <desc>, so its target cannot be checked')
    return match.group(1).strip()


def draw(tag: str, url: str, path: Path) -> None:
    try:
        import segno
    except ImportError:
        raise SystemExit(
            'segno is not installed, so the code cannot be drawn: '
            'python -m pip install segno'
        )

    # Edge length 6 px per module at the size the page shows it (128 px), with a
    # two-module quiet zone, which is the narrowest the spec allows and the
    # smallest that survived a phone camera in testing.
    qr = segno.make(url, error='m')
    qr.save(
        str(path),
        kind='svg',
        scale=6,
        border=2,
        dark=DARK,
        light=LIGHT,
        xmldecl=False,
        svgclass=None,
        lineclass=None,
        title=f'WARDEN {tag} Android APK',
        # The <desc> is the checkable record of what this image points at; `--check`
        # reads it, and so does CI.
        desc=url,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument(
        '--check',
        action='store_true',
        help='verify the committed image names the committed manifest; draw nothing',
    )
    args = parser.parse_args()

    tag, url = manifest_url(args.manifest)

    if args.check:
        current = drawn_url(args.out)
        if current != url:
            print(
                f'::error::{args.out.name} points at {current}, but the manifest '
                f'({tag}) points at {url}',
                file=sys.stderr,
            )
            return 1
        print(f'qr: {args.out.name} and {tag} agree')
        return 0

    draw(tag, url, args.out)
    print(f'qr: {args.out.name} -> {url}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
