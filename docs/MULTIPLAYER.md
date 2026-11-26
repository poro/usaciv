# Multiplayer: backend and API contract (v0.3, step 1)

The site stays static. A small Cloudflare Worker sits in front of the same static assets and answers only
`/api/*`. Everything else is still served straight from the assets.

- **Hosting:** one Worker, `usaciv`.
  - Static assets come from `dist/usaciv`, as before.
  - `run_worker_first: ["/api/*"]` sends API calls to the Worker.
  - **D1** (`DB`, database `usaciv`) holds players and scores.
  - A **Durable Object** class `RaceRoom` (SQLite-backed, WebSocket hibernation) runs one live room per object.
- **Identity, step 1 (no login):** a player is a random id plus a secret token, issued on first use and kept in
  `localStorage` (`usaciv:player`). It carries a public nickname. Login (email link, Google, Apple; ROADMAP Phase 3)
  will later attach to this same player row, so nothing is lost when it arrives.
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
worker/rules.js        pure rules (names, step checks + replay, room codes, places); tested by tests/js/worker.test.mjs
worker/blocklist.js    the short name blocklist
migrations/0001_init.sql
web/js/games/shared/net.js   the browser client (below)
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
