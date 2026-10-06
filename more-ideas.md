# More ideas: making The Scroll multi-user

Ten ideas for taking The Scroll from one visitor's experience to a live,
shared one, all kept inside the constraints in `CLAUDE.md` and `README.md`:
no accounts, no edit or delete, the view works without JavaScript, one SQLite
file, and the keyboard reaches drawing wherever a pointer does.

| # | Idea | What it is | Why it's interesting | Fit with the constraints |
|---|------|------------|----------------------|--------------------------|
| 1 | **Live ink (SSE)** | Other people's strokes appear as soon as they're saved, over one Server-Sent Events stream. | The scroll stops being a page you reload and becomes something happening. | One process, no new service; the no-JS view still renders saved marks. |
| 2 | **Ghost brushes** | While someone is mid-stroke, everyone else sees a faint brush tip moving in that person's strip. | You watch a stranger paint in real time, which is the "all at once" feeling. | Ephemeral and never stored; nothing is written until the mark is saved. |
| 3 | **Strip reservation** | Opening the page claims the next free strip for a short time (e.g. 3 min) under an anonymous per-visit token. | Two people at once get two different strips, replacing the "reload, you lost" stopgap. | Token only, no login; marks still stay inside `zoneBounds`. |
| 4 | **Presence as ink drops** | "3 people are holding a brush right now" is shown as small ink dots by the header. | You can feel others are there without avatars, names or a social feed. | No identity is shown or stored. |
| 5 | **Anonymous seals** | Each visit token gets a small generated hanko-style red seal stamped under its mark. | Shows "a different hand made this" without saying whose. | Derived from the token, not from an account; nothing editable. |
| 6 | **One mark per visitor** | A signed cookie token; after your mark the zone says "you've left yours, come back tomorrow" and the server refuses a second one. | Makes the README's promise real instead of trusted. | Validated server-side in `src/pages/api/strokes.ts`, testable in `spec/`. |
| 7 | **Call and response** | Your strip shows a faint echo of the previous mark's edge, prompting "continue their line". | Turns separate marks into a conversation along the scroll. | The echo is only a guide; your ink still can't leave your strip. |
| 8 | **Replay** | A "watch it grow" button replays the scroll mark by mark in timestamp order. | Shows the scroll as many people's work over time. | Read-only, built from `created_at`; the static view is unchanged without JS. |
| 9 | **Ink of the hour** | Ink tone depends on the time of day the mark was made (dawn grey to midnight black). | Visitors at different hours leave visibly different layers, with no settings. | Computed from `created_at`; no user choice, no new table. |
| 10 | **Gathering moments** | When 3 or more people draw at once, their strips get a shared subtle wash on the saved scroll. | A permanent record that these marks were made together. | Additive marking only; no existing mark is changed. |

## Strongest set for crit 9 ("All at once")

**1, 2, 3 and 6** together tell one story: you can see others drawing, you
never collide with them, and "one mark per visit" is finally enforced.
