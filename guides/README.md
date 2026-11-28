# Community guides — ingestion and regeneration

Nine player-made infographics by **@destryyy**, transcribed into one JSON per board
(`guides/data/*.json`), embedded into the userscript by `tools/embed-guides.mjs`,
and re-validated after every game update by `tools/regen-guides.mjs`.

The boards themselves (PNGs) are third-party work and are **not committed**. Each
JSON keeps the credit, the board title, the game version/build and the source image
name.

## Layout

```
guides/
  README.md
  data/
    underground.json      id underground    Underground Expedition Picks
    farming.json          id farming        Auto-Replay Farming Guide
    berry.json            id berry          Berry Farming Guide
    overnight.json        id overnight      Overnight Farming
    gem-tiers.json        id gem-tiers      Legendary Gem Tier List *0 → *5
    ru-tiers.json         id ru-tiers       Rare & Uncommon Investment Tier List
    type-picks.json       id type-picks     Best by Type
    catch-teams.json      id catch-teams    Catch Teams (plain fights)
    elite2-teams.json     id elite2-teams   Team Recommendations Elite II fights
tools/
  embed-guides.mjs
  regen-guides.mjs
```

## Envelope

Every file carries the same outer fields:

- `id`, `title`, `subject`, `credit` (`@destryyy`), `ingested`
- `board`: `gameVersion`, `build`, `pulled`, `title`
- `sourceImage`: the board's file name
- `method`: `summary`, `algorithm` (`goal`, `engine`, `steps`, `parameters`, `acceptance`), `gameFacts`,
  plus the blocks the board needs: `measurement` and `changes` on `gem-tiers`, `layout` on `ru-tiers`
- `data`: the board's own tables (shape per guide, see the files)
- `uncertain`: every value the OCR left ambiguous, with what was done instead

`method` is the re-runnable part: the algorithm records the engine and build, the
ordered steps, the parameter values and the acceptance rules, so a later round can
re-run the same methodology on a new build without the image.

## Tools

### `node tools/embed-guides.mjs`

- Reads the nine files in the fixed id order, validates the envelope and each data
  shape (missing/empty top-level keys fail).
- Refuses duplicate ids, missing files, parse errors (exit 1, names the file).
- Replaces the block between the two markers in `pokecatch-team-optimizer.user.js`:
  - `/* ---------- 9c-0. COMMUNITY GUIDES DATA ... */`
  - `/* ---------- end of generated guides data ---------- */`
- Writes one pretty-printed `const GUIDES = { ... };` literal. JSON is a JS subset,
  so the literal is safe and stable. Running twice with unchanged JSONs is a no-op.

### `node tools/regen-guides.mjs`

Run after a game update or a new ingestion round:

1. Fetches `https://pokecatch-online.pages.dev/boot.js`, takes the `app.<hash>.js`
   bundle and the `lang-en.<hash>.js` pack from the manifest.
2. Builds the English name → dex id map from the Pokédex literal, the `FORMS`
   array and the English pack (`I18N_DATA.en.pokemon`, `I18N.en` for form names).
3. Resolves every species/form `name` in the nine guides, plus every `gemTypes`
   list against the species' real types, the Underground theme keys against
   `THEMES`, and the 18 canonical types in `type-picks`. Any unresolved species,
   gem type or theme exits 1. Chapter/loop/map names are warning-only: the boards
   use loose English, the bundle ships French chapter names.
4. Recomputes the Arceus-shield attackers (`2 × max(Atk, SpA) + 5` at Lv 100,
   neutral, no IVs) and diffs the stored `catch-teams.data.shield` lists.
5. Exits 0 with per-guide resolved counts. Any stored shield mismatch is printed
   but does not fail the run (the name/theme checks do).

Name matching is normalized (lowercase, accents stripped, punctuation and word
order ignored). Forms match through `Base + form name` and through the form slug,
which covers the board spellings `White Kyurem`, `Arceus Rock`, `Deoxys Attack`,
`Rotom (Frost)`, `Landorus Therian`, `Giratina Origin`, `Genesect Chill`,
`Meloetta Pirouette` and `Shaymin Sky`. No alias file is needed on the current
bundle; if a future update renames forms, add a small alias table here rather than
editing every JSON.

The tools use only Node ≥ 18 built-ins and global `fetch`. The userscript never
writes to the save and never calls the game server; only these dev-time tools
fetch the public bundle and language pack.

## Regeneration round

1. Re-OCR the new boards (or read the new numbers) and update the affected JSONs.
2. `node tools/embed-guides.mjs` — validates and embeds.
3. `node tools/regen-guides.mjs` — live names, gem types, themes and shield diff.
4. `node --check pokecatch-team-optimizer.user.js`.
5. In the game: `window.__pcopt.selftest()`; open Helper in the side nav and walk
   each tab (search, region filters, expand a card, the Elite II `→ fight` links).

## OCR notes

- Status tags: `s_p`, `sip`, `sLP` = SLP; `cNF`/`cnr` = CNF; `psn`/`PsN` = PSN;
  `BRN` = burn; `par`/`PAR` = paralysis; `FRz`/`Frz` = freeze.
- `(Gan)`, `(san)`, `(gan)` after an alternate's name = `(Ban)`: that alternate
  comes with its own move bans, listed in the card's
  "BANS OF THE ALTERNATES MARKED BAN" section.
- Sprite/gem-chip/rank glyph garble (`@D @Q GD GB £1 fi «1 #1`) is dropped.
- The two tier boards (`legendary-rank-tiers-2.png`, `rare-uncommon-tiers-2.png`) are
  read from the picture itself, not OCR: crop a row with `pngcrop.py` and read the
  names and scores, then measure the gem board's bars with `barmeasure.py` (76px is
  the full track). OCR mangled both boards' columns into shifted lists.
- Team-board headers: `0:52` is one fight's time, `69 wins/h` wins per hour,
  `LESSER LEGENDARIES ALLOWED` is the first team, `WITHOUT/NO ANY LEGENDARY` the
  second, `BANS +N%` the wins/h the bans add.
- Values the OCR could not settle are listed in each file's `uncertain`; nothing
  was invented to fill a gap.
