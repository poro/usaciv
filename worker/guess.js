// Ballpark daily: the server rebuilds the day's six questions from the date (web/js/games/guess/sim/guess.js, over
// cities.json) and scores the guesses. First finished game per player per day (worker/daily.js).
import { makeDaily } from "./daily.js";
import { guessPool, guessRounds, dailySeed, scoreGuesses } from "../web/js/games/guess/sim/guess.js";

const daily = makeDaily({
  table: "guess_daily", detail: "guesses_json", data: ["cities"],
  build: (d) => guessPool(d.cities),
  puzzle: (pool, key) => ({ pool, rounds: guessRounds(pool, dailySeed(key)) }),
  score: ({ pool, rounds }, body) => scoreGuesses(pool, rounds, body?.guesses),
  detailOf: (body) => body.guesses,
});

/** POST /api/guess/daily {key, guesses: [number × 6]} → {score, rank, total} (stored: true on a resubmission). */
export const submitGuessDaily = daily.submit;
/** GET /api/guess/daily/:key?limit=20 → {key, total, top: [{rank, name, score}], you} */
export const guessDailyBoard = daily.board;
export const guessPoolFor = daily.pool;
