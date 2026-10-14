# Decisions

Each consequential choice, and why. When something wasn't covered by the
brief, the smaller, more reversible option won.

## Creative direction

Three sketches, one picked:

1. **Hollowfield** (picked). An autumn farming village at the edge of amber
   fields and an old barrow. Warm greens and oranges from Kenney's Tiny Town,
   people and monsters from Tiny Dungeon. The jelly is the Mossling, a
   slime that eats unclaimed loot; the MVP is the Ember Crab, a fire crab
   that hates water. Gentle tone, small stakes, Ghibli-ish.
2. **Saltmarsh.** A fishing harbour under grey skies; the jelly is a
   tide-pool blob, the MVP a drowned lighthouse keeper. Moodier, but Kenney
   has no matching harbour tileset at 16px, so it would mean mixing packs.
3. **Ashgrave.** A frontier keep at the edge of a burnt forest; the jelly is
   an ash mote, the MVP a charred treant. Harsher, but grimness fights the
   "standing in a field with friends" feeling the brief opens with.

Hollowfield won because the two Tiny packs already make it, as one coherent
family, and its tone matches the premise.

## Stack

- **Astro on Node, as before.** The repo already deploys this way; the game
  needs a server, two pages and JSON routes, which Astro gives without a
  framework on the client. The client is plain TypeScript bundled by Astro.
- **SSE, not WebSockets.** Server-to-client is the only stream the game
  needs; intents are rare enough (a few per second at most) that a POST each
  is fine. SSE works through Fly's proxy with no upgrade handling, reconnects
  by itself, and the old presence code already proved it here.
- **One tick, 5 Hz.** Fast enough that click-to-move feels responsive with
  client-side interpolation; slow enough that a shared-cpu-1x machine runs
  three maps with room to spare. Every queued intent is applied at the start
  of a tick, in arrival order, across all maps. One global queue is simpler
  than per-map queues and gives the same guarantee (no two intents
  interleave) since Node is single-threaded.
- **better-sqlite3, no ORM.** Synchronous transactions are exactly what
  "one mutation at a time" wants: a transaction can't be interrupted by
  another request halfway.

## Identity

A random 32-byte token in an httpOnly, SameSite=Lax cookie; SQLite holds its
SHA-256. Identity is never read from a body. The stream and the logs use two
different derived ids (`publicId` for the stream, a 3-hex `shortHash` for log
lines) so neither reveals the character id. "Start over in this browser"
just deletes the cookie; the old character stays in the records.

## Loot

Top damage dealer owns drops for 6 seconds, then they're free; unclaimed
drops expire after 60 seconds, and looters (Mosslings, Grave Jellies) eat
free drops within 6 tiles. See `README.md` for the options and the cost.

## Restarts: what survives

- **Durable immediately:** anything involving items or zeny (every pickup,
  trade, sale, refine, storage move, MVP reward), party and guild
  membership, stat and skill choices, stall contents. These are written in
  the intent's own transaction before the client hears "ok".
- **Durable within 10 seconds:** XP, level, HP/SP, position. Saved on level
  up, death, map change, logout and every 10 s otherwise. A crash can lose a
  few seconds of XP or walking, never an item.
- **Lost by design:** monsters (positions, HP, damage tallies), ground loot,
  pending invites, open trade windows (nothing has moved until both
  confirm), cast bars, buffs, cooldowns, recent command ids.
- **Resync:** the client's EventSource reconnects (reopening by hand after a
  non-200 answer, which plain EventSource gives up on), receives a fresh
  snapshot with a new sequence number, and redraws. A client that sees a gap
  in sequence numbers asks for a fresh snapshot the same way. The client
  never sends its own state back.

## Caps (256 MB)

`CAPS` in `src/game/data.ts`: 20 monsters per map, 60 ground items per map
(the oldest crumbles first), 60 players online, parties of 6, guilds of 20,
8 lines per stall, 120-character chat. Each command id is remembered for the
last 200 intents per character. A character with no open stream for 20 s is
saved and dropped from memory. Measured RSS under the bot playtest is in
`TESTING.md`.

## Test hooks

`/api/test` fixes dice, spawns monsters and simulates a restart so the spec
can assert exact outcomes. It is on unless `FLY_APP_NAME` is set (Fly sets it
on every machine) or `TEST_HOOKS=0`. CI's container runs without
`FLY_APP_NAME`, so the spec works there without editing the course workflow;
production answers 404.

## Rate limits

Twelve intents a second per character, bursting to 30. Held arrow keys send
about five a second, so a person never meets the limit; a script does.

## Numbers

Monster stats, XP curve (`20 × level^1.8`), refine odds (safe to +4, then
60/50/40/30/20/10%) and drop rates (2% for a card) were set by hand, then
checked against the bot playtest (`TESTING.md`).

## Sprites stay PNG

The course's media rule prefers AVIF, but these sheets are 5 KB indexed PNGs
whose pixels must survive exactly; a lossless AVIF of them came out three
times larger and didn't round-trip pixel-for-pixel. They stay as Kenney
ships them.
