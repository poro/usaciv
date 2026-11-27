// Login (worker/auth.js, worker/webauthn.js) end to end through the Worker's fetch handler, with D1 played by
// node:sqlite (tests/js/d1shim.mjs) and a software passkey authenticator built on WebCrypto. node --test, no Workers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { makeD1 } from "./d1shim.mjs";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}", shortCircuit: true };
    return next(spec, ctx);
  },
});
const worker = (await import("../../worker/index.js")).default;
const W = await import("../../worker/webauthn.js");
const A = await import("../../worker/auth.js");

const ORIGIN = "https://usaciv.test";
const RP = "usaciv.test";

// --- a tiny CBOR encoder and software authenticator ------------------------------------------------------------
function cbor(v) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  };
  const enc = (x) => {
    if (x === true || x === false || x === null) { out.push(x === null ? 0xf6 : x ? 0xf5 : 0xf4); return; }
    if (typeof x === "number") return x >= 0 ? head(0, x) : head(1, -1 - x);
    if (typeof x === "string") { const b = new TextEncoder().encode(x); head(3, b.length); out.push(...b); return; }
    if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); return; }
    if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); return; }
    if (x instanceof Map) { head(5, x.size); for (const [k, val] of x) { enc(k); enc(val); } return; }
    if (x && typeof x === "object") return enc(new Map(Object.entries(x)));
    throw new Error("cbor: unsupported");
  };
  enc(v);
  return new Uint8Array(out);
}
const cat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b));
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = cat(new Uint8Array([0]), b); return cat(new Uint8Array([2, b.length]), b); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

async function makeAuthenticator({ rpId = RP, origin = ORIGIN } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  let count = 0;
  const id = W.b64urlEncode(credId);
  return {
    id,
    count: (n) => { count = n; },
    async create(publicKey, over = {}) {
      const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: publicKey.challenge, origin: over.origin || origin, crossOrigin: false }));
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, W.b64urlDecode(jwk.x)], [-3, W.b64urlDecode(jwk.y)]]));
      const authData = cat(await sha(over.rpId || rpId), new Uint8Array([0x45]), u32(count), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
      return { id, clientDataJSON: W.b64urlEncode(cd), attestationObject: W.b64urlEncode(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal", "hybrid", "<bad>"] };
    },
    async get(publicKey, over = {}) {
      count += over.step ?? 1;
      const cd = new TextEncoder().encode(JSON.stringify({ type: over.type || "webauthn.get", challenge: over.challenge || publicKey.challenge, origin: over.origin || origin }));
      const authData = cat(await sha(over.rpId || rpId), new Uint8Array([over.flags ?? 0x05]), u32(count));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, cat(authData, await sha(cd))));
      return { id, clientDataJSON: W.b64urlEncode(cd), authenticatorData: W.b64urlEncode(authData), signature: W.b64urlEncode(rawToDer(raw)), userHandle: null };
    },
  };
}

// --- calling the Worker ------------------------------------------------------------------------------------------
function harness() {
  const env = { DB: makeD1(), IP_SALT: "test" };
  let ip = 1;
  const call = async (method, path, { body, token, origin = ORIGIN, ipAddr, cookie } = {}) => {
    const headers = { "CF-Connecting-IP": ipAddr || `10.0.0.${ip}` };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), env);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* redirect */ }
    return { status: res.status, data, headers: res.headers };
  };
  const newPlayer = async (name) => (await call("POST", "/api/player", { body: { name } })).data;
  return { env, call, newPlayer, nextIp: () => { ip++; } };
}

test("CBOR, DER and COSE helpers", () => {
  const m = W.cborDecode(cbor(new Map([[1, 2], [-3, new Uint8Array([1, 2])], ["s", [true, false, null]]]))).value;
  assert.equal(m.get(1), 2);
  assert.deepEqual([...m.get(-3)], [1, 2]);
  assert.deepEqual(m.get("s"), [true, false, null]);
  assert.equal(W.cborDecode(cbor(70000)).value, 70000);
  assert.throws(() => W.cborDecode(new Uint8Array([0x5f])), W.AuthError, "indefinite lengths refused");
  assert.throws(() => W.cborDecode(new Uint8Array([0x58, 10, 1])), W.AuthError, "truncated");
  const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
  assert.deepEqual([...W.derToRaw(rawToDer(raw))], [...raw]);
  assert.throws(() => W.coseToJwk(new Map([[1, 1], [3, -8]])), W.AuthError, "EdDSA not supported");
  assert.equal(W.b64urlEncode(W.b64urlDecode("AQID_-8")), "AQID_-8");
});

test("passkey: register on device 1, sign in on device 2, scores merge", async () => {
  const h = harness();
  const cfg = await h.call("GET", "/api/auth/config");
  assert.deepEqual(cfg.data, { passkeys: true, link: true, google: false, apple: false, email: false });

  const ann = await h.newPlayer("Ann");
  const auth = await makeAuthenticator();
  const opt = await h.call("POST", "/api/auth/passkey/register/options", { token: ann.token });
  assert.equal(opt.status, 200);
  assert.equal(opt.data.publicKey.rp.id, RP);
  assert.equal(opt.data.publicKey.user.name, "Ann");
  assert.equal(opt.data.publicKey.authenticatorSelection.residentKey, "required");
  const cred = await auth.create(opt.data.publicKey);
  const reg = await h.call("POST", "/api/auth/passkey/register", { token: ann.token, body: { challengeId: opt.data.challengeId, credential: cred } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal(reg.data.passkey.name, "Passkey 1");
  // the challenge is single use
  const again = await h.call("POST", "/api/auth/passkey/register", { token: ann.token, body: { challengeId: opt.data.challengeId, credential: cred } });
  assert.equal(again.status, 400);
  const acct = await h.call("GET", "/api/account", { token: ann.token });
  assert.equal(acct.data.secured, true);
  assert.equal(acct.data.passkeys.length, 1);
  assert.equal(acct.data.thisDevice, "device");
  assert.equal(JSON.parse((await h.env.DB.prepare("SELECT transports FROM passkeys").first()).transports).length, 2, "bad transports dropped");

  // Ann has a Mainline best and a daily on device 1.
  const now = Date.now();
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, '2020-01-02', 20, '[]', ?)").bind(ann.id, now).run();
  await h.env.DB.prepare("INSERT INTO ml_runs VALUES (?, 'texas', 's1', NULL, 1.5, 'h', 2050, NULL, ?)").bind(ann.id, now).run();

  // Device 2 played anonymously as "Guest": a daily on another day, a clashing daily, and a better Texas run.
  const guest = await h.newPlayer("Guest");
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, '2020-01-01', 18, '[]', ?)").bind(guest.id, now).run();
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, '2020-01-02', 25, '[]', ?)").bind(guest.id, now).run();
  // today's daily is still open: it does not merge (no retrying the daily on throwaway players)
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, ?, 25, '[]', ?)").bind(guest.id, new Date().toISOString().slice(0, 10), now).run();
  await h.env.DB.prepare("INSERT INTO ml_runs VALUES (?, 'texas', 's2', NULL, 2.5, 'h2', 2050, NULL, ?)").bind(guest.id, now).run();
  await h.env.DB.prepare("INSERT INTO ml_runs VALUES (?, 'rust', 's3', NULL, 0.5, 'h3', 2050, NULL, ?)").bind(guest.id, now).run();

  const lo = await h.call("POST", "/api/auth/passkey/login/options");
  assert.equal(lo.data.publicKey.rpId, RP);
  assert.deepEqual(lo.data.publicKey.allowCredentials, []);
  const asr = await auth.get(lo.data.publicKey);
  const li = await h.call("POST", "/api/auth/passkey/login", { token: guest.token, body: { challengeId: lo.data.challengeId, credential: asr } });
  assert.equal(li.status, 200, JSON.stringify(li.data));
  assert.equal(li.data.id, ann.id);
  assert.equal(li.data.name, "Ann");
  assert.deepEqual(li.data.merged, { daily: 2, runs: 2 });
  const d2 = li.data.token;
  assert.notEqual(d2, ann.token);
  // Both devices are Ann now; the guest is gone.
  assert.equal((await h.call("GET", "/api/player", { token: d2 })).data.id, ann.id);
  assert.equal((await h.call("GET", "/api/player", { token: ann.token })).data.id, ann.id);
  assert.equal((await h.call("GET", "/api/player", { token: guest.token })).status, 401);
  assert.equal((await h.call("GET", "/api/account", { token: d2 })).data.thisDevice, "session");
  const daily = (await h.env.DB.prepare("SELECT key, score FROM wm_daily WHERE player = ? ORDER BY key").bind(ann.id).all()).results;
  assert.deepEqual(daily, [{ key: "2020-01-01", score: 18 }, { key: "2020-01-02", score: 20 }], "the account's daily wins a clash; today's stays behind");
  const runs = (await h.env.DB.prepare("SELECT scenario, uplift, seed FROM ml_runs WHERE player = ? ORDER BY scenario").bind(ann.id).all()).results;
  assert.deepEqual(runs, [{ scenario: "rust", uplift: 0.5, seed: "s3" }, { scenario: "texas", uplift: 2.5, seed: "s2" }], "the better run wins");
  assert.equal((await h.env.DB.prepare("SELECT COUNT(*) n FROM players").first()).n, 1);
  assert.equal((await h.env.DB.prepare("SELECT sign_count FROM passkeys").first()).sign_count, 1);
});

test("passkey sign-in refuses tampering, replays, other sites and cloned counters", async () => {
  const h = harness();
  const ann = await h.newPlayer("Ann");
  const auth = await makeAuthenticator();
  const reg = async (over) => {
    const o = (await h.call("POST", "/api/auth/passkey/register/options", { token: ann.token })).data;
    return h.call("POST", "/api/auth/passkey/register", { token: ann.token, body: { challengeId: o.challengeId, credential: await auth.create(o.publicKey, over) } });
  };
  assert.equal((await reg({ origin: "https://evil.test" })).status, 400);
  assert.equal((await reg({ rpId: "evil.test" })).status, 400);
  assert.equal((await reg()).status, 201);
  assert.equal((await reg()).status, 409, "same passkey twice");

  const login = async (over, mutate) => {
    const o = (await h.call("POST", "/api/auth/passkey/login/options")).data;
    const c = await auth.get(o.publicKey, over);
    mutate?.(c);
    return h.call("POST", "/api/auth/passkey/login", { body: { challengeId: o.challengeId, credential: c } });
  };
  assert.equal((await login({ origin: "https://evil.test" })).status, 400);
  assert.equal((await login({ rpId: "evil.test" })).status, 400);
  assert.equal((await login({ type: "webauthn.create" })).status, 400);
  assert.equal((await login({ challenge: "AAAAAAAAAAAAAAAAAAAAAA" })).status, 400);
  assert.equal((await login({ flags: 0x04 })).status, 400, "user presence required");
  assert.equal((await login({}, (c) => { const s = W.b64urlDecode(c.signature); s[s.length - 1] ^= 1; c.signature = W.b64urlEncode(s); })).status, 400);
  assert.equal((await login({}, (c) => { c.id = W.b64urlEncode(new Uint8Array(32)); })).status, 404);
  const ok = await login({ step: 5 });
  assert.equal(ok.status, 200);
  auth.count(2);
  assert.equal((await login({ step: 1 })).status, 400, "counter went backwards");
  // A used challenge can't be replayed.
  const o = (await h.call("POST", "/api/auth/passkey/login/options")).data;
  const c = await auth.get(o.publicKey, { step: 10 });
  assert.equal((await h.call("POST", "/api/auth/passkey/login", { body: { challengeId: o.challengeId, credential: c } })).status, 200);
  assert.equal((await h.call("POST", "/api/auth/passkey/login", { body: { challengeId: o.challengeId, credential: c } })).status, 400);
  // Cross-site writes are refused before any of this.
  assert.equal((await h.call("POST", "/api/auth/passkey/login/options", { origin: "https://evil.test" })).status, 403);
});

test("device link codes, sign-out, sign-out others, passkey rename/remove, delete account", async () => {
  const h = harness();
  const ann = await h.newPlayer("Ann");
  const l = await h.call("POST", "/api/auth/link", { token: ann.token });
  assert.equal(l.status, 201);
  assert.match(l.data.code, /^[A-Z2-9]{8}$/);
  const pretty = `${l.data.code.slice(0, 4).toLowerCase()}-${l.data.code.slice(4)}`;
  const r = await h.call("POST", "/api/auth/link/redeem", { body: { code: pretty } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.id, ann.id);
  assert.equal(r.data.merged, null);
  assert.equal((await h.call("POST", "/api/auth/link/redeem", { body: { code: l.data.code } })).status, 404, "single use");
  assert.equal((await h.call("POST", "/api/auth/link/redeem", { body: { code: "abc" } })).status, 400);

  // A secured player is never merged into another.
  const bob = await h.newPlayer("Bob");
  const auth = await makeAuthenticator();
  const o = (await h.call("POST", "/api/auth/passkey/register/options", { token: bob.token })).data;
  await h.call("POST", "/api/auth/passkey/register", { token: bob.token, body: { challengeId: o.challengeId, credential: await auth.create(o.publicKey) } });
  const l2 = (await h.call("POST", "/api/auth/link", { token: ann.token })).data;
  const r2 = await h.call("POST", "/api/auth/link/redeem", { token: bob.token, body: { code: l2.code } });
  assert.equal(r2.data.id, ann.id);
  assert.equal(r2.data.merged, null);
  assert.equal((await h.call("GET", "/api/player", { token: bob.token })).data.id, bob.id, "Bob still exists");

  // Rename and remove a passkey.
  const pk = (await h.call("GET", "/api/account", { token: bob.token })).data.passkeys[0];
  assert.equal((await h.call("PATCH", `/api/auth/passkey/${pk.id}`, { token: bob.token, body: { name: "My phone" } })).data.name, "My phone");
  assert.equal((await h.call("DELETE", `/api/auth/passkey/${pk.id}`, { token: ann.token })).status, 404, "only your own");
  assert.equal((await h.call("DELETE", `/api/auth/passkey/${pk.id}`, { token: bob.token })).status, 200);
  assert.equal((await h.call("GET", "/api/account", { token: bob.token })).data.secured, false);

  // Sign out: a session token stops working; the first-device token is revoked in place.
  const sess = r.data.token;
  assert.equal((await h.call("POST", "/api/auth/signout", { token: sess })).status, 200);
  assert.equal((await h.call("GET", "/api/player", { token: sess })).status, 401);
  // Sign out others from a new session keeps only that one.
  const l3 = (await h.call("POST", "/api/auth/link", { token: ann.token })).data;
  const keep = (await h.call("POST", "/api/auth/link/redeem", { body: { code: l3.code } })).data.token;
  assert.equal((await h.call("POST", "/api/auth/signout-others", { token: keep })).status, 200);
  assert.equal((await h.call("GET", "/api/player", { token: ann.token })).status, 401);
  assert.equal((await h.call("GET", "/api/player", { token: r2.data.token })).status, 401);
  assert.equal((await h.call("GET", "/api/player", { token: keep })).data.id, ann.id);

  // Delete the account: needs the nickname, removes everything.
  assert.equal((await h.call("DELETE", "/api/account", { token: keep, body: { confirm: "nope" } })).status, 400);
  assert.equal((await h.call("DELETE", "/api/account", { token: keep, body: { confirm: "Ann" } })).status, 200);
  assert.equal((await h.call("GET", "/api/player", { token: keep })).status, 401);
  assert.equal((await h.env.DB.prepare("SELECT COUNT(*) n FROM sessions").first()).n, 0);
});

test("link codes are rate limited per IP", async () => {
  const h = harness();
  let last;
  for (let i = 0; i < 11; i++) last = await h.call("POST", "/api/auth/link/redeem", { body: { code: "AAAAAAAA" }, ipAddr: "9.9.9.9" });
  assert.equal(last.status, 429);
  assert.equal((await h.call("POST", "/api/auth/link/redeem", { body: { code: "AAAAAAAA" }, ipAddr: "9.9.9.8" })).status, 404);
});

test("Google: off without secrets; with them, start → callback → handoff signs in and links", async () => {
  const h = harness();
  assert.equal((await h.call("POST", "/api/auth/google/start", { body: {} })).status, 404);
  h.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  h.env.GOOGLE_CLIENT_SECRET = "secret";
  assert.equal((await h.call("GET", "/api/auth/config")).data.google, true);
  const ann = await h.newPlayer("Ann");
  const st = await h.call("POST", "/api/auth/google/start", { token: ann.token, body: { returnTo: "/" } });
  const setCookie = st.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-usaciv-oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const cookie = setCookie.split(";")[0];
  const url = new URL(st.data.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state"), nonce = url.searchParams.get("nonce");

  let curNonce = nonce; // what the mocked Google signs into the ID token (the latest flow's nonce)
  const realFetch = globalThis.fetch;
  const idToken = (claims) => `x.${W.b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
  let sent = null;
  globalThis.fetch = async (u, init) => { sent = { u: String(u), body: String(init.body) }; return new Response(JSON.stringify({ id_token: idToken({ iss: "https://accounts.google.com", aud: h.env.GOOGLE_CLIENT_ID, sub: "g-123", email: "ann@example.com", email_verified: true, nonce: curNonce, exp: Date.now() / 1000 + 600 }) })); };
  try {
    // From another browser (no cookie) the state is refused, and it is spent.
    const st0 = await h.call("POST", "/api/auth/google/start", { body: {} });
    const s0 = new URL(st0.data.url).searchParams.get("state");
    assert.match((await h.call("GET", `/api/auth/google/callback?state=${s0}&code=abc`, { origin: null })).headers.get("Location"), /auth-error=browser/);
    const cb = await h.call("GET", `/api/auth/google/callback?state=${state}&code=abc`, { origin: null, cookie });
    assert.equal(cb.status, 302);
    assert.match(sent.body, /code_verifier=/);
    const loc = cb.headers.get("Location");
    assert.match(loc, /^\/#auth=/);
    const hand = loc.split("#auth=")[1];
    const hs = await h.call("POST", "/api/auth/handoff", { body: { code: hand }, cookie });
    assert.equal(hs.data.id, ann.id, "linked to the signed-in player");
    assert.equal((await h.call("POST", "/api/auth/handoff", { body: { code: hand } })).status, 404, "single use");
    const acct = (await h.call("GET", "/api/account", { token: hs.data.token })).data;
    assert.deepEqual(acct.identities.map((i) => [i.provider, i.email]), [["google", "ann@example.com"]]);
    assert.equal(acct.secured, true);
    // A handoff link redeemed in another browser (handoff fixation) is refused.
    const stF = await h.call("POST", "/api/auth/google/start", { body: {} });
    const cookie2 = stF.headers.get("set-cookie").split(";")[0];
    curNonce = new URL(stF.data.url).searchParams.get("nonce");
    const loc2 = (await h.call("GET", `/api/auth/google/callback?state=${new URL(stF.data.url).searchParams.get("state")}&code=abc`, { origin: null, cookie: cookie2 })).headers.get("Location");
    assert.equal((await h.call("POST", "/api/auth/handoff", { body: { code: loc2.split("#auth=")[1] } })).status, 403);
    // A replayed state is refused; a wrong nonce is refused.
    assert.match((await h.call("GET", `/api/auth/google/callback?state=${state}&code=abc`, { origin: null })).headers.get("Location"), /auth-error=expired/);
    const r2 = await h.call("POST", "/api/auth/google/start", { body: {} });
    const st2 = new URL(r2.data.url).searchParams.get("state");
    curNonce = "not-this-flows-nonce";
    const bad = await h.call("GET", `/api/auth/google/callback?state=${st2}&code=abc`, { origin: null, cookie: r2.headers.get("set-cookie").split(";")[0] });
    assert.match(bad.headers.get("Location"), /auth-error=google/);
  } finally {
    globalThis.fetch = realFetch;
  }
  // A new Google identity with no signed-in player makes a new player named from the profile.
  const p = await A.playerForIdentity(h.env, "google", { sub: "g-999", given_name: "Zed" }, null);
  assert.equal((await h.env.DB.prepare("SELECT name FROM players WHERE id = ?").bind(p).first()).name, "Zed");
});

test("account stats: daily records, streaks and Mainline ranks", async () => {
  const { streak } = await import("../../worker/stats.js");
  assert.equal(streak(["2026-11-27", "2026-11-26", "2026-11-24"], "2026-11-27"), 2);
  assert.equal(streak(["2026-11-26", "2026-11-25"], "2026-11-27"), 2, "yesterday keeps a streak alive");
  assert.equal(streak(["2026-11-25"], "2026-11-27"), 0);
  assert.equal(streak([], "2026-11-27"), 0);
  const h = harness();
  const ann = await h.newPlayer("Ann"), bob = await h.newPlayer("Bob");
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, ?, 20, '[]', ?)").bind(ann.id, today, now).run();
  await h.env.DB.prepare("INSERT INTO wm_daily VALUES (?, '2000-01-01', 10, '[]', ?)").bind(ann.id, now).run();
  await h.env.DB.prepare("INSERT INTO fd_daily VALUES (?, ?, 700, 6, '[]', ?)").bind(ann.id, today, now).run();
  await h.env.DB.prepare("INSERT INTO ml_runs VALUES (?, 'texas', 's', NULL, 1.5, 'h', 2050, NULL, ?)").bind(ann.id, now).run();
  await h.env.DB.prepare("INSERT INTO ml_runs VALUES (?, 'texas', 's', NULL, 2.5, 'h', 2050, NULL, ?)").bind(bob.id, now).run();
  const st = (await h.call("GET", "/api/account/stats", { token: ann.token })).data;
  assert.equal(st.wm.played, 2);
  assert.equal(st.wm.best, 20);
  assert.equal(st.wm.avg, 15);
  assert.equal(st.wm.streak, 1);
  assert.deepEqual(st.fd.recent, [{ key: today, score: 700, towns: 6 }]);
  assert.deepEqual(st.ml.map((r) => [r.scenario, r.rank, r.total]), [["texas", 2, 2]]);
  assert.equal((await h.call("GET", "/api/account/stats")).status, 401);
});

test("safeReturn allows only plain same-site paths", async () => {
  for (const ok of ["/", "/index.html", "/a/b-c_d.e"]) assert.equal(A.safeReturn(ok), ok);
  for (const bad of ["/\\evil.com", "//evil.com", "https://evil.com", "/a//b", "/x?y=1", "/#play", "", null, "evil"]) assert.equal(A.safeReturn(bad), "/", String(bad));
});

test("a player signed in on two devices is never merged away", async () => {
  const h = harness();
  const p = await h.newPlayer("Pat"), q = await h.newPlayer("Quinn");
  const code = (await h.call("POST", "/api/auth/link", { token: p.token })).data.code;
  const dev2 = (await h.call("POST", "/api/auth/link/redeem", { body: { code } })).data.token; // Pat on a second device
  const qcode = (await h.call("POST", "/api/auth/link", { token: q.token })).data.code;
  const r = (await h.call("POST", "/api/auth/link/redeem", { token: dev2, body: { code: qcode } })).data;
  assert.equal(r.id, q.id);
  assert.equal(r.merged, null);
  assert.equal((await h.call("GET", "/api/player", { token: p.token })).data.id, p.id, "Pat's first device still works");
});
