# Credits

## Audio

Files live in `packages/client/public/audio/`.

Every file in this set is **CC0 1.0 (public domain dedication)**. You can ship all of them in both the public GPL-3.0 repo and the private closed-source repo. No attribution is legally required. The credits below are a courtesy, and keeping them is recommended.

I checked each license on the asset's own page (Kenney pack page, OpenGameArt "License(s)" field) on 2026-11-16. The Kenney pack archives also include a License.txt that says CC0.

CC0: https://creativecommons.org/publicdomain/zero/1.0/

### Sound effects (`sfx/`, MP3 mono 44.1 kHz 96 kbps, silence trimmed, levels evened out)

| File | Title (source file) | Author | Source page | License | Attribution required | Private repo OK |
|---|---|---|---|---|---|---|
| sfx/move.mp3 | Interface Sounds, `tick_004.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/interface-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None (optional: "Kenney, www.kenney.nl") | Yes |
| sfx/rotate.mp3 | Interface Sounds, `toggle_001.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/interface-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/lock.mp3 | Impact Sounds, `impactWood_medium_000.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/impact-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/fall.mp3 | Impact Sounds, `impactGeneric_light_001.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/impact-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/pop.mp3 | 3 Pop Sounds, `pop1.ogg` | wubitog | https://opengameart.org/content/3-pop-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None (page says "No Attribution Required") | Yes |
| sfx/chain.mp3 | 3 Pop Sounds, `pop1.ogg`, pitched up 5 semitones | wubitog | https://opengameart.org/content/3-pop-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/win.mp3 | Win Jingle, `WinPizzicato.wav` (from winjingle.zip) | Fupi | https://opengameart.org/content/win-jingle | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/lose.mp3 | Music Jingles, `Pizzicato jingles/jingles_PIZZI07.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/music-jingles | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/select.mp3 | Interface Sounds, `confirmation_001.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/interface-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| sfx/pause.mp3 | Interface Sounds, `minimize_001.ogg` | Kenney (kenney.nl) | https://kenney.nl/assets/interface-sounds | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |

### Music (`music/`, MP3 stereo 44.1 kHz 128 kbps, loudness normalized to about -16 LUFS)

| File | Title | Author | Source page | License | Attribution required | Private repo OK |
|---|---|---|---|---|---|---|
| music/music-upbeat.mp3 | Flowerbed Fields [Loop] (`flowerbed_fields.ogg`, 1:46, seamless loop) | Zane Little Music | https://opengameart.org/content/flowerbed-fields-loop | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |
| music/music-calm.mp3 | Honey Bear (`honey-bear-loop.ogg`, 1:20, loop version) | TinyWorlds | https://opengameart.org/content/honey-bear | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None (author asks to be told if you use it: Twitter @tinyworlds) | Yes |
| music/music-extra.mp3 | Insect Factory (Wii-style music) (`insect_factory.wav`, 2:32, trailing silence trimmed) | Zane Little Music | https://opengameart.org/content/insect-factory-wii-style-music | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | None | Yes |

Notes:
- `music-extra` is the full album version of the track. It has a proper ending, so it is **not** a seamless loop: it will restart audibly when it repeats. The upbeat and calm tracks are published as loops.
- MP3 encoding adds a few ms of encoder delay and padding. For gapless looping, play the music through Web Audio (`AudioBufferSourceNode.loop = true`, adjusting `loopStart`/`loopEnd` if a click is heard) rather than `<audio loop>`.
- Music is mastered louder (about -16 LUFS) than the SFX (about -19 to -20 LUFS). Play music at around 0.4 to 0.6 volume in the game.
- `chain.mp3` is a pitched copy of `pop.mp3`. Higher combo steps can use `playbackRate` on either file.

### Courtesy credit line

Sound effects and jingles by Kenney (www.kenney.nl), wubitog and Fupi; music by Zane Little Music and TinyWorlds. All CC0, via kenney.nl and OpenGameArt.org.

## Art

The test skin is drawn in code (`packages/client/src/render.ts`). Skin art in `packages/client/public/skins/` is original work for Bug Pop, licensed CC-BY-SA 4.0 unless a file says otherwise.
