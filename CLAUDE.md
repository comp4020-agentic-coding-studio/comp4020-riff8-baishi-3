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

The rules below are derived from `README.md`'s argument, not separate from
it: if a rule here doesn't trace back to a sentence there, it doesn't belong
in either.

## What the app must never do

- **Never delete or edit a saved mark.** `src/lib/db.ts` has no update or
  delete statement, and none should be added — not even for moderation. If
  a mark ever needs removing, that's a decision to argue for in
  `README.md` first, with a real mechanism (who can, and why), not a quiet
  admin route. Overpainting is erasing too: a new mark's path, halo
  included, stays inside its own zone (`zoneBounds` in `src/lib/layout.ts`).
- **Never require an account to draw or to view.** Identity, when it
  arrives (crit 9), should be the minimum that makes "multi-user" true —
  an anonymous per-visit token at most — never a login.
- **Never trust the client for anything `spec/` can check.** Path length,
  stroke width, request shape: validate in the data layer
  (`src/pages/api/strokes.ts`), the same place the promise is tested, not
  just in `draw.ts`.

## What every page holds to

- The page that shows the scroll (`/`) must render the existing marks and
  answer 200 with JavaScript disabled. Only the act of drawing needs a
  script — and within that, a pointer is never the only way in: the
  drawing zone is a real focusable control, not just a hit-tested shape,
  so Enter/Space works wherever a pointer does.
- `/readme/` always serves the current `README.md` in full, headings
  intact — `spec/invariants.test.ts` checks this; don't special-case it
  away.

## What a change must not break

- One SQLite table, one file, one volume. If a change needs a second
  service (a queue, a cache, a second database), that's a bigger decision
  than this file should wave through — raise it in `PROCESS.md` first,
  with the trade-off named.
- `pnpm check` and `pnpm check:evidence` pass before every commit. A red
  run never gets committed over.
- Every commit that changes behaviour has a test in `spec/` that would have
  failed without it, where the behaviour is the kind a test can hold —
  see `spec/scroll.test.ts` for the shape (persistence, validation,
  no-delete) established this crit.

## What's live, and what must stay out of it

`README.md`'s "All at once" section decides it: only lantern positions are
live. Presence lives in `src/lib/presence.ts`'s memory and nowhere else —
never a table, a column, a log line or a second service, and a tab's own
id never goes out on the stream. Marks still arrive on reload; live ink is
a new decision for `README.md`, not a quiet extension of the stream.

## Left open on purpose

Multi-user identity and rate-limiting "one mark per visitor" are not bugs
to fix — they're later crits' scope, named as such in `README.md`. Don't
build ahead of the crit that's supposed to decide them.
