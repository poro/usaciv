// Cached loads of the site's /data/<name>.json through the static-assets binding. Each file is fetched and
// parsed at most once per isolate; the promise lives in module scope (a failed load is dropped so the next
// request retries).
import { buildPool } from "../web/js/games/whichMetro/sim/puzzle.js";

const cache = new Map(); // name → Promise<object>

const NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/i;

export function loadData(env, request, name) {
  if (!NAME_RE.test(name)) return Promise.reject(new Error(`bad data name ${name}`));
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const res = await env.ASSETS.fetch(new Request(new URL(`/data/${name}.json`, request.url)));
      if (!res.ok) throw new Error(`/data/${name}.json: HTTP ${res.status}`);
      return res.json();
    })();
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}

/** Several files → {name: json}. */
export async function loadMany(env, request, names) {
  const vals = await Promise.all(names.map((n) => loadData(env, request, n)));
  return Object.fromEntries(names.map((n, k) => [n, vals[k]]));
}

let pool = null;
/** The Which Metro? answer pool (buildPool(cities)), cached. */
export function wmPool(env, request) {
  pool ||= loadData(env, request, "cities").then((c) => buildPool(c));
  pool.catch(() => { pool = null; });
  return pool;
}
