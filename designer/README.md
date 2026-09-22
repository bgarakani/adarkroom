# A Dark Room designer tools

A tuning panel and an autoplay bot, running next to the game. Nothing here is
loaded by the normal game on port 8080 — the designer server injects it.

```
yarn designer        # http://localhost:8181
```

- `/` — the panel: the game on the left, **tuning** and **bot** tabs on the right.
- `/game/` — the tuned game on its own, no panel.

The server binds to localhost only. Use `HOST=0.0.0.0 yarn designer` to share it.

## Tuning tab

Every numeric parameter the game holds as data, discovered by walking the module
globals: timings, costs, earnings, probabilities, weapon and enemy stats, loot
tables and event odds. Edit fields, then **apply & reload** (⌘S) to save them to
`overrides.json` and restart the game with them. Saved progress carries over.

Prices are functions in the game source rather than data, so each one is probed
with 0 and 1 owned to recover its base and per-owned amounts, then replaced with
a parameterised version. Terrain and landmark values only affect newly generated
maps, so use **new game** after changing them.

## Bot tab

A rule-based autoplayer — no AI, no model calls. It plays through the game's own
controls, so costs, cooldowns and unlock rules apply exactly as for a person.
Its rules live at the top of `bot.js` and are meant to be edited:

| Table | What it decides |
|---|---|
| `BUILD_PLAN` | build and craft order, with a cap per entry |
| `WORKER_SHARES`, `RUNWAY_TICKS` | population split, then a balancing pass so no resource runs dry |
| `MELEE`, `RANGED`, `KIT` | what to pack for an expedition |
| `EVENT_RULES`, `COST_WEIGHT`, `RETREAT_WORDS` | how event choices are scored |
| `SHIP_HULL_TARGET`, `SHIP_THRUSTER_TARGET` | when to lift off |

Priorities per decision: keep the fire alive (100/60) > ship (70) > trade (55) >
build (50) > traps and gathering (45/40) > workers (35) > expedition (30).

The build plan tracks a high-water mark per item, because the game destroys
traps and huts. The first entry never yet reached is the goal; anything
destroyed is rebuilt only with what the goal does not need.

Expeditions pick a destination by breadth-first search over seen tiles: nearest
unvisited landmark in reach, else the nearest frontier next to unexplored map,
else home. Landmark tiles are routed around unless they are the destination. It
turns back when the remaining water and meat only cover the walk home, and it
stays inside a radius set by its armour.

## Traces

Every run appends NDJSON to `designer/traces/<runId>.ndjson`, one object per
line, streamed while it plays. Entry types: `run.*`, `action`, `event.*`,
`combat.hit`, `world.move`, `world.goal`, `trip.*`, `death`, `notify`,
`milestone`, `snapshot`, `space.*`, `game.win`, `bot.error`.

Each `action` carries the rule that caused it and the resulting change in
stores, so a run can be audited decision by decision:

```json
{"seq":842,"t":2902000,"type":"action","module":"Room","action":"build",
 "target":"smokehouse","reason":"next in build plan (#9)","delta":{"wood":-600,"meat":-50}}
```

`t` is milliseconds of game time since the run began. Analyse a run with any
JSON tool, for example pacing to each milestone:

```bash
jq -r 'select(.type=="milestone") | "\(.t/1000|floor)s \(.what)"' designer/traces/*.ndjson
```

## Speed and browser throttling

The speed control runs the page's clock faster: timer delays are divided and
`Date` is scaled, so game timers, button cooldowns and spaceflight all speed up
together and stay in step.

**Chrome throttles background tabs** to roughly one timer wake-up per second,
and far less when hidden for a while. That slows the game and the bot together,
so keep the panel tab visible for a run you intend to measure. Time lost this
way is measured, subtracted from trace timestamps, recorded as `run.stall`
entries, and flagged in the panel — the reported game time stays honest.

## Known gaps

- The bot has been watched through the village, crafting, expeditions, combat,
  looting and (in a staged test) asteroid dodging. A full unattended run to the
  ending has not been observed end to end.
- Conditions inside event functions (`isAvailable`, e.g. `distance <= 10`) are
  code, not data, so the tuning panel cannot reach them.
- The panel can change the amounts in a price but cannot add a new resource to one.
- The bot does not use the Fabricator.
