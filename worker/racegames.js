// Race scoring for the short games beyond Which Metro? (worker/race.js). A race plays a practice seed of the game;
// the room rebuilds that practice game from the same pure sim code and scores what a player finishes with.
//   pinpoint  finish {guesses: [cell…]} (1–8; fewer when the clock ran out) → points of those rounds
//   duel      finish {answers: [bool…]}  → the streak (correct answers before the first wrong one)
//   trip      finish {order: [id…]}      → 0–1000 (an unfinished route scores 0)
import { roundsFor, scoreGuess, ROUNDS as PP_ROUNDS, MAX_POINTS as PP_MAX } from "../web/js/games/pinpoint/sim/rounds.js";
import { duelSequence, streakOf } from "../web/js/games/duel/sim/duel.js";
import { tripFor, scoreTrip, STOPS } from "../web/js/games/trip/sim/trip.js";
import { ppPool } from "./pp.js";
import { duelPoolFor } from "./duel.js";
import { tripPoolFor } from "./trip.js";

export const DUEL_RACE_LEN = 400;

export const RACE_GAMES = {
  pinpoint: {
    maxRound: PP_ROUNDS, maxScore: PP_ROUNDS * PP_MAX,
    async score(env, seed, m) {
      const g = m?.guesses;
      const { grid, pool } = await ppPool(env);
      const rounds = roundsFor(pool, `pinpoint-practice:${seed}`);
      if (!Array.isArray(g) || g.length < 1 || g.length > rounds.length) return { error: "guesses must be 1–8 hexes" };
      let total = 0;
      for (const c of g) if (!Number.isInteger(c) || c < 0 || c >= grid.size) return { error: "bad hex" };
      g.forEach((c, i) => { total += scoreGuess(grid, rounds[i], c).points; });
      return { score: total, round: g.length };
    },
  },
  duel: {
    maxRound: DUEL_RACE_LEN, maxScore: DUEL_RACE_LEN,
    async score(env, seed, m) {
      const seq = duelSequence(await duelPoolFor(env), `duel-practice:${seed}`, DUEL_RACE_LEN);
      const r = streakOf(seq, m?.answers);
      return r.error ? r : { score: r.streak, round: r.answered };
    },
  },
  trip: {
    maxRound: STOPS, maxScore: 1000,
    async score(env, seed, m) {
      const trip = tripFor(await tripPoolFor(env), `trip-practice:${seed}`);
      if (Array.isArray(m?.order) && m.order.length < STOPS) return { score: 0, round: m.order.length };
      const r = scoreTrip(trip, m?.order);
      return r.error ? r : { score: r.points, round: STOPS };
    },
  },
};

/** {round, score} from a progress message within the game's bounds, or null. */
export function cleanRaceProgress(game, m) {
  const g = RACE_GAMES[game];
  const ok = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  return g && ok(m?.round, g.maxRound) && ok(m?.score, g.maxScore) ? { round: m.round, clues: 0, score: m.score } : null;
}
