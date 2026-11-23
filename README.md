# Poke'Catch Team Optimizer

![Version](https://img.shields.io/badge/version-1.7.0-2f6fe4?style=flat)
![Platform](https://img.shields.io/badge/Tampermonkey-userscript-00a94f?style=flat)

A single-file Tampermonkey userscript for [Poke'Catch](https://pokecatch-online.netlify.app/) ([mirror](https://pokecatch-online.pages.dev/)). It reads the game's code bundle, the file the page has already loaded, simulates fights with the game's formulas, and fields the result by dragging Pokémon into the game's own team slots. The save is read but not written.

## Technology stack

- Vanilla JavaScript, one userscript file. No dependencies and no build step.
- Tampermonkey APIs: `GM_getValue` and `GM_setValue` for storage (cached bundle tables, the type chart, the English pack URL and the prepared segments), `GM_xmlhttpRequest` for cross-origin requests, with a `fetch` fallback when the Tampermonkey APIs are unavailable.
- `@connect` hosts: `pokemondb.net`, `pokeapi.co`, `pokecatch-online.pages.dev`.
- `@match` on `https://pokecatch-online.netlify.app/*` and `https://pokecatch-online.pages.dev/*`, at `document-idle`.

## Architecture

The game ships a hashed bundle (`bundle/app.<hash>.js`) with the Pokédex, moves, evolutions, chapters, encounters, config constants, legend zones and underground themes. The userscript fetches the same file, finds each table by its public marker (`a.POKEDEX=`, `a.CONFIG=`, and so on) or by the table's shape, and evaluates the literal in a sandbox. Legend zones are found by their data shape, and their per-zone elite power table (`ELITE_P`) through the public `LegendZones` export. Parsed tables are stored in userscript storage under a key built from the bundle URL. The entry is checked against minimum table sizes on load, and a cache that fails is parsed again.

A required table (the Pokédex, moves, type chart, evolutions, encounters, regions, chapters and config) that fails stops the parse, and the dashboard shows the error naming it. Optional tables and missing config knobs log a `[pcopt]` warning; the feature that needs them turns off and the rest keeps working.

Battles run locally. The engine ports the game's damage, stat, type and status formulas, and the chapter search applies them to candidate teams. Network calls happen at load, not inside the optimizers: the bundle fetch above, the type chart from pokemondb.net (PokeAPI and the game's chart as fallbacks), a once-per-load read of the raw userscript from GitHub to compare `@version`, and, when English names are not already loaded, a fetch of `/boot.js` to find `bundle/lang-en.*.js` followed by a fetch of that pack and execution of its code so the names reach the Tampermonkey sandbox. The PokéAPI cross-check runs only when you call `window.__pcopt.compareWithPokeApi`.

The DOM is the interface to the game. The script clicks the game's template buttons and moves Pokémon with synthetic drag events on the game's team slots and PC cells. It reads the save from `localStorage` and leaves it untouched.

The file is one IIFE with numbered sections. This table is the map:

| Line | Section |
|---|---|
| 26 | 0. Small helpers |
| 73 | 0b. Console log (`[pcopt]`, last 400 entries) |
| 91 | 1. Game data parsed from the bundle |
| 536 | 2. Type chart (pokemondb.net, PokeAPI and the game as fallbacks) |
| 582 | 3. Save access |
| 631 | 4. Battle math (the game's formulas) |
| 736 | 5. Chapter events |
| 1004 | 6. Optimizer |
| 1268 | 6c. Chapter simulation |
| 1799 | 6b. Legendary fights |
| 2122 | 7. Roamer hunt |
| 2652 | 8. Team editing (drag and drop) |
| 2744 | 8b. PokéAPI cross-check and the moves panel |
| 2794 | 8b. Shiny raids |
| 2970 | 8c. Controls inside the game's screens |
| 3114 | 9. UI state |
| 3523 | 9b. UI blocks mounted in the game's screens |
| 3949 | 10. Boot and actions |

Section numbers are the file's own labels; the table follows file order, and 8b is used twice.

## Getting started

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`pokecatch-team-optimizer.user.js`](https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js). Tampermonkey offers to install it. The same URL is in `@updateURL` and `@downloadURL`, so updates land in place.
3. Open the game and log in. The blocks appear inside the game's own screens: the dashboard on Progress, the optimizer on Team/PC, and controls in the legendary/elite, underground and raid pickers.

## Project structure

```text
pokecatch-team-optimizer.user.js   the userscript: all code, styles and UI
README.md                          this file
.gitignore                         ignores local save exports
```

## Key features

### Chapter planning

The simulator plays the chapter the game generated for this run and scores each candidate team on how far it gets. It walks the live node list in order (wilds, trainers, story trainers, gym leaders, heal stops, static encounters).

Battles follow the game's rules. Every living mon acts each round in speed order, with paralysis at a quarter speed. OHKO moves are preferred; otherwise the mon uses a status move on the game's 30 % chance (accuracy capped at 100, 70 or 30 by move kind) or its best attack. Damage rolls and crits are rolled per hit, including each hit of a multi-hit move; a move's secondary status is rolled once after the hits, only if the target survives. Sleep lasts 1 to 3 turns, freeze thaws at 0.2, full paralysis at 0.25 is capped at 3 turns, burn and poison tick `maxHp/8` for 5 turns, the status stat cuts are 0.75, confusion can cause a self-hit, and diurnal wilds can start asleep at night.

The team keeps its HP between fights, gains the game's XP, and levels up mid-run with new moves from the graded learnset and evolutions under the game's gates (daytime, party, a branch chosen by the mon's uid hash, item, link-cable fee). The search ranks the strongest candidates by individual score, takes the top 26, and hill-climbs one slot at a time with Monte-Carlo runs. Every team keeps one mon per species. The result line reads `chapter sim: win …% · clears n/N battles · T teams in Xs · wipe at step #i×n`, where the wipe item is the most frequent wipe point and its count.

A roamer on the chapter joins the plan as a level-100 boss with the game's `ROAM_HP` and `ROAM_POWER` multipliers, weighted heavily in the candidate score. The chapter line also shows its one-ball capture chance (`ROAMING.CATCH`).

### Segment teams

A chapter is split at its heal stops (the game's Pokémon Centers). **prepare segments** computes one team per stretch and writes segment *i* into **Template *i* + 1**, so the first segment lands in T1. Only the first five stretches get a template, since the game saves five. While the chapter runs, the script switches to the prepared template one node before each Pokémon Center: the game heals when the center starts, so a team fielded at the center would miss the heal. A template picked by hand in the game's own template bar wins for the rest of that segment.

**empty templates** clears the templates through the game's own gestures: it selects each filled template, drags every member back to the PC, and logs what is left to the console.

### Legendary and elite teams

Open a legend zone's picker, pick a tier (elite tiers are the game's harder versions of the fight), then **✨ Optimize (mine)**, which picks from the mons in your PC. Only level-100 mons are used, as in the game's own picker. The region link (the in-game link that limits which regions may join a team) is skipped here, so the picker may suggest a mon the link will not let you field; **apply to team** skips that one.

The ranking is the game's `counterTeam` score: each mon's damage into the boss times the rounds it survives, plus the status credit. The status credit is the expected damage over time (DoT) from the boss's `HURT` divisor, capped at the game's `BOSS_STATUS.DOT_TURNS` (land chance from the 30 % status rule, reduced by `ELITE.RESIST`), and paralysis, combined as `Σ value + best dots × STATUS_TEAM − STATUS_PARA_COST × Σ para` where the paralysis penalty applies only when a DoT is credited. A mon per species is allowed, and elite teams allow one legendary (`ELITE.LEGENDS`); outside elite there is no legendary cap. A swap-one-slot hill climb with a time budget (about 1.5 s) refines the picks against the fight simulation and logs `legend refine: +x%` or `unchanged`.

The odds line reports win %, rounds, catch % per attempt, and expected runs and time to capture, from 200 simulated fights using the game's rolls. Direct damage ignores `ELITE.RESIST`; the game applies that resistance to statuses only.

### Underground

The picker uses the theme's guard pool: the game's `guardsOf` species, the top-BST final forms of the unlocked dex whose types match the theme, at level 100. A greedy builder picks the team against the guard list and fills the three slots from the eligible PC mons. **⛏ Optimize (mine)** runs it, and **apply to team** places the result. The theme is matched from the type badges in the picker header, with the header label as a fallback.

### Shiny raids

Below the raid picker's community section, **⚡ Fastest clear** ranks level-100 mons one per species and fills the two pick slots. Each species card gets an `atk` badge, and each ally avatar carries the total DPS badge for that ally's duo.

Picks are survival-weighted. The script ranks by raw DPS for a provisional team, sets `R = bossHp / teamDps`, then re-ranks by `dps × min(aliveRounds, R)`, where `aliveRounds` is the mon's HP divided by the boss's per-round hit (the boss's best damage split across the team and scaled by the raid damage multiplier). The badges and the total line show raw DPS; the weighting affects only the pick order. After the two slots are filled, the script opens each ally slot's picker and takes the highest-DPS row.

### Roamer hunt

The game keeps a roaming legendary on a random chapter of its region for 15 minutes, 30 with a rowap berry, then re-rolls it. The dashboard lists the roamers the save has out (`save.roam.at`) with their chapter and time left. Pick one and press **Hunt**: the script re-checks the timer and placement, restarts the roamer's chapter with the game's restart button, turns the game's chapter loop toggle on, waits out the fight and its single capture roll, and starts over on a miss. **Stop** ends the hunt and turns the loop off unless you had turned it on yourself.

The server pacing is one restart per 10–14 s and at most 120 per rolling hour; hitting the cap starts a 10-minute rest. The hunt stops when the placement timer runs out, follows the roamer when it moves, stays off during an event, legend zone, league or tower, and does not survive a reload.

### The dashboard

The Progress screen carries a dashboard above the map. It shows the run's state (chapter and step, level cap, league progress, the count of mons that can join), the data source and bundle, errors and the update notice, the chapter's type chips, the presets, the quick action buttons, the prepared segment rows, and the roamer hunt. Every block is built from the game's classes and only rebuilds when its inputs change; the Progress row below lists each item.

## Where each block appears

| Game screen | What the helper adds |
|---|---|
| **Progress** | The **Chapter dashboard** above the map: chapter name and step n/N, cap, league line, eligible count, data source and bundle, errors and the update notice, the chapter's type chips, the **Defense / Offense / Balanced** presets, **simulate**, **apply to team**, **prepare segments**, **empty templates**, the prepared segment rows, and the roamer hunt (out on a chapter, time left, **Hunt** / **Stop**). |
| **Adventure** | A copy of the game's team-template bar between the timeline and the arena, with the same markup and active state: one click loads that template into the team. |
| **Team/PC** | Above the PC list sits the **Chapter optimizer**: presets, **simulate** with its progress bar and the chapter sim line, the team rows (sprite, `atk` and `def` badges), **apply to team**, a base-team template select with **apply base team** (it switches the game to the picked template and fields the optimized team there, so the team lands in the template you choose as the base), **prepare segments**, **empty templates**, and the segment rows (T1–T5 with sprites and win rate; click one to switch). An **empty templates** button also sits next to the game's own template bar (`#team-sets`). |
| **Legendary / elite picker** | Below "Les plus choisis" (the community section's French label): presets, **✨ Optimize (mine)**, the boss line (types, HP, damage per round), the odds line, the team with `atk` (damage into the boss) and `def` (rounds survived) badges, and **apply to team**. |
| **Underground picker** | Below the community section: the theme's guards, presets, **⛏ Optimize (mine)** and **apply to team**. |
| **Raid picker** | Below the community section: **⚡ Fastest clear**, the total DPS line, `atk` on the species cards and a total-DPS badge on each ally avatar. |
| **PC grid** (any picker with a result) | A blue ▲ marks every mon the script picked. The ▲ is gold when the game's own ranking would pick it too (in pickers without a boss: when the game already marks it with its own `eff-up` class). The game's green marks are left alone. |

Templates are the game's own: up to five saved teams (T1–T5). The script places its picks into them, and every bar it adds loads one with a click. The **Defense / Offense / Balanced** presets set the order of the candidate pool and the weights inside the chapter fight score, and the same preset is shared by all the optimizers.

## Data sources

The game data comes from the bundle. The per-species learnset is recomputed with the game's grading (20-level gap cap, per-type reassignment, the 4–5 spacing step), so the move list matches the game's moves panel.

`https://pokemondb.net/type` supplies the type chart, with PokeAPI and the game's chart as fallbacks.

`https://pokeapi.co/api/v2` is a debug cross-check only (`window.__pcopt.compareWithPokeApi`). No UI button uses it.

The optimizers fetch nothing at run time: the tables they read are already parsed and cached.

## Testing

There is no test suite in the repository. The script carries its own checks:

```js
window.__pcopt.selftest()   // runs the optimizer invariants on the live save and on synthetic cases
```

It logs one `[pcopt] selftest:` line per check and returns `{ ok, ms, results }`. The checks, as the code names them:

- `legend zone data`
- `elite tier parses both language packs`
- `fire+steel boss gets no DoT and no para credit`
- `elite boss power uses ELITE_P`
- `legend pool is level 100`
- `legend team is one per species`
- `elite team respects ELITE.LEGENDS`
- `legend refine never lowers the score`
- `refined team stays one per species`
- `shiny + plain of one species never both picked`
- `elite caps the legendaries`
- `no legend cap outside elite`
- `raid pool is level 100`
- `raid picks are survival weighted`
- `raid picks respect RAID.MINE`
- `2-round glass cannon ranks below a survivor at R=10`
- `no roamer out, the plan is unchanged`
- `roamer node becomes a level-100 boss`
- `caught roamer is not a boss`

Actions are logged to the console with a `[pcopt]` prefix: bundle tables, cache hits, chart source, optimizer runs and teams, applied slots, picker mounts, refine gains and errors. The last 400 entries are in `window.__pcopt.logs`.

## Development

The project is one file with no build step. Edit `pokecatch-team-optimizer.user.js`, then reload the game with the script installed (or paste an edited copy into Tampermonkey). The code is organised as one section per concern, with the section map above matching the file.

A version bump goes in the `@version` header and in the `VERSION` constant near the top; the dashboard and the update check read the constant. On each page load the script fetches the raw file from GitHub once and shows an update line when the repository's `@version` is newer. Tampermonkey also updates through `@updateURL` and `@downloadURL`; GitHub raw caches for about 5 minutes.

## Notes and limits

- **Levels.** Legend and raid pools are level-100 only, as in the game's own pickers. The chapter optimizer projects at the current chapter cap; the underground's guards are level 100 and its PC candidates can be any level.
- **Eligibility.** The chapter and underground pickers apply the region link. The legend and raid pickers skip it. This matches the game's own `allow` rules.
- **Shiny** mons get the game's `SHINY_STAT_BONUS` (10 % in the current bundle) on every stat and are marked `✨`.
- **Evolutions** within the cap are projected with the game's gates listed above. The game's dex-dedup rule for evolutions is not modeled.
- **Raids** rank by DPS and survival; the fight is not simulated round by round.
- The world-boss attack picker is not covered.
- **The underground theme** is matched from the type badges in the picker header, with the label the game puts there as a fallback (its config name stays French, whatever language the interface is in). If a future language pack translates that label, the block stays hidden rather than guessing a theme.
- **The roamer's rage burst** (its burst move) is averaged into one strong per-round attack in the chapter sim. The chapter line's capture chance is a one-ball estimate, and no roamer fight is replayed round by round.
- The simulator is a model: it uses the game's formulas and probabilities.
