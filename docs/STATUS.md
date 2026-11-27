# Where things stand (2026-11-27)

A snapshot for picking the work up again. The feature history is in [ROADMAP.md](ROADMAP.md), the server API in
[MULTIPLAYER.md](MULTIPLAYER.md), the game designs in [GAME_PLAN.md](GAME_PLAN.md).

## Live

https://usaciv.mark-ollila.workers.dev: the `main` branch as of the last commit, deployed by hand (see below). D1
migrations 0001–0013 are applied to the remote database.

## What's in the Play menu (12 modes)

| Daily puzzles (a board each, practice by seed, races) | Strategy games |
|---|---|
| Which Metro?, Pinpoint, Metro Duel, Road Trip, Lens Detective, Metro Ranking, State Shapes, Ballpark, Rail Link, Settle | Mainline (scenarios, daily, versus vs AI or online), Founders (solo, daily, AI / hotseat / online) |

Every daily's score is recomputed on the server from the same `web/js/games/<mode>/sim` code. Login: passkeys and
device codes (Google built, off until its secrets exist).

## How to work on it

- Tests: `node --test tests/js/*.test.mjs` (176 passing) and `uv run python -m unittest discover -s tests -q`.
- Local, everything (boards, races, login): `uv run python -m pipeline package`, then
  `npx wrangler@4 d1 migrations apply usaciv --local`, then `npx wrangler@4 dev --port 8788`. The dev server serves
  `dist/usaciv`, so run `pipeline package` again after editing `web/`.
- Local, single player only: `uv run python -m pipeline serve`.
- Deploy (manual until the `CLOUDFLARE_API_TOKEN` GitHub secret exists): from a clean export of `HEAD`
  (`git archive HEAD | tar -x -C <dir>`), run `uv run python -m pipeline package`,
  `npx wrangler@4 d1 migrations apply usaciv --remote`, `npx wrangler@4 deploy`. New routes can 404 for ~10 s.
- After a deploy: `node scripts/smoke/smoke-<mode>.mjs` ([scripts/smoke/README.md](../scripts/smoke/README.md)).
- Adding a daily: `worker/daily.js` (`makeDaily`) does the board; then wire `worker/index.js` routes,
  `worker/today.js`, `worker/stats.js`, `worker/auth.js` (merge and delete), `worker/racegames.js`,
  `web/js/games/host.js` (FMT), `web/js/app/account.js`, `web/js/games/registry.js` (`group: "daily"`),
  `web/js/games/shared/nextdaily.js`, a migration, and the game list in `tests/js/duel.test.mjs`.

## Waiting on the owner

- `CLOUDFLARE_API_TOKEN` GitHub secret, for automatic deploys from `main`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` Worker secrets, to switch on Google sign-in
  (redirect URI `https://usaciv.mark-ollila.workers.dev/api/auth/google/callback`).
- The open data-refresh pull request, poro/usaciv#1.

## Ideas not started

- A weekly or all-dailies streak; a "today's results" page to share.
- Share images for the newer modes (Pinpoint and Road Trip have them, via `shared/shareimg.js`).
- Rail Link: let players delete a single link (only Undo / Clear today).
- Settle: a harder variant (more settlements, wider spacing) or the whole country.
- Founders: more improvements and a simple AI neighbour (Phase 2 in the roadmap).
- Mainline online rejoin framing (reported once, not reproduced).
