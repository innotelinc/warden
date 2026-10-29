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

What the image actually encodes is checked separately, by decoding it:
`scripts/verify-qr.py` (that is the CI check, and it is the one that matters —
metadata can be right while the pixels are unscannable).

Requires `segno` (pure Python) to draw:
  python -m pip install segno
"""

from __future__ import annotations

import argparse
import json
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
        # A readable record of what the image points at, for whoever opens the
        # file. `verify-qr.py` does not trust it: it decodes the pixels.
        desc=url,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--out', type=Path, default=OUT)
    args = parser.parse_args()

    tag, url = manifest_url(args.manifest)
    draw(tag, url, args.out)
    print(f'qr: {args.out.name} -> {url}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
