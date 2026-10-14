# Testing

## The spec

`pnpm check` runs `spec/` against a running server (locally with
`DB_PATH` on a scratch file; in CI, the Docker image with a throwaway
`/data`). The test route fixes the dice, so damage and drops are exact.

- `spec/rules.test.ts` — damage for a known Warden and Ember, element
  multipliers, hit and crit, XP and level-up, party split, death penalty,
  stat costs, refine odds, map connectivity.
- `spec/world.test.ts` — identity (two cookies, two characters; a body
  claiming another character is ignored; no cookie, no access; httpOnly
  cookie never logged); every refusal the brief names returns a 4xx and a
  `[reject]` line; two players damaging one monster, both named in the logs
  and both earning XP; party XP shared with a member who didn't hit; heal;
  cast interruption; weight; death and respawn; loot ownership window; the
  mossling eating free loot; races for one item, one stall unit, one 1 HP
  monster; command-id replay; trade, vending and refine conservation; one
  MVP reward per MVP kill; the ledger balancing across the whole session;
  level, bag and zeny surviving a simulated restart; the no-JS form.
- `spec/invariants.test.ts` — the course's own: `/` and `/readme/`.

The "restart" test simulates one in-process (memory wiped, SQLite kept). A
real process restart was also checked by hand: stop the server, start it,
reload two browsers, and both characters reappeared where they stood.

## In a browser

Two isolated `agent-browser` sessions (no shared cookies) at 1440×900:
created a Warden and an Ember through the real form, walked both to the
fields with arrow keys, made a party through the Party tab and the
click-a-player panel, chatted (bubble shown), and killed a Mossling
together: Warden auto-attack with A, Ember Firebolt with 1. Console clean
in both.

## Bot playtest

`node scripts/bots.ts --url <server> --bots N --minutes M [--solo]` runs
headless players through the same HTTP API and stream a browser uses.

| | Target | Measured |
| --- | --- | --- |
| first level-up | 20–60 s | party 24 s each; solo 19, 20 and 67 s |
| level after 4 min | 3 | party 3/3/3; solo 3/3/2 |
| deaths in 4 min, party vs solo | solo clearly more | party 2, solo 7 |
| first card | 5–15 min of party play | none in 4 min (2% rate; expected ~1 per 8 min at this kill rate) |
| memory, 3 bots | well under 256 MB | 49 MB in the Docker image; ~110 MB RSS for bare node locally |
| server errors | 0 | 0 in every run |

### Runs

- 2026-10-14, pass 1 numbers, 3 bots (Warden, Ember, Mender) in a party,
  3 min, local Docker image: first level-ups at 12 s, all level 5, no
  deaths, 38 kills, 2 trades, 0 server errors, ledger balanced, 49 MB.
  Too fast and too safe.
- 2026-10-14, after retuning (tougher field monsters, XP curve `30 × L²`),
  3 bots for 4 min, party and solo side by side on two fresh servers: the
  numbers in the table. Party and solo level at about the same rate, but a
  solo player dies three to four times as often, and only a party has a
  Mender topping it up between fights. The bots never attempt the MVP; a
  Lv1 party of three can't take it, which is the point of an MVP.

## Not tested

Real touch input; more than a handful of simultaneous players; a slow
network (the tools here can abort requests but not throttle them); a real
Fly machine waking from auto-stop mid-session, beyond the reconnect logic
being exercised by stopping a local server.
