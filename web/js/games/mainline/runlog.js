// The run's action log, for the online boards: every action the player applied since newGame, in order, so a fresh
// replay (sim/verify.js, on the server) reaches the same state hash. Pure (no DOM).
//
// Undo is recorded as an action ({type: "undo"}), not by dropping the undone action: the state carries a network
// version (nv) and the turn's undo stack, so only replaying the undo itself gives back the identical state.
//
// The save (ctx.storage "save") is the sim state plus `log`. Saves from before the log have none (log: null): they
// still load and play, but cannot be submitted.
import * as S from "./sim/index.js";

/** check + apply + record. log may be null (an old save: play on, record nothing). → {state, error} */
export function record(env, state, log, action) {
  const error = S.check(env, state, action);
  if (error) return { state, error };
  const next = S.applyValid(env, state, action);
  log?.push(JSON.parse(JSON.stringify(action)));
  return { state: next, error: null };
}

/** The save to store: the state with its log. */
export function packSave(state, log) {
  return { ...state, log: Array.isArray(log) ? log : null };
}

/** A stored save → {state (migrated, without the log), log (array, or null for an old save)}, or null. */
export function unpackSave(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { log, ...rest } = raw;
  const state = S.migrate(rest);
  if (!state) return null;
  // only a current-version save can carry a log (a migrated old save never had one)
  return { state, log: Array.isArray(log) && rest.v === S.SAVE_VERSION ? log : null };
}
