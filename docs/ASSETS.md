# Assets

Every image, font and sound in the game is from Kenney (<https://kenney.nl>),
released under Creative Commons Zero (CC0 1.0,
<https://creativecommons.org/publicdomain/zero/1.0/>): free to use,
including in a public repo, with no attribution required. Credited here
anyway. The packs are one family (16px pixel art, shared palette), so tiles,
people, monsters and UI match.

| File | Pack | Source | Licence | What it's used for |
| --- | --- | --- | --- | --- |
| `public/sprites/town.png` | Tiny Town 1.0 (`Tilemap/tilemap_packed.png`, unmodified) | <https://kenney.nl/assets/tiny-town> | CC0 | grass, paths, plaza, trees, houses, well, signpost, items (key, honey pot) |
| `public/sprites/dungeon.png` | Tiny Dungeon 1.0 (`Tilemap/tilemap_packed.png`, unmodified) | <https://kenney.nl/assets/tiny-dungeon> | CC0 | the three jobs and NPCs, all monsters, barrow floor and walls, portals, weapons, potions, cards, anvil, stall |
| `public/favicon.png` | Tiny Dungeon 1.0 (`Tiles/tile_0097.png`) | <https://kenney.nl/assets/tiny-dungeon> | CC0 | favicon (the Warden) |
| `public/sprites/panel.png`, `inlay.png`, `button.png`, `button-pressed.png` | Pixel UI Pack (`9-Slice/Ancient/brown.png`, `tan_inlay.png`, `tan.png`, `tan_pressed.png`) | <https://kenney.nl/assets/pixel-ui-pack> | CC0 | panel frames and buttons (CSS `border-image`) |
| `public/fonts/kenney-pixel.ttf` | Kenney Fonts (`Kenney Pixel.ttf`) | <https://kenney.nl/assets/kenney-fonts> | CC0 | all text |
| `public/audio/levelup.ogg` | Music Jingles (`8-Bit jingles/jingles_NES00.ogg`) | <https://kenney.nl/assets/music-jingles> | CC0 | level up, refine success |
| `public/audio/rare.ogg` | Music Jingles (`jingles_NES03.ogg`) | same | CC0 | rare drop, +7 refine |
| `public/audio/mvp.ogg` | Music Jingles (`jingles_NES10.ogg`) | same | CC0 | MVP appears or falls |
| `public/audio/break.ogg` | Music Jingles (`jingles_NES07.ogg`) | same | CC0 | refine breaks |

Two monsters reuse a sprite with a hue shift done at draw time (the Grave
Jelly is the Mossling turned blue). The sprite indices each thing uses are
in `src/game/data.ts`.
