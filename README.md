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

## Using it

| Panel button | What it does |
|---|---|
| **Defense / Offense / Balanced** | Chooses the scoring preset: incoming damage, outgoing damage, or both. |
| **optimize** | Reads the chapter events + your PC and computes the best team of 6. |
| **apply to team** | Puts the recommended team into the game (drag & drop on the real UI). |
| **watch for wipes** | Records every wipe: the step it happened on, the first step where a member fell, the foes and your team at that moment. The watcher resets itself as soon as the team is back up, so the next wipe is recorded too. |
| **moves** (per Pokémon) | Opens the game's own *moves panel* for that Pokémon — the authoritative learnset. |
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
  game's own algorithm, so it matches the *moves panel* exactly (verified species by species).
* **https://pokemondb.net/type** — the type chart (it is identical to the chart the game uses).
* **https://pokeapi.co/api/v2** — cross-check of species types and level-up learnsets, and a
  fallback source for the type chart.

Everything is cached in the userscript storage, keyed by the bundle hash, so a game update
invalidates the cache automatically.

## Notes / limits

* The team is evaluated at the **chapter cap** (the maximum level you can reach in the
  chapter), which is what the game will let your Pokémon reach anyway.
* **Shiny Pokémon get the game's +10 % stat bonus** (all stats and HP), exactly like in game —
  a shiny is scored with the boosted stats and marked with ✨ in the panel.
* Only Pokémon that the game currently accepts in the team are considered (region link,
  duplicates, one Pokémon per species).
* Random trainers (the ones you meet on the routes) have a random team; the script uses the
  wild encounters of the same route for them and the fixed teams (gym leader, story trainers)
  as they are.
* The weekly **raid** bosses are not modelled yet — only the legend zones.
