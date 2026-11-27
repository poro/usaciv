// Mainline: verified runs and per-scenario boards (docs/MULTIPLAYER.md "Mainline boards").
// The replay lives in web/js/games/mainline/sim/verify.js: verifyRun(data, {scenario, seed, home, log}) →
// {ok, uplift, beat, hash, year, error?} and REQUIRED_DATA (the /data names it needs). It is imported lazily
// through a template-literal path so the bundler (esbuild) includes whatever sim/*.js exists at build time: until
// verify.js exists the import fails at runtime and both endpoints answer 503; once it exists, the next build
// picks it up with no change here.
import { json, error, readJson, requirePlayer, optionalPlayer, limitWrite, HttpError } from "./http.js";
import { loadMany } from "./data.js";
import { cleanMlRun, ML_SCENARIOS, keyInWindow, utcToday, ML_MAX_LOG } from "./rules.js";
import { mlDaily } from "../web/js/games/mainline/sim/daily.js";

const NOT_READY = "Mainline boards are not ready";

async function verifier() {
  const name = "verify";
  try {
    const mod = await import(`../web/js/games/mainline/sim/${name}.js`);
    if (typeof mod.verifyRun !== "function" || !Array.isArray(mod.REQUIRED_DATA)) return null;
    return mod;
  } catch {
    return null;
  }
}

const standing = async (env, scenario, uplift) => {
  const r = await env.DB.prepare(
    "SELECT SUM(uplift > ?2) AS above, COUNT(*) AS total FROM ml_runs WHERE scenario = ?1",
  ).bind(scenario, uplift).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/ml/run {scenario, seed, home, log} → {uplift, beat, rank, total, best, improved} */
export async function submitRun(request, env) {
  const me = await requirePlayer(env, request);
  const v = await verifier();
  if (!v) return error(503, NOT_READY);
  await limitWrite(env, me.id);
  const run = cleanMlRun(await readJson(request, 512 * 1024));
  if (run.error) throw new HttpError(400, run.error);

  const data = await loadMany(env, request, v.REQUIRED_DATA);
  let res;
  try {
    res = await v.verifyRun(data, run);
  } catch (e) {
    throw new HttpError(422, "Run does not replay");
  }
  if (!res?.ok || typeof res.uplift !== "number" || !Number.isFinite(res.uplift)) {
    throw new HttpError(422, res?.error || "Run is not finished or does not replay");
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ml_runs (player, scenario, seed, home, uplift, hash, year, log_json, created)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(player, scenario) DO UPDATE SET
       seed = excluded.seed, home = excluded.home, uplift = excluded.uplift, hash = excluded.hash,
       year = excluded.year, log_json = excluded.log_json, created = excluded.created
     WHERE excluded.uplift > ml_runs.uplift`,
  ).bind(me.id, run.scenario, String(run.seed), run.home, res.uplift, String(res.hash ?? ""), res.year | 0, JSON.stringify(run.log), now).run();
  const best = await env.DB.prepare("SELECT uplift, created FROM ml_runs WHERE player = ? AND scenario = ?").bind(me.id, run.scenario).first();
  return json({
    uplift: res.uplift, beat: res.beat ?? null, ...(await standing(env, run.scenario, best.uplift)),
    best: best.uplift, improved: best.created === now && best.uplift === res.uplift,
  });
}

/** GET /api/ml/board/:scenario?limit=20 → {scenario, total, top: [{rank, name, uplift, seed, home, year}], you} */
export async function mlBoard(request, env, scenario) {
  if (!ML_SCENARIOS.includes(scenario)) return error(404, "Unknown scenario");
  if (!(await verifier())) return error(503, NOT_READY);
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, r.uplift, r.seed, r.home, r.year,
              (SELECT COUNT(*) FROM ml_runs b WHERE b.scenario = r.scenario AND b.uplift > r.uplift) + 1 AS rank
       FROM ml_runs r JOIN players p ON p.id = r.player
       WHERE r.scenario = ? ORDER BY r.uplift DESC, r.created ASC LIMIT ?`,
    ).bind(scenario, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM ml_runs WHERE scenario = ?").bind(scenario).first(),
  ]);
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT uplift, seed, home, year FROM ml_runs WHERE player = ? AND scenario = ?").bind(me.id, scenario).first();
    if (mine) you = { rank: (await standing(env, scenario, mine.uplift)).rank, ...rowOut(mine) };
  }
  return json({ scenario, total: tot.n | 0, top: top.results.map((r) => ({ rank: r.rank, name: r.name, ...rowOut(r) })), you });
}

const rowOut = (r) => ({ uplift: r.uplift, seed: Number(r.seed), home: r.home, year: r.year });

// --- Mainline daily (sim/daily.js; docs/MULTIPLAYER.md "Mainline daily") -----------------------------------------

const dailyRank = async (env, key, uplift) => {
  const r = await env.DB.prepare("SELECT SUM(uplift > ?2) AS above, COUNT(*) AS total FROM ml_daily WHERE key = ?1").bind(key, uplift).first();
  return { rank: (r.above | 0) + 1, total: r.total | 0 };
};

/** POST /api/ml/daily {key, log} → {uplift, beat, rank, total, best, improved, scenario, seed} (stored: true on a resubmission). */
export async function submitMlDaily(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request, 512 * 1024);
  const key = body?.key;
  if (!keyInWindow(key, utcToday())) throw new HttpError(400, "That day's challenge is closed");
  const d = mlDaily(key);
  const prev = await env.DB.prepare("SELECT uplift FROM ml_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  if (prev) return json({ uplift: prev.uplift, ...(await dailyRank(env, key, prev.uplift)), best: prev.uplift, improved: false, stored: true, scenario: d.scenario, seed: d.seed });
  const v = await verifier();
  if (!v) return error(503, NOT_READY);
  await limitWrite(env, me.id);
  if (!Array.isArray(body.log) || body.log.length > ML_MAX_LOG) throw new HttpError(400, "log must be an array");
  const data = await loadMany(env, request, v.REQUIRED_DATA);
  let res;
  try {
    res = v.verifyRun(data, { scenario: d.scenario, seed: d.seed, home: null, log: body.log, daily: key });
  } catch {
    throw new HttpError(422, "Run does not replay");
  }
  if (!res?.ok || !Number.isFinite(res.uplift)) throw new HttpError(422, res?.error || "Run is not finished or does not replay");
  await env.DB.prepare("INSERT OR IGNORE INTO ml_daily (player, key, scenario, uplift, hash, log_json, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(me.id, key, d.scenario, res.uplift, String(res.hash ?? ""), JSON.stringify(body.log), Date.now()).run();
  const row = await env.DB.prepare("SELECT uplift FROM ml_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
  return json({ uplift: row.uplift, beat: res.beat ?? null, ...(await dailyRank(env, key, row.uplift)), best: row.uplift, improved: true, scenario: d.scenario, seed: d.seed });
}

/** GET /api/ml/daily/:key?limit=20 → {key, scenario, seed, total, top: [{rank, name, uplift, seed, home, year}], you} */
export async function mlDailyBoard(request, env, key) {
  const d = mlDaily(key);
  if (!d) return error(400, "Bad date key");
  const limit = Math.max(1, Math.min(100, Number.parseInt(new URL(request.url).searchParams.get("limit") || "20", 10) || 20));
  const [me, top, tot] = await Promise.all([
    optionalPlayer(env, request),
    env.DB.prepare(
      `SELECT p.name, r.uplift, (SELECT COUNT(*) FROM ml_daily b WHERE b.key = r.key AND b.uplift > r.uplift) + 1 AS rank
       FROM ml_daily r JOIN players p ON p.id = r.player WHERE r.key = ? ORDER BY r.uplift DESC, r.created ASC LIMIT ?`,
    ).bind(key, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM ml_daily WHERE key = ?").bind(key).first(),
  ]);
  const out = (r) => ({ uplift: r.uplift, seed: d.seed, home: null, year: 2026 + d.years });
  let you = null;
  if (me) {
    const mine = await env.DB.prepare("SELECT uplift FROM ml_daily WHERE player = ? AND key = ?").bind(me.id, key).first();
    if (mine) you = { rank: (await dailyRank(env, key, mine.uplift)).rank, ...out(mine) };
  }
  return json({ key, scenario: d.scenario, seed: d.seed, total: tot?.n | 0, top: top.results.map((r) => ({ rank: r.rank, name: r.name, ...out(r) })), you });
}
