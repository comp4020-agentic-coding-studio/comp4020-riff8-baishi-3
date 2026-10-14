# Process

This repo began as The Scroll, baishi's crit-8 final project. A pod's
`prompt.md` at crit 9 replaced it with a small shared-world RPG aimed at
crit 10 ("Fly by instruments": tell people apart, enforce permissions on the
server, log who did what). This file is a dated entry per pass, as the
prompt asks. The design is in `docs/DESIGN.md`, the reasons in
`docs/DECISIONS.md`, the evidence in `docs/TESTING.md`.

## Pass 1 — the whole loop, minimal (2026-10-14)

Built in one sitting, server first:

- the shared data (`src/game/data.ts`: jobs, skills, monsters, items, three
  maps built deterministically so the browser and server agree) and the pure
  rules (`src/game/rules.ts`: derived stats, hit/crit/element damage, XP
  curves, refine odds), unit-tested in `spec/rules.test.ts`;
- SQLite persistence with a ledger of everything created or destroyed
  (`src/server/db.ts`), and the referee (`src/server/world.ts`): one intent
  queue applied at the start of each 200 ms tick, command-id dedupe, rate
  limiting, refusals that write `[reject]` lines, monster AI with three
  temperaments, ownership-windowed loot, parties with pooled XP, death and
  respawn;
- cookie identity (`src/server/auth.ts`), the JSON and SSE routes, and a
  test-only route that fixes the dice so outcomes are deterministic;
- the browser client (`src/client/`): canvas rendering with Kenney sprites,
  route preview, click and keyboard play, chat bubbles, emotes, HUD panels.

Because passes 2 to 4 share the same intent pipeline, most of their systems
(stats, skills with prerequisites and cast interruption, weight, cards, both
MVPs, shop, refining, trading, vending, guilds and storage, the barrow) went
in alongside pass 1 rather than being bolted on later. They're tested in
`spec/world.test.ts` with the rest.

Found by using it in a real browser, not by the spec: the no-JavaScript
character form returned a 500 because `Response.redirect` has immutable
headers, so Astro couldn't attach the cookie (fixed, and now tested); two
characters spawning on the same tile hid each other (arrivals now land on
the nearest free tile); a sprite drawn below another character covered
their name (names now draw after every sprite).

Cut in pass 1: nothing from the brief's list. Not built: PvP, which is out
of scope.
