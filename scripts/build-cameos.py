#!/usr/bin/env python3
"""Builds the built-in photo cameos.

assets/cameos/src/<id>.png   the supplied cut-out photos (transparent backdrop)
  -> assets/cameos/built/<id>.png   256x256, tight head crop, oval mask
  -> assets/cameos/built/index.json eyes/mouth anchors, same shape as the
                                    user index (~/.claude-traffic-light/cameos)

Run with `npm run cameos` (needs Pillow). `--sheet out.png` also writes a
contact sheet (sources with their crop, results with their anchors).
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SRC = os.path.join(ROOT, 'assets', 'cameos', 'src')
OUT = os.path.join(ROOT, 'assets', 'cameos', 'built')
SIZE = 256
WORK = 512
OVAL_RX = 0.42  # of the square, as in cameos.js; the oval is the full height

# Per face, in source pixels: the square head crop (x, y, side) from the top
# of the hair to under the chin, ear to ear (it may run past the image edge),
# the midpoint between the pupils, the middle of the mouth, and the flat
# colour the cut-out was shown on.
FACES = {
    'neo': dict(name='Neo', crop=(35, 12, 160), eyes=(115, 94), mouth=(107, 133), bg='white'),
    'mcafee': dict(name='McAfee', crop=(60, 30, 1530), eyes=(628, 745), mouth=(640, 1180), bg='black'),
    'spagni': dict(name='Spagni', crop=(40, 8, 170), eyes=(103, 94), mouth=(100, 140), bg='white'),
    'powell': dict(name='Powell', crop=(-20, 12, 705), eyes=(355, 384), mouth=(360, 565), bg='black'),
    'baker': dict(name='Baker', crop=(-5, 12, 790), eyes=(505, 408), mouth=(520, 640), bg='black'),
    'ellison': dict(name='Ellison', crop=(298, 18, 945), eyes=(602, 457), mouth=(590, 745), bg='black'),
    'saylor': dict(name='Saylor', crop=(-30, 15, 1275), eyes=(530, 674), mouth=(515, 1030), bg='black'),
}


def oval_mask(n, ss=4):
    big = Image.new('L', (n * ss, n * ss), 0)
    c = n * ss / 2
    rx = n * ss * OVAL_RX
    ImageDraw.Draw(big).ellipse((c - rx, 0, c + rx, n * ss - 1), fill=255)
    return big.resize((n, n), Image.LANCZOS)


def cut(fid, face):
    src = Image.open(os.path.join(SRC, f'{fid}.png')).convert('RGBA')
    x, y, s = face['crop']
    sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    sq.paste(src, (-x, -y))
    work = sq.resize((WORK, WORK), Image.LANCZOS)
    alpha = work.getchannel('A').point(lambda v: 0 if v < 48 else v)
    # The backdrop: the cut-out's transparent area plus any flat black/white
    # joined to the crop's corners. A tight threshold keeps dark hair and
    # white shirts, which differ from the flat colour by more than that.
    bgc = (0, 0, 0) if face['bg'] == 'black' else (255, 255, 255)
    flat = Image.new('RGB', work.size, bgc)
    flat.paste(work.convert('RGB'), mask=alpha)
    sentinel = (255, 0, 255)
    for p in [(0, 0), (WORK - 1, 0), (0, WORK - 1), (WORK - 1, WORK - 1)]:
        if flat.getpixel(p) != sentinel:
            ImageDraw.floodfill(flat, p, sentinel, thresh=22)
    reached = ImageChops.difference(flat, Image.new('RGB', work.size, sentinel)).convert('L').point(lambda v: 255 if v == 0 else 0)
    # Grow the backdrop ~1 output pixel into the edge: it eats the light halo
    # the cut-outs carry, then soften what is left.
    backdrop = reached.filter(ImageFilter.MaxFilter(5))
    alpha = ImageChops.darker(alpha, ImageChops.invert(backdrop)).filter(ImageFilter.GaussianBlur(0.8))
    work.putalpha(alpha)
    out = work.resize((SIZE, SIZE), Image.LANCZOS)
    out.putalpha(ImageChops.multiply(out.getchannel('A'), oval_mask(SIZE)))
    frac = lambda p: {'x': round((p[0] - x) / s, 4), 'y': round((p[1] - y) / s, 4)}
    entry = {'name': face['name'], 'eyes': frac(face['eyes']), 'mouth': frac(face['mouth']), 'shape': 'oval', 'addedAt': 0}
    return src, out, entry


def checker(n, a=(58, 54, 64), b=(40, 37, 45), k=16):
    im = Image.new('RGB', (n, n), a)
    d = ImageDraw.Draw(im)
    for i in range(0, n, k):
        for j in range(0, n, k):
            if (i // k + j // k) % 2:
                d.rectangle((i, j, i + k - 1, j + k - 1), fill=b)
    return im


def sheet(results, path):
    n = len(results)
    im = Image.new('RGB', (n * (SIZE + 16) + 16, 2 * SIZE + 48), (28, 26, 31))
    d = ImageDraw.Draw(im)
    for i, (fid, face, src, out, entry) in enumerate(results):
        ox = 16 + i * (SIZE + 16)
        # source, scaled into a SIZE box, with its crop square
        k = SIZE / max(src.size)
        thumb = Image.new('RGBA', (SIZE, SIZE), (90, 90, 90, 255))
        small = src.resize((max(1, int(src.width * k)), max(1, int(src.height * k))), Image.LANCZOS)
        thumb.alpha_composite(small)
        td = ImageDraw.Draw(thumb)
        x, y, s = face['crop']
        td.rectangle((x * k, y * k, (x + s) * k, (y + s) * k), outline=(255, 200, 0), width=2)
        im.paste(thumb.convert('RGB'), (ox, 16))
        bg = checker(SIZE)
        bg.paste(out, (0, 0), out)
        bd = ImageDraw.Draw(bg)
        for key, col in (('eyes', (56, 189, 248)), ('mouth', (218, 119, 86))):
            px, py = entry[key]['x'] * SIZE, entry[key]['y'] * SIZE
            bd.ellipse((px - 5, py - 5, px + 5, py + 5), fill=col, outline=(255, 255, 255))
        bd.line((0, entry['eyes']['y'] * SIZE, SIZE, entry['eyes']['y'] * SIZE), fill=(56, 189, 248))
        im.paste(bg, (ox, SIZE + 32))
        d.text((ox, SIZE + 18), fid, fill=(236, 232, 226))
    im.save(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}
    results = []
    for fid, face in FACES.items():
        src, out, entry = cut(fid, face)
        out.save(os.path.join(OUT, f'{fid}.png'), optimize=True)
        index[fid] = entry
        results.append((fid, face, src, out, entry))
        print(f'{fid:8} eyes {entry["eyes"]} mouth {entry["mouth"]}')
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, indent=2)
        f.write('\n')
    if '--sheet' in sys.argv:
        sheet(results, sys.argv[sys.argv.index('--sheet') + 1])


if __name__ == '__main__':
    main()
