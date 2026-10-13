# Brief: replace The Scroll with a small shared-world RPG inspired by Ragnarok Online

You're running unattended and nobody can answer questions. When something
isn't covered here, take the smaller, more reversible choice, write down why
in `docs/DECISIONS.md`, and keep going.

## Premise

Ragnarok Online's lasting magic wasn't its stat formulas. It was standing in a
field with friends, a healer keeping a swordsman alive, everyone stopping when
a rare card dropped, and a busy town full of strangers' stalls. Build a small,
original browser game that captures that feeling: a shared world where
playing together is clearly better than playing alone, and where the server
is a fair referee everyone can trust.

## Design pillars

Every decision should serve one of these. When two conflict, the earlier one
wins.

1. **Together beats alone.** Jobs depend on each other: a fighter holds
   monsters, a caster deals damage from behind, a healer keeps both alive. A
   party should clear things a solo player can't.
2. **The server is the referee.** Every outcome — damage, drops, trades,
   levels — is decided on the server. Nobody can cheat, and when two people
   reach for the same thing at once, exactly one consistent thing happens.
3. **Rare moments feel like events.** A card drop, an MVP kill, a +7 refine
   that holds: these get a visible, audible, shared moment, not a silent
   inventory row.
4. **The world feels alive.** Monsters with different temperaments, a jelly
   that eats loot left on the ground, a town where other players' names,
   chat bubbles and stalls are visible.
5. **The logs tell the story.** Someone reading only the server logs can
   narrate who did what to whom.

## What you're allowed to change

You may:

- replace the app in `src/` entirely, and rewrite `README.md` for the new app;
- delete or rewrite `spec/scroll.test.ts` and `spec/lanterns.test.ts`, which
  encode the old brief;
- replace the "Your harness" half of `CLAUDE.md` (everything below the `---`
  line) with rules for the new app.

You must not:

- change the top block of `CLAUDE.md` (above the `---` line);
- break `spec/invariants.test.ts`: `/` answers 200 and `/readme/` serves the
  current `README.md` with its headings in order;
- change the deploy shape in `fly.toml`: one shared-cpu-1x machine, 256 MB,
  one volume at `/data`, no second service (no Redis, Postgres or queue).

## Creative authority

You own the identity: the world's name, the town, the monsters, the three
jobs, the art style, the writing. Early on, sketch two or three short
creative directions (a sentence or two each: tone, palette, what the jelly
and the MVP are), pick one, and record why in `docs/DECISIONS.md`. Don't
spend long on this; one decision, then build.

Don't copy Ragnarok Online sprites, music, maps or trademarked names into this
public repo.

**Art: no ugly vector graphics.** Do not draw the game's characters,
monsters, tiles, items or UI as plain vector shapes (flat SVG circles and
rectangles, canvas-drawn primitives, coloured blocks). That look is
explicitly forbidden. Use proper raster sprite art from CC0 packs instead,
such as Kenney's (<https://kenney.nl/assets>), which are free to use in a
public repo. Pick one coherent pack family so tiles, characters, monsters
and UI share a style, commit the sprites you use under the repo, and render
them with crisp pixel scaling where the art is pixel art. List every asset,
its pack, URL and licence in `docs/ASSETS.md`.

## The brief this is aimed at

The next crit is
<https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/>.
Read it. In short: the app must tell people apart, check on the server what
each person may see and change, and log who did what, server-side, in a way
that outlives the crit. At the crit, two pod members open the URL in separate
Chrome profiles and play while a third narrates only from
`mise exec -- flyctl logs -a <repo>`. Two characters fighting the same
monster, with logs that read like a battle report, is the demo.

## Architecture

- **Server-authoritative, tick-based.** The server owns world state and
  advances each map on a fixed tick (5–10 Hz). Clients send only intents:
  "move to tile x,y", "attack monster 12", "use skill 3 on target 7", "pick
  up item 40". The server validates every intent (walkable tile, target in
  range, item owned, skill off cooldown, rate limit, input bounds) and
  rejects anything invalid with a clear reason.
- **Transport.** Server → client: Server-Sent Events, as the old
  `src/lib/presence.ts` did (heartbeat comments, client reconnects, cleanup
  on abort). Client → server: small JSON POSTs under `src/pages/api/`. Send
  per-map deltas, not the whole world, each tick. Only switch to WebSockets
  if SSE genuinely can't do the job, and record why.
- **Rendering.** A tile grid on a `<canvas>`, top-down or simple isometric,
  click-to-move with client-side A* for preview only; the server recomputes
  and validates the path. No game engine, no client framework. Keyboard play
  must work (arrow keys move, a key attacks the nearest target).
- **Identity.** No accounts, no login, no email. On first visit the player
  names a character and picks a job; the character is bound to an httpOnly,
  unguessable cookie. One browser profile = one character, stable across
  reloads; two profiles = two characters. Identity always comes from the
  cookie, never from a request body.
- **Persistence.** SQLite (`better-sqlite3`, already a dependency) on the
  volume, via `DB_PATH` as today. Persist characters, stats, levels, XP,
  skills, inventory, equipment, cards, refine levels, zeny, parties, guilds,
  guild storage and vending stalls. Monster positions and HP, and who's
  online, live in memory and are rebuilt on restart (monsters respawn).
- **Memory budget.** Everything fits in 256 MB. Cap monsters per map, online
  players and ground items, and write the caps down.

## Multiplayer correctness

These are the rules the referee pillar depends on. Test each one.

- **One mutation at a time per map.** Process each map's intents in order,
  inside the tick, so two intents can't interleave halfway.
- **Races give one outcome.** Two players picking up the same item, buying
  the last unit from a stall, or attacking a monster with 1 HP left: one wins,
  the other gets a clear refusal, and nothing is duplicated or lost.
- **Money and items move atomically.** Every trade, purchase, vending sale,
  refine and storage move is one SQLite transaction. It either fully
  happens or changes nothing.
- **Retries apply once.** Every intent that changes state carries a
  client-generated command id; the server remembers recent ids per
  character, so a resent "buy" or "trade confirm" can't apply twice.
- **Snapshot, then sequenced deltas.** On join or reconnect, the client gets
  a consistent snapshot with a sequence number, then deltas after it. If the
  client sees a gap, it asks for a fresh snapshot. A returning browser never
  overwrites server state with its own copy.
- **Restarts.** State the recovery policy in `docs/DECISIONS.md`: what is
  durable immediately (anything involving items or zeny), what can be lost
  (monster HP, positions), and how clients resynchronise afterwards.

## Logging is a feature

Every meaningful server event writes one structured line to stdout, prefixed
by a category, naming characters by name plus a short hash of their id
(never the raw cookie):

```
[join]    Alice#a3f (Healer) entered town
[combat]  Alice#a3f hit Jelly#12 for 34 (fire vs water x1.5)
[drop]    Bob#9c1 looted Jelly Card
[reject]  Bob#9c1 tried to pick up item 40 protected for Alice#a3f
[party]   Alice#a3f invited Bob#9c1
[refine]  Alice#a3f +6 Sword failed: broke
[trade]   Alice#a3f gave Bob#9c1 2 Red Potions for 50z
```

Rejections are logged too: that's how the narrator shows the server enforcing
the rules. Summarise movement rather than logging every step.

## Build order: the whole loop thin first, then deepen

Don't polish one system while later ones don't exist. Get the full loop
playable early, then make it richer. Commit each pass with its tests and keep
`main` deployable after every commit. If you run out of time, stop at the
end of a pass and record which passes are done in `PROCESS.md`.

**Pass 1 — the whole loop, minimal.** Character creation with a choice of
three jobs (fighter, caster, healer), each with one or two skills. A town
and a field joined by a portal. Live movement, names, chat bubbles, a few
emotes. Three monsters with different AI (a passive jelly that eats ground
loot, an aggressive chaser, one that calls friends when hit). Server-tick
combat with hit/flee, crits and a small element table. Base and job XP, a
level-up moment, death with a small XP penalty and respawn in town. Drops
with a short ownership window, a basic inventory. Party create/invite/leave
with shared XP. Structured logging throughout. The page at `/` must still
answer 200 and show something meaningful without JavaScript.

**Pass 2 — depth.** Stat allocation (STR/AGI/VIT/INT/DEX/LUK) with rising
cost, 3–5 skills per job with prerequisites, cast times that getting hit
interrupts, weight limits (over 50% stops regen, over 90% stops attacking),
equipment slots, rare cards that slot into gear, and one MVP on a timed
respawn whose reward goes to the top damage dealer and is announced to
everyone.

**Pass 3 — economy.** NPC shop and zeny, refining +1 to +10 with a rising
break chance above a safe level, a trade window where both sides confirm the
same contents (any change resets both), and vending stalls in town that
others can buy from while the seller is idle.

**Pass 4 — guilds and a second map.** Guild create/invite/leave, guild chat,
guild storage only members can use, and a second field or dungeon with its
own monsters and a stronger MVP.

**If time is short, cut** (in this order): the second map, guilds, vending,
refining, extra skills, extra monster types, art polish. Cutting art polish
never means falling back to vector shapes: CC0 sprites from the start.
**Never cut:** two players in separate profiles fighting the same monster
together, server-side validation, fair loot ownership, the party, the
structured logs, and the tests for them.

**Out of scope:** guild sieges, rebirth, pets, marriage, crafting, mounts,
accounts or passwords, real money.

## The multiplayer decision to write down

`README.md` must make one deliberate decision about what happens when several
people act on the same thing at once, with the options considered and the
cost of the one chosen. Use loot: who gets a drop when two players fought the
same monster, and what happens to unclaimed loot (free for all after a few
seconds; the jelly may eat it). Also write down, with reasons, what each
player may see and change: inventories are private, trades and stalls are the
only ways to give items, party and guild storage have their own rules. Crit
10 asks for this explicitly.

## Tests

Keep `spec/invariants.test.ts` green. Replace the old specs with tests for the
new rules, run against the running app as the existing specs are (see
`spec/global-setup.ts`). Make randomness injectable so outcomes are testable.

Rules and refusals:

- two clients with different cookies are different characters; a body that
  claims another character's id is ignored;
- invalid intents are refused with a 4xx and a `[reject]` log line: attack
  out of range, unwalkable tile, item you don't own, skill on cooldown,
  uninvited party join, guild storage by a non-member, stale or malformed
  input;
- damage, element multiplier and XP math for a known stat setup;
- loot goes to the right player inside the ownership window and is free
  after it.

Invariants (check these across whole scripted sessions, not just one call):

- total zeny and total item count are conserved across every trade and
  vending sale (only shops, drops and refine breaks create or destroy them,
  and those are counted);
- no item is ever owned by two characters, and no inventory goes negative;
- two players racing for the same item, the last stall unit, or a 1 HP
  monster produce exactly one winner;
- a resent command id applies once;
- each MVP kill gives exactly one MVP reward;
- refining above the safe level can break the item, proven with forced
  success and forced failure;
- a character's level, inventory and zeny survive a server restart.

`pnpm check` and `pnpm check:evidence` pass before every commit. Never commit
over a red run.

## Playtest with bots

Write a small script that runs two to four headless clients against a local
server for several minutes: they walk to the field, fight, party up, loot and
trade. Use it to tune pacing (time to first level-up, time to first rare
drop, how often a solo player dies versus a party) and to catch crashes and
leaks. Record targets and measured results separately in `docs/TESTING.md`,
and say plainly what wasn't tested.

## Keep records

Keep these short and current, and update them at the end of each pass:

- `docs/DESIGN.md`: the world, jobs, monsters, economy, and how the pillars
  show up in play;
- `docs/DECISIONS.md`: each consequential choice and why;
- `docs/TESTING.md`: what was tested, how, and what it showed;
- `docs/ASSETS.md`: every asset and its source;
- `PROCESS.md`: a dated entry per pass, including what you cut.

## Definition of done

A new player opens the URL, names a character, picks a job, and meets a
friend in town. They walk into the field together, fight the same monster,
and see the same damage numbers. The healer keeps the fighter alive, the drop
goes to the right person, and both level up. Someone trying to cheat is
refused and logged. Refreshing restores the character; restarting the server
loses no items or zeny. `flyctl logs` tells the whole story without anyone
looking at a browser.

A landing page, a disconnected prototype or a design document alone is not
done. Aim for a small, complete, fair game first, then make it as rich as time
allows.

## Finish

Deploy, then confirm on the live URL with two separate browser profiles that
both characters see each other, fight the same monster, and that
`mise exec -- flyctl logs -a <repo>` narrates it. Update `README.md` (what the
game is, what good means, the multiplayer decision, what's out of scope) and
the records above. Delete `prompt.md` in your last commit and push.
