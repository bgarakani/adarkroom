# Designer tools for A Dark Room

Two tools for taking the game apart as a designer: a **tuning panel** that makes
every number in the game editable while you play, and a **bot** that plays the
game by itself and records what it did. Use them together to ask "what happens
to the game if I change this?" and get an answer you can point at.

Neither tool changes the original game. They are served separately, on their own
port, by a small server that lives in this folder.

---

## 1. Getting started

You need [Node.js](https://nodejs.org) 18 or newer. Check yours:

```sh
node --version
```

Then, from the project folder:

```sh
yarn install        # or: npm install   — once, to fetch the one dependency
yarn designer       # or: npm run designer
```

Leave that terminal running and open **http://localhost:8181**.

You should see the game on the left and a panel on the right with two tabs,
**tuning** and **bot**. If the page does not load, look at the terminal for an
error. To stop the server, press `Ctrl+C` in that terminal.

Everything runs on your own computer. The server accepts connections from your
machine only, and nothing is uploaded anywhere.

Two other addresses are useful:

| Address | What it is |
|---|---|
| http://localhost:8181 | the panel and the game together |
| http://localhost:8181/game/ | your tuned game on its own, no panel — good for playtesting or showing someone |
| http://localhost:8080 | the plain, untouched game (`yarn start`) |

The tuned game at 8181 and the plain game at 8080 keep **separate saves**, so
experimenting will not disturb a normal playthrough.

---

## 2. The tuning tab

The panel lists every number the game keeps as data — roughly 2,300 of them —
grouped by where they live in the game: The Room, Outside, Path, World, Events,
Starship, Space, Fabricator.

**To change something:**

1. Search for it. Searching `stoke` finds the fire controls; `trap` finds the
   trap's cost and what it drops; `beast` finds that enemy's damage and health.
2. Type a new value. The field turns highlighted and shows what the original was.
3. Press **apply & reload** (or `⌘S` / `Ctrl+S`).

The game reloads with your values and your saved progress carries over. The
**modified** filter shows only what you have changed, each with a ↺ button to put
it back. **reset all to defaults** clears everything.

### What you can change

- **Timing** — the cooldown on stoking the fire, how fast the fire dies down, how
  long the stranger takes to recover, gather and trap cooldowns, how often
  villagers arrive, how often random events fire.
- **Prices** — every building, tool, weapon and upgrade, and the trader's prices.
  Each price has a base amount and a **+ per owned** amount. By default only
  traps and huts get more expensive as you own more; you can make anything scale,
  or stop traps scaling at all.
- **Earnings** — wood per gather (with and without the cart) and what each worker
  job produces and consumes.
- **Chance** — trap drop odds, the chance of a fight while walking, hit chances,
  loot drop chances, and the odds of each branch of an event.
- **Combat and survival** — weapon damage and speed, enemy health and damage,
  healing amounts, water capacity, carrying capacity, armour, perks.

### Things worth knowing

- A few values only matter when the world map is first generated: map size, the
  mix of terrain, how many of each landmark there are. Change those, then press
  **new game** (it deletes the save; prestige is kept).
- The panel warns you about values that break a rule — probabilities outside 0
  to 1, terrain odds that do not add up to 1, a minimum above its maximum.
- You can change the amounts in a price, but not add a new resource to it.
- Conditions written as code rather than data — such as an event only appearing
  more than ten tiles from the village — cannot be edited here.

### Sharing your settings

Your values are saved to `designer/overrides.json`. Use **export JSON** in the
`more` menu to save them to a file you can hand in or send to someone, and
**import JSON** to load someone else's. Importing tells you if it skipped
anything it did not recognise.

---

## 3. The bot tab

The bot plays the game on its own. It is not an AI and makes no model calls: it
follows a fixed list of rules and priorities, written in plain JavaScript at the
top of `bot.js`. It plays by clicking the game's own buttons, so it pays the same
costs and waits through the same cooldowns you do.

**To run it:** open the bot tab and press **start fresh run**. It deletes the
save and plays from the first fire. **play from here** continues your current
game instead, and **step** runs a single decision at a time, which is the easiest
way to see how it thinks.

**Speed** runs the game's clock faster — 20× turns an hour of game time into
three minutes. Button cooldowns, timers and spaceflight all speed up together.

> **Keep the tab visible while the bot runs.** Browsers deliberately slow down
> tabs in the background, which slows the game and the bot to a crawl. The panel
> warns you when this is happening, and the time lost is excluded from the
> recorded times so the numbers stay truthful.

### Reading a run

**Milestones** is the most useful part for a designer: how long the bot took to
reach each stage, and the gap between them.

```
0:45      outside
2:38:21   path                  +2:37:35
2:38:51   dungeon cleared          +0:29
```

Run the bot once, change some numbers in the tuning tab, run it again, and
compare. That gap is your pacing, measured rather than guessed.

**Trace** is the running commentary: every action with the rule behind it, every
event choice with the options it weighed, every blow struck in a fight, every
step on the map. The buttons above it filter by kind. Hovering over a line shows
the raw record behind it.

### What the bot does and does not do

It handles the fire and the stranger, builds and crafts in a set order, trades,
assigns villagers to jobs and rebalances them so nothing runs out, packs for
expeditions, explores the map, fights, takes loot, upgrades the ship and dodges
asteroids.

It has been watched working through the village, crafting, expeditions, combat
and looting, and the asteroid dodging has been tested on its own. **A complete
unattended run to the ending has not been observed**, so treat a long run as
something to check rather than trust. It does not use the Fabricator.

---

## 4. The trace files

Every run is written to `designer/traces/<run id>.ndjson` as it plays. The format
is one JSON object per line, which every language can read. The bot tab lists
past runs with download links.

An action records what the bot did, the rule that made it do so, and what it cost:

```json
{"seq":1845,"t":9275660,"type":"action","module":"Room","action":"build",
 "target":"smokehouse","reason":"next in build plan (#9)","delta":{"wood":-600,"meat":-50}}
```

`t` is milliseconds of game time since the run started. The kinds of record are
`run.*` (start, stop, speed changes, browser stalls), `action`, `event.*`,
`combat.hit`, `world.move`, `world.goal`, `trip.*`, `death`, `notify` (the
game's own text), `milestone`, `snapshot` (everything you own, every 30 seconds),
`space.*`, `game.win` and `bot.error`.

Some things to ask a trace, using [jq](https://jqlang.github.io/jq/):

```sh
cd designer/traces

# pacing: how long to each stage
jq -r 'select(.type=="milestone") | "\(.t/1000|floor)s  \(.what)"' RUN.ndjson

# what it built, in order, and what it cost
jq -r 'select(.action=="build") | "\(.t/1000|floor)s  \(.target)  \(.delta|tostring)"' RUN.ndjson

# how much wood came in and went out
jq -s '[.[] | select(.delta.wood) | .delta.wood] | {gained: map(select(.>0))|add, spent: map(select(.<0))|add}' RUN.ndjson

# every death, and where
jq -r 'select(.type=="death") | "\(.t/1000|floor)s  died \(.home) tiles from home"' RUN.ndjson
```

Python works just as well:

```python
import json
rows = [json.loads(line) for line in open('RUN.ndjson')]
snaps = [r for r in rows if r['type'] == 'snapshot']
print([(s['t'] // 1000, s['population']) for s in snaps])   # population over time
```

Trace files are not committed to git; they are yours, per run.

---

## 5. Exercises to try

1. **Speed up the opening.** Time how long the bot takes to reach "outside" with
   the defaults. Then change the stoke cooldown, the fire cooling time and the
   stranger's recovery, and run it again. How much can you cut before the opening
   stops feeling like a slow awakening?
2. **Make the trap matter more, or less.** Change the trap's drop odds and its
   cost curve, then compare how much fur and meat the village has after an hour.
3. **Break the economy on purpose.** Make cured meat cost more than a hunter can
   supply and watch the bot's worker balancing fight it in the trace.
4. **Rebalance a fight.** Take the snarling beast's damage, health and hit chance
   and make the first encounter genuinely dangerous. Check the combat lines in
   the trace to see how close the bot came to dying.
5. **Change the bot's mind.** Open `bot.js` and reorder `BUILD_PLAN`, or change
   `WORKER_SHARES`. Does a different strategy reach the compass sooner?

---

## 6. If something goes wrong

**Port 8181 is already in use.** Either stop whatever is using it, or pick
another: `PORT=8282 yarn designer`.

**The panel says "waiting for game".** The game did not load. Check the terminal
running the server, and reload the page.

**My change did nothing.** Three common reasons: you did not press **apply &
reload**; the value only applies to a newly generated map, so you need **new
game**; or the thing you changed is decided by code rather than data.

**The bot is idle or very slow.** The tab is probably in the background — bring
it to the front. The panel shows a warning in red when this is happening.

**The bot says it is "staying home".** That is not a hang. It has explored
everything it can reach: how far it will stray is limited by its armour, and how
far it can walk before turning back is limited by its water. It carries on
building and trading until it has better armour or a bigger water skin, then sets
out again. Watch the `doing` line for the exact reason.

**The bot is doing something silly.** That is worth writing down. Use the trace
to find the decision and the reason it recorded, and either change the numbers or
change the rule in `bot.js`.

**I want to start completely over.** Press **new game** in the tuning tab, and
**reset all to defaults** to clear your tuning.

---

## 7. How it works, briefly

- `server.js` serves the panel, serves the game with the tools injected, and
  stores overrides and traces. It listens on your machine only.
- `game-hook.js` walks the game's own objects to find every number and remember
  its default, then applies your overrides before the game starts. Prices are
  written as functions rather than plain numbers, so each one is run twice — once
  as if you owned none, once as if you owned one — to work out its base and its
  per-owned step, then replaced with a version that uses your values.
- `timewarp.js` gives the page one virtual clock so timers, cooldown animations
  and spaceflight all speed up together.
- `bot.js` is the player: its rules are the tables at the top of the file.
- `panel.*` and `bot-panel.js` are the interface.
