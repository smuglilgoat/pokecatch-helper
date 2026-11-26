# Poke'Catch Team Optimizer

[![version](https://img.shields.io/badge/dynamic/regex?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsmuglilgoat%2Fpokecatch-helper%2Fmain%2Fpokecatch-team-optimizer.user.js&search=%40version%5Cs%2B%28%5Cd%2B%5C.%5Cd%2B%5C.%5Cd%2B%29&replace=%241&label=version&color=2f6fe4)](https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js)
[![last commit](https://img.shields.io/github/last-commit/smuglilgoat/pokecatch-helper)](https://github.com/smuglilgoat/pokecatch-helper/commits/main)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-00a94f?style=flat)](https://www.tampermonkey.net/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6fe4?style=flat)](LICENSE)

Tampermonkey userscript that simulates Poke'Catch's fights and fills the game's own team slots with the result.

[Poke'Catch](https://pokecatch-online.app/) is a browser monster-catching game whose Optimize button fills a team greedily. This script parses the game's bundle, runs the game's battle formulas in the page, and searches for teams that win the fight in front of you: the running chapter, a legendary or elite zone, the underground, or a shiny raid. It clicks the game's buttons and drags mons into its slots. The save is read, never written.

## Install

Requires [Tampermonkey](https://www.tampermonkey.net/) and a Poke'Catch account.

**From GitHub**

1. Install Tampermonkey.
2. Open the raw userscript: https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js. Tampermonkey shows its install screen; confirm it.
3. Open the game and log in. The script's panels appear on Progress and Team/PC, and inside the game's team pickers.

`@updateURL` and `@downloadURL` point at that file, so Tampermonkey updates the script in place. Each page load also fetches it once to compare versions, and the dashboard shows a notice when GitHub's copy differs.

**From a local copy** (when editing)

```bash
python3 -m http.server 8765
```

Open `http://localhost:8765/pokecatch-team-optimizer.user.js`, accept Tampermonkey's prompt, reload the game. Reopen the URL after an edit to reinstall the changed file.

## Features

- **Chapter optimizer**: simulates the live chapter node by node and fields the best six into the game's slots
- **Segment teams**: one prepared template per stretch between Pokémon Centers, switched before each heal
- **Legendary and elite**: win and catch odds, expected runs, and a team from your level-100 mons
- **Underground**: a team against the theme's guard pool
- **Shiny raids**: fastest clear, ranked by damage and survival
- **Roamer hunt**: restarts the roaming legendary's chapter until it is caught
- **Item Hunter**: pick a farmable story item and the chapter reruns until it drops
- **Pokémon hunter**: pick a missing mon with a weather, night/day or season spawn and the script restarts its chapter inside the next window, then goes back to watching
- **Dashboard**: run state, data source, errors, and the hunts on the Progress screen
- **English names**: bundle ids read through the game's English language pack
- **Selftest**: 60 optimizer invariants against the live save and synthetic cases

## Where the blocks appear

| Screen | What the script adds |
|---|---|
| Progress | Dashboard with chapter and step, level cap, eligible mons, data source, errors, and the roamer hunt, item hunter and Pokémon hunter card rows |
| Team/PC | Chapter optimizer with simulate line, team rows, template select and apply, segment rows |
| Adventure | A copy of the game's template bar; one click loads a template. The chapter list shows legend zones first |
| Legend, elite, underground and raid pickers | The optimizer beside the game's own Optimize button, with odds and apply to team. Elite fights also get the gold Optimize button back in the picker header, wired to the script's optimizer |
| PC grid | A blue marker on each mon the script picked, gold when the game's own ranking agrees |

## Pacing

The roamer hunt, the item hunter and the Pokémon hunter share one restart gate: one chapter restart every 10–14 s, at most 120 per rolling hour, then a 10-minute rest. All three wait out a paused adventure and stop when an event, legend zone, league or tower run starts; the item hunter also waits for a day, night or tide-gated zone. The Pokémon hunter watches outside its spawn window and stops the item hunter while it works, then hands the map back and resumes it when the window closes. None of them survives a reload; the game's chapter loop they switched on stays in the save — turn it off on the map.

## Screenshots

> TODO: none committed yet. Needed: the Progress dashboard with the chapter, roamer hunt, item hunter and Pokémon hunter blocks; the Team/PC chapter optimizer with its simulate line.
>
> Alt text to use: `Progress screen: chapter dashboard, roamer hunt, item hunter and Pokémon hunter` and `Team/PC screen: chapter optimizer with simulate line and segment rows`.

## Development

No build step and no dependencies: one file, `pokecatch-team-optimizer.user.js`. Edit it, then reinstall through one of the methods above.

```bash
node --check pokecatch-team-optimizer.user.js
```

The script logs every action with `[pcopt]`, and the last 400 entries stay in `window.__pcopt.logs`. In the game console, `window.__pcopt.selftest()` runs the 60 checks and returns `{ ok, ms, results }`. `window.__pcopt.compareWithPokeApi(uid, info)` cross-checks one mon against PokeAPI; no button calls it.

Two places carry the version: `@version` in the header and the `VERSION` constant near the top.

The file is one IIFE in numbered sections: 0 helpers, 1 game data from the bundle, 2 type chart, 3 save access, 4 battle math, 5 chapter events, 6 optimizers (6c chapter simulation, 6b legendary fights), 7 roamer hunt (7b item hunter, 7c Pokémon hunter), 8 team editing (8b PokéAPI cross-check and shiny raids, 8c in-game picker controls), 9 UI (9b blocks mounted in the game's screens), 10 boot and actions. `grep -n '^ *\* [0-9]' pokecatch-team-optimizer.user.js` lists them.

## Contributing

Small single-file project. Open an issue before a large change, keep the diff inside the userscript, and run the selftest plus `node --check` before sending it.

## Credits

[Poke'Catch](https://pokecatch-online.app/) by its authors; type chart from [pokemondb.net](https://pokemondb.net/type), with [PokéAPI](https://pokeapi.co/) as the optional cross-check; written by GrumpyOwl.

## License

MIT — see [LICENSE](LICENSE).
