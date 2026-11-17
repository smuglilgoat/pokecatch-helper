# Poke'Catch Team Optimizer

A Tampermonkey helper for [Poke'Catch](https://pokecatch-online.netlify.app/) that

1. reads the **events of the current chapter** (wild encounters, story trainers and the gym leader),
2. **watches the team** and records **on which step the team falls** when it is wiped,
3. builds an **optimal team of 6** out of your PC with three presets: **Defense**, **Offense** and **Balanced**,
4. does the same for the **legendary bosses** (legend zones and their elite versions),
5. can **apply** that team to the game (it drags the Pokémon into the team slots like a player would).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `pokecatch-team-optimizer.user.js` → Tampermonkey offers to install it.
3. Open <https://pokecatch-online.netlify.app/> and log in to your account. A small
   **Team Optimizer** panel appears in the bottom-right corner. It is built from the game's own
   CSS (same buttons, badges, colours and light/dark theme), so it looks like part of the UI.
   Drag its left edge to widen it (the width is remembered), and use the `–` button to fold it.
   The panel only redraws when something actually changed, so it never flickers while the game
   plays in the background. All Pokémon and move names are shown in **English** (the game ships
   an English pack in every language; the script fetches it when missing).

## Using it

| Panel button | What it does |
|---|---|
| **Defense / Offense / Balanced** | Chooses the scoring preset: incoming damage, outgoing damage, or both. The switch sits next to the optimize button, and next to the boss choice for legendary fights — one click, one preset. |
| **optimize** | Reads the chapter events + your PC and computes the best team of 6. |
| **apply to team** | Puts the recommended team into the game (drag & drop on the real UI). |
| **watch for wipes** | Records every wipe: the chapter and step it happened on, the foes and your team at that moment. The game heals the team the instant it is wiped, so the "all knocked out" state never lasts; the watcher reads the game's own counters instead — `adv.deaths[chapter]` for a normal chapter, `adv.league.tries` for a league run, `adv.zone.tries` for an elite legend zone (the 2026-11 update stopped counting league and elite wipes in `deaths`). |
| **moves** (per Pokémon) | Opens the game's own *moves panel* for that Pokémon — the authoritative learnset. |
| **✨ Optimize (mine)** (in the game's picker) | My optimizer, inside the game's own team picker, right next to its Optimize button: it fills the slots and prints the fight's win/run/catch odds. |
| **✨ Optimize (mine)** (in Team/PC) | The chapter optimizer, inside the game's own Team/PC header: it picks the best six for the chapter you are running right now and puts them in your team. |
| **api** (per Pokémon) | Fetches the same species from [PokéAPI](https://pokeapi.co/api/v2) and shows its canonical types/learnset next to the game's freer one. |

### Legendary fight

The **Legendary fight** section lists the roaming legendaries (legend zones) of every region with
their game knobs (HP, damage, burst move) and the five **elite** tiers the game adds on top of them:

| Region | Bosses |
|---|---|
| Kanto | Zapdos, Articuno, Moltres, Mewtwo, Mew |
| Johto | Ho-Oh, Lugia, Celebi |
| Hoenn | Groudon, Kyogre, Rayquaza (+ Sky Pillar), Regirock/Regice/Registeel, Deoxys (+ forms) |
| Sinnoh | Dialga, Palkia, Giratina (+ Origin), Heatran, Regigigas, Cresselia, Darkrai, Arceus (+ Sky Forme), Mesprit, Azelf |
| Unova | Reshiram, Zekrom, Kyurem (+ Black/White), Victini, Cobalion/Terrakion/Virizion, Keldeo, Landorus (+ mirrors), Genesect (+ modules) |

Pick a boss and a tier, then **optimize for this boss**: the boss fights the whole team every round
(main move + burst + counter, the same way the game does it) and the boss scales with the team
(shiny and level raise the boss' HP and damage, like the game's aura scaling).

Under the boss the line tells you what the fight costs:

* **win %** — the victory chance, from 200 simulated fights with the game's rolls (0.85–1 damage
  variance, 1/24 crits, misses);
* **rounds ≈ time/run** — the length of one attempt (a round is ~2.5 s at the game's fast speed,
  scaled by your speed setting);
* **catch %/run** — the capture chance of one successful attempt, using the game's own formula
  (`captureRate × 0.6 / 255`, or the legendary rate `3/255`, times your capture-berry buff);
* **~N runs ≈ total time** — the expected attempts and wall-clock time to catch it, capped by the
  raid pity (150 tries).

### Inside the game: beside its own "Optimize" button

The game has its own **Optimize** button in the team picker it opens for a legendary zone, a raid
or the elite league. This helper adds its own row right beside it — **Defense / Offense / Balanced**,
**✨ Optimize (mine)** and the same win/run/catch line — and its button fills the game's own slots
with the team it computed, so the two optimizers sit side by side and both write to the game.

The same row also sits in the **Team/PC** header, aimed at the chapter you are currently running
(it shows the chapter, its foes and the cap), so you can re-optimise without leaving the screen.

A legendary fight is simulated at the level the game brings the team to — the **zone's level**
(100 for every legend zone), or the max level when you pick an elite tier — with the team at full
health, which is how a legendary fight always starts.

<figure the picker header: Optimize | Defense Offense Balanced | Optimize (mine) | win 100% · 11 rounds ≈ 30s/run · catch 1.2%/run · ~71 runs ≈ 35.7 min>

### How this compares to the game's own optimizer

Poke'Catch has an optimizer of its own, but it works on a different axis: the **auto-switch**
(option *Switch auto*, on by default) re-orders the Pokémon you already have by a **type-matchup
score** — `strong +3 / weak −3 / immune −5 / exposed −2 / resists +2` — against the enemy in front
of you. It never changes *which* Pokémon are in the team, and it looks at types only: no stats, no
levels, no damage numbers.

This helper keeps the same type logic but adds what the game leaves out: the real damage formula
(STAB, accuracy curve, crits, level gap, multi-hit, burn), the foe's own best move and damage
multipliers, the chapter's actual encounters, the legendary zone knobs and elite tiers, the
team-eligibility rules, and the fact that your team keeps its HP between fights.

### League chapters (the five Elite Four paths)

A league chapter is not one fight: it is the **four Elite Four members plus the champion**, each
its own mini path (a heal, the trainers on the way, then the member). The game therefore:

* **rewinds the whole league to the first member** after a wipe — so the first member is the real
  gate, whatever member you died to;
* **raises the level cap** for the league as you clear members (the cap is the next gym you still
  owe: `ace + 3` for an Elite Four chapter, `ace + 5` for the champion);
* **heals the team** between members (every member's path starts with a heal node).

The optimizer follows that: in a league it plans against **all five members** at once, each one
evaluated with the team at the level it will have reached by then, at full health.

### Scoring

* **Defense** – how many rounds the team survives against the chapter's foes.
* **Offense** – how much damage the team puts into them.
* **Balanced** – rounds survived ÷ rounds needed to win (the classic "turns to die / turns to kill" margin).

For a legendary boss the same three numbers are used, but the boss fights the **whole team** every
round (its best move ÷ 6, plus its burst and counter moves) and it **scales with your team**
(shiny and level raise the boss' HP and damage, exactly like the game's aura scaling).
Elite tiers add the game's per-species `[HP, damage]` multipliers and make the boss take less damage.

## Where the data comes from

* **The game itself** — the script parses the bundle the page already loaded
  (`bundle/app.<hash>.js`) and extracts the Pokédex, the move table, the evolutions, the
  chapter list and the encounter tables. The per-species learnset is recomputed with the
  game's own grading algorithm (the 2026-11 re-grading: a max 20-level gap between damaging
  moves, per-type level reassignment by weight, and a per-species 4–5 spacing step), so the
  recommended attacks are exactly the ones the game allows at the level cap — verified equal
  to the game's own algorithm on all 649 species.
* **https://pokemondb.net/type** — the type chart (it is identical to the chart the game uses).
* **https://pokeapi.co/api/v2** — cross-check of species types and level-up learnsets, and a
  fallback source for the type chart.

Everything is cached in the userscript storage, keyed by the bundle hash, so a game update
invalidates the cache automatically. The cached tables are validated on load (species, moves,
chapters): an implausible or half-read table is thrown away and parsed again instead of being
used.

## When the game updates

The game rewrites its bundle on every release, including the minified names the script reads.
The parser therefore never trusts a minified name: it locates each table by its public marker
(`a.POKEDEX=`, `a.CONFIG=`…) or by the shape of its data, and reads the legend zones through the
game's public `a.LegendZones` export. Each table is parsed on its own; a table the update broke
is reported by name in the panel (`bundle parse failed: game update changed the bundle: MOVES — …`)
while everything else keeps working.

Every action is logged to the browser console with a `[pcopt]` prefix — bundle fetch and parse
(with table sizes), cache hits, type-chart source, optimizer runs and their team, each applied
slot, picker/Team-PC injections, legendary runs and their odds, wipes and their mode, and every
error with its message. The last 400 entries are also available as `window.__pcopt.logs`.

The script declares an `@updateURL` pointing at the GitHub raw file, so Tampermonkey can pick up
fixes automatically (`@version` is bumped on each release).

## Notes / limits

* The team is evaluated at the **level cap** — the level the game lets your Pokémon reach right
  now (it stops their XP until you beat the next badge; the mon card then says *"Plafond Nv. 83"*).
  The cap is the game's own formula: the next gym you still owe, its *ace* level plus the league
  margin (so the Elite Four chapters give `ace + 3`). The panel shows it as *level cap* and writes
  every recommendation as `Lv74 → 83` (now → cap), because the team you will actually field is
  the one at the cap.
* **Shiny Pokémon get the game's +10 % stat bonus** (all stats and HP), exactly like in game —
  a shiny is scored with the boosted stats and marked with ✨ in the panel.
* Only Pokémon that the game currently accepts in the team are considered (region link,
  duplicates, one Pokémon per species).
* **Evolutions within the cap count.** The game evolves a mon by itself when it levels past
  its evolution level, so the team you field at the cap is its evolved form: the optimizer
  projects the whole evolution chain that the cap allows. Item evolutions are only counted
  when the item is in the bag of the current region (`fire-stone` at 0 means Growlithe stays
  Growlithe); trades and other gated evolutions are not projected, and a branching evolution
  takes the first reachable branch.
* Random trainers (the ones you meet on the routes) have a random team; the script uses the
  wild encounters of the same route for them and the fixed teams (gym leader, story trainers)
  as they are.
* The chapter's foes are read from the nodes the game itself built (`adv.nodes`), so trainer
  teams, levels and gym multipliers are the real ones; the static chapter data is only the
  fallback (and the source for the other members of a league).
* The weekly **raid** bosses are not modelled yet — only the legend zones.
