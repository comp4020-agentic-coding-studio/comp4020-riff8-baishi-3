# Hollowfield

Hollowfield is a small browser RPG for a handful of people at once. You name
a character, pick one of three jobs, and walk out of an autumn village into
fields where monsters are easier, and more fun, to fight with friends. It is
inspired by the feeling of early Ragnarok Online (a healer keeping a
swordsman alive, everyone stopping when a card drops, a town full of other
people's stalls), not by its content: the world, jobs and monsters are
original, and the art is Kenney's CC0 pixel packs.

Open the URL, make a character, and you're in. No account, no email, no
password. Your character lives in your browser as a cookie; another browser
profile is another character.

## What good means here

1. **Together beats alone.** The Warden holds monsters (Provoke, Endure),
   the Ember burns them from behind and dies if anything reaches them, the
   Mender heals and blesses. A party splits XP among members on the map with
   a 15% bonus per extra member, so two people finish faster than one each.
2. **The server is the referee.** The browser sends only intents ("move
   here", "attack monster 12", "buy item 40"). The server checks each one,
   applies it on the next tick in arrival order, and refuses anything
   invalid with a reason. Damage, drops, prices and levels are decided there
   and nowhere else.
3. **Rare moments are events.** A card drop, an MVP kill or a +7 refine that
   holds is announced to everyone online, with a jingle.
4. **The world feels alive.** Mosslings wander and eat loot nobody claimed;
   bristlerats chase; webspinners call their friends when hit; the Ember
   Crab comes back every three minutes.
5. **The logs tell the story.** Every meaningful event is one line on the
   server's stdout, naming people as `Name#abc` (their name and a short hash
   of their id, never the cookie). `flyctl logs` reads like a battle report.

## Who gets the loot when two people fight the same monster

This is the decision about acting on the same thing at once.

The options were: last hit takes all (simple, but it rewards stealing kills
and punishes the Warden who held the monster); everyone who hit it gets a
copy (generous, but it duplicates items, which breaks the economy); round
robin within a party (fair inside a party, meaningless between strangers);
or the top damage dealer owns the drop for a short window.

**Hollowfield uses the last one.** When a monster dies, the server sums
damage per character. Drops land on the ground owned by whoever dealt the
most, for 6 seconds. During that window only the owner can pick them up,
and anyone else gets a refusal naming the owner and the seconds left. After
it, the drop is anyone's. An unclaimed drop vanishes after a minute, and a
wandering mossling may eat it first. XP is not exclusive: everyone who did
damage gets their share, and a party pools its shares.

The cost: a healer who never hits anything owns no drops, and a Warden who
mostly tanks may out-damage nobody. In a party that's softened by shared XP
and by trading; between strangers it's the price of not duplicating items.
Ties go to whoever hit it first. The MVP's special reward
follows the same rule and goes straight into the top damage dealer's bag.

Racing for the same thing has exactly one outcome because every intent waits
in one queue and is applied one at a time inside the tick: two pickups of
one item give one success and one "gone" refusal; two buyers of a stall's
last unit give one sale and one "sold out"; two killing blows on a 1 HP
monster give one kill.

## Who may see and change what

- **Your character** (stats, bag, zeny, skills) is yours. Only the cookie
  that made it can act as it; the server never reads identity from a request
  body. Others see your name, job, level, HP bar, position, party and guild,
  because that's what standing in a field next to someone shows.
- **Your bag is private.** Nobody else can read it or use an item from it.
  Items change hands in exactly two ways: a **trade**, where both sides see
  the same offer and both confirm it (any change clears both confirmations,
  and the swap is one transaction), or a **stall**, where you list items at
  prices you set and anyone in town may buy them, even while you're away.
- **Ground loot** belongs to its owner for 6 seconds, then to anyone.
- **Your party** sees each other's HP and map and shares XP. Joining needs an
  invitation from a member; leaving is always allowed.
- **Guild storage** is shared by the guild's members and nobody else. Any
  member may put in or take out; a non-member is refused even if they know
  an item's id. It's held by Ilse the Steward in Hollowfield.
- **The shop and the anvil** are the only places zeny and items appear from
  or vanish into, besides monster drops; every such change is written to a
  ledger so the totals can be audited.

## What's out of scope

Guild sieges, rebirth, pets, marriage, crafting, mounts, accounts or
passwords, real money, PvP. There's no moderation either: names and chat are
length-limited and logged, and that's all.

## How it's built

Astro in server mode on Node, one SQLite file on Fly's volume, Server-Sent
Events for the world stream and small JSON POSTs for intents. The world runs
on a 5 Hz tick in memory; characters, items, zeny, parties, guilds and stalls
are durable in SQLite. `docs/` holds the design, the decisions, the testing
record and the asset list.
