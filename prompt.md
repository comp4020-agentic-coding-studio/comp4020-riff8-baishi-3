# Brief: tell people apart, check it server-side, log it server-side

You're running unattended and nobody can answer questions. When something
isn't covered here, take the smaller, more reversible choice, write down why
in `PROCESS.md`, and keep going.

## Where this picks up

The scroll currently has no notion of a person: every stroke row is
anonymous, and the one identity-shaped thing in the codebase — a lantern's
random per-tab id in `src/lib/presence.ts` — is deliberately throwaway,
in-memory, never logged, and scoped to presence only. `README.md` already
names this as left open on purpose ("multi-user identity... [is] later
crits' scope"). This crit is that later crit.

The next crit's brief (read it in full, it's the actual spec you're building
to):
<https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/>

Its spec, restated for what that means here:

1. The app is multi-user by that brief's definition: two or more people, each
   in their own browser, act on shared state, and the app tells them apart.
2. What each person may see and change is checked **on the server**, and that
   decision is written down in the repo with why.
3. The app logs who did what, server-side, and that logging outlives the
   crit (so it's still there if someone deploys again next week).
4. At the actual crit, two pod members will use the deployed URL from
   **separate Chrome profiles** (no shared cookies/storage between them)
   while a third narrates from `flyctl logs` alone — no clicking through the
   UI to explain what happened. Build for that: the logs have to be legible
   enough, and name the two people distinctly enough, that a narrator who
   wasn't at the keyboard can read a story off them.

## What to build

1. **A real per-visitor identity, server-side.** Give every visitor a
   long-lived, anonymous identity — a signed or random cookie-backed id is
   enough; no login, no account, no email. One id per browser profile,
   stable across reloads, distinct across profiles. This is not the
   lantern id: lanterns stay exactly as they are (anonymous, in-memory,
   presence-only, per-tab) — don't merge the two or route one through the
   other. The new identity is for marks and logs; lanterns are for light.

2. **Attribute every stroke to its visitor, checked server-side.** Add a
   column to the `strokes` table (a new migration-shaped `CREATE TABLE IF
   NOT EXISTS`, following `db.ts`'s existing style — don't break existing
   rows, which have no visitor id and should read as anonymous/legacy, not
   be backfilled with a guess) holding that visitor id. `POST
   /api/strokes` resolves the visitor from the request's own identity
   (the cookie), never from anything the client's JSON body claims — the
   same rule `CLAUDE.md` already states for path length and width.

3. **Decide, and enforce server-side, what a visitor's own identity actually
   gates.** This app has very little to gate — there's no edit or delete to
   restrict (and there must never be: see `CLAUDE.md`'s no-delete rule,
   unchanged by this crit) — so the honest answer may be "not much *changes*
   this crit, but it has to be true going forward." At minimum: a visitor
   can distinguish *their own* marks from everyone else's when looking at
   the page (e.g., a `?mine` affordance or equivalent, server-rendered, not
   a client-side guess from local storage) without that requiring any new
   client-sent identity claim the server has to trust. If you decide
   something more is worth gating (e.g., the existing "one mark per visit"
   judgement call in `README.md` could now be enforced, since there's
   finally a real notion of a visitor) — that is explicitly allowed by this
   brief and arguably the more interesting answer, but it is your decision
   to make and argue for in `README.md`'s "what good means" section, not a
   quiet default. Whichever you choose, write down in `README.md` *why*,
   the way every other enforced rule there is justified.

4. **Server-side logging that outlives the crit.** Every stroke write and
   every rejected write should produce a structured server-side log line
   (stdout is fine — that's what `flyctl logs` reads) naming: a short,
   stable, human-distinguishable identifier for the visitor (not the raw
   cookie value — hash or truncate it the way `presence.ts` already hashes
   lantern ids for the stream, so a leaked log line doesn't hand out a
   working identity), what happened (accepted / rejected and why), and
   enough about the stroke (not its full path data — that's noise) to
   narrate from. This needs no new service, no new table beyond the one
   column above: `console.log` on the already-running Node process is
   "logging that outlives the crit" as long as Fly keeps serving requests,
   which it does. Say in `PROCESS.md` what you chose to log and why that's
   enough for a narrator with no other context to tell two visitors apart
   from the log alone.

## What good looks like

- Open the deployed site in two separate Chrome profiles. Draw a mark in
  each. `mise exec -- flyctl logs -a <this-repo-name>`, tailed live, shows
  two distinguishable lines, one per profile, without needing to look at
  the browsers at all.
- A mark made in one profile is still visible to the other profile on
  reload (this doesn't change — marks were never live) but each page can
  now tell you which marks were *yours*, from that profile's own cookie,
  checked server-side.
- Nothing here requires an account, a login screen, or a name. "Tell people
  apart" is satisfied by a stable anonymous identity, the same spirit as
  the lantern id, just persistent and attributed instead of throwaway and
  presence-only.

## Tests

`spec/scroll.test.ts`, `spec/lanterns.test.ts` and `spec/invariants.test.ts`
all stay green; add to them, don't weaken them. Add tests that would fail
without this work, for example:

- two requests with different visitor cookies produce strokes attributed to
  different ids, and a request with no cookie yet gets one assigned
  (check the `Set-Cookie` behaviour, not just the stored row);
- the server resolves the visitor from its own cookie/session even if the
  request body includes a claimed id, and the claimed id is ignored;
- a stroke write produces a log line (capture `console.log` in the test, or
  expose a small hook if that's cleaner) naming the visitor and the
  outcome;
- whatever your README decision in step 3 turns out to gate, has a test
  that fails without the gate and passes with it.

`pnpm check` and `pnpm check:evidence` pass before every commit. Never
commit over a red run.

## Leave alone

- The no-edit, no-delete, no-overpaint rules in `CLAUDE.md`, and the
  `zoneBounds` check — nothing about identity changes any of this.
- Lantern presence (`src/lib/presence.ts`, `src/pages/api/lanterns.ts`):
  stays anonymous, in-memory, per-tab, unlogged, exactly as it is. Do not
  give a lantern a persistent identity or route it through the new visitor
  cookie.
- One SQLite file, one volume, one machine (`fly.toml`) — a visitor table
  or column is still "one table, one file," not a second service.
- Accounts, login, email, chat, reactions, analytics dashboards. "Tell
  people apart" is satisfied by an anonymous persistent id; nothing here
  asks for more than that.
- The no-JS rendering of `/` and `/readme/` — identity and the "mine" view
  (if you build it) should degrade sensibly without JavaScript too (a
  server-rendered cookie check doesn't need a script to work), not require
  it.

## Finish

Deploy, and confirm on the live URL, from two separate browser profiles,
that each profile's marks are attributed to a distinct, stable id and that
`flyctl logs` narrates the difference without needing to look at either
browser. Add a `PROCESS.md` entry covering the decisions you made —
especially what you chose to gate in step 3 and why — then delete
`prompt.md` in your last commit and push.
