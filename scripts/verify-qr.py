#!/usr/bin/env python3
"""verify-qr.py — prove the download code actually decodes to the APK.

The landing page advertises one release and its QR is drawn from the same
manifest, so what has to be true is: the pixels in the committed image decode to
the APK URL the committed manifest names. Comparing the image's `<desc>` with the
manifest is not that — the `<desc>` is a comment the generator writes, and an
image whose geometry is wrong would still carry an honest `<desc>`. A phone would
still scan nothing.

So this reads the module grid out of the SVG's own path data and then:

  1. decodes it with OpenCV, which is what a camera effectively does — CI
     installs it so the decode really runs on every push; or
  2. if OpenCV is not available, re-encodes the manifest URL with segno and
     compares the two grids. Identical grids mean the image is byte-for-byte the
     code for that URL, which is the same claim from the other side.

`--no-decode` forces path 2, which is how the fallback is tested.

Exit codes:
  0  the image decodes to the manifest's APK URL
  1  it does not: wrong payload, or no code found in the image at all
  2  the image could not be checked here (no decoder and no segno)

Usage:
  python scripts/verify-qr.py
  python scripts/verify-qr.py --svg web/landing/android-apk-qr.svg --no-decode
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SVG = ROOT / 'web' / 'landing' / 'android-apk-qr.svg'
DEFAULT_MANIFEST = ROOT / 'web' / 'landing' / 'release.json'


def manifest_url(path: Path) -> str:
    manifest = json.loads(path.read_text(encoding='utf-8'))
    url = (manifest.get('android') or {}).get('apk')
    if not isinstance(url, str) or not url:
        raise SystemExit(f'{path} has no android.apk URL')
    return url


def module_grid(svg: str) -> tuple[set[tuple[int, int]], int]:
    """The dark modules of the SVG, as (row, column) pairs and the grid size.

    segno draws each row of modules as one stroked horizontal run — `h7` for
    seven modules, then `m` to the next run — so the path data is a run-length
    description of the grid. Only that writer is supported; anything else is
    reported rather than guessed at.
    """
    match = re.search(r'<path stroke="[^"]*" d="([^"]+)"', svg)
    if not match:
        raise SystemExit('the SVG has no stroked module path; cannot read the code')

    tokens = re.findall(r'M([\d.]+) ([\d.]+)|h(\d+)|m(-?[\d.]+) (-?[\d.]+)', match.group(1))
    if not tokens:
        raise SystemExit('the module path is empty; cannot read the code')

    x = y = 0.0
    cells: list[tuple[int, int]] = []
    for mx, my, run, dx, dy in tokens:
        if mx:
            x, y = float(mx), float(my)
        elif run:
            # `h` is a relative horizontal line: it draws and advances.
            count = int(float(run))
            cells.extend((int(y), int(round(x)) + i) for i in range(count))
            x += count
        elif dx:
            x += float(dx)
            y += float(dy)

    rows = [r for r, _ in cells]
    cols = [c for _, c in cells]
    top, left = min(rows), min(cols)
    size = max(max(rows) - top, max(cols) - left) + 1
    return {(r - top, c - left) for r, c in cells}, size


def rasterise(grid: set[tuple[int, int]], size: int, scale: int = 10, quiet: int = 4):
    """A picture of the code, with the quiet zone the spec requires."""
    import numpy

    side = (size + 2 * quiet) * scale
    image = numpy.full((side, side), 255, numpy.uint8)
    for row, col in grid:
        top = (row + quiet) * scale
        left = (col + quiet) * scale
        image[top : top + scale, left : left + scale] = 0
    return image


def decode(grid: set[tuple[int, int]], size: int) -> str | None:
    """What a camera would read. None means OpenCV is not installed here."""
    try:
        import cv2
    except ImportError:
        return None
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(rasterise(grid, size))
    return text or ''


def reencode(url: str) -> tuple[set[tuple[int, int]], int] | None:
    """The grid segno produces for this URL, or None without segno."""
    try:
        import segno
    except ImportError:
        return None
    matrix = segno.make(url, error='m').matrix
    rows: set[tuple[int, int]] = set()
    for y, line in enumerate(matrix):
        for x, value in enumerate(line):
            if value:
                rows.add((y, x))
    return rows, len(matrix)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--svg', type=Path, default=DEFAULT_SVG)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        '--no-decode',
        action='store_true',
        help='skip OpenCV and compare against a fresh segno encoding instead',
    )
    args = parser.parse_args()

    url = manifest_url(args.manifest)
    svg = args.svg.read_text(encoding='utf-8')
    grid, size = module_grid(svg)
    print(f'{args.svg.name}: {size}x{size} modules, {len(grid)} dark')

    desc = re.search(r'<desc>(.*?)</desc>', svg, re.S)
    if desc and desc.group(1).strip() != url:
        print(
            f'::error::the image says it points at {desc.group(1).strip()}, '
            f'but the manifest names {url}',
            file=sys.stderr,
        )
        return 1

    if not args.no_decode:
        text = decode(grid, size)
        if text is None:
            print('OpenCV is not installed; comparing against a fresh encoding instead')
        else:
            if text == url:
                print(f'decoded: {text}')
                return 0
            if not text:
                print('::error::no QR code could be read from the image', file=sys.stderr)
                return 1
            print(f'::error::the image decodes to {text}, not {url}', file=sys.stderr)
            return 1

    expected = reencode(url)
    if expected is None:
        print('neither OpenCV nor segno is available, so nothing was verified', file=sys.stderr)
        return 2

    expected_grid, expected_size = expected
    if (expected_grid, expected_size) == (grid, size):
        print(f'matches a fresh encoding of {url}')
        return 0
    print(
        f'::error::the image does not match the code for {url} '
        f'({size}x{size} vs {expected_size}x{expected_size}, '
        f'{len(grid)} vs {len(expected_grid)} dark modules)',
        file=sys.stderr,
    )
    return 1


if __name__ == '__main__':
    sys.exit(main())
