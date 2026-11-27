# Roadmap

usaciv is the **base engine**: the real United States on a 25 km hex grid, built from 31 public data sources, with
the map, lenses, City View and Advisors. On top of it sit **game modes** that players pick from the **Play** menu.
**Explore** (the original visualizer) stays the default.

| Mode | One line | Players (now) | Players (later) |
|---|---|---|---|
| **Explore** | The original data map | n/a | n/a |
| **Which Metro?** | A daily data puzzle: guess the metro from its workforce, industries and yields | Single player, daily seed | Shared daily leaderboard, head-to-head races |
| **Pinpoint** | Eight real places a day (metros, parks, universities, airports, ports, plants): click where each one is | Single player, daily seed + practice; daily board | Head-to-head races |
| **Metro Duel** | Higher or lower on real metro statistics; keep the streak alive | Single player, daily run of 30 + endless practice; daily board | Head-to-head |
| **Road Trip** | Visit six real metros and come home by the shortest loop | Single player, daily trip + practice; daily board | Head-to-head |
| **Lens Detective** | Name the hidden data lens colouring the map, from four choices | Single player, daily 6 + practice; daily board | |
| **Metro Ranking** | Five real metros, one statistic: put them in order, highest first | Single player, daily 5 + practice; daily board, races | |
| **State Shapes** | A state's outline on the hex map, alone: which one is it? | Single player, daily 8 + practice; daily board, races | |
| **Ballpark** | Estimate real numbers on a slider: metro statistics and distances | Single player, daily 6 + practice; daily board, races | |
| **Rail Link** | Join five real metros with the cheapest rail network you can find; beat par | Single player, daily puzzle + practice; daily board, races | |
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

- [x] Repo `poro/usaciv` (public), starting from the original source (MIT, credit kept). Live at
  https://usaciv.mark-ollila.workers.dev, auto-deployed from `main`; data refreshed monthly by a GitHub Action.
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

- [x] Game-mode framework: `web/js/games/` (a registry, the Play menu, a mode host with automatic cleanup, a seeded
  RNG, hex-map helpers and pathfinding, and namespaced saves). URL: `#play=<mode>`.
- [x] `node --test tests/js/*.test.mjs` for the shared helpers and each game's simulation.

## Phase 1: single-player games (v0.1, playable): shipped 2026-11-26

All three are live. Polished 2026-11-26: Mainline has upgrades, express services, a frontier grant for remote
Sandbox homes, a share image and a tutorial; Founders has turn helpers and a tutorial, and hides the real cities
fully; Which Metro? clues no longer give away the biggest metros, landscape phones have a layout, and the reveal
labels the answer and each wrong guess on the map.

**Which Metro?** ✅ (smallest; first to be playable)
- 5 rounds a day from a date seed. Clues are revealed one at a time (job mix in five groups → how people live:
  age, driving, schooling → size band, transit, birthplace and wealth per person → districts and industries →
  region), and fewer clues means more points. Guess with city search.
- No clue before the last shows absolute size (population is a band, yields are per 1,000 residents, industries
  are shares of jobs), so the biggest metros are not given away by their counts. `tests/js/whichMetro.ambiguity.mjs`
  measures how many metros each clue leaves plausible; tests keep clue 1 from ever singling one out, and clues 1-2
  at a median of 4 or more plausible metros with none of the 10 biggest alone (2026-11-26: 28 → 9 → 1 → 1).
- At the reveal the game's own overlay names the answer (a gold plate, even for small metros the banners skip) and
  each wrong guess (a red plate with its distance, a dashed line to the answer; far guesses sit at the view's edge).
- Landscape phones get the side dock (narrowed, controls pinned above the scrolling clues), not the bottom sheet.
- Streaks and stats in localStorage. A spoiler-free share text (grid of squares).
- Practice mode with a random seed.

**Mainline** ✅ (milestones M0–M4 in GAME_PLAN.md)
- Lay rail hex to hex, with costs from terrain and discounts for upgrading real rail. Budget, End Turn, 2026–2050.
- Contracts from the 40 real FAF freight flows plus gravity-model contracts (labelled as a model). Connected cities
  grow faster than their real trend.
- Disasters rolled from real FEMA county rates. Damage, repair, hardening.
- Score against baseline America, an end screen, scenarios (Texas Triangle, Rust to Rail, Western Grid, Sandbox).
- Upgrades: double track, terminals (real ports and cargo airports), hardening per hazard, and express services (the
  late-game project: passenger and express trains on all-double-track corridors that speed growth at every stop; a
  game model). Sandbox homes with little freight nearby get a frontier grant (a game model for balance).

**Founders** ✅
- Start with one settler on real terrain. Hex output comes from real land cover, relief, rivers and resource sites.
- Found cities, claim hexes, grow population, build simple improvements. A fixed number of turns.
- No combat in v0.1. The end screen compares your settlement pattern with where Americans actually live (overlap
  with real metros, population, output).

## New mode: Pinpoint (2026-11-27)

- `web/js/games/pinpoint/`: a geography game on the real map. Each UTC day brings eight places for everyone, one from
  each pool: a big, a mid-size and a small metro (Census), a national park or landmark and a research university
  (wonders.json), an airport (FAA boardings), a port (USACE tonnage) and a big power plant or dam (EIA-860M).
- Click a hex: 1,000 points within one hex (25 km), one point less per km beyond, 0 from about 1,025 km. The reveal
  draws your guess, the answer and the distance; the end screen maps all eight and gives a share grid (🟩🟨🟧🟥).
- City banners, tooltips, resource icons and map layers are hidden while you play. Practice rounds by seed
  (`#play=pinpoint~p-<seed>`). Today's game resumes after a reload.
- Board: the server rebuilds the day's rounds from the same data and scores the eight guessed hexes itself
  (`/api/pp/daily`, docs/MULTIPLAYER.md).

## New mode: Metro Duel (2026-11-27)

- `web/js/games/duel/`: two real metros and one statistic (population, median income, rent, home value,
  unemployment, GDP per person, population growth since 2021; Census ACS, BEA, Census estimates). Is the second one
  higher or lower? A right answer makes it the next metro to beat, with a new statistic; the first miss ends the run.
- Gaps start wide and narrow as the streak grows (never under 4%). Both metros are lit and labelled A/B on the map;
  city banners are hidden because they show population.
- Today's run is 30 duels, the same for everyone (resumes after a reload); practice runs are endless. Board: the
  server rebuilds the day's duels and counts the streak (`/api/duel/daily`).

## New mode: Road Trip (2026-11-27)

- `web/js/games/trip/`: a start metro and six others within 900 km. Click the stops in the order you would drive;
  the loop closes back home. The best loop is found exactly (all 720 orders); score = 1000 × (best ÷ yours)⁴, so a
  loop 10% longer than the best scores 683. The end screen draws your route and the best one.
- One trip a day for everyone (resumes after a reload), practice trips by seed; the server rebuilds the trip and scores
  the order (`/api/trip/daily`).
- **Play menu:** every daily card now shows today's status (`/api/today`): how many played, and your score and rank.

## New mode: Lens Detective (2026-11-27)

- `web/js/games/lens/`: each round colours the map by one of the 18 numeric data lenses with its name, legend, lens
  dock, tooltips and URL hash hidden (`app.setLensSecret`); pick it from four choices (one decoy usually from the same
  family). Six rounds a day for everyone, practice by seed, keys 1–4; the server rebuilds the rounds from
  lenses.json and scores the picks (`/api/lens/daily`). It doubles as a tour of what the lenses show.

## New mode: Metro Ranking (2026-11-27)

- `web/js/games/rank/`: five real metros and one of Metro Duel's statistics (population, income, rent, home value,
  unemployment, GDP per person, growth, job mix). Click them highest first, in the panel or on the map (keys A–E or
  1–5, Backspace to undo, Enter to lock in); the last one fills itself in. Every two metros in a round are at least 8%
  apart, so there is one right order. 10 points for each of the 10 pairs in the right order; five rounds a day
  (500 max), practice by seed, races. The server rebuilds the rounds and scores the orders (`/api/rank/daily`).
- Duel and Ranking hide the lens bar while they run: a population or income lens would give the answer away.
- **Play menu groups (2026-11-27):** Explore, then the daily puzzles in a compact two-column grid, then the two
  strategy games (registry `group`).
- **Next daily:** every short daily's end screen links to the next one you haven't finished today
  (`shared/nextdaily.js`), so the day's games run one after another.

## New mode: State Shapes (2026-11-27)

- `web/js/games/shapes/`: one state's 25 km hexes drawn alone in the panel; pick its name from four states close to it
  in size (keys 1–4). The map is covered while you choose (every border is on it) and shows the state at the reveal;
  the end screen lights the day's eight together. Rounds 1–3 upright, 4–6 upside down, 7–8 turned by any multiple of
  60° (a cube-coordinate rotation, exact on the hex lattice). States under 38 hexes (the small New England states,
  NJ, MD, DE) are left out. Eight rounds a day, practice, races; the server rebuilds the rounds from world.json
  (`/api/shapes/daily`).

## New mode: Rail Link (2026-11-27)

- `web/js/games/link/`: a daily network puzzle on Mainline's real build costs (relief, land cover, river crossings; real
  rail at about half price). Five metros of 250,000+ people, 200–700 km from the first and 170 km apart. Click a metro
  (or your track; clicks snap within two hexes) to build from it, then click anywhere: the cheapest track to the click
  is laid, your own track free to reuse, with a live preview and its cost under the pointer. Undo, Clear, Esc to stop.
- Par is the game's own network (shortest-path heuristic for the Steiner tree, best of five roots); score = 1000 ×
  (par ÷ cost)³, so a clever junction can beat par (over 1000). The end screen draws par dashed over yours. One puzzle a
  day, practice, races; the server rebuilds puzzle and par and scores the links (`/api/link/daily`).

## New mode: Ballpark (2026-11-27)

- `web/js/games/guess/`: six questions a day, four real metro statistics (Metro Duel's) and two straight-line distances,
  answered on a slider (logarithmic, except growth; Enter locks in). Up to 100 points each by how close the guess is as a
  ratio, against a tolerance per question type (×3 for population, ×1.6 for income, ×1.7 for distance, 6 points for
  growth). The metros are lit on the map; the distance is drawn at the reveal. Practice, races; the server scores the
  guesses (`/api/guess/daily`). The lens bar is hidden while it runs.

## Races for the short games (2026-11-27)

- Pinpoint, Metro Duel, Road Trip, Lens Detective, Metro Ranking, State Shapes, Rail Link and Ballpark have **Race friends**: a room by link (up to 8), the host starts it, everyone plays
  the same practice puzzle at once with live standings, and the room scores each finish itself. It is the Which
  Metro? race room (`RaceRoom`), now game-aware, with scorers in `worker/racegames.js` and one shared browser
  controller (`web/js/games/shared/race.js`).

## Phase 2: polish (v0.2)

- Tutorials, sound, phone layout for every mode, share images of end screens (reuse `render/snapshot.js`).
- Mainline: ✅ power and fibre networks (2026-11-27, GAME_PLAN M6: a Rail / Power / Fibre switch, keys 1–3, a
  *Power & fibre* tab; real plants and research metros; coal and gas pay less each decade; in versus too, each company earning from its own lines). ✅ 3-step first-run tutorial (lay track, serve a contract, end the turn;
  dismissable, replay from How to play). ✅ Train animation (overlay only, only while playing; Trains toggle), ✅
  optional sound (off by default), ✅ portrait phone pass (End turn pinned to the bottom sheet).
- Founders: more improvements and a simple AI neighbour (events ✅).
- [x] Founders polish (2026-11-26): built-up hexes read and yield like the open land around them (sim/terrain.js
  `openLand`; the cover layer redraws the engine's terrain art from it), so the hidden cities no longer show as flat,
  empty patches; turn helpers for big countries (per-town Auto, R repeat last order, N next that needs orders, End
  turn warns only when a party or spare materials sit idle; sim/auto.js); a three-step first-run tutorial, replayable
  from How to play.
- [x] Founders share and phone (2026-11-26): "Download image" on the end screen (founders/share.js, via
  `render/snapshot.js`): your country (real cities still covered) beside the real country under your borders, with the
  verdict, score, metro overlap, real population inside your borders, seed and site URL; "Copy result" text as before.
  Phones: End turn / Next stay pinned in the bottom sheet (sticky row), key hints hidden, touch-sized focus chips,
  the start list gets the whole sheet before the first town. Events were already in (sim/events.js: floods, storms,
  fires, hard winters and droughts weighted by FEMA/NOAA records; harvests, rich seams, newcomers, trade fairs).
- A `pipeline/build/game.py` builder for richer data: hundreds of FAF flows, per-hex hazard rates, per-hex build costs.

## Phase 3: accounts and multiplayer (v0.3+)

**Step 1 shipped 2026-11-26** (no login yet; see [MULTIPLAYER.md](MULTIPLAYER.md)): a Worker in front of the static
site with D1 and a `RaceRoom` Durable Object. Players pick a nickname (a device id and token, no account). Which
Metro? has a daily leaderboard and live races by room link; Mainline has a best-run board per scenario. The server
replays every submitted run with the same `sim/` code, so scores can't be typed in.

**Mainline versus shipped 2026-11-26** (sim/versus.js; protocol in [MULTIPLAYER.md](MULTIPLAYER.md)):
- **Companies and contracts:** 2–4 rail companies on one scenario map. A contract pays only the company holding it:
  the first to serve it takes it, the shorter route wins a same-year tie, and a rival takes it if your route is cut.
- **Turns:** simultaneous. Games last 10 or 25 years.
- **Offline:** "Play vs AI" runs entirely in the browser against 1–3 greedy AI companies, which stay out of races they
  would lose.
- **Online rooms** (by link, AI seats optional) are lockstep: a `VersusRoom` Durable Object checks every action with
  the same rules and broadcasts the entry log, and each browser replays it.

**Founders multiplayer shipped 2026-11-26** (sim/match.js; protocol in [MULTIPLAYER.md](MULTIPLAYER.md)):
- **Nations and land:** 2–4 nations settle the same empty country at once, each from a different region. Where
  borders meet, the oldest town holds the land. Rival land can't be settled, worked or improved.
- **Close towns:** two towns founded within 3 hexes in the same turn can't both stand. The nation with that turn's
  priority (it rotates) keeps its town; the other party is sent back.
- **Modes:** against AI nations (the solo bot), hotseat on one device with a hand-off screen between players, or an
  online room. Online rooms use the same `VersusRoom` Durable Object through a per-game adapter.
- **Length:** 30 or 60 turns. The highest prosperity score wins.
- **Closer starts (2026-11-26):** a "Starts" choice. "Neighbours" (the default) puts every nation in one part of the
  country, 8–18 hexes apart by nation count, so borders meet early: in 4-AI test games by turn 9–17, where the old
  one-region-each starts met in only 3 of 6 games. "Whole country" keeps the old layout. Local URLs mark it with a
  trailing `.far`; old saves and rooms replay as "far".

**Login shipped 2026-11-26** (worker/auth.js, app/account.js; details in [MULTIPLAYER.md](MULTIPLAYER.md#login)):
- **Passkeys:** an account button in the top bar. A nickname player saves it with a passkey and can then sign in on
  any device; no email or password is stored. Verification is our own (worker/webauthn.js, WebCrypto, no npm).
- **Device codes:** a signed-in device shows an 8-character code that signs another device in (for browsers without
  passkeys).
- **Nothing lost:** login attaches to the existing player rows. Signing in on a device that played anonymously moves
  its daily scores and Mainline runs into the account. Sign out, sign out other devices, rename passkeys, and delete
  the player with everything stored about it.
- **Google:** built and tested, off until a Google OAuth client id and secret are set as Worker secrets. Apple (needs
  a developer enrollment) and email links (need a sending domain) are not built.

**Three dailies (2026-11-27):** every game now has a daily with a server-verified board. Which Metro? (five puzzles),
**Founders daily** (one map for everyone, 30 turns, first finished game counts) and **Mainline daily** (the date
picks the scenario and seed, 10 years). The account panel shows your record: days played, best, average and streak
for each daily, and your Mainline ranks.

The static site stays static. Multiplayer is added as a small backend next to it.

- **Hosting:** Cloudflare Workers + Durable Objects (one object per game room) + D1 for accounts and leaderboards.
  This matches the hosting already used for your other projects.
- **Login:** passkeys and device codes (shipped); Google ready to switch on; Apple and email links later. Guests can
  always play single player with no account.
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
