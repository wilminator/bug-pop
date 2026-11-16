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
| Skins | `packages/client/src/skin.ts`, `public/skins/` | Pure data (colors, shapes, sprites, sounds). The engine knows "color 2"; the skin decides what color 2 looks like. |

Things worth knowing:

- **Saving:** the whole game state is JSON. It is written to `localStorage` every time a piece lands and the moment the page is hidden, so when iOS kills the app the game reopens exactly where it was.
- **Replays:** every action is logged as `tick * 8 + action`. `replay(config, log)` rebuilds the game bit for bit, which lets a server verify a leaderboard score.
- **Input:** keyboard, mouse (the piece follows the pointer), gamepads and joysticks (standard mapping), and on-screen touch buttons all feed one input manager that emits engine actions.
- **Pause:** hides the board so it cannot be used to plan. Competitive (versus) modes will have no pause.
- **Accessibility:** the default palette is Okabe-Ito (colorblind-safe) and every color also has its own shape. Reduced-motion is respected.

## Skins

A skin is a `skin.json` plus art and sound files. A deployment picks one with a `config.json` beside the page: `{"skin": "skins/code-bugs/skin.json"}`. Skins can animate bugs (two frames), carry a `season` window (holiday skins) and a `tier` (`supporter` skins).

## License

- Code: [GNU GPL v3.0](LICENSE)
- Audio: CC0, see [CREDITS.md](CREDITS.md)
- Skin art in this repository: CC-BY-SA 4.0 unless a file says otherwise
