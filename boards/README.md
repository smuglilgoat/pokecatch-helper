# Source board images

Nine community infographics by **@destryyy** (the in-game helper's community
boards), pulled in November 2026 for the game build in `guides/data/*.json`.
They are the transcription ground truth for `guides/data/*.json`: every name,
rate, share, ban and tier in those files was read from these images. The PNGs
are third-party work, so `.gitignore` keeps them out of git; this note does not.

One board per guide file:

- `underground-guide-2.png` — `underground.json` (Underground Expedition Picks)
- `farming-guide-2.png` — `farming.json` (Auto-Replay Farming Guide)
- `berry-guide-2.png` — `berry.json` (Berry Farming Guide)
- `overnight.png` — `overnight.json` (Overnight Farming; source image `image-2.png` in the JSON)
- `legendary-rank-tiers-2.png` — `gem-tiers.json` (Legendary Gem Tier List *0 → *5)
- `rare-uncommon-tiers-2.png` — `ru-tiers.json` (Rare & Uncommon Investment Tier List)
- `type_picks-2.png` — `type-picks.json` (Best by Type)
- `catch_teams-2.png` — `catch-teams.json` (Catch Teams, plain fights)
- `elite2-teams.png` — `elite2-teams.json` (Team Recommendations Elite II fights)

The board's game version, build and pull date are in each JSON's `board` field.
Re-read a board with the helpers in `tools/` (`pngcrop.py`, `chipread.py`); the
method and the OCR decoding table are in `guides/README.md`.
