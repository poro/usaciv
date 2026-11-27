# Multiplayer: backend and API contract (v0.4)

The site stays static. A small Cloudflare Worker sits in front of the same static assets and answers only
`/api/*`. Everything else is still served straight from the assets.

- **Hosting:** one Worker, `usaciv`.
  - Static assets come from `dist/usaciv`, as before.
  - `run_worker_first: ["/api/*"]` sends API calls to the Worker.
  - **D1** (`DB`, database `usaciv`) holds players and scores.
  - A **Durable Object** class `RaceRoom` (SQLite-backed, WebSocket hibernation) runs one live room per object.
- **Identity:** a player is a random id plus a secret token, issued on first use and kept in `localStorage`
  (`usaciv:player`). It carries a public nickname. **Login** (below) attaches passkeys, more devices and (once set up)
  Google to that same player row, so a nickname player loses nothing by signing in later.
- **Trust:** the server never takes a score from the client.
  - It replays the submitted moves with the **same pure `sim/` modules** the browser uses, imported by the Worker
    from `web/js/games/<mode>/sim/`.
  - It scores the run itself.
  - That is what the deterministic simulations were built for.
- **Graceful when offline:** the static dev server (`pipeline serve`) has no `/api`. `shared/net.js` detects that
  (`GET /api/health`), and the games then simply hide their online features.

## Code layout

```
worker/index.js        router: /api/* → handlers, everything else → env.ASSETS
worker/http.js         json(), error(), auth (Bearer token → player), name rules, rate limits
worker/data.js         cached loads of /data/*.json through env.ASSETS (module scope, once per isolate)
worker/wm.js           Which Metro?: daily submit/board, race room create
worker/race.js         export class RaceRoom (Durable Object)
worker/ml.js           Mainline: submit/board (uses web/js/games/mainline/sim/verify.js)
worker/vs.js           Mainline versus: room create/info and export class VersusRoom (Durable Object)
worker/auth.js         login: passkeys, device codes, Google (off until configured), sign-out, merge, delete
worker/webauthn.js     passkey verification (CBOR/COSE parsing, ES256/RS256 with WebCrypto); pure, no npm
worker/rules.js        pure rules (names, step checks + replay, room codes, places); tested by tests/js/worker.test.mjs
worker/blocklist.js    the short name blocklist
migrations/0001_init.sql, 0002_login.sql
web/js/games/shared/net.js   the browser client (below)
web/js/app/account.js        the top-bar account button and panel
```

The Worker may import from `web/js/games/**/sim/*.js` and `web/js/games/shared/rng.js`, all pure ES modules. It must
not import anything that touches the DOM.

## API

All bodies are JSON. Errors look like `{error: "message"}`, with a 4xx/5xx status. Authenticated calls send
`Authorization: Bearer <token>`. Same origin only: no CORS headers, and a write (or socket) whose `Origin` names
another site gets 403. An unknown `/api` path is 404 JSON; a known path with the wrong method is 405.

| Method and path | Auth | Body → response |
|---|---|---|
| `GET /api/health` | | → `{ok: true, version}` |
| `POST /api/player` | | `{name}` → `{id, token, name}` (201). Creates a player |
| `GET /api/player` | ✓ | → `{id, name}` |
| `PATCH /api/player` | ✓ | `{name}` → `{id, name}` |
| `POST /api/wm/daily` | ✓ | `{key, rounds: [{steps}]}` → `{score, rank, total}` (`stored: true` on a resubmission) |
| `GET /api/wm/daily/:key` | (✓) | `?limit=20` → `{key, number, total, top: [{rank, name, score}], you: {rank, score} \| null, histogram: [26 counts]}` |
| `POST /api/wm/race` | ✓ | `{}` → `{code}` |
| `GET /api/wm/race/:code` | | → `{code, status, players: n}` (404 if unknown) |
| `GET /api/wm/race/:code/ws?token=…` | token | WebSocket upgrade (below) |
| `POST /api/ml/run` | ✓ | `{scenario, seed, home, log}` → `{uplift, beat, rank, total, best, improved}` |
| `GET /api/ml/board/:scenario` | (✓) | `?limit=20` → `{scenario, total, top: [{rank, name, uplift, seed, home, year}], you}` |

**Names:** trimmed, inner whitespace collapsed, 2–20 characters from letters, digits, space and `_ - . '`. "Letters"
means Latin letters, accents included (so the blocklist cannot be dodged with look-alike scripts). A short blocklist
of slurs (`worker/blocklist.js`) is rejected. Names are not unique.

**Rate limits:** 12 writes (rename, daily submit, room create, Mainline run) per player per minute; 10 new players
per IP per hour. Over the limit → 429 with `Retry-After`. A daily resubmission does not count.

**Privacy:** tokens are stored only as SHA-256; IPs only as a salted SHA-256 (salt = the `IP_SALT` secret).

### Which Metro? daily

- `key` is a date key `YYYY-MM-DD`. It is accepted only if it is within one day of the server's UTC date, because
  players' local midnights differ.
- `rounds[i].steps` is exactly the browser's `state.rounds[i].steps`: `[{t: "skip"} | {t: "miss", id} | {t: "hit",
  id}]`.
- The server builds the answers with `dailyAnswers(buildPool(cities), key)` and replays the steps with
  `newGame`/`reveal`/`guess`/`nextRound`. It scores with `totalScore`.
- One entry per player per key: the first verified submission counts. Resubmitting returns the stored entry.

### Which Metro? races (real time)

- `POST /api/wm/race` makes a room with a 6-character code from an unambiguous alphabet (no 0/O/1/I) and a fresh
  practice seed. The creator is the host.
- The client opens `#play=whichMetro~race-<CODE>`, then connects to the WebSocket.
- Rules:
  - At most 8 players.
  - The room is "lobby" until the host starts it. Then it is "live" and everyone plays
    `practiceAnswers(pool, seed)`.
  - A player's run counts when they finish, or when the room closes (30 minutes after start).
  - Rooms are forgotten 2 hours after their last activity (DO alarm).
- **Client → server:**
  - `{t: "start"}` (host only, in the lobby)
  - `{t: "progress", round, clues, score}` (display only; throttled by the client)
  - `{t: "finish", rounds: [{steps}]}` (the server replays it for the real score)
- **Server → client:**
  - `{t: "room", room}` on every change, where `room = {code, status: "lobby"|"live"|"done", seed, host, startedAt,
    players: [{id, name, round, clues, score, done, place, online}]}`. `seed` is `null` in the lobby (nobody can
    study the puzzle before the start). `host` is the host's player id. `score` is the player's displayed progress
    until they finish, then the verified score.
  - `{t: "error", error}`
  - The player's own id is in `players`; the client knows it from `net.player()`.
- Places are by verified score, then by finish time. `place` is set as players finish (provisional while live).
- A `finish` may be partial (for example sent when the clock runs out): the rounds it holds are replayed and only the
  last one may be unfinished; missing rounds score 0. One finish per player.
- When the room closes, anyone who has not finished gets `done: true`, score 0, and the place after the last finisher.
  The room is also "done" as soon as every player has finished.
- Joining is open only in the lobby: a newcomer after the start, or a ninth player, gets `{t: "error"}` and the
  socket is closed (code 4001). Players already in the room can reconnect at any time.

### Mainline boards

- The board keys are `texas`, `rust`, `northeast` and `sandbox`. Sandbox entries also carry `home`.
- `log` is the run's action log, the same one the replay-hash test uses. The server calls `verifyRun(data,
  {scenario, seed, home, log})` from `web/js/games/mainline/sim/verify.js`, which replays the log to 2050 and returns
  `{ok, uplift, beat, hash, year}`. A run that is not finished, or that fails to replay, is rejected.
- Each player keeps their best uplift per scenario. `best` is that best uplift after this submission; `improved` says
  whether this run replaced it.
- `ml.js` imports `verify.js` lazily, and loads exactly its `REQUIRED_DATA` files. If `verify.js` is missing from
  a build, both Mainline endpoints answer 503 "Mainline boards are not ready".

## Mainline versus (real time)

2–4 rail companies on one scenario map compete for the same freight contracts. Seats can be people or AI companies.
The rules engine is `web/js/games/mainline/sim/versus.js`: pure and deterministic, shared by the room and the
browsers (its header has the full rules). In short:

- Everyone starts at the scenario's home metro with the same money and seed. Each company builds its own track.
- A contract pays only its holder. The first company to serve it takes it; in a tie the shorter network route wins,
  then the lower seat. A holder keeps a contract while it serves it; if its route is cut or gone and a rival serves
  it, the rival takes it.
- Turns are simultaneous: each company acts on its own state during the year. When every company is ready (or the
  deadline passes) the room resolves the year for all.
- The winner is the highest GDP uplift when the last year ends. Games are 10 years (2026–2035) or 25 (to 2050).

**Lockstep:**
- The room's Durable Object (`VersusRoom`) holds the authoritative entry log and checks every action with the
  same `vsCheck` the browser uses.
- It broadcasts accepted entries. Each browser replays them with `applyEntry` from
  `newVersus(env, {seed, years, players})`, where `players = room.players.map(({name, bot}) => ({name, bot}))` in seat
  order. Nobody's state is ever sent: only actions.

Entries: `{p, a}` = seat `p` applied action `a` (a Mainline action, never `endTurn`); `{r: 1}` = the year resolved.

**The browser** (`web/js/games/mainline/index.js`, "online versus rooms"):
- It applies its own actions at once and keeps them as pending until the room echoes them back.
- The game it shows is the confirmed log plus the pending actions.
- A `reject`, or an `entries` message whose index does not match, drops the pending actions; the client then asks
  for a `sync` or replays.
- While its company is ready it sends no actions. The Ready button toggles `ready`.

| Method and path | Auth | Body → response |
|---|---|---|
| `POST /api/ml/vs` | ✓ | `{scenario, home?, years, bots}` → `{code}` (201). `home` (a 5-digit CBSA id) only for `sandbox`, required there; `years` is 10 or 25; `bots` 0–3. Counts as a write |
| `GET /api/ml/vs/:code` | | → `{code, status, scenario, home, years, players: n, seats: max human seats}` (404 if unknown) |
| `GET /api/ml/vs/:code/ws?token=…` | token | WebSocket upgrade |

`room = {code, status: "lobby"|"live"|"done", scenario, home, years, bots, seed, host, year, deadline, players: [{id,
name, bot, online, ready}]}`

- `seed` is `null` in the lobby.
- `deadline` is a ms timestamp, or `null`.
- `players` are listed in seat order once the game starts. In the lobby it is the people in join order; the bots get
  seats at the start, after the people, named `BOT_NAMES` (`id: null`).

**Seats:**
- At most `VS_MAX` (4) companies. People can take `4 − bots` seats.
- The host may start with any number of people as long as there are at least 2 companies in all, so one person plus
  one bot is fine.
- Joining is lobby-only. A newcomer after the start, or one over the limit, gets `{t: "error"}` and close code 4001.
- Seated players can reconnect at any time.

**Client → server:**
- `{t: "start"}`: host only, in the lobby. The server picks a random seed.
- `{t: "act", a}`: the server checks `shapeError` (sim/verify.js), then `vsCheck`.
  - Accepted: the entry is appended and broadcast.
  - Refused: `{t: "reject", error, i}` goes to the sender only (`i` = the log length).
- `{t: "ready", on: true|false}`: marks the sender's company ready (or not) for the current year.
- `{t: "sync"}`: asks for the full log again.

**Server → client:**
- `{t: "room", room}` on every change.
- `{t: "log", es}`: the full log, on connect (once the game has started) and on `sync`. The client replays it from
  scratch.
- `{t: "entries", i, es}`: new entries, where `i` is the index of the first one. A client whose log length is not `i`
  sends `sync`.
- `{t: "reject", error, i}` and `{t: "error", error}`.

**Resolving a year:**
- It happens when every online person is ready (offline people count as ready), or at the deadline.
- The deadline is 90 s after the first person readies that year (a DO alarm).
- Then each bot seat in order appends its `botActions`, followed by `{r: 1}`, all in one `entries` message.
- The ready flags and the deadline reset. When `vs.over`, the room is `"done"`.
- If every person is offline, nothing resolves until someone comes back.
- Rooms are forgotten 2 hours after their last activity.

**Limits:**
- At most 20,000 entries a room.
- At most 30 `act` messages a second per socket; extra ones are refused.

**Details settled in the implementation (`worker/vs.js`):**
- **Rooms and seats:**
  - For a fixed-home scenario, `home` may be omitted or equal to the scenario's own home, and is stored as `null`.
  - A Sandbox home must be a region metro.
  - In the lobby, a non-host who leaves gives the seat back; the host keeps theirs.
  - Names follow renames only until the start, because they are part of the replay init.
  - Bots always show `online: true, ready: true`.
- **Ready and the deadline:**
  - Un-readying does not move or clear the deadline.
  - If the deadline passes with every person offline, the year resolves as soon as someone reconnects.
  - `{t: "ready"}` without `on` counts as `on: true`.
  - The server accepts acts from a ready company (holding back is a client rule).
- **Messages:**
  - At the start everyone gets `{t: "room"}`, then `{t: "log", es: []}`.
  - The entry cap keeps one slot for each resolve still to come, so a game can always finish. Over it, acts are
    refused and bot actions are cut short.

## Founders multiplayer (real time)

2–4 nations settle one map at once. Seats can be people or AI nations. The rules engine is
`web/js/games/founders/sim/match.js` (its header has the full rules). In short:

- Each nation starts with a founding party at a good coast or river site. The match's `map` picks the layout:
  - `"near"` (the default for new games): every nation in one part of the country, close enough that borders meet
    in the first half of a 30-turn game. Every two starts are 8–12 hexes apart with 2 nations, 9–14 with 3 and 11–18
    with 4 (`NEAR_GAP`; widened a little for the rare seed with no fit). Site values within about 10%.
  - `"far"`: one start per west→east quarter of the country (the solo starts, shuffled by the seed). A match or room
    with no `map` is `"far"`, so games saved before the choice existed replay unchanged.
- Every nation's towns claim land together, oldest first. Towns founded in the same turn claim in a seat order that
  rotates each turn.
- Rival land can't be settled, worked or improved. Parties and roads may cross it.
- Close towns: a town founded within 3 hexes of an earlier-ranked rival town in the same turn is turned back, and its
  party waits on the hex.
- The highest prosperity score after the last turn wins. Games are 30 turns (1790–1906) or 60 (to 2026).

**Room:** the same `VersusRoom` Durable Object and the same lockstep protocol as Mainline versus, with
`room.game = "founders"`. The room loads its game through a per-game adapter (`worker/games.js`).
- Entries: `{p, a}` (a Founders action, never `start` or `end`) and `{r: 1}`, the turn resolved.
- Checks: `matchShapeError`, then `matchAct`.
- AI moves: `botActions`.
- Replay init: `{seed, turns, players: [{name, bot}]}`, with `seed` a string.
- Env: `makeEnv({world, resources, hazards: buildHazards(disasters, world)})` from `world.json`, `resources.json` and
  `disasters.json`, exactly as the browser builds it. Events depend on the hazards.

| Method and path | Auth | Body → response |
|---|---|---|
| `POST /api/fd/match` | ✓ | `{turns, bots, map?}` → `{code}` (201). `turns` is 30 or 60; `bots` 0–3; `map` `"near"` or `"far"` (missing = `"far"`, what clients from before the choice replay). Counts as a write |
| `GET /api/fd/match/:code` | | → `{code, game, status, turns, map, players, seats}` (404 if unknown) |
| `GET /api/fd/match/:code/ws?token=…` | token | WebSocket upgrade |

- **The room object:** `room = {code, game, status, turns, map, bots, seed, host, turn, deadline, players: [{id, name, bot,
  online, ready}]}`. AI seats are named `BOT_NATIONS`.
- **Messages, seats and timing:** the same as Mainline versus. A turn resolves when every online person is ready, or
  90 s after the first one. The AI nations append their actions, then `{r: 1}`.
- **Codes:** room codes are shared across games, so either game's status endpoint answers with the room's own
  `game`.

## Login

Login is optional and never needed for single player. It exists so a player can keep one identity across devices
and survive cleared browser data.

**Methods:**
- **Passkeys** (WebAuthn, the default; works today with no setup). A player saves a passkey from the account panel
  (Face ID, Touch ID, Windows Hello, a phone, a password manager). On any device, "Sign in with a passkey" asks the
  browser for a discoverable credential; no username is typed. The relying party id is the site's host name, so
  passkeys made on `usaciv.mark-ollila.workers.dev` work only there (a custom domain later means new passkeys).
- **Device codes.** A signed-in device shows an 8-character code (alphabet without 0/O/1/I, valid 10 minutes, single
  use); typing it on another device signs that device in. For browsers without passkeys.
- **Google** (OpenID Connect, authorization code with PKCE and a nonce). Built and tested but **off** until the Worker
  has the secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Google Cloud "Web application" OAuth client with
  the redirect URI `https://<host>/api/auth/google/callback`). `GET /api/auth/config` reports `google: true` once
  both are set, and the panel then shows "Continue with Google".
- **Apple and email links:** not built. Apple needs a paid developer enrollment; email links need a sending domain.

**How it fits the player rows:**
- `players.token_hash` stays the token of the device that made the player. Every later sign-in adds a `sessions` row
  with its own token. Signing out deletes that row (or, for the first device, replaces its hash with an unusable
  `revoked:` value). A player keeps at most 20 sessions; the least recently used go first.
- **Merge on sign-in:** if the device signing in holds an *anonymous* player (no passkey, no identity), its scores
  move into the account and the anonymous player is deleted. Daily scores: the account's entry for a date wins.
  Mainline: the better run per scenario wins. A player that has a passkey or identity is never merged.
- A "secured" player has at least one passkey or identity. The panel warns an unsecured player that signing out or
  clearing site data loses them.
- **Delete player:** removes the player, its scores, sessions, passkeys and identities (the nickname must be typed).

**Passkey checks** (`worker/webauthn.js`): client data type, challenge (single use, 5 minutes, stored in
`auth_tokens`), exact origin, not cross-origin; `rpIdHash`, the user-present flag, the attested credential; ES256 or
RS256 signatures over `authenticatorData ‖ SHA-256(clientDataJSON)`; and a sign counter that may not go backwards
while non-zero. Attestation is "none": a passkey is trusted because a signed-in player added it.

| Method and path | Auth | Body → response |
|---|---|---|
| `GET /api/auth/config` | | → `{passkeys, link, google, apple, email}` |
| `GET /api/account` | ✓ | → `{id, name, created, passkeys: [{id, name, created, lastUsed}], identities: [{provider, email, created}], devices, secured, thisDevice: "device"\|"session"}` |
| `DELETE /api/account` | ✓ | `{confirm: <nickname>}` → `{ok}` |
| `POST /api/auth/passkey/register/options` | ✓ | → `{challengeId, publicKey}` (WebAuthn creation options, binary fields base64url). Counts as a write |
| `POST /api/auth/passkey/register` | ✓ | `{challengeId, credential: {id, clientDataJSON, attestationObject, transports}, name?}` → `{passkey}` (201; 409 if already saved) |
| `POST /api/auth/passkey/login/options` | | → `{challengeId, publicKey}` (request options, empty `allowCredentials`) |
| `POST /api/auth/passkey/login` | (✓) | `{challengeId, credential: {id, clientDataJSON, authenticatorData, signature, userHandle}}` → `{id, name, token, merged}` |
| `PATCH /api/auth/passkey/:id` | ✓ | `{name}` → `{ok, name}` |
| `DELETE /api/auth/passkey/:id` | ✓ | → `{ok}` |
| `POST /api/auth/link` | ✓ | → `{code, expires}` (201). One live code per player; a new one replaces it |
| `POST /api/auth/link/redeem` | (✓) | `{code}` (case, spaces and dashes ignored) → `{id, name, token, merged}` |
| `POST /api/auth/google/start` | (✓) | `{returnTo}` → `{url}`; signed in, the Google account is added to this player |
| `GET /api/auth/google/callback` | | Google's redirect → 302 to `returnTo#auth=<handoff>` (or `#auth-error=…`) |
| `POST /api/auth/handoff` | (✓) | `{code}` → `{id, name, token, merged}` (the handoff is single use, 2 minutes) |
| `DELETE /api/auth/identity/:provider` | ✓ | → `{ok}` |
| `POST /api/auth/signout` | ✓ | → `{ok}`; this device's token stops working |
| `POST /api/auth/signout-others` | ✓ | → `{ok}`; every other device's token stops working |

`(✓)` on a sign-in call means: send this device's current token if it has one, so its anonymous scores merge.
`merged` is `{daily, runs}` (rows that were on the anonymous player) or `null`.

**Limits:** 30 sign-in attempts (passkey options/verify, handoffs, Google starts) per IP per 10 minutes; 10 code
redemptions per IP per 10 minutes (an 8-character code has 40 bits, so guessing is hopeless at that rate).

**Browser** (`net.js`): `addPasskey()`, `signInWithPasskey()`, `linkCode()`, `redeemCode(code)`,
`signInWithGoogle()`, `signOut()`, `account()`, `onPlayer(f)` (fires on sign-in, sign-out, rename and changes in
other tabs). A Google redirect comes back as `/#auth=…`; `net.js` removes it from the address bar before the app reads
its hash and restores the page's own hash from `sessionStorage`. The games' nickname prompts carry a "Have a player?
Sign in" link (`[data-open-account]`) that opens the panel; Which Metro? continues the pending step once signed in.

## Local development

- `npx wrangler@4 dev --port 8788` runs the Worker, local D1 and the Durable Object together, serving
  `dist/usaciv`. Run `uv run python -m pipeline package` first. Apply the schema once with
  `npx wrangler@4 d1 migrations apply usaciv --local`.
- `.claude/launch.json` entry: `usaciv-worker`.
- Plain `pipeline serve` (port 8766) still works for single player. Online features hide themselves there.

## Deploy

The Deploy workflow runs `wrangler d1 migrations apply usaciv --remote`, then `wrangler deploy`. The
`CLOUDFLARE_API_TOKEN` secret therefore needs **D1 Edit** as well as the Workers permissions. Set the Worker secret
once: `npx wrangler@4 secret put IP_SALT` (any long random string). Locally, `.dev.vars` holds `IP_SALT=…`.
