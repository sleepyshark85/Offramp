#!/usr/bin/env python3
"""Generate app icon, adaptive icon, splash and favicon from the design palette.

The mark is the game in one glyph: a car on the trunk road, the fork below it,
and the open branch lit. Colours are the literal tokens from docs/design/ui.md
Sections 5.1 and 5.3 -- nothing here is picked by eye.

Roads are stroked as filled polygons built from offset normals, not as thick
polylines. PIL's `joint="curve"` shreds a wide stroke on a curve into visible
hatching, which is what the first version of this file did.

Drawn at 4x and downsampled, because PIL has no antialiased primitives.

    python3 tools/make-assets.py
"""
import math

from PIL import Image, ImageDraw

BG             = (0x0B, 0x0E, 0x13)
ROAD           = (0x2B, 0x32, 0x3C)
ROAD_EDGE      = (0x43, 0x4C, 0x59)
ROAD_DASH      = (0x5A, 0x64, 0x72)
SURFACE_RAISED = (0x1F, 0x26, 0x30)
DEPOT          = (0x1B, 0x22, 0x2C)
EMBER          = (0xFF, 0x85, 0x2A)
SKY            = (0x89, 0xD9, 0xFF)
INK            = (0x0B, 0x0E, 0x13)

S = 4  # supersample factor


def bezier(p0, p1, p2, steps=64):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def normals(pts):
    """Unit normal at each point, averaged across the adjacent segments."""
    out = []
    for i, _ in enumerate(pts):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1.0
        out.append((-dy / d, dx / d))
    return out


def rr(d, box, radius, fill):
    """Rounded rectangle with the radius clamped to the box. PIL raises rather
    than clamping, and the 48px favicon is small enough to hit it."""
    x0, y0, x1, y1 = box
    r = max(0, min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill)


def stroke(d, pts, width, fill):
    """Fill the ribbon swept by a pen of `width` along `pts`, with round caps."""
    h = width / 2.0
    n = normals(pts)
    left  = [(p[0] + v[0] * h, p[1] + v[1] * h) for p, v in zip(pts, n)]
    right = [(p[0] - v[0] * h, p[1] - v[1] * h) for p, v in zip(pts, n)]
    d.polygon(left + right[::-1], fill=fill)
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - h, p[1] - h, p[0] + h, p[1] + h], fill=fill)


def draw_mark(d, cx, cy, size):
    """Draw the mark: a car on the trunk, the fork below it, the open branch
    lit, and the two depots it decides between. That is the whole game."""
    u = size / 1024.0
    def P(x, y):
        return (cx + (x - 512) * u, cy + (y - 512) * u)

    road_w = 178 * u
    edge_w = road_w + 30 * u
    fork_y = 432

    trunk = [P(512, 40), P(512, fork_y)]
    left  = [P(*p) for p in bezier((512, fork_y), (512, 672), (240, 848))]
    right = [P(*p) for p in bezier((512, fork_y), (512, 672), (784, 848))]

    # Casing first, all three roads, so the joins are buried under the fills.
    # The open branch gets the bright casing -- that is the whole "which way is
    # open" signal, reduced to one stroke.
    stroke(d, trunk, edge_w, ROAD_EDGE)
    stroke(d, right, edge_w, ROAD_EDGE)
    stroke(d, left,  edge_w, ROAD_DASH)
    for path in (trunk, right, left):
        stroke(d, path, road_w, ROAD)

    # The two depots the junction decides between. The lit branch leads to the
    # one matching the car, which is what makes the mark readable rather than
    # decorative.
    for col, colour, glyph in ((240, EMBER, "circle"), (784, SKY, "triangle")):
        w, h = 268 * u, 150 * u
        bx, by = P(col, 884)
        rr(d, [bx - w / 2, by - h / 2, bx + w / 2, by + h / 2], 34 * u, DEPOT)
        fh = 74 * u
        rr(d, [bx - w / 2, by - h / 2, bx + w / 2, by - h / 2 + fh], 34 * u, colour)
        d.rectangle([bx - w / 2, by - h / 2 + fh - 34 * u,
                     bx + w / 2, by - h / 2 + fh], fill=colour)
        g = 30 * u
        gy = by + 34 * u
        if glyph == "circle":
            d.ellipse([bx - g, gy - g, bx + g, gy + g], fill=colour)
        else:
            d.polygon([(bx, gy - g), (bx + g, gy + g * 0.8),
                       (bx - g, gy + g * 0.8)], fill=colour)

    # Junction node.
    jr = 54 * u
    jx, jy = P(512, fork_y)
    d.ellipse([jx - jr, jy - jr, jx + jr, jy + jr],
              fill=SURFACE_RAISED, outline=ROAD_DASH, width=max(1, int(13 * u)))

    # The car: body, wheels, windshield, and the always-on colour-blind glyph.
    cw, ch = 138 * u, 216 * u
    ccx, ccy = P(512, 212)
    tyre_w, tyre_h = 22 * u, 58 * u
    for sx in (-1, 1):
        for oy in (-58 * u, 58 * u):
            x = ccx + sx * (cw / 2 - 4 * u)
            rr(d, [min(x, x + sx * tyre_w), ccy + oy - tyre_h / 2,
                   max(x, x + sx * tyre_w), ccy + oy + tyre_h / 2], 9 * u, INK)
    rr(d, [ccx - cw / 2, ccy - ch / 2, ccx + cw / 2, ccy + ch / 2], 36 * u, EMBER)
    ww, wh = 92 * u, 48 * u
    wy = ccy - ch / 2 + 26 * u
    rr(d, [ccx - ww / 2, wy, ccx + ww / 2, wy + wh], 15 * u, INK)
    gr = 31 * u          # Ember's glyph is the circle (ui.md Section 5.1)
    gy = ccy + 40 * u
    d.ellipse([ccx - gr, gy - gr, ccx + gr, gy + gr], fill=INK)


def render(w, h, mark_size, bg=BG, transparent=False):
    im = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0) if transparent else bg + (255,))
    draw_mark(ImageDraw.Draw(im), w * S / 2, h * S / 2, mark_size * S)
    return im.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    out = "assets/"
    render(1024, 1024, 980).convert("RGB").save(out + "icon.png")
    # Android masks centre-crop an adaptive icon: keep the mark inside the safe
    # 66% and leave the field to `adaptiveIcon.backgroundColor`.
    render(1024, 1024, 620, transparent=True).save(out + "adaptive-icon.png")
    # The splash is a square logo, not a full-bleed screen: expo-splash-screen
    # scales it to `imageWidth` and centres it on `backgroundColor`, so a tall
    # image would be scaled down by its height and arrive as a speck.
    render(1024, 1024, 880).convert("RGB").save(out + "splash.png")
    # The favicon is a downscale of the finished icon rather than a re-render:
    # at 48px the mark's detail is below the resolution that can carry it, and
    # LANCZOS from 1024 reads better than drawing it small.
    Image.open(out + "icon.png").resize((48, 48), Image.LANCZOS).save(out + "favicon.png")
    print("wrote icon.png adaptive-icon.png splash.png favicon.png")
