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

The "restart" test simulates one in-process (memory wiped, SQLite kept, open
streams closed). Real restarts were checked by hand too: a shop purchase
followed immediately by `kill -9` on the server kept the zeny spent and the
potion bought; two browsers left open across a restart reconnected and
showed both characters where they stood; an open vending stall survived and
was still buyable.

All 50 specs also pass against the Docker image CI builds, run the way
`checks.yml` runs it (`docker run --tmpfs /data`); and the same image with
`FLY_APP_NAME` set answers 404 on the test route.

## In a browser

Found this way and fixed (none of them a spec failure): the no-JS form's
500, characters landing on the same tile, names drawn under sprites, a
stall's seller intercepting the click for the stall, the trade window's ×
leaving the trade open, the MVP banner spilling over the side panel, and a
tab never resyncing after a restart.


Two isolated `agent-browser` sessions (no shared cookies) at 1440×900:
created a Warden and an Ember through the real form, walked both to the
fields with arrow keys, made a party through the Party tab and the
click-a-player panel, chatted (bubble shown), and killed a Mossling
together: Warden auto-attack with A, Ember Firebolt with 1. Console clean
in both.

## Bot playtest

`node scripts/bots.ts --url <server> --bots N --minutes M [--solo]` runs
headless players through the same HTTP API and stream a browser uses.

Latest numbers (5 min, 3 bots: Warden, Ember, Mender; party and solo side
by side on two fresh local servers):

| | Target | Party | Solo |
| --- | --- | --- | --- |
| first level-up | 20–60 s | 19, 23, 23 s | 23, 24 s; the Mender never levelled |
| level after 5 min | 3 | 3, 3, 3 | 3, 3, 1 |
| kills | party more | 36 | 28 (Mender: 1) |
| deaths | solo more | 1 | 3 |
| first card | within 15 min | 47 s (lucky) | none |
| trades completed | some | 7 | n/a |
| server errors | 0 | 0 | 0 |
| ledger balanced | always | yes | yes |
| node RSS | well under 256 MB | 113 MB | 108 MB |

The earlier 10-minute, 4-bot run (below) reached 118 MB RSS from 79 MB at
start, with no growth trend worth chasing on a world this size.

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
- 2026-10-14, 4 bots, 10 min: first card at 118 s, 96 kills, 4 trades, no
  server errors, ledger balanced, RSS 79 → 118 MB. But 75 deaths: 37 to
  the Ember Crab, whose 5-tile aggro range reached the middle of the field,
  and most of the rest to bots fighting on with no potions. Fixes: the MVPs'
  aggro range is now 3 and they leash at 6 tiles from their lair; the bots
  retreat to regenerate when low with no potions (a player would).
- 2026-10-14, after those fixes, the table above.

## Not tested

The live Fly deployment: this run doesn't deploy (CI deploys the pod's app
when the harness pushes), so the two-profile check on the live URL and
`flyctl logs` narration are for the crit itself.

Real touch input; more than a handful of simultaneous players; a slow
network (the tools here can abort requests but not throttle them); a real
Fly machine waking from auto-stop mid-session, beyond the reconnect logic
being exercised by stopping a local server.
