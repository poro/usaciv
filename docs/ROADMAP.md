# Roadmap

usaciv is the **base engine**: the real United States on a 25 km hex grid, built from 31 public data sources, with
the map, lenses, City View and Advisors. On top of it sit **game modes** that players pick from the **Play** menu.
**Explore** (the original visualizer) stays the default.

| Mode | One line | Players (now) | Players (later) |
|---|---|---|---|
| **Explore** | The original data map | n/a | n/a |
| **Which Metro?** | A daily data puzzle: guess the metro from its workforce, industries and yields | Single player, daily seed | Shared daily leaderboard, head-to-head races |
| **Mainline** | Lay rail across the real map, 2026→2050. Real freight is demand and real disaster risk is the enemy | Single player vs. "baseline America" | AI rival companies; online versus; co-op with one region each |
| **Founders** | An empty America with real terrain and resources: found cities, grow, compare with the real country | Single player | Hotseat, then online 2–4 players |

The design notes for each game are in [GAME_PLAN.md](GAME_PLAN.md).

## Principles

- **Single player first.** Every mode must be fun alone before multiplayer is added.
- **Deterministic simulations.** Game logic lives in `web/js/games/<mode>/sim/` as pure functions:
  `(state, action, rng) → state`, with a seeded RNG and no DOM. That keeps it unit-testable (`node --test`). It
  also makes multiplayer straightforward later: send actions, not state, and replay them on every client.
- **No build step, no npm.** The engine's rule stays: plain ES modules and Canvas 2D.
- **Real numbers stay honest.** Game numbers derived from data say so. Tooltips show the real figure and its source.
- **Original names.** No names, art or rules taken from commercial games. The data's district names are plain,
  descriptive names (see Phase 0).

## Phase 0: engine and framework (now)

- [x] Private repo `poro/usaciv`, starting from the original source (MIT, credit kept).
- [x] Rename the city districts to plain names, in the pipeline, the data, the UI, the tests and the docs:

  | Old id / name | New id / name |
  |---|---|
  | `campus` Campus | `research_park` Research Park |
  | `commercial_hub` Commercial hub | `financial_district` Financial District |
  | `industrial_zone` Industrial zone | `industrial_park` Industrial Park |
  | `harbor` Harbor | `port_district` Port District |
  | `theater_square` Theater square | `arts_district` Arts District |
  | `entertainment_complex` Entertainment complex | `leisure_district` Leisure District |
  | `aerodrome` Aerodrome | `aviation_hub` Aviation Hub |
  | `government_plaza` Government plaza | `civic_center` Civic Center |
  | `encampment` Encampment | `defense_district` Defense District |
  | `aqueduct` Aqueduct & dam | `utility_district` Utility District |

- [ ] Game-mode framework: `web/js/games/` (a registry, the Play menu, a mode host with automatic cleanup, a seeded
  RNG, hex-map helpers and pathfinding, and namespaced saves). URL: `#play=<mode>`.
- [ ] `node --test tests/js` for the shared helpers and each game's simulation.

## Phase 1: single-player games (v0.1, playable)

**Which Metro?** (smallest; first to be playable)
- 5 rounds a day from a date seed. Clues are revealed one at a time (workforce figures → district mix → yields →
  region), and fewer clues means more points. Guess with city search.
- Streaks and stats in localStorage. A spoiler-free share text (grid of squares).
- Practice mode with a random seed.

**Mainline** (milestones M0–M4 in GAME_PLAN.md)
- Lay rail hex to hex, with costs from terrain and discounts for upgrading real rail. Budget, End Turn, 2026–2050.
- Contracts from the 40 real FAF freight flows plus gravity-model contracts (labelled as a model). Connected cities
  grow faster than their real trend.
- Disasters rolled from real FEMA county rates. Damage, repair, hardening.
- Score against baseline America, an end screen, scenarios (Texas Triangle, Rust to Rail, Western Grid, Sandbox).

**Founders**
- Start with one settler on real terrain. Hex output comes from real land cover, relief, rivers and resource sites.
- Found cities, claim hexes, grow population, build simple improvements. A fixed number of turns.
- No combat in v0.1. The end screen compares your settlement pattern with where Americans actually live (overlap
  with real metros, population, output).

## Phase 2: polish (v0.2)

- Tutorials, sound, phone layout for every mode, share images of end screens (reuse `render/snapshot.js`).
- Mainline: power and fibre networks; train animation (overlay only, only while playing).
- Founders: more improvements, events, and a simple AI neighbour.
- A `pipeline/build/game.py` builder for richer data: hundreds of FAF flows, per-hex hazard rates, per-hex build costs.

## Phase 3: accounts and multiplayer (v0.3+)

The static site stays static. Multiplayer is added as a small backend next to it.

- **Hosting:** Cloudflare Workers + Durable Objects (one object per game room) + D1 for accounts and leaderboards.
  This matches the hosting already used for your other projects.
- **Login:** passwordless email links plus Google/Apple OAuth. Guests can always play single player with no account.
- **Async first:**
  - a daily leaderboard for Which Metro?
  - a shared seed, best-score board for Mainline scenarios
- **Real time:**
  - Which Metro? head-to-head races
  - Mainline versus (rivals bid for the same contracts)
  - Founders 2–4 players with simultaneous turns
- **Netcode:** lockstep over WebSocket. Clients send actions; the room's Durable Object checks each action against the
  same `sim/` code (shared ES modules), orders the actions and broadcasts them. This works because the simulations
  are deterministic.
- **Co-op with an AI partner** (Mainline, Founders): the turn state is small JSON, so an LLM can play a region as a
  teammate. This links to the human+AI teamwork research in HybridGame.

## Later ideas

- Alaska and Hawaii insets; an elections lens; a time slider; USDA crops as resources (from the original README).
- A level editor for scenarios; mods as extra `web/js/games/<mode>/` folders.
