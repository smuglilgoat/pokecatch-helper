#!/usr/bin/env python3
"""Crop a PNG to a rectangle (stdlib only). Usage: pngcrop.py in.png out.png x y w h

Used to slice a wide community board into the 640px columns that tesseract reads
line by line (elite2-teams.png and catch_teams-2.png at x = 0/640/1280/1920), and
to cut a single card's window for a targeted re-read. The PNG codec half (read_png,
write_png) is also exec'd by chipread.py, which has no third-party imports either.
"""
import sys, zlib, struct

def read_png(path):
    d = open(path,'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, meta = 8, b'', None
    while pos < len(d):
        ln, typ = struct.unpack('>I4s', d[pos:pos+8]); pos += 8
        data = d[pos:pos+ln]; pos += ln + 4
        if typ == b'IHDR': meta = struct.unpack('>IIBBBBB', data)
        elif typ == b'IDAT': idat += data
    w,h,depth,ctype,comp,filt,inter = meta
    assert depth == 8 and inter == 0 and comp == 0 and filt == 0, meta
    bpp = {0:1, 2:3, 3:1, 4:2, 6:4}[ctype]
    raw = zlib.decompress(idat)
    stride = w*bpp
    rows = []
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for i in range(bpp, stride): line[i] = (line[i] + line[i-bpp]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i-bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i-bpp] if i >= bpp else 0
                b = prev[i]; c = prev[i-bpp] if i >= bpp else 0
                pp = a+b-c; pa,pb,pc = abs(pp-a),abs(pp-b),abs(pp-c)
                pr = a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(bytes(line)); prev = line
    return w, h, bpp, ctype, rows

def chunk(typ, data):
    return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ+data) & 0xffffffff)

def write_png(path, w, h, bpp, ctype, rows):
    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0))
    body = b''.join(b'\x00' + r for r in rows)
    out += chunk(b'IDAT', zlib.compress(body, 9))
    out += chunk(b'IEND', b'')
    open(path,'wb').write(out)

inp, outp, x, y, cw, ch = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8])
W, H, bpp, ctype, rows = read_png(inp)
x2, y2 = min(x+cw, W), min(y+ch, H)
crop = [r[x*bpp:x2*bpp] for r in rows[y:y2]]
write_png(outp, x2-x, y2-y, bpp, ctype, crop)
print(f"cropped {inp.split('/')[-1]} {W}x{H} -> {x2-x}x{y2-y} at ({x},{y})")
