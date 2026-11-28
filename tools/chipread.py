#!/usr/bin/env python3
"""Read the rate badges on the community team boards (stdlib only + tesseract).

On elite2-teams.png the alternate rates are bright plates (light blue 100, darker
blue 98/94, gray) with dark digits, ~20-44px wide and inverted relative to the
page. tesseract on the page reads them as glyph noise ("QD", "Gi)"), so this
reader finds the plates by luminance, inverts them, upscales 3x and OCRs the
digits with a 0123456789 whitelist, voting across psm 7/8/6/13.

Usage:
  from chipread import read_image, find_badges, ocr_badge
  read_image('boards/elite2-teams.png')
  boxes = find_badges(yline, x0=col*640, x1=(col+1)*640)
  [ocr_badge(*b) for b in boxes]
or standalone: chipread.py board.png <yline> [<yline> ...]

Used for the elite2 alternate rates; catch-team rates are plain page-polarity text
and need no badge pass. Rate chips are wins out of 100 at Elite II.
"""
import os, sys, subprocess, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pngcrop.py')).read().split("inp, outp, x, y")[0])

_state = {}
def read_image(path):
    W,H,bpp,ctype,rows = read_png(path)
    _state.update(W=W,H=H,bpp=bpp,ctype=ctype,rows=rows)
    return _state
def _lum(r,i):
    bb=_state['bpp']; p=r[i*bb:i*bb+bb]; return 0.299*p[0]+0.587*p[1]+0.114*p[2]
def find_badges(yline, x0=0, x1=None):
    rows,bpp,H,W = _state['rows'],_state['bpp'],_state['H'],_state['W']
    if x1 is None: x1 = W
    rr = []
    for yy in range(max(0,yline-3), min(H,yline+26)):
        row = rows[yy]; s=None
        for x in range(x0, x1):
            b = _lum(row,x) > 95
            if b and s is None: s = x
            elif not b and s is not None:
                if x-s >= 20: rr.append((yy, s, x))
                s = None
        if s is not None and x1-s >= 20: rr.append((yy, s, x1))
    badges = []
    for i,(y1,a1,b1) in enumerate(rr):
        for j in range(i+1, len(rr)):
            y2,a2,b2 = rr[j]
            if y2-y1 > 28: break
            if y2-y1 < 11: continue
            if min(b1,b2)-max(a1,a2) >= 18:
                xa, xb = max(a1,a2), min(b1,b2)
                if all(sum(1 for xx in range(xa,xb) if _lum(rows[y],xx)>95) > (xb-xa)*0.25
                       for y in range(y1+1,y2)):
                    if not any(abs(xa-B[0])<=8 and abs(y1-B[2])<=8 for B in badges):
                        badges.append((xa, xb, y1, y2+1))
                break
    return badges
def _plate(xa, xb, ya, yb):
    """Grow the detected bright box to the full plate: the digit OCR truncates
    ('100' -> '10') when the right edge of the plate was cut by the run detector."""
    rows,bpp,H,W = _state['rows'],_state['bpp'],_state['H'],_state['W']
    left, right = xa, xb
    for x in range(xa-1, max(0,xa-26), -1):
        if any(_lum(rows[y],x) > 95 for y in range(ya,yb)): left = x
        else: break
    for x in range(xb, min(W,xb+26)):
        if any(_lum(rows[y],x) > 95 for y in range(ya,yb)): right = x+1
        else: break
    top, bot = ya, yb
    for y in range(ya-1, max(0,ya-12), -1):
        if any(_lum(rows[y],x) > 95 for x in range(left,right)): top = y
        else: break
    for y in range(yb, min(H,yb+12)):
        if any(_lum(rows[y],x) > 95 for x in range(left,right)): bot = y+1
        else: break
    return left, right, top, bot
def ocr_badge(xa, xb, ya, yb):
    """Read one plate's digits. The board uses two plate styles: light fill with
    dark digits (most cards) and blue fill (luminance ~106) with white digits
    (the Johto cards). Binarize against the fill's modal luminance so both read
    the same: ink = pixels far from the fill, whatever their polarity.
    A single upscale factor reads 9 as 3 on some plates, so vote over two scales
    and a third crop on a tie."""
    rows,bpp = _state['rows'],_state['bpp']
    xa, xb, ya, yb = _plate(xa, xb, ya, yb)
    pth = os.path.join(tempfile.gettempdir(), '_pcopt_chip.png')
    def votes_at(k, trim=3):
        # crop inside the plate: the dark page around the plate merges with the
        # digits and tesseract invents border glyphs ("198", "7100")
        ax, bx, ay, by = xa+trim, xb-trim, ya+1, yb-1
        win = [r[ax*bpp:bx*bpp] for r in rows[ay:by]]
        lums = [[_lum(r, i) for i in range(bx-ax)] for r in win]
        hist = {}
        for v in (v for row in lums for v in row):
            hist[int(v//24)] = hist.get(int(v//24), 0) + 1
        fill = max(hist.items(), key=lambda kv: kv[1])[0] * 24 + 12
        margin = 8
        out = [bytes([0,0,0]*((bx-ax+2*margin)*k))] * margin
        for row in lums:
            e = bytearray([0,0,0]*margin*k)
            for v in row:
                ink = abs(v-fill) > 55
                for _ in range(k): e += bytes([255,255,255]) if ink else bytes([0,0,0])
            e += bytes([0,0,0]*margin*k)
            out += [bytes(e)] * k
        out += [bytes([0,0,0]*((bx-ax+2*margin)*k))] * margin
        write_png(pth, len(out[0])//3, len(out), 3, 2, out)
        votes = {}
        for psm in ('7','8','6','13'):
            r = subprocess.run(['tesseract',pth,'stdout','--psm',psm,'-c','tessedit_char_whitelist=0123456789'],capture_output=True,text=True)
            t=''.join(c for c in r.stdout if c.isdigit())
            if not t: continue
            t = t.lstrip('0') or '0'
            # a rate is 1-100: longer reads are a merged plate or noise
            if 1 <= int(t) <= 100: votes[t] = votes.get(t,0)+1
        return votes
    total = {}
    for k, trim in ((3, 3), (5, 3)):
        for t, n in votes_at(k, trim).items():
            total[t] = total.get(t, 0) + n
    if not total: return None
    ranked = sorted(total.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        for t, n in votes_at(5, 2).items():
            total[t] = total.get(t, 0) + n
        ranked = sorted(total.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None
    return ranked[0][0] if ranked[0][1] >= 3 else None

if __name__ == '__main__':
    read_image(sys.argv[1])
    for y in map(int, sys.argv[2:]):
        boxes = find_badges(y)
        print(f"y={y}: {[(b[0],b[2]) for b in boxes]} -> {[ocr_badge(*b) for b in boxes]}")
