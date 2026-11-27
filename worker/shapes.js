// State Shapes daily: the server rebuilds the day's eight rounds from the date (web/js/games/shapes/sim/shapes.js, over
// world.json's state hexes) and scores the picks. First finished game per player per day (worker/daily.js).
import { makeDaily } from "./daily.js";
import { shapePool, shapeRounds, dailySeed, scoreShapes } from "../web/js/games/shapes/sim/shapes.js";

const daily = makeDaily({
  table: "shapes_daily", detail: "picks_json", data: ["world"],
  build: (d) => shapePool(d.world),
  puzzle: (pool, key) => shapeRounds(pool, dailySeed(key)),
  score: (rounds, body) => scoreShapes(rounds, body?.picks),
  detailOf: (body) => body.picks,
});

/** POST /api/shapes/daily {key, picks: [stateAbbr × 8]} → {score, rank, total} (stored: true on a resubmission). */
export const submitShapesDaily = daily.submit;
/** GET /api/shapes/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export const shapesDailyBoard = daily.board;
export const shapesPoolFor = daily.pool;
