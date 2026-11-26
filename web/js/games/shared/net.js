// Browser client for the multiplayer API (docs/MULTIPLAYER.md). Same origin, JSON, never throws on "offline":
// available() is false on the static dev server (no /api), and games then hide their online features.
//
//   import { net } from "../shared/net.js";
//   if (await net.available()) {
//     const me = await net.ensurePlayer("Mark");      // creates the player once; later calls return it
//     const r = await net.post("/api/wm/daily", {...}); // {ok, status, data}
//     const ws = net.socket(`/api/wm/race/${code}/ws`); // token appended for you
//   }

const KEY = "usaciv:player";
let health = null; // Promise<boolean>, cached per page load

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}
function save(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: online play still works this session */ }
  mem = p;
}
let mem = load();

async function request(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (mem?.token) headers.Authorization = `Bearer ${mem.token}`;
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let data = null;
    try { data = await res.json(); } catch { /* empty or not JSON */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : data?.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: "offline" };
  }
}

export const net = {
  /** True when this site has the multiplayer backend (cached; a 2 s timeout counts as no). */
  available() {
    health ||= (async () => {
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const t = setTimeout(() => ctrl?.abort(), 2000);
      try {
        const res = await fetch("/api/health", { cache: "no-store", signal: ctrl?.signal });
        if (!res.ok) return false;
        const j = await res.json();
        return j?.ok === true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    return health;
  },
  /** The stored player {id, token, name}, or null. */
  player() { return mem ? { id: mem.id, name: mem.name } : null; },
  /** Create the player on first use (name required then); otherwise return the stored one. */
  async ensurePlayer(name) {
    if (mem?.token) return net.player();
    const r = await request("POST", "/api/player", { name });
    if (!r.ok) throw new Error(r.error);
    save(r.data);
    return net.player();
  },
  async rename(name) {
    const r = await request("PATCH", "/api/player", { name });
    if (!r.ok) throw new Error(r.error);
    save({ ...mem, name: r.data.name });
    return net.player();
  },
  /** Forget this device's player (a new one is made next time). */
  forget() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } mem = null; },
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  /** A WebSocket to an /api path on this origin, with the player's token as ?token=. */
  socket(path) {
    const u = new URL(path, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (mem?.token) u.searchParams.set("token", mem.token);
    return new WebSocket(u);
  },
};
