// Server-side run verification for the online boards (docs/MULTIPLAYER.md, "Mainline boards"). Pure: no DOM, no
// clock; the Worker imports it, and the browser uses it to check a log before sending it.
//
//   verifyRun(data, {scenario, seed, home, log}) → {ok, uplift, beat, score, hash, year, error?, at?}
//   data = {world, cities, trade, infrastructure, disasters}   (REQUIRED_DATA: the parsed web/data files)
//
// It builds the env exactly as the browser does (the browser's ctx.hexmap is makeHexMap(world), which makeEnv
// rebuilds from data.world), starts newGame(env, {seed}) and applies every action with check() + apply. The first
// malformed or invalid action rejects the run. The log must end the game (state.over: 2050 played), and the score is
// the end screen's summary(). The log is the browser's action log, undo actions included (index.js records them).
import { makeEnv } from "./env.js";
import { newGame, check, applyValid } from "./state.js";
import { summary } from "./score.js";
import { stateHash } from "./hash.js";
import { scenarioById } from "./scenarios.js";
import { HZ_TYPES } from "./events.js";

export const REQUIRED_DATA = ["world", "cities", "trade", "infrastructure", "disasters"];

// Bounds. A bot Sandbox game logs ~1,500 actions and ~2,000 path cells; a person plays far fewer, undo included.
export const MAX_LOG = 5000; // actions
export const MAX_PATH = 1000; // cells in one build
export const MAX_CELLS = 60000; // path cells over the whole log
const MAX_ID = 64;

// action type → allowed fields (besides type); "?" = optional
const SHAPES = {
  build: { path: 1 },
  undo: {},
  repair: { key: 1 },
  repairAll: {},
  harden: { key: 1, hz: 0 },
  double: { key: 1 },
  hub: { city: 1 },
  express: { id: 1 },
  closeExpress: { id: 1 },
  endTurn: {},
};
const isStr = (v, re = null) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID && (!re || re.test(v));

/** Why an action is malformed (before the rules see it), or null. size = hex count of the map. */
export function shapeError(a, size) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "Not an action";
  const shape = Object.hasOwn(SHAPES, a.type) ? SHAPES[a.type] : null;
  if (!shape) return `Unknown action ${typeof a.type === "string" ? `"${a.type.slice(0, MAX_ID)}"` : ""}`.trim();
  for (const k of Object.keys(a)) if (k !== "type" && !Object.hasOwn(shape, k)) return `Unexpected field "${k.slice(0, MAX_ID)}"`;
  for (const [k, req] of Object.entries(shape)) if (req && a[k] === undefined) return `Missing "${k}"`;
  if (a.type === "build") {
    const p = a.path;
    if (!Array.isArray(p) || p.length < 2 || p.length > MAX_PATH) return "Bad path";
    for (const c of p) if (!Number.isInteger(c) || c < 0 || c >= size) return "Bad path";
  }
  if ("key" in shape && !isStr(a.key, /^\d+-\d+$/)) return "Bad link key";
  if (a.hz !== undefined && !HZ_TYPES.includes(a.hz)) return "Bad hazard";
  if ("city" in shape && !isStr(a.city)) return "Bad city";
  if ("id" in shape && !isStr(a.id)) return "Bad contract";
  return null;
}

// Envs are costly to build (5–30 ms) and depend only on data + scenario + home: cache them per data.world, and per
// the other files' identity (the Worker keeps the parsed files in module scope).
const envCache = new WeakMap();
function envFor(data, scenario, home) {
  let m = envCache.get(data.world);
  if (!m) envCache.set(data.world, (m = new Map()));
  const key = `${scenario}:${home ?? ""}`;
  const hit = m.get(key);
  if (hit && REQUIRED_DATA.every((n) => hit.data[n] === data[n])) return hit.env;
  const env = makeEnv(data, scenario, { home });
  m.set(key, { env, data: Object.fromEntries(REQUIRED_DATA.map((n) => [n, data[n]])) });
  return env;
}

const fail = (error, at = null) => ({ ok: false, error, at, uplift: null, beat: false, score: null, hash: null, year: null });

export function verifyRun(data, { scenario, seed, home = null, log } = {}) {
  for (const n of REQUIRED_DATA) if (!data?.[n]) return fail(`Server is missing ${n}.json`);
  const sc = scenarioById(scenario);
  if (!sc) return fail("Unknown scenario");
  if (!Number.isSafeInteger(seed) || seed < 0) return fail("Bad seed");
  if (sc.home) {
    if (home != null && home !== sc.home) return fail("This scenario has a fixed home");
    home = null;
  } else if (!isStr(home, /^\d{5}$/)) return fail("Sandbox runs need a home metro");
  if (!Array.isArray(log)) return fail("No action log");
  if (log.length > MAX_LOG) return fail(`The log is too long (${log.length} actions; at most ${MAX_LOG})`);

  let env;
  try {
    env = envFor(data, sc.id, home);
  } catch (err) {
    return fail(`Could not build the scenario: ${err.message}`);
  }
  if (!sc.home && env.home?.id !== home) return fail("Unknown home metro");

  const size = env.hexmap.size;
  let cells = 0;
  let s = newGame(env, { seed });
  for (let i = 0; i < log.length; i++) {
    const a = log[i];
    const bad = shapeError(a, size);
    if (bad) return fail(`Action ${i + 1}: ${bad}`, i);
    if (a.type === "build" && (cells += a.path.length) > MAX_CELLS) return fail("The log lays too much track", i);
    const err = check(env, s, a);
    if (err) return fail(`Action ${i + 1} (${a.type}, ${s.year}): ${err}`, i);
    s = applyValid(env, s, a);
  }
  if (!s.over) return fail(`The run is not finished (it stops in ${s.year})`, log.length);
  const sum = summary(env, s);
  return { ok: true, uplift: sum.uplift, beat: sum.beat, score: sum.score, hash: stateHash(s), year: sum.year };
}
