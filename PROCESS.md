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

## Pass 2 — depth (2026-10-14)

Stats with rising cost, four skills per job with prerequisites, cast times
that a hit interrupts (unless Endure is up), weight limits, two equipment
slots, cards, and an MVP per wild map rewarding the top damage dealer were
already in from pass 1. This pass was about whether they play well:

- the first bot playtest put three bots at level 5 in three minutes with no
  deaths, so field monsters got tougher and the XP curve steeper;
- a 10-minute run then showed 75 deaths, half of them to an Ember Crab that
  wandered out of its corner to fight the whole field. MVPs now aggro only
  close to their lair and give up six tiles from home;
- after both, a party clearly beats solo (36 kills and 1 death against 28
  and 3, with the solo Mender managing one kill), which is the first pillar.

A two-profile browser run of the MVP fight found the announcement banner
spilling across the side panel; it now sits inside the game view.

## Pass 3 — economy (2026-10-14)

The shop, refining (safe to +4, then a rising break chance), the trade
window (both confirm the same version; any change clears both) and vending
stalls (open while the seller is away, closed by selling out) were in from
pass 1, with conservation tests. A browser run with two profiles opened a
stall in one and bought from it in the other, then traded a potion for 60z
through the trade window: one `[trade]` line each, totals unchanged. It
found two UI gaps: a seller standing on their stall's tile intercepted the
click meant for the stall, and the trade window's × left the trade open
server-side. Both fixed.

## Pass 4 — guilds and a second map (2026-10-14)

Guild create, invite, join and leave, guild chat, guild storage at Ilse the
Steward (members only, tested for outsiders and for someone who just left),
and The Old Barrow with its own four monsters and a stronger MVP (the Barrow
Wight) were built alongside the rest. The barrow hasn't had a bot playtest
of its own; its numbers are hand-set.

## What was cut

Nothing from the brief's list was cut. What's thinner than it could be:
monster variety reuses two sprites with a hue shift, the barrow is untuned,
and the bots never reach the MVPs on their own in a few minutes (a party of
level-1 characters shouldn't).

## Finish (2026-10-14)

All four passes are in, `pnpm check` is green (50 specs) locally and against
the CI image, and two-profile browser runs covered the definition of done
except the live URL: as a pod run this doesn't deploy or push, so CI ships
it and the live two-profile check happens at the crit. `prompt.md` is
deleted in the last commit, as the riff asks.
