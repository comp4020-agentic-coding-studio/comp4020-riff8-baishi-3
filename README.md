# The Scroll

A shared ink drawing that only ever grows. Visit, and there's a blank strip
waiting at the right-hand edge of whatever everyone before you has drawn.
Leave one mark there — a line, a dot, whatever the brush does under your
hand — and it's part of the scroll from then on. Nobody can undo it,
including you.

## What good means here

Good, for this app, means **small on purpose**. Not small because it isn't
finished yet, but small as the actual design: one shared surface, one mark
per visit, nothing that scales past what a single SQLite file and a single
small machine can hold. Three things I read while deciding what that should
look like:

- Robin Sloan's
  [_An app can be a home-cooked meal_](https://www.robinsloan.com/notes/home-cooked-app/)
  argues that software built for a small, specific, known use doesn't need
  the affordances — accounts, growth, retention — that software built to
  scale needs. The Scroll has no login and no notion of "your" marks once
  they're made, because nothing here is trying to bring you back for a
  streak.
- Ben Hoyt's [_The small web is beautiful_](https://benhoyt.com/writings/the-small-web-is-beautiful/)
  argues for fewer moving parts as a virtue in itself, not just a
  constraint: one table, one process, one file on one volume. There's no
  queue, no cache, no second service.
- Hundred Rabbits'
  [description of their own practice](https://sourcehut.org/blog/2021-12-08-100-rabbits-interview/) —
  "if we can use less technology to solve any one task, we will" — is the
  standard I held the drawing itself to: one SVG path per mark, one write,
  no client-side framework.

What's **enforced**: a mark, once saved, is never edited or deleted (there
is no code path that can — see `CLAUDE.md`), and nor can a later one paint
over it, since every mark has to stay inside its own strip, soft edge and
all; every write is validated server-side regardless of what the client
sends (`spec/scroll.test.ts`); the page that shows the scroll works without
JavaScript, since drawing is the only part that genuinely needs a script;
and drawing itself doesn't require a pointer — the zone is a real focusable
control, and Enter or Space leaves a dot at its centre, the same shape a
stationary tap already produces.

What's **judged, not enforced**: nothing stops a visitor from reloading and
drawing a second mark, or a tenth. Enforcing "one mark per person" needs a
real notion of a person, which is next crit's job (multi-user identity, [All
at once](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/09-all-at-once/)).
Two visitors who load the page at the same moment are offered the same blank
strip; whoever saves second is told to reload and draw in the next one,
rather than drawing on top of the first. Refusing is the honest stopgap
until then. For now the scroll trusts you the way a paper one would: nothing
stops you picking up the brush twice, and not doing so is part of what the
piece asks of you.

What I deliberately **didn't build**: accounts, undo, a gallery of past
scrolls, likes, moderation tooling. Ink-wash painting tolerates the mark
that goes wrong, and a scroll that lets you take back a bad stroke stops
being a record of what actually happened.

## All at once: what's live, and what isn't

Crit 9 asks what it means for several people to be here at the same time.
The decision: **only light is live.** Everyone on the page right now carries
a lantern, their pointer or finger, and with the script running the scroll
is dark except where lanterns light it. Other people's lanterns drift across
your screen as they move, revealing ink you'd otherwise miss, so the scroll
can only be seen in full together.

What is *not* live: the marks. A new mark still appears for others when they
next load the page. Live ink would make the scroll a feed to watch rather
than a place to be in, and it's a bigger promise than this piece needs.

Why this is the smallest honest version:

- Lantern positions are held in the one Node process's memory, sent over one
  Server-Sent Events stream, and forgotten when you leave. No new table, no
  queue, no cache, no second service. Nothing records where anyone looked.
- A lantern is a per-tab random id and a soft glow: no name, no colour, no
  account. You can tell someone else is here, never who.
- Lanterns change what you see, never what's stored. Without JavaScript the
  scroll is simply fully lit, and a "Light the whole scroll" switch does the
  same for anyone who wants it.

Two quieter ideas sit beside it, both about time rather than presence. When
the last mark ran up to the edge of its strip, your blank strip shows a
dotted echo of where it was heading, inviting you to *continue their line*;
it's a suggestion, never enforced. And "Watch it grow" replays every mark in
the order it was made, paced by the real gaps between visits.

## What's here now

One growing SVG scroll, one `strokes` table, one write path, plus three
ways of sharing it: lanterns for the people here now, the echo for the
person just before you, and the replay for everyone who came before.
