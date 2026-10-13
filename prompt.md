# Brief: replace The Scroll with a small shared-world RPG inspired by Ragnarok Online

You're running unattended and nobody can answer questions. When something
isn't covered here, take the smaller, more reversible choice, write down why
in `PROCESS.md`, and keep going.

## What this is, and what you're allowed to change

The pod has decided to retire The Scroll and build a different app in this
repo: a small, browser-based, multiplayer action RPG in the spirit of
Ragnarok Online — one shared world where people walk around, fight
monsters together, level up, trade and team up.

You are explicitly allowed to:

- replace the app in `src/` entirely, and rewrite `README.md` for the new app;
- delete or rewrite `spec/scroll.test.ts` and `spec/lanterns.test.ts`, which
  encode the old brief;
- replace the "Your harness" half of `CLAUDE.md` (everything below the
  `---` line) with rules for the new app.

You must not:

- change the top block of `CLAUDE.md` (above the `---` line);
- break `spec/invariants.test.ts`: `/` answers 200 and `/readme/` serves the
  current `README.md` with its headings in order;
- change the deploy shape in `fly.toml`: one shared-cpu-1x machine, 256 MB,
  one volume at `/data`, no second service (no Redis, no Postgres, no queue).

Use original names and art. Don't copy Ragnarok Online sprites, music, maps
or trademarked names into this public repo. Simple shapes, colours and
original names are fine ("a jelly that eats loot", not "Poring").

## The brief this is aimed at

The next crit is
<https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/>.
Read it. In short: the app must tell people apart, check on the server what
each person may see and change, and log who did what, server-side, in a way
that outlives the crit. At the crit, two pod members open the URL in separate
Chrome profiles and play, while a third narrates only from
`mise exec -- flyctl logs -a <repo>`. A game where two characters fight the
same monster and the logs read like a battle report is the demo.

## Architecture (follow this unless it's impossible)

- **Server-authoritative, tick-based.** The server owns the world state and
  advances it on a fixed tick (5–10 Hz). Clients only send intents: "move to
  tile x,y", "attack monster 12", "use skill 3 on target 7", "pick up item
  40". The server validates every intent (is that tile walkable, is the
  target in range, does this character own that item, is it on cooldown)
  and rejects anything invalid. Never trust the client for damage, position,
  inventory or XP.
- **Transport.** Server → client: Server-Sent Events, the same approach the
  old `src/lib/presence.ts` used (heartbeat comments, client reconnects when
  the stream drops, clean up on abort). Client → server: small JSON POSTs
  under `src/pages/api/`. Send per-map deltas, not the whole world, each
  tick. Only switch to WebSockets if SSE genuinely can't do the job, and
  write down why in `PROCESS.md`.
- **Rendering.** A tile grid on a `<canvas>`, top-down or simple isometric,
  click-to-move with A* pathfinding on the client for preview only — the
  server recomputes and validates the path. No game engine, no client
  framework. Keyboard must work too (arrow keys move, a key to attack the
  nearest target), so a pointer is never the only way in.
- **Identity.** No accounts, no login, no email. On first visit the player
  picks a character name; that character is bound to an httpOnly cookie
  (random, unguessable). One browser profile = one character, stable across
  reloads; two profiles = two characters. Identity always comes from the
  cookie on the server, never from anything in a request body.
- **Persistence.** SQLite (`better-sqlite3`, already a dependency) on the
  volume, via `DB_PATH` as today. Persist only what matters across restarts:
  characters, stats, levels, XP, job, skills, inventory, equipment, cards,
  refine levels, zeny, parties, guilds, guild storage, vending stalls.
  Monster positions and HP, and who is online, live in memory and are
  rebuilt on restart (monsters respawn — that's fine and RO-like).
- **Memory budget.** Everything has to fit in 256 MB. Cap monsters per map,
  online players and dropped items, and say what the caps are.
- **Logging is a feature.** Every meaningful server-side event writes one
  structured line to stdout, prefixed by a category, naming characters by
  name plus a short hash of their id (never the raw cookie):
  `[join] Alice#a3f entered Prontera-like town`,
  `[combat] Alice#a3f hit Jelly#12 for 34 (fire vs water x1.5)`,
  `[drop] Bob#9c1 looted Jelly Card`,
  `[reject] Bob#9c1 tried to pick up item 40 owned by Alice#a3f`,
  `[refine] Alice#a3f +6 Sword failed: broke`,
  `[trade] Alice#a3f gave Bob#9c1 2 Red Potions for 50z`.
  Rejections must be logged too: that's how the narrator shows the server
  enforcing the rules. Don't log every movement step; summarise.

## Build in stages

Commit each stage with its tests before starting the next, and keep `main`
deployable after every commit. If you run out of time, stop at the end of a
stage — a finished stage 3 beats a half-built stage 7. Record in `PROCESS.md`
which stages you finished.

1. **Arrive in town together.** Character creation (name, cookie identity),
   one town map, click-to-move and keyboard movement, everyone on the map
   sees everyone else move live, names above heads, chat bubbles, a few
   emotes. Structured logging from this stage on. Replace the old app at `/`.
   The page must still answer 200 and render something meaningful (the town,
   who is here) with JavaScript disabled, even if playing needs a script.
2. **Fight in the field.** A field map joined to town by a warp portal.
   Three monster types with different AI: a passive jelly that also picks up
   loot left on the ground, an aggressive one that chases players in range,
   and one that calls nearby friends when attacked. Server-tick combat with
   attack speed, hit/flee, crits and a small element table (at least
   neutral/fire/water/earth/wind). Base level and job level as two XP bars,
   level-up announcement, HP/SP regen, and a death penalty (lose a small %
   of XP, respawn at the town save point).
3. **Loot.** Drops with rarity, ground items with a short ownership window,
   an inventory with a weight limit based on STR (over 50% stops regen,
   over 90% stops attacking), equipment slots, and cards: a very rare drop
   from each monster that can be slotted into gear for a bonus. One MVP boss
   on a timed respawn with a visible "returns in N minutes" marker; the
   player who dealt the most damage gets the MVP reward, and the server
   announces it to everyone.
4. **Become someone.** Stat allocation (STR/AGI/VIT/INT/DEX/LUK) with a
   rising cost per point, a Novice job, and three first jobs reached by a
   short job-change task: a melee fighter, a caster, and a support/healer.
   Each has a small skill tree (3–5 skills, prerequisites, passive and
   active, cast time interrupted when hit for casters). The healer must be
   genuinely useful to others (heal and a buff), so playing together
   matters.
5. **Party up.** Create/invite/leave a party, see party members' HP, party
   chat, and XP sharing (even split only when members are within a level
   range, else each keeps their own). The server checks every party action
   (only the leader invites/kicks, you can't join a party you weren't
   invited to).
6. **Economy.** NPC shop and zeny; equipment refining +1…+10 with a growing
   chance of breaking the item above a safe level; a player trade window
   where both sides must confirm the same contents (any change resets both
   confirmations); vending stalls a character can open in town that others
   can browse and buy from while the seller stays idle. All money and item
   moves happen in one SQLite transaction, so nothing is duplicated or lost.
7. **Guilds and a second field.** Create a guild, invite/leave, a guild
   storage only members can use (server-checked), guild chat, and a second
   field or dungeon map with its own monsters and a stronger MVP.

Out of scope: guild siege / castle wars, rebirth, pets, marriage, crafting,
mounts, real-money anything, accounts or passwords.

## The multiplayer decision to write down

`README.md` must contain one deliberate decision about what happens when
several people act on the same thing at once, with the options considered
and the cost of the one chosen. Use loot ownership: who gets a drop when two
players fought the same monster, and what happens to unclaimed loot (it
becomes free for all after a few seconds; the looter jelly may eat it). Also
write down, with why, what each player may see and change (other players'
inventories are private; vending stalls and trade windows are the only ways
to give items; party and guild storage rules), since crit 10 asks for that
explicitly.

## What good looks like

- Open the deployed site in two separate Chrome profiles. Both pick names,
  meet in town, walk through the portal and fight the same monster. Damage
  numbers pop on both screens; the drop is claimed by the right player;
  `flyctl logs` tells the whole story without anyone looking at a browser.
- Trying to cheat (posting an attack on a monster across the map, picking up
  someone else's protected item, trading an item you don't own, joining a
  party uninvited) is rejected by the server and shows up as a `[reject]`
  log line.
- It feels like a game: responsive movement, readable hit feedback, a
  satisfying level-up and rare-drop moment, and a world that's more fun with
  two people than one.
- Accessible enough: keyboard play, text for every status (not colour
  alone), AA contrast, and `prefers-reduced-motion` respected for effects.

## Tests

Keep `spec/invariants.test.ts` green. Replace the old specs with tests for
the new rules, run against the running app the same way the existing specs
do (see `spec/global-setup.ts`). At least:

- two clients with different cookies are different characters; a body that
  claims another character's id is ignored;
- the server rejects invalid intents (out of range attack, unwalkable tile,
  item you don't own, skill on cooldown, uninvited party join, guild storage
  by a non-member) with a 4xx and a log line;
- damage, element multiplier and XP math for a known stat setup;
- loot goes to the right player during the ownership window and is free
  after it;
- a trade or vending purchase moves items and zeny atomically, and a failed
  one moves nothing;
- refining above the safe level can break the item, and a forced-success /
  forced-failure seed proves both paths (make randomness injectable for
  tests);
- a character's level, inventory and zeny survive a server restart.

`pnpm check` and `pnpm check:evidence` pass before every commit. Never
commit over a red run.

## Finish

Deploy, then confirm on the live URL with two separate browser profiles that
both characters see each other, fight the same monster, and that
`mise exec -- flyctl logs -a <repo>` narrates it. Update `README.md`
(what the game is, what good means, the multiplayer decision, what's out of
scope) and add a `PROCESS.md` entry covering the stages you finished, the
decisions you made and anything you cut. Delete `prompt.md` in your last
commit and push.
