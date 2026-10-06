# Brief: make The Scroll something people share, across time and in the moment

You're running unattended and nobody can answer questions. When something
isn't covered here, take the smaller, more reversible choice, write down why
in `PROCESS.md`, and keep going.

## What to build

Build the three ideas fully described in **`fixed-idea.md`**. Read it all
first: it is the spec for *what* each idea is and what "good" looks like, and
its open questions are yours to decide (record each decision in `PROCESS.md`).
`more-ideas.md` is background only; don't build anything else from it.

Build them in this order, and commit each one (with its tests) before
starting the next, so `main` is deployable after every step:

1. **Call and response (idea 7).** The blank strip shows a faint, clearly
   not-ink echo of the part of the previous mark closest to the shared edge,
   inviting the visitor to continue it. Server-rendered, so it's identical
   with JavaScript off. No echo when the previous mark doesn't come near the
   edge, or when there is no previous mark.
2. **Replay (idea 8).** A "watch it grow" control that replays the marks in
   `created_at` order, paced so short and long scrolls are both watchable
   (real gaps, capped, is a fine starting point). Strictly read-only. The
   control only appears when the script has loaded; without JavaScript there
   is no dead button. Starting to draw cancels a replay.
3. **Lantern viewing.** With the script running, the scroll is dark except
   where lanterns light it: yours, and those of everyone else on the page
   right now, shown live. Your own drawing strip is always lit, and a dim
   ambient glow means it's never pitch black. Without JavaScript the scroll is
   fully lit, exactly as today. Include a visible "Light the whole scroll"
   switch, arrow keys to move your own lantern, and steady (non-drifting)
   lanterns under `prefers-reduced-motion`.

## How lantern presence should work

This is the one real-time piece, and `README.md` says real-time sync is this
crit's decision. So **first** add a short section to `README.md` that makes
the decision: what is live (lantern positions only), what is not (marks still
appear on reload; don't build live ink), and why that's the smallest version
of "all at once" that fits the piece. Then build it:

- One Server-Sent Events endpoint and one small POST endpoint under
  `src/pages/api/`, in the same Node process. Presence is held **in memory
  only**: no new table, no new column, no queue, no cache, no second service.
  Nothing about where anyone looked is ever written to disk or logged.
- Each tab gets a random, anonymous id for the life of the tab. No cookie
  identity, no account, and nothing shown that identifies a person. Lanterns
  are only soft light: no names, colours, labels or arrow cursors.
- Positions are in scroll (SVG) coordinates, so a lantern lights the same ink
  for everyone at any window size or scroll position.
- The server validates position messages like any other input: correct
  shape, numbers in range of the current scroll, rate-limited per id (about
  10/second). A lantern silent for about 10 seconds fades out for everyone.
- In-memory presence only works on one machine. Check `fly.toml` and make
  sure the app can't scale to two machines that would each hold half the
  room (the single SQLite volume already implies one). Write in `PROCESS.md`
  what you checked.
- The SSE stream has to survive Fly's proxy: send a heartbeat comment
  periodically and reconnect on the client when it drops.

## What good looks like

- Open the deployed site in two windows side by side. Moving in one makes a
  warm light drift across the other and reveal ink that was dark a moment
  ago. That is the demo; if it doesn't feel a little magical, tune the size,
  softness and fade until it does.
- A first-time visitor understands the echo in their strip without a label,
  and the replay feels like something growing, not a slideshow.
- It still looks like ink on paper. Keep the existing palette, light and dark
  schemes, and AA contrast; ink inside a lantern meets the same contrast
  targets as today.

## Tests

`spec/scroll.test.ts` and `spec/invariants.test.ts` both stay green; add to
them, don't weaken them. Add tests that would fail without each feature, for
example:

- the echo is in the server-rendered HTML when the previous mark reaches the
  edge, and absent when it doesn't or there is no previous mark;
- the no-JS page has no replay control and no darkness overlay;
- the lantern POST rejects bad shapes, out-of-range coordinates and floods,
  and a valid one shows up on the SSE stream;
- no new statement in `src/lib/db.ts` writes presence, and no
  `UPDATE`/`DELETE` exists anywhere.

`pnpm check` and `pnpm check:evidence` pass before every commit. Never commit
over a red run.

## Leave alone

- The no-edit, no-delete, no-overpaint rules in `CLAUDE.md`, and the
  `zoneBounds` check.
- Accounts of any kind, "one mark per visitor" enforcement, live ink, chat,
  reactions, heatmaps or analytics.
- `fixed-idea.md`, `more-ideas.md`, and the top block of `CLAUDE.md`.
- The no-JS rendering of `/` and `/readme/`.

## Finish

Deploy, and confirm on the live URL that two windows see each other's
lanterns and that `/` still renders every mark with JavaScript off. Add a
`PROCESS.md` entry covering the decisions you made, then delete `prompt.md`
in your last commit and push.
