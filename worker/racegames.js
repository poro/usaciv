// Race scoring for the short games beyond Which Metro? (worker/race.js). A race plays a practice seed of the game;
// the room rebuilds that practice game from the same pure sim code and scores what a player finishes with.
//   pinpoint  finish {guesses: [cell…]} (1–8; fewer when the clock ran out) → points of those rounds
//   duel      finish {answers: [bool…]}  → the streak (correct answers before the first wrong one)
//   trip      finish {order: [id…]}      → 0–1000 (an unfinished route scores 0)
//   lens      finish {picks: [lensId…]}  → right answers among the rounds played (1–6)
//   rank      finish {orders: [[id×5]…]} → points of the rankings played (1–5 rounds, 0–100 each)
//   shapes    finish {picks: [abbr…]}    → right answers among the rounds played (1–8)
//   settle    finish {sites: [cell × 5]} → 1000 × people reached ÷ par's (progress round = settlements placed)
//   guess     finish {guesses: [number…]} → points of the questions answered (1–6, 0–100 each)
//   link      finish {edges: [[a, b]…]}  → 1000 × (par ÷ cost)³ for a network joining all five metros (progress round = metros joined)
import { roundsFor, scoreGuess, ROUNDS as PP_ROUNDS, MAX_POINTS as PP_MAX } from "../web/js/games/pinpoint/sim/rounds.js";
import { duelSequence, streakOf } from "../web/js/games/duel/sim/duel.js";
import { tripFor, scoreTrip, STOPS } from "../web/js/games/trip/sim/trip.js";
import { ppPool } from "./pp.js";
import { duelPoolFor } from "./duel.js";
import { tripPoolFor } from "./trip.js";
import { lensRounds, ROUNDS as LENS_ROUNDS } from "../web/js/games/lens/sim/lens.js";
import { lensPoolFor } from "./lens.js";
import { rankRounds, scoreRank, practiceSeed as rankPractice, ROUNDS as RANK_ROUNDS, MAX_SCORE as RANK_MAX } from "../web/js/games/rank/sim/rank.js";
import { rankPoolFor } from "./rank.js";
import { shapeRounds, scoreShapes, practiceSeed as shapesPractice, ROUNDS as SHAPES_ROUNDS } from "../web/js/games/shapes/sim/shapes.js";
import { shapesPoolFor } from "./shapes.js";
import { scoreNetwork, practiceSeed as linkPractice, TERMINALS as LINK_TERMINALS, MAX_SCORE as LINK_MAX } from "../web/js/games/link/sim/link.js";
import { linkBaseFor, linkPuzzleFor } from "./link.js";
import { guessRounds, scoreGuesses, practiceSeed as guessPractice, ROUNDS as GUESS_ROUNDS, MAX_SCORE as GUESS_MAX } from "../web/js/games/guess/sim/guess.js";
import { guessPoolFor } from "./guess.js";
import { scoreSites, practiceSeed as settlePractice, SITES as SETTLE_SITES, MAX_SCORE as SETTLE_MAX } from "../web/js/games/settle/sim/settle.js";
import { settleEnvFor, settleFor } from "./settle.js";

export const DUEL_RACE_LEN = 400;

export const RACE_GAMES = {
  settle: {
    maxRound: SETTLE_SITES, maxScore: SETTLE_MAX,
    async score(env, seed, m) {
      const { E, puzzle, par } = settleFor(await settleEnvFor(env), settlePractice(seed));
      const r = scoreSites(E, puzzle, m?.sites, par);
      return r.error ? r : { score: Math.min(SETTLE_MAX, r.score), round: SETTLE_SITES };
    },
  },
  guess: {
    maxRound: GUESS_ROUNDS, maxScore: GUESS_MAX,
    async score(env, seed, m) {
      const pool = await guessPoolFor(env);
      const r = scoreGuesses(pool, guessRounds(pool, guessPractice(seed)), m?.guesses, { partial: true });
      return r.error ? r : { score: r.score, round: r.points.length };
    },
  },
  link: {
    maxRound: LINK_TERMINALS, maxScore: LINK_MAX,
    async score(env, seed, m) {
      const { L, puzzle, par } = linkPuzzleFor(await linkBaseFor(env), linkPractice(seed));
      const r = scoreNetwork(L, puzzle, m?.edges, par);
      return r.error ? r : { score: Math.min(LINK_MAX, r.score), round: LINK_TERMINALS };
    },
  },
  shapes: {
    maxRound: SHAPES_ROUNDS, maxScore: SHAPES_ROUNDS,
    async score(env, seed, m) {
      const r = scoreShapes(shapeRounds(await shapesPoolFor(env), shapesPractice(seed)), m?.picks, { partial: true });
      return r.error ? r : { score: r.score, round: r.results.length };
    },
  },
  rank: {
    maxRound: RANK_ROUNDS, maxScore: RANK_MAX,
    async score(env, seed, m) {
      const r = scoreRank(rankRounds(await rankPoolFor(env), rankPractice(seed)), m?.orders, { partial: true });
      return r.error ? r : { score: r.score, round: r.points.length };
    },
  },
  lens: {
    maxRound: LENS_ROUNDS, maxScore: LENS_ROUNDS,
    async score(env, seed, m) {
      const rounds = lensRounds(await lensPoolFor(env), `lens-practice:${seed}`);
      const p = m?.picks;
      if (!Array.isArray(p) || p.length < 1 || p.length > rounds.length) return { error: "picks must be 1–6 lens ids" };
      for (let i = 0; i < p.length; i++) if (typeof p[i] !== "string" || !rounds[i].options.includes(p[i])) return { error: `pick ${i + 1} is not one of the choices` };
      return { score: p.filter((x, i) => x === rounds[i].answer).length, round: p.length };
    },
  },
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
