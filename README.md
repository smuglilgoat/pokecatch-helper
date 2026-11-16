# Poke'Catch Team Optimizer

A Tampermonkey helper for [Poke'Catch](https://pokecatch-online.netlify.app/) that

1. reads the **events of the current chapter** (wild encounters, story trainers and the gym leader),
2. **watches the team** and records **on which step the team falls** when it is wiped,
3. builds an **optimal team of 6** out of your PC with three presets: **Defense**, **Offense** and **Balanced**,
4. can **apply** that team to the game (it drags the Pokémon into the team slots like a player would).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `pokecatch-team-optimizer.user.js` → Tampermonkey offers to install it.
3. Open <https://pokecatch-online.netlify.app/> and log in to your account. A small
   **Poke'Catch Optimizer** panel appears in the bottom-right corner.

## Using it

| Panel button | What it does |
|---|---|
| **Defense / Offense / Balanced** | Chooses the scoring preset: incoming damage, outgoing damage, or both. |
| **optimize** | Reads the chapter events + your PC and computes the best team of 6. |
| **apply to team** | Puts the recommended team into the game (drag & drop on the real UI). |
| **watch for wipes** | Records every wipe: the step it happened on, the foes, and your team at that moment. A wipe also triggers a new optimisation. |
| **moves** (per Pokémon) | Opens the game's own *moves panel* for that Pokémon — the authoritative learnset. |
| **api** (per Pokémon) | Fetches the same species from [PokéAPI](https://pokeapi.co/api/v2) and shows its canonical types/learnset next to the game's freer one. |

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
* Only Pokémon that the game currently accepts in the team are considered (region link,
  duplicates, one Pokémon per species).
* Random trainers (the ones you meet on the routes) have a random team; the script uses the
  wild encounters of the same route for them and the fixed teams (gym leader, story trainers)
  as they are.
