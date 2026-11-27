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
const RETURN_KEY = "usaciv:auth-return"; // the page's hash before a Google sign-in redirect
let health = null; // Promise<boolean>, cached per page load
let config = null; // Promise<{passkeys, link, google, apple, email}>
const listeners = new Set();

// A Google sign-in comes back as /#auth=<handoff> (or #auth-error=…). Take it out of the address bar before the app
// reads its hash state, and put the page's own hash back. net.js loads before main.js runs, so this is early enough.
let pendingAuth = null;
if (typeof location !== "undefined" && /^#auth(-error)?=/.test(location.hash)) {
  const [k, v] = location.hash.slice(1).split("=");
  pendingAuth = k === "auth" ? { code: v } : { error: v };
  let back = "";
  try { back = sessionStorage.getItem(RETURN_KEY) || ""; sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ }
  history.replaceState(null, "", location.pathname + location.search + back);
}

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}
function save(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: online play still works this session */ }
  const changed = mem?.id !== p?.id || mem?.name !== p?.name;
  mem = p;
  if (changed) for (const f of listeners) { try { f(net.player()); } catch (e) { console.error(e); } }
}
let mem = load();
// Another tab signed in or out: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    const was = mem;
    mem = load();
    if (was?.id !== mem?.id || was?.name !== mem?.name) for (const f of listeners) { try { f(net.player()); } catch (err) { console.error(err); } }
  });
}

const b64u = {
  enc(buf) {
    const u = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

/** A browser error from navigator.credentials, in words a player understands. */
function passkeyError(err) {
  if (err?.name === "NotAllowedError") return "Cancelled, or the passkey prompt timed out.";
  if (err?.name === "InvalidStateError") return "This device already holds a passkey for your player.";
  if (err?.name === "SecurityError") return "Passkeys don't work on this address.";
  if (err?.name === "NotSupportedError") return "This browser can't make a passkey we can use.";
  return err?.message || String(err);
}

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
  forget() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    const had = mem;
    mem = null;
    if (had) for (const f of listeners) { try { f(null); } catch (e) { console.error(e); } }
  },
  /** Call f(player|null) whenever this device's player changes (sign-in, sign-out, rename). Returns an unsubscribe. */
  onPlayer(f) { listeners.add(f); return () => listeners.delete(f); },

  // --- login (docs/MULTIPLAYER.md "Login") ---------------------------------------------------------------------
  /** Which sign-in methods the server offers (cached). */
  authConfig() {
    config ||= request("GET", "/api/auth/config").then((r) => (r.ok ? r.data : { passkeys: false, link: false, google: false }));
    return config;
  },
  /** True when this browser can use passkeys at all. */
  passkeysSupported: () => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials,
  /** {id, name, created, passkeys, identities, devices, secured, thisDevice} or throws. */
  async account() {
    const r = await request("GET", "/api/account");
    if (r.status === 401) { net.forget(); throw new Error("This device's player was signed out"); }
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  /** Save a passkey for this device's player (the browser asks the person). */
  async addPasskey() {
    const o = await request("POST", "/api/auth/passkey/register/options", {});
    if (!o.ok) throw new Error(o.error);
    const pk = o.data.publicKey;
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          ...pk,
          challenge: b64u.dec(pk.challenge),
          user: { ...pk.user, id: b64u.dec(pk.user.id) },
          excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: b64u.dec(c.id) })),
        },
      });
    } catch (err) { throw new Error(passkeyError(err)); }
    const r = await request("POST", "/api/auth/passkey/register", {
      challengeId: o.data.challengeId,
      credential: {
        id: cred.id,
        clientDataJSON: b64u.enc(cred.response.clientDataJSON),
        attestationObject: b64u.enc(cred.response.attestationObject),
        transports: cred.response.getTransports?.() || [],
      },
    });
    if (!r.ok) throw new Error(r.error);
    return r.data.passkey;
  },
  /** Sign in with a passkey; this device's anonymous player (if any) is merged into the account. */
  async signInWithPasskey() {
    const o = await request("POST", "/api/auth/passkey/login/options", {});
    if (!o.ok) throw new Error(o.error);
    const pk = o.data.publicKey;
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: b64u.dec(pk.challenge), allowCredentials: [] } });
    } catch (err) { throw new Error(passkeyError(err)); }
    const r = await request("POST", "/api/auth/passkey/login", {
      challengeId: o.data.challengeId,
      credential: {
        id: cred.id,
        clientDataJSON: b64u.enc(cred.response.clientDataJSON),
        authenticatorData: b64u.enc(cred.response.authenticatorData),
        signature: b64u.enc(cred.response.signature),
        userHandle: cred.response.userHandle ? b64u.enc(cred.response.userHandle) : null,
      },
    });
    if (!r.ok) throw new Error(r.error);
    save({ id: r.data.id, name: r.data.name, token: r.data.token });
    return r.data; // {id, name, token, merged}
  },
  /** A one-time code (10 minutes) that signs another device in as this player. */
  async linkCode() {
    const r = await request("POST", "/api/auth/link", {});
    if (!r.ok) throw new Error(r.error);
    return r.data; // {code, expires}
  },
  async redeemCode(code) {
    const r = await request("POST", "/api/auth/link/redeem", { code });
    if (!r.ok) throw new Error(r.error);
    save({ id: r.data.id, name: r.data.name, token: r.data.token });
    return r.data;
  },
  /** Leave for Google; the page comes back signed in (see pendingAuth above). */
  async signInWithGoogle() {
    try { sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* ignore */ }
    const r = await request("POST", "/api/auth/google/start", { returnTo: location.pathname });
    if (!r.ok) throw new Error(r.error);
    location.assign(r.data.url);
  },
  /** Finish a Google sign-in that just came back; null when there was none. */
  async finishRedirect() {
    const p = pendingAuth;
    pendingAuth = null;
    if (!p) return null;
    if (p.error) throw new Error(p.error === "cancelled" ? "Google sign-in was cancelled" : "Google sign-in failed, try again");
    const r = await request("POST", "/api/auth/handoff", { code: p.code });
    if (!r.ok) throw new Error(r.error);
    save({ id: r.data.id, name: r.data.name, token: r.data.token });
    return r.data;
  },
  async signOut() {
    await request("POST", "/api/auth/signout", {});
    net.forget();
  },
  async signOutOthers() {
    const r = await request("POST", "/api/auth/signout-others", {});
    if (!r.ok) throw new Error(r.error);
  },
  async renamePasskey(id, name) {
    const r = await request("PATCH", `/api/auth/passkey/${id}`, { name });
    if (!r.ok) throw new Error(r.error);
  },
  async removePasskey(id) {
    const r = await request("DELETE", `/api/auth/passkey/${id}`);
    if (!r.ok) throw new Error(r.error);
  },
  async unlinkIdentity(provider) {
    const r = await request("DELETE", `/api/auth/identity/${provider}`);
    if (!r.ok) throw new Error(r.error);
  },
  async deleteAccount(confirm) {
    const r = await request("DELETE", "/api/account", { confirm });
    if (!r.ok) throw new Error(r.error);
    net.forget();
  },
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
