#!/usr/bin/env python3
"""Measure the area bars on the legendary gem tier board (stdlib only).

Each card on legendary-rank-tiers-2.png has three solid pixel bars under the
"LG / EL / UG" labels: yellow (255,203,61), lavender (201,168,255) and green
(91,224,160). A bar is one exact-colour horizontal run, about 6 rows tall with
rounded ends (4 for the smallest), so its length is the union of that colour
over the band's rows. Cards sit on a ~125px pitch; the run starting near x=189
is a row's first card.

Usage:
  barmeasure.py board.png                 -> every bar band and its run lengths
  barmeasure.py board.png <y> [<y> ...]   -> the runs of one bar colour at y

A band is a run of consecutive rows whose only bar-colour runs are one colour.
Splitting at the colour change gives the LG/EL/UG rows of each card row; pair
the runs left to right with the names printed above the row.
"""
import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pngcrop.py')).read().split("inp, outp, x, y")[0])

COLOURS = {
    'LG': (255, 203, 61),
    'EL': (201, 168, 255),
    'UG': (91, 224, 160),
}

def runs_at(rows, y, colour, minlen=1):
    """Exact-colour horizontal runs at row y."""
    out, start = [], None
    for x in range(len(rows[y]) // 3):
        hit = tuple(rows[y][x*3:x*3+3]) == colour
        if hit and start is None:
            start = x
        elif not hit and start is not None:
            if x - start >= minlen:
                out.append((start, x, x - start))
            start = None
    if start is not None and len(rows[y]) // 3 - start >= minlen:
        out.append((start, len(rows[y]) // 3, len(rows[y]) // 3 - start))
    return out

def band_runs(rows, y0, y1, colour):
    """Union of one colour over the band's rows: the bar's full pixel extent."""
    width = len(rows[y0]) // 3
    mask = [False] * width
    for y in range(y0, y1 + 1):
        for x in range(width):
            if tuple(rows[y][x*3:x*3+3]) == colour:
                mask[x] = True
    out, start = [], None
    for x in range(width + 1):
        hit = x < width and mask[x]
        if hit and start is None:
            start = x
        elif not hit and start is not None:
            out.append((start, x, x - start))
            start = None
    return out

def bands(rows, height):
    """Group rows into single-colour bar bands; return (colour, y0, y1)."""
    out, prev = [], None
    for y in range(300, height):  # skip the legend and title text above the cards
        kinds = {k for k, c in COLOURS.items() if runs_at(rows, y, c, 2)}
        if len(kinds) != 1:
            continue
        kind = kinds.pop()
        if prev and prev[0] == kind and y - prev[2] <= 2:
            prev[2] = y
        else:
            prev = [kind, y, y]
            out.append(prev)
    return [(k, y0, y1) for k, y0, y1 in out if y1 - y0 >= 2]

if __name__ == '__main__':
    path = sys.argv[1]
    W, H, bpp, ctype, rows = read_png(path)
    assert bpp == 3, f"expected RGB, got bpp {bpp}"
    args = list(map(int, sys.argv[2:]))
    if args:
        for y in args:
            for k, c in COLOURS.items():
                runs = runs_at(rows, y, c)
                if runs:
                    print(f"y={y} {k}: {runs}")
    else:
        for kind, y0, y1 in bands(rows, H):
            print(f"{kind} y={y0}-{y1}: {band_runs(rows, y0, y1, COLOURS[kind])}")
