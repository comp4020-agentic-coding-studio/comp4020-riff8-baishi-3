# Design

## The world

**Hollowfield** is a farming village with a well, a grocer, a smith and a
steward. East through the gate are the **Amber Fields** (36×22, trees,
flowers and a road), and in the far south-east corner of the fields a
stairway down into **The Old Barrow** (30×20, stone and dust). Fields and
barrow are generated from a fixed seed, so server and browser build the same
map from the same code (`src/game/data.ts`).

## Jobs

| Job | Role | Starts with | Skills (prerequisites) |
| --- | --- | --- | --- |
| Warden | fighter: high HP, holds aggro | Training Blade, Bash, Provoke | Bash, Provoke, Endure (Provoke), Ember Sweep (Bash, Endure) |
| Ember | caster: magic damage, fragile | Oak Staff, Firebolt, Frost Lance | Firebolt, Frost Lance, Flame Ring (Firebolt), Meditate (Flame Ring) |
| Mender | healer: heals and buffs | Willow Wand, Heal, Blessing | Heal, Blessing, Sanctuary (Heal), Quicken (Blessing, Sanctuary) |

Skill points come from job levels; stat points from base levels, with STR,
AGI, VIT, INT, DEX and LUK costing more every ten points. Ember and Mender
skills with a cast time are interrupted by being hit, unless the caster has
Endure. Weight over 50% stops regeneration; over 90% stops attacking.

## Monsters

| Monster | Where | Temperament | Element |
| --- | --- | --- | --- |
| Mossling | fields | passive; eats free loot on the ground | earth |
| Bristlerat | fields | aggressive; chases within 4 tiles | neutral |
| Webspinner | fields | passive until hit, then calls every spinner within 6 tiles | earth |
| **Ember Crab** (MVP) | fields, south-east | aggressive, hits hard, respawns every 3 min | fire |
| Dusk Bat | barrow | aggressive and evasive | neutral |
| Cairn Beetle | barrow | armoured caller | earth |
| Grave Jelly | barrow | passive looter | water |
| **Barrow Wight** (MVP) | barrow, south-east | aggressive, respawns every 5 min | water |

Elements: fire beats earth, water beats fire, earth beats water (×1.5 one
way, ×0.5 back). An Ember with Frost Lance is the Ember Crab's natural enemy.

## Economy

Zeny comes from selling loot to Marta (half its price) and goes on potions,
gear and refining. Refining at Old Tobin is certain to +4; past that each
attempt costs more and can break the item. Cards (2% drops) slot into a free
slot on gear for permanent bonuses. Trades and stalls move items between
players without creating or destroying anything; the ledger proves it.

## How the pillars show up

1. **Together beats alone.** A solo Ember dies to two bristlerats; with a
   Warden provoking them she clears the field. Party XP has a 15% bonus per
   extra member. The MVPs are tuned to need a party.
2. **The server is the referee.** Intents only; one queue; refusals with
   reasons; transactions and a ledger for anything valuable.
3. **Rare moments.** Card drops, MVP spawns and kills, and +7 refines are
   announced to everyone online with a banner and a jingle; rare drops glow
   on the ground.
4. **The world feels alive.** Three temperaments, jellies eating loot,
   names, HP bars, chat bubbles, emotes and stalls in town.
5. **The logs tell the story.** See `README.md` and any `flyctl logs`.
