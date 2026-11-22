# Bug Pop

A falling-block puzzle game: drop two-part pieces to match four of a color with the bugs on the board, and the bugs fly away. Built as an installable web app (PWA) that never loses your game when your phone closes it in the background.

**Dev build:** https://bugpop-dev.wilminator.com (deployed from `main`, see [docs/cloudflare-setup.md](docs/cloudflare-setup.md))

## Run it

    npm ci
    npm run dev        # http://localhost:5173
    npm test           # engine tests
    npm run typecheck
    npm run build      # static site in packages/client/dist

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Engine | `packages/engine` | The rules as a pure state machine. `step(state, actions)` advances one 1/60 s tick. No clock, screen or `Math.random`: a seeded generator makes every game reproducible from its seed and input log. |
| Client | `packages/client` | The PWA: canvas renderer, input layer, audio, menus, saving. |
| Protocol | `packages/protocol` | Online versus without the network: message types and checks, and `OnlineMatch`, which plays my board and rebuilds the opponent's from their moves (input relay), checking them as it goes. |
| Relay | `packages/relay` | The minimal reference server for online play: 1 against 1 quick match, no accounts. `npm run build -w @bug-pop/relay`, then `PORT=8080 npm start -w @bug-pop/relay`. |
| Skins | `packages/client/src/skin.ts`, `public/skins/` | Pure data (colors, shapes, sprites, sounds). The engine knows "color 2"; the skin decides what color 2 looks like. |

Things worth knowing:

- **Saving:** the whole game state is JSON. It is written to `localStorage` every time a piece lands and the moment the page is hidden, so when iOS kills the app the game reopens exactly where it was.
- **Replays:** every action is logged as `tick * 8 + action`. `replay(config, log)` rebuilds the game bit for bit, which lets a server verify a leaderboard score.
- **Input:** keyboard, mouse (the piece follows the pointer), gamepads and joysticks (standard mapping), and on-screen touch buttons all feed one input manager that emits engine actions.
- **Pause:** hides the board so it cannot be used to plan. Versus has no pause: Leave opens a card while both games keep running.
- **Versus:** a versus game sends loose halves to the opponent when one piece makes two or more matches (up to 4 wait at once). They fall at 75% of the sender's speed and fill the two middle entry columns last. Multiplayer on one device (`packages/client/src/versus.ts`) plays you against the computer, two people, or the computer against itself.
- **Computer player:** `Bot` in `packages/engine/src/bot.ts` steers with the same actions a person sends. It has its own random numbers (seeded from the browser), so no two games against it are the same.
- **Online (in progress):** each device plays its own board and rebuilds the other from its moves, so nobody's picture of the game has to be trusted. Attacks are never sent: each device sees them happen on its copy of the other board.
- **Accessibility:** the default palette is Okabe-Ito (colorblind-safe) and every color also has its own shape. Reduced-motion is respected.

## Saving and cloud save

The game is written to `localStorage` every time a piece lands and the moment
the page is hidden, so iOS closing the app never loses a game.

When a deployment's `config.json` names an `api` and the player is signed in,
single player also copies the game to their account each time it pauses
(`packages/client/src/cloud.ts`). Choosing Single player on any device offers
the newest save, with a picture of the board, to resume or start over. Other
modes never touch it. Without an `api` (this repo's default) cloud save is off.

## Sign-in and ads (deployments with a server only)

With an `api` in `config.json`, the title page asks the server who is signed
in (`packages/client/src/account.ts`). A Wilminator Games account shows a
**Sign in** button above Play, or the player's name, a supporter badge and
**Sign out**. The browser never holds a token: the server runs the sign-in and
keeps a session cookie. If the server doesn't answer, the box stays hidden and
the game plays as usual.

This repo has no ad code. A deployment can add `"ads": {"script": "..."}` to
load its own ad script into the ad spaces (one on the title page, one on Choose a game)
(`packages/client/src/ads.ts` describes what that script must do), or
`"ads": {"preview": true}` for an empty outlined box. Ads appear only on the
title page and Choose a game, never during play, and signed-in players see them only when their
account allows it.

## Menus

Title, then **Choose a game** (Single player; Multiplayer; Leaderboard run is shown as "Coming soon"), then **Set up** (level, speed, colors, Start). Every screen after the title has Back (top left) and a Settings gear (top right) for sound, music, touch buttons, shapes, how bugs leave, auto next level, look and the controls help. The design, including the later multiplayer screens, is in [docs/screens.md](docs/screens.md).

## Skins

A skin is a `skin.json` plus art and sound files. A deployment picks one with a `config.json` beside the page: `{"skin": "skins/code-bugs/skin.json"}`. Skins can animate bugs (two frames), carry a `season` window (holiday skins) and a `tier` (`supporter` skins).

### Seasonal looks

A deployment can offer extra looks in Settings → Look by listing them in `config.json`:

```json
"looks": [{"id": "code-bugs-winter", "name": "Snow Day Bugs", "skin": "skins/code-bugs-winter/skin.json", "season": {"from": "12-01", "to": "02-29"}}]
```

A look with a `season` (MM-DD to MM-DD, inclusive, may wrap the new year) is listed only while it is in season. Nothing changes by itself: once per season the title page says new looks are out, with a button to Settings. When the picked look's season ends, the game goes back to the default look. The Look setting stays on each device. A testing site can add `"allLooks": true` to list every look whatever the date (out-of-season ones are marked); the title-page note still follows the real season. A skin can add weather over its board with `"ambient": {"kind": "snow" | "leaves" | "petals" | "fireflies", "colors": [...], "count": 18}`; it stands still with Calm motion and is left out with motion Off.

The open-source build ships four seasonal Code Bugs looks (winter, spring, summer, fall), drawn from the Code Bugs art by `python3 tools/draw-seasons.py`, which also writes the `looks` list into `packages/client/public/config.json`.

A skin can also paint the title page and the menu screens: `"title": {"background": "title-bg.svg"}` (path relative to `skin.json`). The picture is stretched to fill the whole screen, not cropped, so make it an SVG that lays itself out to any size (no `viewBox`). A skin without it, like Code Bugs, keeps the plain dimmed backdrop.

## Logo and publisher link

A deployment can put a logo and a link to its own site on the title page by adding two optional entries to `config.json` (paths relative to the page):

```json
"logo": {"wide": "brand/logo-wide.png", "stacked": "brand/logo-stacked.png"},
"home": {"url": "https://example.com/", "name": "More games from Example", "icon": "brand/icon.png"}
```

The wide logo shows above the title card; screens 600 px wide or less get the stacked one when it is given. With a logo, the plain "Bug Pop" heading is hidden (the logo's alt text keeps the name for screen readers). Without these entries the title page looks as before.

## License

- Code: [GNU GPL v3.0](LICENSE)
- Audio: CC0, see [CREDITS.md](CREDITS.md)
- Skin art in this repository: CC-BY-SA 4.0 unless a file says otherwise
