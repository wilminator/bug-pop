#!/usr/bin/env python3
"""Draws the four seasonal Code Bugs looks from the Code Bugs art.

Run:  python3 tools/draw-seasons.py

Each season gets its own folder next to the base skin, packages/client/public/skins/code-bugs-<season>/,
holding a skin.json and the bug and piece pictures. The bugs are the Code Bugs critters dressed for the
season (knit hats and scarves, flower crowns, straw hats, acorn caps); the piece tiles keep their colors,
shapes and <> brackets and gain a small seasonal touch (snow, a sprout, a sun, a leaf). Colors and shapes
never change, so the game plays and reads exactly the same in every look.
Sounds, music, the title picture and power-up names come from the base skin by relative path.

The pictures are Code Bugs skin art: CC-BY-SA 4.0, like the rest of the Code Bugs art (see LICENSE.txt
in each folder). config.json lists the looks so they show in Settings while in season.
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKINS = ROOT / 'packages/client/public/skins'
BASE = SKINS / 'code-bugs'


def inner(svg: str) -> str:
    """The drawing inside a 64x64 <svg>, so more can be layered on top."""
    return re.sub(r'^<svg[^>]*>|</svg>\s*$', '', svg.strip())


def svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{body}</svg>'


def petals(cx, cy, r, color, centre, n=5):
    """A small flower: n round petals and a centre."""
    import math
    out = ''.join(
        f'<circle cx="{cx + r * math.cos(2 * math.pi * i / n - math.pi / 2):.1f}" cy="{cy + r * math.sin(2 * math.pi * i / n - math.pi / 2):.1f}" r="{r * 0.75:.1f}" fill="{color}"/>'
        for i in range(n))
    return out + f'<circle cx="{cx}" cy="{cy}" r="{r * 0.6:.1f}" fill="{centre}"/>'


# ---- What each bug wears (drawn over the head, which sits around x 32, y 12-26 in every bug) ----
def beanie(main, band, pom):
    return (f'<path d="M20.5 17.5Q21 5.5 32 5.5Q43 5.5 43.5 17.5Z" fill="{main}" stroke="#0A0E18" stroke-width="1.4"/>'
            f'<path d="M24 9.5Q32 6.5 40 9.5M22.5 13Q32 10 41.5 13" fill="none" stroke="{band}" stroke-width="1.6" opacity=".8"/>'
            f'<rect x="19" y="15" width="26" height="5.5" rx="2.75" fill="{band}" stroke="#0A0E18" stroke-width="1.2"/>'
            f'<circle cx="32" cy="6" r="3" fill="{pom}" stroke="#0A0E18" stroke-width="1.2"/>')


def scarf(main, stripe):
    return (f'<path d="M19 27.5Q32 33 45 27.5L45 31.5Q32 37 19 31.5Z" fill="{main}" stroke="#0A0E18" stroke-width="1.2"/>'
            f'<path d="M39 31L42.5 42L38.5 43L36 32.5Z" fill="{main}" stroke="#0A0E18" stroke-width="1.2"/>'
            f'<path d="M25 30.5V34M31 31.5V35M37 31V34.5" stroke="{stripe}" stroke-width="1.6"/>')


def flower_crown():
    vine = '<path d="M20 15Q32 8 44 15" fill="none" stroke="#3B8F3A" stroke-width="2.2" stroke-linecap="round"/>'
    leaves = ('<ellipse cx="26.5" cy="11.5" rx="3" ry="1.6" fill="#59B85A" transform="rotate(-30 26.5 11.5)"/>'
              '<ellipse cx="37.5" cy="11.5" rx="3" ry="1.6" fill="#59B85A" transform="rotate(30 37.5 11.5)"/>')
    return vine + leaves + petals(21, 14.5, 2.6, '#FFFFFF', '#F0C030') + petals(32, 9.5, 3, '#F7A8C8', '#F0C030') + petals(43, 14.5, 2.6, '#FFE36A', '#E07A20')


def straw_hat(ribbon):
    return ('<ellipse cx="32" cy="15.5" rx="16" ry="4.2" fill="#E9C46A" stroke="#6B4E16" stroke-width="1.3"/>'
            '<path d="M24 15Q24 5.5 32 5.5Q40 5.5 40 15Z" fill="#E9C46A" stroke="#6B4E16" stroke-width="1.3"/>'
            f'<path d="M24.2 12.5Q32 14.5 39.8 12.5L39.9 14.8Q32 16.8 24.1 14.8Z" fill="{ribbon}"/>'
            '<path d="M18 15.5Q32 19 46 15.5" fill="none" stroke="#C9A04A" stroke-width="1"/>')


def acorn_cap():
    return ('<path d="M21.5 16.5Q21.5 6 32 6Q42.5 6 42.5 16.5Z" fill="#8A5A2B" stroke="#3E2610" stroke-width="1.4"/>'
            '<path d="M23 13.5L41 13.5M24.5 10L39.5 10M25 16.5L28 6.8M32 16.5V6M39 16.5L36 6.8" stroke="#B07A45" stroke-width="1.1"/>'
            '<path d="M32 6V3.5" stroke="#3E2610" stroke-width="2.6" stroke-linecap="round"/>')


# ---- The small seasonal touch on each piece tile (tiles fill about 6..58) ----
SNOW_CAP = ('<path d="M8 17Q8 7 18 7H46Q56 7 56 17Q52 15 49 17.5Q45 14.5 41 17Q37 14 33 16.5Q29 14 25 17Q21 14.5 17 17Q12 14.5 8 17Z" '
            'fill="#FFFFFF" stroke="#C9D8EA" stroke-width="1"/><circle cx="15" cy="11" r="1.2" fill="#DDE8F5"/><circle cx="40" cy="10.5" r="1.2" fill="#DDE8F5"/>')
SPROUT = ('<path d="M49 15V7.5" stroke="#2F7D32" stroke-width="2" stroke-linecap="round"/>'
          '<path d="M49 10Q44 9 43 4.5Q48 4.5 49 10Z" fill="#66BB6A" stroke="#1F5A22" stroke-width="1"/>'
          '<path d="M49 9Q54 7.5 56 3.5Q50.5 3 49 9Z" fill="#81C784" stroke="#1F5A22" stroke-width="1"/>')
SUN = ('<g stroke="#E8A317" stroke-width="1.6" stroke-linecap="round">'
       + ''.join(f'<line x1="{51 + 5.6 * c:.1f}" y1="{12 + 5.6 * s:.1f}" x2="{51 + 8 * c:.1f}" y2="{12 + 8 * s:.1f}"/>'
                 for c, s in [(1, 0), (.71, .71), (0, 1), (-.71, .71), (-1, 0), (-.71, -.71), (0, -1), (.71, -.71)])
       + '</g><circle cx="51" cy="12" r="4.4" fill="#FFD54A" stroke="#B37A00" stroke-width="1"/>')
LEAF = ('<path d="M50 4Q58 6 57 14Q55 19 49 18Q45 12 50 4Z" fill="#E07A1F" stroke="#6E3505" stroke-width="1.1"/>'
        '<path d="M49.5 18Q52 11 53.5 6" fill="none" stroke="#6E3505" stroke-width="1"/>')

# The Code Bugs' eyes sit higher (around y 18) than the hats were drawn for, so every hat is made a
# little smaller and lifted, pivoting on the hat band (y 20.5). The scarf stays where it is.
HAT = 'translate(0 -5.5) translate(32 20.5) scale(.86) translate(-32 -20.5)'


def hat(body):
    return f'<g transform="{HAT}">{body}</g>'


SEASONS = {
    'winter': dict(
        name='Snow Day Bugs', season={'from': '12-01', 'to': '02-29'},
        wear=hat(beanie('#2A9D8F', '#F2EFE6', '#F2EFE6')) + scarf('#3B6FD1', '#F2EFE6'), tile=SNOW_CAP,
        colors=dict(background='#0C1424', boardFill='#14203A', boardEdge='#3A5378', grid='#1C2B48', accent='#9FD3F5'),
        ambient={'kind': 'snow', 'colors': ['#FFFFFF', '#DDEBFA'], 'count': 22}),
    'spring': dict(
        name='Spring Sprint Bugs', season={'from': '03-01', 'to': '05-31'},
        wear=hat(flower_crown()), tile=SPROUT,
        colors=dict(background='#101A17', boardFill='#16241F', boardEdge='#3E6B57', grid='#1E3029', accent='#8FD9A8'),
        ambient={'kind': 'petals', 'colors': ['#F7B8D2', '#FFFFFF', '#FBD3E3'], 'count': 14}),
    'summer': dict(
        name='Summer Patch Bugs', season={'from': '06-01', 'to': '08-31'},
        wear=hat(straw_hat('#D55E00')), tile=SUN,
        colors=dict(background='#0E1622', boardFill='#14223A', boardEdge='#3E6690', grid='#1B2D48', accent='#FFD54A'),
        ambient={'kind': 'fireflies', 'colors': ['#FFE97A', '#C8F56A'], 'count': 12}),
    'fall': dict(
        name='Fall Release Bugs', season={'from': '09-01', 'to': '11-30'},
        wear=hat(acorn_cap()) + scarf('#E69F00', '#7A3E00'), tile=LEAF,
        colors=dict(background='#1A120C', boardFill='#251A12', boardEdge='#6B4A2E', grid='#30231A', accent='#F0B85A'),
        ambient={'kind': 'leaves', 'colors': ['#E07A1F', '#C9531A', '#E8B23A'], 'count': 14}),
}


def main():
    base = json.loads((BASE / 'skin.json').read_text())
    licence = (BASE / 'LICENSE.txt').read_text().split('\n')[0] + '\n'
    looks = []
    for key, s in SEASONS.items():
        out = SKINS / f'code-bugs-{key}'
        out.mkdir(exist_ok=True)
        for name in [f'bug-{i}.svg' for i in range(5)] + [f'bug-{i}b.svg' for i in range(5)]:
            (out / name).write_text(svg(inner((BASE / name).read_text()) + s['wear']) + '\n')
        for i in range(5):
            (out / f'half-{i}.svg').write_text(svg(inner((BASE / f'half-{i}.svg').read_text()) + s['tile']) + '\n')
        skin = dict(base)
        skin.update(id=f'code-bugs-{key}', name=s['name'], season=s['season'], ambient=s['ambient'], **s['colors'])
        # Sounds and music already point up to the shared audio folder, which is the same
        # distance from every skin folder; only the title picture lives in the base skin's folder.
        skin['title'] = {'background': '../code-bugs/title-bg.svg'}
        (out / 'skin.json').write_text(json.dumps(skin, indent=2) + '\n')
        (out / 'LICENSE.txt').write_text(licence + 'Drawn by tools/draw-seasons.py from the Code Bugs art.\n')
        looks.append({'id': f'code-bugs-{key}', 'name': s['name'], 'skin': f'skins/code-bugs-{key}/skin.json', 'season': s['season']})
    cfg_file = ROOT / 'packages/client/public/config.json'
    cfg = json.loads(cfg_file.read_text())
    cfg['looks'] = looks
    cfg_file.write_text(json.dumps(cfg, indent=2) + '\n')
    print(f'wrote {len(looks)} looks')


if __name__ == '__main__':
    main()
