# This repo is a pod riff: pods write the prompt, the agent does the work

This repo is a copy of [`comp4020-final-baishi`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-baishi) at
`236607f4` --- baishi's crit agent's final project as it stood at
`08-its-alive`. Their repo is untouched and off limits. From here to the end of
semester, each crit a pod picks this repo up from wherever the last run left
it.

**Pods: the only file you change is `prompt.md`, at the repo root.** Read the
live app, the code and the history, then write the prompt that would take
this app to a strong, interesting answer to the next brief (the crit runsheet
links it). The prompt can point at any file here. After the session,
baishi's crit agent runs `prompt.md` once, unattended, start to finish, and
nobody is there to answer its questions --- so say what you want, what good
looks like and what to leave alone. Push it before you leave.

**Crit agent: when `prompt.md` exists, it is your brief.** Run it to
completion in one go, keep `main` deployable, and delete `prompt.md` in your
last commit. Leave this block of `CLAUDE.md` as it is.

**Nothing here is marked.** No cutoff, no reflection, no `PROCESS.md` entry.
The next crit opens by looking at where each pod repo ended up, beside the
prompt that got it there (the `prompt-crit<N>` tag).

**The agent's own spec tests are `spec/scroll.test.ts`.** They encode the brief it was
working to, and they gate the deploy. A prompt aimed at a different brief can
have them changed or deleted; keep `spec/invariants.test.ts` green, since that
one is true of any good site.

Everything below this line was written for the agent's graded submission. Its
marks, cutoff and weekly skills don't govern this repo: read it for how the
agent was directed, not for what anyone owes.

---

# Your harness

Hollowfield is a small shared-world RPG. `README.md` says what it is and what
good means; these are the rules a change must keep.

## The server is the referee

- Clients send intents to `POST /api/act`; `src/server/world.ts` queues them
  and applies them in order at the start of a tick. Never decide an outcome
  (damage, drops, levels, prices, who won a race) in `src/client/`.
- Every state-changing intent carries a `cmd` id and goes through `submit()`,
  so a resend applies once. Don't add a route that mutates the world outside
  that queue.
- Validate in the handler, then refuse with `refuse(status, reason)`, which
  writes the `[reject]` line. A refusal names the reason a player can act on.
- Anything that moves items or zeny is one `tx()` in `src/server/db.ts`.
  Anything that creates or destroys them also writes a `ledger()` row, so
  `audit()` stays balanced; trades, stalls and storage only move rows.
- Random draws go through `roll()` in `src/server/rng.ts`, never
  `Math.random`, wherever the outcome matters.

## Identity and permissions

- Who you are comes from the `hf_token` cookie only (`src/server/auth.ts`),
  never a request body. The database stores the token's hash.
- Inventories are private (`/api/me` is your own); trades and stalls are the
  only ways items change hands; guild storage is for that guild's members.
  `README.md` "Who may see and change what" is the source; change it there
  first.
- The stream never carries a character id, only `publicId()`, and the logs
  name people as `Name#abc` (`src/server/log.ts`).

## Logs

Every meaningful event is one `log(category, …)` line a narrator can read
aloud: who, what, to whom, the numbers. Summarise movement (map changes, not
steps). Add a line when you add an intent.

## The test route

`src/pages/api/test.ts` fixes dice, places monsters and simulates a restart.
It is off on Fly (`testHooks()` in `src/server/rng.ts`). Never let it run
where real players are.

## What a change must not break

- `fly.toml`'s shape: one machine, 256 MB, one volume, no second service.
  Respect the caps in `CAPS` (`src/game/data.ts`).
- Art is Kenney CC0 raster sprites (`public/sprites/`, listed in
  `docs/ASSETS.md`). No flat vector or canvas-primitive characters, monsters,
  tiles or items.
- `/` answers 200 and shows the world with JavaScript off; `/readme/` serves
  `README.md` (`spec/invariants.test.ts`).
- `pnpm check` passes before every commit, against a server started with
  `DB_PATH` pointing at a scratch file. New rules get a test in `spec/`.
- Keep `docs/` current: `DESIGN.md`, `DECISIONS.md`, `TESTING.md`,
  `ASSETS.md`.
