#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Draws packages/client/public/skins/code-bugs/title-bg.svg, the Code Bugs title background.

Run:  python3 tools/draw-title-bg.py

The picture has no viewBox, so it fills any screen. Four small scenes are pinned to the
corners (nested <svg> elements that scale to fit), leaving the middle clear for the title
card; the grid, the glow and the floating bits stretch across the rest. Show it stretched:
`background: url(title-bg.svg) center / 100% 100% no-repeat`.
"""
import math, pathlib, random

rnd = random.Random(11)
INK = '#0A0E18'
COL = {  # body, outline, light
    'o': ('#D55E00', '#5A2600', '#F5A262'), 'b': ('#56B4E9', '#1B4058', '#B5E0F7'), 'y': ('#F0E442', '#5A5410', '#FBF6A8'),
    'g': ('#009E73', '#06382B', '#6FD6B6'), 'p': ('#CC79A7', '#532A41', '#EFC0DA'),
}

def star(r, r2=None, n=5):
    r2 = r2 or r * .5
    pts = []
    for i in range(n * 2):
        a = math.pi * i / n - math.pi / 2
        rr = r if i % 2 == 0 else r2
        pts.append(f'{rr*math.cos(a):.1f} {rr*math.sin(a):.1f}')
    return 'M' + 'L'.join(pts) + 'Z'

BODY = {
    'o': '<circle r="30"/>',
    'b': '<path d="M-34 -24L34 -24L0 34Z"/>',
    'y': '<rect x="-28" y="-28" width="56" height="56" rx="9"/>',
    'g': '<path d="M0 -36L36 0L0 36L-36 0Z"/>',
    'p': f'<path d="{star(40, 21)}"/>',
}

def eye(x, y, r, look):
    px, py = x + look[0] * r * .32, y + look[1] * r * .32
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="{INK}" stroke-width="1.6"/>'
            f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r*.5:.1f}" fill="{INK}"/><circle cx="{px-r*.2:.1f}" cy="{py-r*.25:.1f}" r="{r*.18:.1f}" fill="#fff"/>')

def bug(kind, look=(.7, .4), wave=False, hang=False):
    """A shape-bodied bug standing up on two feet, head on top, seen from the front."""
    body, edge, light = COL[kind]
    arm_r = 'M26 -6C40 -14 46 -26 44 -38' if wave else 'M26 0C38 2 44 10 46 20'
    legs = ('' if hang else f'<path d="M-12 26L-16 46h-8M12 26L16 46h8" fill="none" stroke="{edge}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>')
    return ('<g>' + legs +
            f'<path d="M-26 0C-38 2 -44 10 -46 20M{arm_r[1:]}" fill="none" stroke="{edge}" stroke-width="5" stroke-linecap="round"/>'
            f'<g fill="{body}" stroke="{edge}" stroke-width="4" stroke-linejoin="round">{BODY[kind]}</g>'
            f'<path d="M-14 -4h28M-14 8h18" stroke="{edge}" stroke-width="4" stroke-linecap="round" opacity=".45"/>'
            f'<circle cx="0" cy="-40" r="19" fill="{edge}" stroke="{INK}" stroke-width="2"/>'
            f'<path d="M-8 -56C-10 -66 -16 -72 -24 -72M8 -56C10 -66 16 -72 24 -72" fill="none" stroke="{edge}" stroke-width="3.4" stroke-linecap="round"/>'
            f'<circle cx="-24" cy="-72" r="4.4" fill="{light}"/><circle cx="24" cy="-72" r="4.4" fill="{light}"/>'
            + eye(-8, -42, 7.6, look) + eye(8, -42, 7.6, look) +
            '<path d="M-6 -30Q0 -25 6 -30" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g>')

def code(x, y, rows, w=230, flip=False):
    """A block of 'code': line numbers and coloured bars, like an editor seen from far away."""
    cols = ['#56B4E9', '#CC79A7', '#F0E442', '#009E73', '#D55E00', '#8FA3C7', '#8FA3C7']
    out = [f'<g transform="translate({x} {y})" opacity=".55">']
    indent = 0
    for r in range(rows):
        indent = max(0, min(3, indent + rnd.choice([-1, 0, 0, 1])))
        cx = indent * 22
        out.append(f'<rect x="{-26 if not flip else w+8}" y="{r*22+2}" width="14" height="6" rx="3" fill="#2E3A55"/>')
        while cx < w - 40:
            ln = rnd.choice([18, 30, 44, 60])
            if rnd.random() < .8:
                xx = cx if not flip else w - cx - ln
                out.append(f'<rect x="{xx}" y="{r*22}" width="{ln}" height="10" rx="5" fill="{rnd.choice(cols)}"/>')
            cx += ln + 10
            if rnd.random() < .3: break
    out.append('</g>')
    return ''.join(out)

def trace(d):
    return f'<path d="{d}" fill="none" stroke="#2E3A55" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'

def node(x, y, c='#2E3A55'):
    return f'<circle cx="{x}" cy="{y}" r="8" fill="#0F1420" stroke="{c}" stroke-width="5"/>'

def corner(anchor, body, x, y):
    return f'<svg x="{x}" y="{y}" width="50%" height="36%" viewBox="0 0 500 400" preserveAspectRatio="{anchor} meet" overflow="visible">{body}</svg>'

top_left = ''.join([
    code(60, 40, 9),
    '<rect x="50" y="250" width="270" height="12" rx="6" fill="#2E3A55"/>',
    f'<g transform="translate(250 204) rotate(4) scale(.95)">{bug("o", (.8, .3), wave=True)}</g>',
    '<path d="M306 150l8 -10M316 166l12 -3" stroke="#D8E1F0" stroke-width="3" stroke-linecap="round" opacity=".7"/>',
])

top_right = ''.join([
    '<text x="250" y="150" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="150" font-weight="700" fill="none" stroke="#2E3A55" stroke-width="5">{ }</text>',
    '<path d="M400 -10L400 150" stroke="#8FA3C7" stroke-width="3" stroke-dasharray="3 7" stroke-linecap="round"/>',
    f'<g transform="translate(400 228) rotate(-6) scale(.95)">{bug("b", (-.7, .6), hang=True)}</g>',
    trace('M520 250H470L440 280V340'), node(440, 340),
    '<text x="110" y="250" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="40" font-weight="700" fill="#7D8AA6" opacity=".6">// TODO</text>',
])

bottom_left = ''.join([
    trace('M-20 150H60L100 190V300'), node(100, 300), trace('M-20 230H40'), node(40, 230, '#009E73'),
    '<rect x="-20" y="384" width="440" height="12" rx="6" fill="#2E3A55"/>',
    # a patch being pushed along the line
    '<g transform="translate(300 330)"><rect x="-46" y="-46" width="92" height="92" rx="16" fill="#161D2E" stroke="#8FA3C7" stroke-width="4" stroke-dasharray="10 8"/>'
    '<path d="M-14 -16l-14 16l14 16M14 -16l14 16l-14 16" fill="none" stroke="#8FA3C7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>',
    f'<g transform="translate(190 336) rotate(8) scale(.95)">{bug("y", (.8, .2))}</g>',
    '<path d="M120 300h-26M126 322h-36M120 344h-22" stroke="#D8E1F0" stroke-width="3" stroke-linecap="round" opacity=".5"/>',
])

bottom_right = ''.join([
    code(210, 60, 6, flip=True),
    '<rect x="80" y="384" width="440" height="12" rx="6" fill="#2E3A55"/>',
    f'<g transform="translate(250 334) scale(.9)">{bug("g", (.8, -.2))}</g>',
    f'<g transform="translate(390 332) rotate(-6) scale(.95)">{bug("p", (-.8, -.2), wave=True)}</g>',
    '<path d="M312 250c-6 -10 -18 -8 -18 2c0 10 18 16 18 24c0 -8 18 -14 18 -24c0 -10 -12 -12 -18 -2Z" fill="#CC79A7" stroke="#532A41" stroke-width="3" opacity=".9"/>',
])

def bits():
    out = []
    for _ in range(40):
        x, y, o = rnd.uniform(2, 98), rnd.uniform(4, 96), rnd.uniform(.2, .6)
        c = rnd.choice(['#56B4E9', '#8FA3C7', '#8FA3C7', '#F0E442', '#CC79A7', '#009E73'])
        if rnd.random() < .5:
            out.append(f'<rect x="{x:.1f}%" y="{y:.1f}%" width="5" height="5" rx="1" fill="{c}" opacity="{o:.2f}"/>')
        else:
            out.append(f'<svg x="{x:.1f}%" y="{y:.1f}%" overflow="visible"><path d="M-5 0h10M0 -5v10" stroke="{c}" stroke-width="2" stroke-linecap="round" opacity="{o:.2f}"/></svg>')
    return ''.join(out)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
<!-- Bug Pop: Code Bugs title background. Drawn by tools/draw-title-bg.py. GPL-3.0-only. -->
<defs>
<linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0A0E18"/><stop offset="1" stop-color="#161D2E"/></linearGradient>
<radialGradient id="screen" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#56B4E9" stop-opacity=".16"/><stop offset="1" stop-color="#56B4E9" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#1F2940" stroke-width="1"/></pattern>
</defs>
<rect width="100%" height="100%" fill="url(#night)"/>
<rect width="100%" height="100%" fill="url(#grid)"/>
<rect width="100%" height="100%" fill="url(#screen)"/>
{bits()}
{corner('xMinYMin', top_left, '0', '0')}
{corner('xMaxYMin', top_right, '50%', '0')}
{corner('xMinYMax', bottom_left, '0', '64%')}
{corner('xMaxYMax', bottom_right, '50%', '64%')}
</svg>
'''
out = pathlib.Path(__file__).resolve().parent.parent / 'packages/client/public/skins/code-bugs/title-bg.svg'
out.write_text(svg)
print(f'wrote {out} ({len(svg)/1024:.1f} KB)')
