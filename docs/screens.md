# Menu screens and game modes

The design for Bug Pop's menus, agreed with Mike on 2026-11-17. Single player exists
today; the leaderboard and multiplayer parts are recorded here so they are built to the
same plan later. "Built" marks say what exists in the client now.

## The flow

```
Title  ->  Choose a game  ->  (Multiplayer)  ->  Set up  ->  play
```

Every menu screen after the title has **Back** (top left) and a **Settings** gear (top
right). A returning player with an unfinished single-player game skips the menus: the
game opens paused where they left it.

### 1. Title (built)

Sign in (or "Signed in as ...", supporter badge, Sign out), Play, the ad space, and the
Credits / Privacy / Terms links. The skin paints the background (`title.background`).

### 2. Choose a game

Three large cards, stacked on a phone and side by side when there is room:

| Card | What it does |
| --- | --- |
| **Single player** | Goes to Set up. Shows a "Resume level N" tag when a game is saved. |
| **Leaderboard run** | A ranked game with fixed rules. Two buttons on the card: **Play** and **View scores**. Signed out, Play reads **Sign in to play**; View scores works for everyone. The result screen after a ranked run also links to the scores. |
| **Multiplayer** | Goes to the Multiplayer screen. On a device with no way to play locally and no sign-in, the card reads "Sign in to play". |

Everyone goes through this screen, signed in or not. Anonymous players are not sent
straight to Set up: they still have real choices here, and the locked modes show what
signing in adds.

Until leaderboards and multiplayer exist, their cards are shown but marked "Coming soon"
and do nothing.

### 3. Multiplayer (later)

Four modes, each a tile with a small diagram of its boards:

| Mode | Players |
| --- | --- |
| **Co-op** | Share one board |
| **PvP** | 1 against 1 |
| **Team PvP** | 2 against 2 |
| **Deathmatch** | 4 at once, last one standing |

Two ways to play, **Online** and **On this device**:

- **Same-device play is offered only when controllers are found** (a keyboard or
  gamepads). Several people cannot share one touch screen, so a touch-only phone or
  tablet is online only. A tablet with paired gamepads does get same-device play. The
  rule looks at the controllers, not at the kind of device.
- Where both are available and there is room (a computer), the two sets of tiles sit
  **side by side**: "On this computer" and "Online". On a narrow screen with
  controllers they stack.
- Online needs a sign-in. Signed out, the Online tiles are dimmed and a **Sign in to
  play online** button sits under them. Same-device play never needs an account.
- "On this device" offers only the modes the connected controllers can cover, and says
  what it found ("2 gamepads + keyboard: up to 3 players").
- No pause in competitive modes. Everyone must be on the latest build before a match
  (`requireLatest()` in `packages/client/src/update.ts`).

### 4. Set up

One screen for every mode: level, speed, colors and (later) power-ups, then **Start**.
Single player shows just that, with Resume when a game is saved. Multiplayer adds the
list of players and who is ready.

### Settings (the gear)

Sound, music, touch button layout, shapes on pieces, how bugs leave, go to the next
level automatically, look. These leave the game-choice screen so it stays simple.

## Ads

Ads are a deployment's own (this repo has no ad code; see `packages/client/src/ads.ts`).
Where a deployment turns them on:

- One fixed **320 x 100** space at the bottom of **Title** and of **Choose a game**. Same
  unit on both.
- Nowhere else: not on Multiplayer, Set up, Settings, pause, results, or during play.
- Signed-in players see them only when their account's `ads` setting allows it.

## Playing with several boards

- **Phone:** your own board stays full size; the other players' boards are small, in a
  column beside it, each with the player's name and bugs left.
- **Computer:** boards side by side at equal size.
- Co-op is one shared board, so it looks like single player with more pieces falling.
