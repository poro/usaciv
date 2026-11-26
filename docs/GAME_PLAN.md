# Game plan: building a game on usaciv

Working title: **Mainline**: build the network that carries the real America to 2050.

Status: a plan. No game code exists yet. Written 2026-11-26 against the usaciv source in this folder.

## 1. What the data is good for (and what it is not)

usaciv already has everything a network game needs, on one 25 km hex grid (4,807 US land hexes):

| Game need | Already in `web/data/` |
|---|---|
| Terrain and build cost | `world.json`: `relief` (flat/hills/mountains/peaks), `water` (ocean/coast/lake), `cover` (forest, wetland, urban…), `elev`, rivers |
| Places that want things | `cities.json`: 524 cities (383 metros) with population, GDP, five yields, member hexes (`footprint`), growth for 2021–2025 and a yearly `pop_series` |
| Things to connect | `resources.json`: 621 sites (wind 97, coal plants 70, solar 66, hydro 56, nuclear 54, mines, oil and gas plays…) |
| Demand between places | `trade.json`: the 40 largest interstate freight flows (FAF5), with value, tonnage, mode split and a road-following path |
| Existing network | `infrastructure.json`: Interstate and highway links, rail links, 136 ports, 368 airports, all as hex-to-hex links |
| Risk | `disasters.json`: FEMA major-disaster declarations per county by type (2000–now) and NOAA billion-dollar costs by state |
| Landmarks | `wonders.json` (52), `military.json` (660 installations) |

What it is **not**: history. Apart from population for 2020–2025, everything is a present-day snapshot. So a game
that starts **today and plays forward** fits the data. A game that starts in 1776 would mean inventing most of the
numbers.

## 2. Three concepts, one recommended

| | **A. Mainline** (recommended) | B. Founders | C. Which Metro? |
|---|---|---|---|
| Pitch | Lay rail, power lines and fibre across the real map, 2026→2050. Real cities and freight flows are your demand. Real disaster risk is your enemy. | An empty America: real terrain and resources, no cities. Settle it and compare your country to the real one. | A daily puzzle: you see a metro's citizens, districts and yields and guess which city it is. |
| Genre | Network/logistics strategy (in the tradition of rail and transit builders) | 4X | Data trivia |
| Data fit | Excellent: uses almost every file as it is | Good for terrain; cities and yields would be invented | Excellent, but only uses the City View |
| Scope to a fun first version | About 1 week | Several weeks (AI rivals, combat, balance) | 1–2 days |
| Risk | Balancing money at real GDP scale | Becomes a clone of the genre's big name; most numbers made up | Shallow; replay value comes only from the daily seed |

**Recommendation: A.** It is the only option where the real numbers drive the gameplay, rather than decorating it, and
that is the point of usaciv. C is a good one-day side project to ship first if you want something live quickly. It
reuses the City View and tests the extension approach.

## 3. Mainline: the design

### Fantasy
You run a new national infrastructure company. Each turn is one year, from 2026 to 2050 (25 turns). You start
with a home metro and a budget. You win by connecting the country's real economic flows better and more
resiliently than the "baseline America" that simply keeps its current growth.

### Core loop (one turn)
1. **Income.** Each contract you serve pays out (see Demand). Connected cities pay a small share of their GDP growth.
2. **Build.** Spend on:
   - **Links** between neighbouring hexes: freight rail, high-voltage line or fibre. The cost comes from `relief`,
     water crossings (`water`), wetland and urban `cover`, and river crossings. Where real infrastructure exists, you
     **upgrade** at a discount: a real rail link costs much less to double-track than building in open country.
   - **Hubs**: upgrade a real port or airport, or build a terminal in a city hex.
   - **Hardening** a link or hub against one hazard type (levees, firebreaks, buried lines).
3. **Demand resolves.** Contracts whose two ends are connected by your network deliver. Their pay scales with the
   real flow value and drops with path length against the straight-line distance (detours cost).
4. **Growth.** Every city grows along its real 2021–2025 trend (`growth`). Cities on your network grow faster: a
   bonus on connected yields (Production for freight, Science for fibre to a university wonder, Gold for power
   to industrial districts).
5. **Events.** Disasters are rolled for each county from its real FEMA rate by type: hurricanes on the Gulf and
   Atlantic coasts, fire in the West, floods along rivers, winter storms in the north. A hit damages unhardened links
   in that county's hexes until repaired. Show the real rate in the event card ("this county had 9 flood declarations
   in 26 years").
6. **Advisors report.** Reuse the existing advisors panels to show your network's share of GDP, risk exposure and
   unserved demand.

### Three kinds of demand (all from real data)
- **Freight contracts.** The 40 FAF routes in `trade.json` are the headline contracts. For example, New York–Boston is
  worth $61.9B of goods a year. Under them, a gravity model creates smaller contracts between cities
  (population × population ÷ distance²). These are labelled as a model in the UI, following the project's honesty
  rules.
- **Power contracts.** A real generation site (`resources.json` nuclear, hydro, wind, solar, gas, coal) can be wired
  to a city. The value comes from the site's MW and the city's population. Coal and gas sites carry a rising
  "transition cost" that grows each decade, which creates a real strategic tension without editorialising.
- **Talent contracts.** Fibre from an R1 university (`wonders.json`) to cities with Campus-type districts adds Science.

### Score and winning
- **Score** = GDP carried by your network in 2050, plus resilience (the share of contract value that survived
  disasters).
- **Baseline America** = the same cities growing on trend with no player network. Every run ends with
  "you vs. the baseline", per state, as a shareable image (reuse `render/snapshot.js`).
- **Scenarios** fix the start city, budget and region so runs are comparable:
  - *Texas Triangle*: Houston, Dallas, San Antonio and Austin, with hurricane risk.
  - *Rust to Rail*: rebuild Great Lakes freight with cheap upgrades of old rail.
  - *Western Grid*: wire Southwest solar and Pacific Northwest hydro to cities through mountains.
  - *Sandbox*: the whole lower 48.
  - *Daily*: a seeded scenario that everyone plays the same day (the seed is in the URL hash).

### Later: rivals and co-op
- **AI rival companies** bid for the same contracts. A simple greedy builder is enough at first.
- **Co-op with an AI partner:** each partner owns a region, and they share contracts that cross the border. This fits
  the human+AI teamwork research in HybridGame: the shared turn state is small JSON, so an LLM partner can read it
  and propose moves.

## 4. How it fits the code

The usaciv architecture already supports this without changing the core:

```
web/js/ext/game/
  index.js        install(app): registerMode("game"), top-bar button, hash key "game=<scenario>:<seed>"
  sim/            pure, deterministic game logic, no DOM: state.js, costs.js, contracts.js, events.js,
                  growth.js, score.js, rng.js (seeded). Every turn is a function: (state, actions, seed) → state
  layers.js       registerStaticLayer({id: "game-links", z: 56}) for built links; z 66 for hubs;
                  registerOverlay for the build cursor, path preview and (while playing only) moving trains
  ui/             ui.dock panels: budget, contract list, turn summary, event cards, end screen
web/js/ext/index.js   add "game" to the extensions it loads
tests/js/         node --test for sim/ (Node is already here; still no npm and no dependencies)
```

- **Rendering rule.** The map must not animate when idle. Trains animate only while the game is open and only on the
  overlay, never in the cached map.
- **Pathfinding.** `trade.json` paths already use a cost order (Interstate < major road < rail < open country <
  water). Reuse that idea for build-cost previews and for checking whether a contract is connected.
- **Save.** Use `localStorage` for the current run. The URL hash holds scenario and seed, so a link reproduces the
  same game.
- **Data.** The first version needs **no pipeline work**: everything it uses is already in `web/data/`. Later, add a
  `pipeline/build/game.py` builder that writes `game.json` with more FAF flows (hundreds, not 40), per-hex hazard
  rates and per-hex build costs. That needs the raw FAF5 and FEMA downloads (they are not in the zip; run
  `uv run python -m pipeline fetch faf5 fema_declarations` first).

## 5. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Skeleton | A "Play" button enters game mode. A seeded sim runs 25 empty turns. `node --test` passes. |
| M1 | Build | You can click hex to hex to lay rail. The cost preview follows terrain and existing rail. There is a budget and an End Turn button. Built links draw on the map. |
| M2 | Demand | FAF and gravity contracts appear. Connected contracts pay out. Connected cities grow faster. A contract panel lists open and served contracts. |
| M3 | Risk | Disasters are rolled from FEMA county rates. Links get damaged, repaired and hardened. Event cards quote the real rates. |
| M4 | Win | Score against the baseline, an end screen with a share image, and three scenarios plus Sandbox. |
| M5 | Feel | Train animation, sound (reuse the Web Audio approach from `web/dev/trailer/score.js`), a 3-step tutorial, phone layout. |
| M6 | Power and fibre | The second and third network types, with power and talent contracts. |
| Later | | AI rivals, co-op with an AI partner, the `game.json` builder, Alaska and Hawaii, the daily seed. |

M0–M4 make a playable, shareable game. A focused session can do M0–M2 in roughly a day of Claude time, and M3–M4 in
another. No multi-agent workflow is needed.

## 6. Decisions to make before starting

1. **Fork or extension?** The plan adds a `game` extension inside this copy. Decide whether this becomes your own
   repo (for example `poro/usaciv-game`) with the MIT notice kept.
2. **Rename the Civ-style district names before shipping a game.** `districts.json` uses names that come straight
   from a well-known commercial series (Campus, Theater Square, Encampment, Aqueduct, Aerodrome, Commercial Hub,
   Government Plaza…). They are fine in a data visualizer, but a game should use its own names (for example Research
   Park, Arts District, Garrison, Waterworks, Airfield, Market District, Civic Center). The same applies to "Gold",
   "Wonders" and "Advisors" in the game's own UI.
3. **Money scale.** Real GDP runs from millions to trillions. Use a log-scaled in-game currency, and show the real dollar
   figure in tooltips, so New York does not dwarf everything.
4. **Tone of disasters.** Use rates and types, never named real events with deaths, in random event cards.
5. **Scope of the map.** Keep the lower 48 to start (that is all the data covers). Alaska and Hawaii insets are a
   separate project.
