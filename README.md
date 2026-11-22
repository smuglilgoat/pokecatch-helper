# Poke'Catch Team Optimizer

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=190&text=Poke%27Catch%20Team%20Optimizer&fontSize=42&fontAlignY=36&desc=Teams%20built%20with%20the%20game%27s%20own%20rules%2C%20applied%20through%20its%20own%20slots&descAlignY=56&fontColor=ffffff" width="100%" />

<!-- readme-gen:start:badges -->
![Version](https://img.shields.io/badge/version-1.7.0-2f6fe4?style=flat)
![Platform](https://img.shields.io/badge/Tampermonkey-userscript-00a94f?style=flat)
![Game](https://img.shields.io/badge/Poke%27Catch-online-ee8130?style=flat)
![Dependencies](https://img.shields.io/badge/dependencies-none-555?style=flat)
<!-- readme-gen:end:badges -->

</div>

A single-file Tampermonkey userscript for [Poke'Catch](https://pokecatch-online.netlify.app/).
It reads the game's own bundle, simulates fights with the game's own math, and fills the game's
own team slots by dragging Pokémon the way a player would — no save editing, no extra requests
during play.

## What it does

<table>
<tr>
<td width="50%" valign="top">

### 🧭 Chapter planning
Simulates the whole generated chapter — wilds, trainers, gyms, heal stops, statuses, XP and
mid-run evolutions — then saves a team per stretch between Pokémon Centers and switches
templates as the run reaches each center.

</td>
<td width="50%" valign="top">

### ✨ Legendary and elite zones
The game's `counterTeam` ranking: one mon per species, one legendary per elite team, damage
plus the boss-status credit (DoT and paralysis), the elite HURT/RESIST tables, a short
swap-one-slot refine, then a 200-fight win and capture line.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⚡ Shiny raids
`atk` badges on the community cards and on every ally avatar, and a **Fastest clear** that
picks two level-100 mons by DPS weighed against how many rounds the boss needs to KO them.

</td>
<td width="50%" valign="top">

### ⛏ Underground
The theme's guard pool (the game's `guardsOf` species, top BST final forms) becomes a plain
foe list; the chapter greedy fills the three slots at cap 100.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🐾 Roamers
A roamer out on the current chapter is modeled as a level-100 boss (ROAM_HP / ROAM_POWER)
inside the chapter plan, so the segment teams have to survive it. The hunt loop restarts the
roamer's chapter and turns its loop on/off through the map.

</td>
<td width="50%" valign="top">

### 🗺️ One dashboard
Progress screen, above the map: chapter and step, cap, eligible count, type chips, the preset
switch, simulate / apply / prepare segments / empty templates, the prepared segment rows and
the roamer hunt.

</td>
</tr>
</table>

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`pokecatch-team-optimizer.user.js`](https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js)
   — Tampermonkey offers to install it.
3. Open the game and log in. There is **no floating window**: every block lives inside the
   game's own screens, built from its classes. Blocks rebuild only when something changed.

## Where everything is

| Game screen | What the helper adds |
|---|---|
| **Progress** | The dashboard above the map: chapter name and step n/N, cap, league line, eligible count, data source and bundle, errors and the update notice, the chapter's type chips, the presets, quick actions, the prepared segment rows, and the roamer hunt (out now, time left, Hunt/Stop). |
| **Adventure** | The game's team-template bar between the timeline and the arena, with the same markup and active state: one click fields that template. |
| **Team/PC** | Above the PC list: the **chapter optimizer** — presets, **simulate** with its progress bar and result line, the compact team rows (icon, `atk` / `def` badges), **apply to team**, a base-team template select + **apply base team**, **prepare segments**, **empty templates**, and the segment rows (T1..T5 with sprites and win rate; click one to switch). An **empty templates** button also sits next to the game's `#team-sets`. |
| **Legendary / elite picker** | Below “Les plus choisis”: presets, **✨ Optimize (mine)**, the boss line (types, HP, damage per round), the odds line, the team with `atk` (damage into the boss) and `def` (rounds survived) badges, and **apply to team**. |
| **Underground picker** | Below the community section: the theme's guards, presets, **⛏ Optimize (mine)** and **apply to team**. |
| **Raid picker** | Below the community section: **⚡ Fastest clear**, the total DPS line, `atk` on the species cards and a total-DPS badge on each ally avatar. |
| **PC grid** (any picker with a result) | A blue ▲ on every mon the script picked; gold when the game's own ranking would pick it too (in edge pickers: when the game already marks it `eff-up`). The game's own green marks are never touched. |

The **Defense / Offense / Balanced** presets order the candidate pool and weigh the chapter
fight score; the same preset is shared by all optimizers.

## The chapter simulator

**simulate** is a full run of the chapter the game generated, not a per-foe score:

- it walks the live node list in order — wilds, random trainers, story trainers, gym leaders,
  heal stops, statics. A league chapter walks every member, and a wipe still rewinds the league.
- battles use the game's rules: every living mon acts each round in speed order (paralysis
  ×0.25 speed), OHKO moves are preferred, **status moves are used with the game's 30 % chance**
  (accuracy capped 100/70/30 by move kind), else the best attack; damage rolls 0.85–1.15,
  crits, multi-hits and secondary statuses per hit.
- statuses behave as in game: sleep 1–3 turns, freeze until a 0.2 thaw, full-para 0.25 with a
  3-turn cap, burn/poison tick `maxHp/8` for 5 turns, the 0.75 stat cuts, confusion self-hits,
  night-sleep on diurnal wilds — and they persist between fights until a heal.
- the team keeps its HP between fights, gains the game's XP and levels up mid-run: new moves
  from the graded learnset, evolutions with their gates (daytime, party, uid-hash branch).
- the search is a hill climb over the strongest pool (Monte-Carlo runs per team, one mon per
  species), scored by completion rate. The line reads like
  `chapter sim: win 62% · clears 19/24 battles · 121 teams in 1.1s · wipe at step #7×3`.

A roamer on the chapter is added to this plan as a boss fight at its real level (100) with the
game's ROAM_HP and ROAM_POWER, and it is weighted heavily in the candidate scoring. The chapter
line also shows its one-ball capture chance (`ROAMING.CATCH × capture-berry buff`).

### Segment teams (one per Pokémon Center)

A chapter is split at its **heal nodes**; each stretch is simulated from a healed team, which
is what a center gives you. **prepare segments** computes a team per stretch and writes
segment *i* into **Template *i* + 1**, overwriting whatever was there (the panel lists T1–T5
with sprites and win rates). While the chapter runs, the script watches the node and switches
**one node before each Pokémon Center** — the game heals when the center starts, so a team
fielded at the center would miss it. A manual pick in the game's bar wins for its segment.

**empty templates** really empties them: it selects each filled template and drags every member
out to the PC through the game's pointer gestures, then logs what is left. It never writes the
save.

## Legendary and elite teams

Open a legend zone's picker, pick a tier, then **✨ Optimize (mine)**. Only **level-100** mons
are used (the game sends max-level teams into these fights) and the region-link rule does not
apply — the game's zone picker allows every region.

The ranking is the game's own `counterTeam`:

- each candidate's value is its damage into the boss × the rounds it survives there;
- on top of that, the **boss-status credit**: the expected DoT (a `bossHp / HURT` tick with the
  `BOSS_STATUS.DOT_TURNS` cap, land chance from the 30 % status-move rule and the status caps,
  scaled by `ELITE.RESIST`) and paralysis, then `Σ value + best dots × STATUS_TEAM −
  STATUS_PARA_COST × Σ para` (the penalty only when a dot is present);
- one mon per species — a shiny and a plain copy of the same species never both go in;
- **one legendary** per elite team (`ELITE.LEGENDS`), no cap outside elite;
- a budgeted (~1.5 s) swap-one-slot hill climb then refines the picks against the fight
  simulation; the console logs `legend refine: +x%` or `unchanged`.

The odds line reports win %, rounds, catch % per attempt and the expected runs/time to the
capture, from 200 simulated fights with the game's rolls and damage variance. The direct damage
is not reduced by `ELITE.RESIST` — in the bundle that resistance applies to statuses only.

## Raids

In the game's raid picker my row adds **⚡ Fastest clear**:

- every species card gets an **atk** badge; each ally avatar gets its duo's total DPS badge
  instead of having a tag pushed into the row;
- picks are **survival-weighted**: rank by raw DPS for a provisional team, let
  `R = bossHp / teamDps`, then re-rank by `dps × min(aliveRounds, R)`, where `aliveRounds` is
  the mon's HP over the boss's per-round hit (`bestDamage / TEAM_SIZE × raid dmgMult`). The
  atk badges and the total line stay raw DPS;
- the pool is level-100 mons, one per species; the button fills the two pick slots, then walks
  the ally modals and takes the best row of each.

## Roamer hunt

The roaming legendaries stay on a random chapter of their region for 15 minutes (30 with a
rowap berry) and re-roll afterwards. The dashboard lists the ones out (`save.roam.at`) with
their chapter and time left. Pick one and press **Hunt**: the script re-checks the timer and
placement, restarts the roamer's chapter with the game's own restart button, turns the
chapter's loop on, waits for the roamer fight and its single capture ball, and starts over on
a miss. **Stop** ends it and turns the loop back off unless you had turned it on yourself.

Server pacing: one restart per 10–14 s and at most 120 per rolling hour, then a 10-minute
rest. The hunt stops or follows the roamer when its placement expires or moves, refuses to run
during an event / zone / league / tower, and never persists: a reload ends it.

## Where the data comes from

- **The game itself** — the bundle the page already loaded (`bundle/app.<hash>.js`): Pokédex,
  moves, evolutions, chapters, encounters, config knobs, legend zones and the gem/underground
  themes. The per-species learnset is recomputed with the game's grading (20-level gap cap,
  per-type reassignment, the 4–5 spacing step).
- **https://pokemondb.net/type** — the type chart, with PokeAPI and the game chart as fallbacks.
- **https://pokeapi.co/api/v2** — the debug `api` cross-check only; no UI button uses it.

Tables are cached in userscript storage keyed by the bundle hash, validated on load, and a
half-read table is thrown away and re-parsed. No new network fetch is added by the optimizers.

## When the game updates

The game rewrites its bundle every release, minified names included. The parser locates tables
by public markers (`a.POKEDEX=`, `a.CONFIG=`…) or by data shape, and reads legend zones through
`a.LegendZones`. Each table parses on its own; a broken one is named in the dashboard while the
rest keeps working. Missing boss-status knobs switch the status credit off with a named
`[pcopt]` log line instead of failing.

The script checks GitHub once per page load and shows the update line when a newer `@version`
exists. Tampermonkey also pulls updates itself through `@updateURL` / `@downloadURL`; GitHub
raw caches for ~5 minutes.

## Debugging and self-test

Every action is logged to the console with a `[pcopt]` prefix (bundle tables, cache hits, chart
source, optimizer runs and teams, applied slots, picker mounts, refine gains, errors). The last
400 entries are in `window.__pcopt.logs`.

```js
window.__pcopt.selftest()   // runs the reworked invariants on the live save + synthetic cases
```

It logs one `[pcopt] selftest:` line per check and returns `{ ok, ms, results }`. The checks
cover: the level-100 legend/raid pools, one mon per species, the elite legendary cap, the shiny
+ plain pair rule, the refine never lowering the score, survival-weighted raid picks and their
size, the 2-round glass cannon ordering, and the roamer node becoming a level-100 boss (and
staying normal when none is out or it is caught). It is cheap (< 2 s on a 540-mon PC).

## Notes and limits

- **Levels.** Legend and raid pools are level-100 only, matching the game's pickers. The
  chapter optimizer projects at the current chapter cap; the underground brings the team to
  level 100 and therefore accepts every level.
- **Eligibility.** The chapter and underground pickers apply the region link; the legend and
  raid pickers do not (the game's own `allow` rules).
- **Shiny** mons get the game's +10 % stat bonus and are marked ✨.
- **Evolutions** within the cap are projected with the game's gates (daytime, party, uid-hash
  branch, item in the bag, link-cable fee). The dex-dedup evolution gate is not modelled.
- **Raids** rank by DPS and survival; the fight is not simulated round by round.
- **The world-boss attack picker is not covered**: its config has no foes and no boss entry to
  rank against, only the daily “already attacked” lock, which the game already enforces.
- **The underground theme** is matched by the label the game puts in the header (its French
  config name). If a future language pack translates it, the block stays hidden rather than
  guessing a theme.
- **The roamer's rage burst** is averaged into one strong per-round attack in the chapter sim;
  the odds line is capture flavour, not a round-by-round roamer simulation.
- The simulator is a model: expected rolls and the game's probabilities, not frame-perfect.

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=100&section=footer" width="100%" />

**One file, no dependencies — built for the game as it is today (bundle `app.29a3ff3cf6.js`).**

</div>
