// Metro Ranking daily: the server rebuilds the day's five rounds from the date (web/js/games/rank/sim/rank.js, over the
// same cities.json) and scores the orders. First finished game per player per day (worker/daily.js).
import { makeDaily } from "./daily.js";
import { rankPool, rankRounds, dailySeed, scoreRank } from "../web/js/games/rank/sim/rank.js";

const daily = makeDaily({
  table: "rank_daily", detail: "orders_json", data: ["cities"],
  build: (d) => rankPool(d.cities),
  puzzle: (pool, key) => rankRounds(pool, dailySeed(key)),
  score: (rounds, body) => scoreRank(rounds, body?.orders),
  detailOf: (body) => body.orders,
});

/** POST /api/rank/daily {key, orders: [[cityId × 5] × 5]} → {score, rank, total} (stored: true on a resubmission). */
export const submitRankDaily = daily.submit;
/** GET /api/rank/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export const rankDailyBoard = daily.board;
export const rankPoolFor = daily.pool;
