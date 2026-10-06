# Fixed ideas: 7 (Call and response), 8 (Replay) and Lantern viewing, fleshed out

`more-ideas.md` gives each of these one line. This fills in what they
actually are, why they'd be worth building, and what "good" looks like for
each — without prescribing the implementation. Both are read-only
descriptions of marks that already exist, so neither needs a new table, a
new service, or an account.

---

## Idea 7: Call and response

**The one-liner:** "Your strip shows a faint echo of the previous mark's
edge, prompting 'continue their line'."

**What it's really getting at:** right now, every visitor's strip is an
island. You draw into a blank rectangle that has no relationship to the
mark next to it — the scroll grows, but nothing about the drawing moment
itself suggests the marks are in conversation. Call and response is about
making the *drawing itself* feel like a reply, not just the finished scroll
looking like a sequence. The moment a new visitor arrives, the zone they're
about to draw in should already feel like it's mid-sentence — like
something is reaching toward them from the edge of the previous mark,
waiting to be continued.

**What "good" looks like:**
- The echo has to be unmistakably *not ink*. It's a prompt, not a mark —
  faint enough that nobody mistakes it for something already drawn, but
  present enough to actually change what a visitor draws. If people ignore
  it and draw whatever they were going to draw anyway, the idea hasn't
  landed.
- It should only show up near the shared edge between strips — the part of
  the previous mark that's physically closest to the new blank zone. A
  mark that stayed in the centre of its own strip, nowhere near the edge,
  has nothing to hand off; the honest move there is to show no echo at
  all, not to invent one from the wrong part of the stroke.
- The "continue their line" framing should feel literal: the echo's
  direction and position should make the suggested continuation obvious
  without instructions. A good test is whether a first-time visitor, with
  no label at all, would still understand they're meant to pick up where
  the ghost shape leaves off.
- It's a purely visual nudge — it must never constrain what someone
  actually draws, or be checkable/enforceable. Nobody is penalised for
  drawing something unrelated. The promise this app already makes (a mark,
  once made, is final and inside its own strip) doesn't change at all;
  this only changes what the empty strip *looks like* before anyone
  touches it.
- Because it's static — computed from a mark that's already saved — it
  belongs to the page's no-JS rendering, not to the drawing script. A
  visitor with JavaScript off should see exactly the same echo a visitor
  with it on does; only the act of turning the echo into a submitted mark
  needs a script, same as today.

**Open questions worth deciding before building it:** how faint is faint
enough — does it need user testing, or is a fixed low opacity an acceptable
guess? Does the very first strip (nothing precedes it) need its own
treatment, or is "no echo" the right answer there too? Should the prompt
text next to the zone change when there's something to continue, or does
the visual alone carry it?

---

## Idea 8: Replay

**The one-liner:** "A 'watch it grow' button replays the scroll mark by
mark in timestamp order."

**What it's really getting at:** the scroll, as it stands, only ever shows
its *current* state — one flat image, however many hands made it. There's
no way to feel the time that passed, the order people arrived in, or the
fact that this was built by many separate visits rather than one. Replay is
about surfacing the thing the database already knows (`created_at` on every
mark) that the page currently throws away the moment it renders: the scroll
has a history, and watching it unfold is a different experience from seeing
the end result. It's the idea that turns "many people's work" from a fact
you're told (the tagline) into a fact you can watch happen.

**What "good" looks like:**
- It needs to feel like *watching something grow*, not like a slideshow.
  The pacing matters more than the mechanism: too fast and it's just a
  flicker that proves nothing; too slow and nobody waits for a scroll with
  more than a handful of marks. A long scroll and a short one should both
  feel watchable — which likely means the pacing adapts to how many marks
  there are, rather than a fixed delay per mark regardless of count.
- It's entirely optional and entirely harmless to skip. Nobody has to
  press the button to get the real experience of the page; the scroll
  fully drawn, as it is today, is still the resting state, both before and
  after a replay finishes.
- It must stay strictly read-only: nothing about pressing it writes
  anything, changes anything in the database, or changes what a later
  visitor sees. Running it twice, or never, leaves the scroll identical.
- It should answer the "many people, over time" question honestly. If the
  underlying order isn't really meaningful (say, every mark happened to be
  made in the same ten minutes once), the feature shouldn't dress that up
  as more dramatic than it was — the value is in showing the *true* order
  and pace, not in manufacturing suspense.
- Since it's an optional, decorative replay of marks that already exist in
  the static page, it sits squarely in the territory that needs a script
  (like drawing already does) — but unlike drawing, there's no reason it
  should ever appear as a control that doesn't work. A visitor without
  JavaScript should see the finished scroll exactly as they do today and
  never be shown a button that does nothing when pressed.

**Open questions worth deciding before building it:** does replaying ever
need to stop or be interrupted (a visitor starts drawing mid-replay —
should that cancel it)? Is per-mark timing proportional to the real gaps
between `created_at` values (capped, so a week-long gap doesn't freeze the
replay), or is a flat per-mark pace honest enough? Does the button deserve
a place in the main flow, or is it clearly secondary to drawing and
belongs tucked near the tagline/README link instead?

---

## Why these two, together

Both ideas are additive and non-destructive in the strictest sense `CLAUDE.md`
cares about — neither one can overpaint, edit, or delete a mark, and
neither needs the view to know who anyone is. They also pair well
narratively: call and response makes each *moment* of drawing feel
connected to the last person; replay makes the *whole scroll* feel like it
happened over time rather than all at once. Between them they're a answer
to "all at once" that doesn't require solving real-time sync, identity, or
rate-limiting at all — the three things `more-ideas.md` and `CLAUDE.md` both
flag as later crits' scope, not this one's.

---

## Idea: Lantern viewing

**The one-liner:** "The scroll is dark. Every visitor who's online carries a
small lantern, their cursor or finger, and the ink only shows where light
falls. Alone you see a little; with a crowd the whole scroll glows."

**What it's really getting at:** call and response and replay both connect
marks across *time*. Lantern viewing connects the people looking at the
scroll *right now*. Today, ten visitors on the page at once see exactly what
one visitor sees, so being there together changes nothing. With lanterns,
presence becomes the light you see by: other people's lanterns light marks
you'd otherwise miss, and the scroll can only be seen in full together. This
is the one idea of the three that answers "all at once" literally rather
than around it, so it does need live presence. But it never touches a stored
mark.

**What "good" looks like:**
- Open the site in two windows side by side. Moving the pointer in one makes
  a warm, soft light drift across the other, revealing ink that was dark a
  moment ago. If that moment doesn't feel a little magical, the idea hasn't
  landed.
- A lantern is just light: no name, no colour-coding, no arrow cursor, no
  label. Nobody can tell who is who, which keeps the README's "no accounts,
  nothing that's 'yours'" stance.
- Lanterns only change what you *see*, never what's *stored*. Nothing about
  them is written to the database, and where people looked is never
  recorded (no heatmaps).
- Your own drawing strip is always lit, so nobody ever has to draw in the
  dark. When nobody's online, the scroll keeps a faint ambient glow: dim,
  never pitch black.
- The darkness is added by the script, so the no-JS page is the fully lit
  scroll, exactly as it is today, and `spec/invariants.test.ts` stays green.
- There's a visible "Light the whole scroll" switch for anyone who needs to
  see everything (low vision, magnifiers, or just curiosity). Under
  `prefers-reduced-motion`, lanterns sit as steady pools rather than
  drifting or flickering. Arrow keys move your own lantern.
- Live presence is the one moving part this needs. It should stay inside
  the single process, with no queue, cache or second service, and the server
  should range-check and rate-limit lantern positions like any other input.
  If it can't be done that small, that's a trade-off to record in
  `PROCESS.md` before building, per `CLAUDE.md`.

**Open questions worth deciding before building it:** how big is a lantern,
and does it shrink as more people arrive so the crowd effect still reads?
Does a lantern follow your pointer only while it's over the scroll, or sit
where you last left it? How long after someone goes quiet should their
light fade: a few seconds, or long enough to feel like they're still there?
And does lantern viewing replace the always-lit resting state, or is it a
mode you step into?
