// Settle daily: the server rebuilds the day's region and par (web/js/games/settle/sim/settle.js, over world.json and
// counties.json) and scores the five settlements. First finished game per player per day (worker/daily.js).
import { makeDaily } from "./daily.js";
import { makeHexMap } from "../web/js/games/shared/hexmap.js";
import { settleEnv, settlePuzzle, parSites, scoreSites, dailySeed } from "../web/js/games/settle/sim/settle.js";

/** The puzzle and its par for a seed. */
export const settleFor = (E, seed) => { const puzzle = settlePuzzle(seed); return { E, puzzle, par: parSites(E, puzzle) }; };

const daily = makeDaily({
  table: "settle_daily", detail: "sites_json", data: ["world", "counties"],
  build: (d) => settleEnv({ world: d.world, counties: d.counties }, makeHexMap(d.world)),
  puzzle: (E, key) => settleFor(E, dailySeed(key)),
  score: ({ E, puzzle, par }, body) => scoreSites(E, puzzle, body?.sites, par),
  detailOf: (body) => body.sites,
});

/** POST /api/settle/daily {key, sites: [cell × 5]} → {score, rank, total} (stored: true on a resubmission). */
export const submitSettleDaily = daily.submit;
/** GET /api/settle/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export const settleDailyBoard = daily.board;
export const settleEnvFor = daily.pool;
