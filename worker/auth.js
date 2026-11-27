// Login for usaciv players (docs/MULTIPLAYER.md "Login"). Login attaches to the existing player rows: a nickname
// player made on one device can add a passkey, link another device with a short code, or (once configured) a Google
// account, and then sign in anywhere. Nothing a player already has is lost:
//   - the original device token (players.token_hash) keeps working; each later sign-in adds a `sessions` row;
//   - signing in on a device that holds an anonymous player (no passkey, no identity) merges that player's scores
//     into the account (daily: the account's entry wins a clash; Mainline: the better run wins), then removes it.
// All secrets are stored as SHA-256 only. Single-use values (challenges, codes, OAuth states) live in auth_tokens.
import { json, readJson, requirePlayer, tokenOwner, bearer, ipHash, rateLimit, limitWrite, randomToken, randomId, sha256Hex, HttpError } from "./http.js";
import { checkName, CODE_ALPHABET } from "./rules.js";
import { verifyRegistration, verifyAssertion, b64urlDecode, b64urlEncode, AuthError } from "./webauthn.js";

export const AUTH = {
  challengeMs: 5 * 60_000,
  linkMs: 10 * 60_000,
  linkLen: 8,
  oauthMs: 10 * 60_000,
  handoffMs: 2 * 60_000,
  maxPasskeys: 10,
  maxSessions: 20,
  ipSignIn: [60, 600_000], // sign-ins (passkey verify, handoff, Google start) per IP per 10 minutes: a class behind one NAT fits
  ipLinkRedeem: [10, 600_000],
};

const now = () => Date.now();
const site = (request) => { const u = new URL(request.url); return { origin: u.origin, rpId: u.hostname }; };

/** Store a single-use value; returns nothing. */
async function putToken(env, key, player, data, ms) {
  await env.DB.prepare("INSERT INTO auth_tokens (key, player, data, expires) VALUES (?, ?, ?, ?)")
    .bind(key, player ?? null, JSON.stringify(data ?? null), now() + ms).run();
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM auth_tokens WHERE expires < ?").bind(now()).run();
}
/** Take (read and delete) a single-use value; null when missing or expired. */
async function takeToken(env, key) {
  const row = await env.DB.prepare("DELETE FROM auth_tokens WHERE key = ? RETURNING player, data, expires").bind(key).first();
  if (!row || row.expires < now()) return null;
  return { player: row.player, data: JSON.parse(row.data) };
}

/** A new signed-in device for `player`; returns the raw token (shown once, stored hashed). */
export async function newSession(env, player, label) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, player, created, last_used, label) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), player, now(), now(), label).run();
  // Keep at most maxSessions devices: the least recently used go first.
  await env.DB.prepare(
    `DELETE FROM sessions WHERE player = ?1 AND token_hash NOT IN
       (SELECT token_hash FROM sessions WHERE player = ?1 ORDER BY last_used DESC LIMIT ?2)`,
  ).bind(player, AUTH.maxSessions).run();
  return token;
}

/** True when the player has a way back in other than device tokens (a passkey or an identity). */
export async function isSecured(env, player) {
  const r = await env.DB.prepare(
    // a player signed in on more than one device (sessions) counts too: merging it would sign the other devices out
    "SELECT (SELECT COUNT(*) FROM passkeys WHERE player = ?1) + (SELECT COUNT(*) FROM identities WHERE player = ?1) + (SELECT COUNT(*) FROM sessions WHERE player = ?1) AS n",
  ).bind(player).first();
  return (r?.n || 0) > 0;
}

/**
 * Move an anonymous player's scores into `to` and delete it. Does nothing (returns null) when `from` is missing, is
 * `to`, or is secured (it is somebody's real account then, so it is never folded into another).
 */
export async function mergeInto(env, from, to) {
  if (!from || from === to) return null;
  if (!(await env.DB.prepare("SELECT id FROM players WHERE id = ?").bind(from).first())) return null;
  if (await isSecured(env, from)) return null;
  // Dailies that are still open (today and yesterday, UTC) are not carried over: otherwise throwaway players could
  // each try today's puzzle and the best one be signed into the account. Older days merge.
  const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
  const cutoff = y.toISOString().slice(0, 10);
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM wm_daily WHERE player = ?1 AND key < ?2) + (SELECT COUNT(*) FROM fd_daily WHERE player = ?1 AND key < ?2)
         + (SELECT COUNT(*) FROM pp_daily WHERE player = ?1 AND key < ?2) + (SELECT COUNT(*) FROM duel_daily WHERE player = ?1 AND key < ?2)
         + (SELECT COUNT(*) FROM trip_daily WHERE player = ?1 AND key < ?2) + (SELECT COUNT(*) FROM lens_daily WHERE player = ?1 AND key < ?2)
         + (SELECT COUNT(*) FROM rank_daily WHERE player = ?1 AND key < ?2)
         + (SELECT COUNT(*) FROM shapes_daily WHERE player = ?1 AND key < ?2)
         + (SELECT COUNT(*) FROM link_daily WHERE player = ?1 AND key < ?2) AS daily,
       (SELECT COUNT(*) FROM ml_runs WHERE player = ?1) + (SELECT COUNT(*) FROM ml_daily WHERE player = ?1 AND key < ?2) AS runs`,
  ).bind(from, cutoff).first();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO wm_daily (player, key, score, rounds_json, created)
       SELECT ?2, key, score, rounds_json, created FROM wm_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO fd_daily (player, key, score, towns, log_json, created)
       SELECT ?2, key, score, towns, log_json, created FROM fd_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO link_daily (player, key, score, edges_json, created)
       SELECT ?2, key, score, edges_json, created FROM link_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO shapes_daily (player, key, score, picks_json, created)
       SELECT ?2, key, score, picks_json, created FROM shapes_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO rank_daily (player, key, score, orders_json, created)
       SELECT ?2, key, score, orders_json, created FROM rank_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO lens_daily (player, key, score, picks_json, created)
       SELECT ?2, key, score, picks_json, created FROM lens_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO trip_daily (player, key, score, km, order_json, created)
       SELECT ?2, key, score, km, order_json, created FROM trip_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO duel_daily (player, key, streak, answers_json, created)
       SELECT ?2, key, streak, answers_json, created FROM duel_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO pp_daily (player, key, score, guesses_json, created)
       SELECT ?2, key, score, guesses_json, created FROM pp_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT OR IGNORE INTO ml_daily (player, key, scenario, uplift, hash, log_json, created)
       SELECT ?2, key, scenario, uplift, hash, log_json, created FROM ml_daily WHERE player = ?1 AND key < ?3`,
    ).bind(from, to, cutoff),
    env.DB.prepare(
      `INSERT INTO ml_runs (player, scenario, seed, home, uplift, hash, year, log_json, created)
       SELECT ?2, scenario, seed, home, uplift, hash, year, log_json, created FROM ml_runs WHERE player = ?1 AND true
       ON CONFLICT(player, scenario) DO UPDATE SET seed = excluded.seed, home = excluded.home, uplift = excluded.uplift,
         hash = excluded.hash, year = excluded.year, log_json = excluded.log_json, created = excluded.created
       WHERE excluded.uplift > ml_runs.uplift`,
    ).bind(from, to),
    ...deleteStatements(env, from),
  ]);
  return { daily: counts.daily, runs: counts.runs };
}

function deleteStatements(env, id) {
  return [
    "DELETE FROM wm_daily WHERE player = ?",
    "DELETE FROM fd_daily WHERE player = ?",
    "DELETE FROM ml_daily WHERE player = ?",
    "DELETE FROM pp_daily WHERE player = ?",
    "DELETE FROM duel_daily WHERE player = ?",
    "DELETE FROM trip_daily WHERE player = ?",
    "DELETE FROM lens_daily WHERE player = ?",
    "DELETE FROM rank_daily WHERE player = ?",
    "DELETE FROM shapes_daily WHERE player = ?",
    "DELETE FROM link_daily WHERE player = ?",
    "DELETE FROM ml_runs WHERE player = ?",
    "DELETE FROM sessions WHERE player = ?",
    "DELETE FROM passkeys WHERE player = ?",
    "DELETE FROM identities WHERE player = ?",
    "DELETE FROM auth_tokens WHERE player = ?",
    "DELETE FROM players WHERE id = ?",
  ].map((sql) => env.DB.prepare(sql).bind(id));
}

/** Finish a sign-in as `player`: merge the caller's anonymous player, if any, and issue a device token. */
async function signedIn(env, request, player, label) {
  const p = await env.DB.prepare("SELECT id, name FROM players WHERE id = ?").bind(player).first();
  if (!p) throw new HttpError(404, "That account no longer exists");
  const current = await tokenOwner(env, bearer(request));
  const merged = current ? await mergeInto(env, current.id, p.id) : null;
  const token = await newSession(env, p.id, label);
  return json({ id: p.id, name: p.name, token, merged });
}

// --- config and account --------------------------------------------------------------------------------------------
export const googleOn = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function authConfig(request, env) {
  return json({ passkeys: true, link: true, google: googleOn(env), apple: false, email: false });
}

export async function account(request, env) {
  const me = await requirePlayer(env, request);
  const [p, keys, ids, devices] = await Promise.all([
    env.DB.prepare("SELECT id, name, created, token_hash NOT LIKE 'revoked:%' AS firstDevice FROM players WHERE id = ?").bind(me.id).first(),
    env.DB.prepare("SELECT id, name, created, last_used AS lastUsed FROM passkeys WHERE player = ? ORDER BY created").bind(me.id).all(),
    env.DB.prepare("SELECT provider, email, created FROM identities WHERE player = ? ORDER BY created").bind(me.id).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE player = ?").bind(me.id).first(),
  ]);
  const passkeys = keys.results || [], identities = ids.results || [];
  return json({
    id: p.id, name: p.name, created: p.created,
    passkeys, identities,
    devices: (p.firstDevice ? 1 : 0) + (devices?.n || 0), // the creating device (unless signed out) plus later sign-ins
    secured: passkeys.length + identities.length > 0,
    thisDevice: me.via,
  });
}

/** Sign this device out. Its token stops working everywhere. */
export async function signOut(request, env) {
  const me = await requirePlayer(env, request);
  const h = await sha256Hex(bearer(request));
  if (me.via === "session") await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(h).run();
  else await env.DB.prepare("UPDATE players SET token_hash = ? WHERE id = ?").bind(`revoked:${randomToken()}`, me.id).run();
  return json({ ok: true });
}

/** Sign out every other device (keeps this one). */
export async function signOutOthers(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const h = await sha256Hex(bearer(request));
  const stmts = [env.DB.prepare("DELETE FROM sessions WHERE player = ? AND token_hash <> ?").bind(me.id, h)];
  if (me.via === "session") stmts.push(env.DB.prepare("UPDATE players SET token_hash = ? WHERE id = ?").bind(`revoked:${randomToken()}`, me.id));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

/** Delete the player and everything stored about it (scores, devices, passkeys, identities). */
export async function deleteAccount(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request);
  if (body?.confirm !== me.name) throw new HttpError(400, "Type your nickname to confirm");
  await env.DB.batch(deleteStatements(env, me.id));
  return json({ ok: true });
}

// --- passkeys ----------------------------------------------------------------------------------------------------
const PUBKEY_PARAMS = [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }];

export async function passkeyRegisterOptions(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const keys = (await env.DB.prepare("SELECT id, transports FROM passkeys WHERE player = ?").bind(me.id).all()).results || [];
  if (keys.length >= AUTH.maxPasskeys) throw new HttpError(400, `At most ${AUTH.maxPasskeys} passkeys`);
  const id = randomToken(), challenge = randomToken();
  await putToken(env, `ch:${id}`, me.id, { challenge, kind: "register" }, AUTH.challengeMs);
  const { rpId } = site(request);
  return json({
    challengeId: id,
    publicKey: {
      challenge,
      rp: { id: rpId, name: "usaciv" },
      user: { id: b64urlEncode(new TextEncoder().encode(me.id)), name: me.name, displayName: me.name },
      pubKeyCredParams: PUBKEY_PARAMS,
      timeout: AUTH.challengeMs,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      excludeCredentials: keys.map((k) => ({ type: "public-key", id: k.id, transports: safeJson(k.transports) || undefined })),
    },
  });
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const bytesField = (v, name, max = 64 * 1024) => {
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${name} missing or too long`);
  try { return b64urlDecode(v); } catch { throw new HttpError(400, `${name} is not base64url`); }
};
const cleanTransports = (t) => (Array.isArray(t) ? t.filter((x) => typeof x === "string" && /^[a-z-]{1,16}$/.test(x)).slice(0, 6) : []);

export async function passkeyRegister(request, env) {
  const me = await requirePlayer(env, request);
  const body = await readJson(request, 64 * 1024);
  const ch = typeof body?.challengeId === "string" ? await takeToken(env, `ch:${body.challengeId}`) : null;
  if (!ch || ch.data?.kind !== "register" || ch.player !== me.id) throw new HttpError(400, "Passkey request expired, try again");
  const c = body.credential || {};
  let v;
  try {
    v = await verifyRegistration({
      id: c.id,
      clientDataJSON: bytesField(c.clientDataJSON, "clientDataJSON"),
      attestationObject: bytesField(c.attestationObject, "attestationObject"),
      challenge: ch.data.challenge,
      ...site(request),
    });
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(400, `Passkey refused: ${e.message}`);
    throw e;
  }
  if (await env.DB.prepare("SELECT 1 FROM passkeys WHERE id = ?").bind(v.credId).first()) throw new HttpError(409, "That passkey is already saved");
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE player = ?").bind(me.id).first())?.n || 0;
  const name = typeof body.name === "string" && checkName(body.name).name ? checkName(body.name).name : `Passkey ${n + 1}`;
  await env.DB.prepare(
    "INSERT INTO passkeys (id, player, jwk, alg, sign_count, name, transports, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(v.credId, me.id, JSON.stringify(v.jwk), v.alg, v.signCount, name, JSON.stringify(cleanTransports(c.transports)), now()).run();
  return json({ passkey: { id: v.credId, name, created: now() } }, 201);
}

export async function passkeyLoginOptions(request, env) { // harmless (a challenge), so not rate limited
  const id = randomToken(), challenge = randomToken();
  await putToken(env, `ch:${id}`, null, { challenge, kind: "login" }, AUTH.challengeMs);
  return json({ challengeId: id, publicKey: { challenge, rpId: site(request).rpId, timeout: AUTH.challengeMs, userVerification: "preferred", allowCredentials: [] } });
}

export async function passkeyLogin(request, env) {
  await rateLimit(env, `si:${await ipHash(env, request)}`, ...AUTH.ipSignIn);
  const body = await readJson(request, 64 * 1024);
  const ch = typeof body?.challengeId === "string" ? await takeToken(env, `ch:${body.challengeId}`) : null;
  if (!ch || ch.data?.kind !== "login") throw new HttpError(400, "Sign-in request expired, try again");
  const c = body.credential || {};
  if (typeof c.id !== "string" || c.id.length > 1400) throw new HttpError(400, "credential id missing");
  const key = await env.DB.prepare("SELECT id, player, jwk, alg, sign_count FROM passkeys WHERE id = ?").bind(c.id).first();
  if (!key) throw new HttpError(404, "This passkey is not saved to any usaciv player (it may have been removed)");
  let v;
  try {
    v = await verifyAssertion({
      clientDataJSON: bytesField(c.clientDataJSON, "clientDataJSON"),
      authenticatorData: bytesField(c.authenticatorData, "authenticatorData"),
      signature: bytesField(c.signature, "signature", 2048),
      challenge: ch.data.challenge,
      ...site(request),
      jwk: JSON.parse(key.jwk),
      alg: key.alg,
      storedCount: key.sign_count,
    });
  } catch (e) {
    if (e instanceof AuthError) throw new HttpError(400, `Sign-in refused: ${e.message}`);
    throw e;
  }
  await env.DB.prepare("UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?").bind(v.signCount, now(), key.id).run();
  return signedIn(env, request, key.player, "passkey");
}

export async function passkeyDelete(request, env, id) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const r = await env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND player = ?").bind(decodeURIComponent(id), me.id).run();
  if (!r.meta?.changes) throw new HttpError(404, "No such passkey");
  return json({ ok: true });
}

export async function passkeyRename(request, env, id) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const c = checkName((await readJson(request))?.name);
  if (c.error) throw new HttpError(400, c.error);
  const r = await env.DB.prepare("UPDATE passkeys SET name = ? WHERE id = ? AND player = ?").bind(c.name, decodeURIComponent(id), me.id).run();
  if (!r.meta?.changes) throw new HttpError(404, "No such passkey");
  return json({ ok: true, name: c.name });
}

// --- device link codes ---------------------------------------------------------------------------------------------
const normCode = (s) => (typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

export async function linkCreate(request, env) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const bytes = crypto.getRandomValues(new Uint8Array(AUTH.linkLen));
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  await env.DB.prepare("DELETE FROM auth_tokens WHERE player = ? AND key LIKE 'link:%'").bind(me.id).run(); // one live code each
  await putToken(env, `link:${await sha256Hex(code)}`, me.id, null, AUTH.linkMs);
  return json({ code, expires: now() + AUTH.linkMs }, 201);
}

export async function linkRedeem(request, env) {
  await rateLimit(env, `lr:${await ipHash(env, request)}`, ...AUTH.ipLinkRedeem);
  const code = normCode((await readJson(request))?.code);
  if (code.length !== AUTH.linkLen) throw new HttpError(400, `The code has ${AUTH.linkLen} letters and digits`);
  const t = await takeToken(env, `link:${await sha256Hex(code)}`);
  if (!t?.player) throw new HttpError(404, "That code is wrong or has expired");
  return signedIn(env, request, t.player, "code");
}

// --- Google (OpenID Connect, authorization code + PKCE); off until GOOGLE_CLIENT_ID/SECRET are set -------------
const GOOGLE = { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", iss: ["https://accounts.google.com", "accounts.google.com"] };
// Only a plain same-site path (the client sends location.pathname): no "//", no backslash (browsers read "/\x" as
// "//x", another site), no scheme.
export const safeReturn = (s) => (typeof s === "string" && /^\/[A-Za-z0-9_\-./]{0,200}$/.test(s) && !s.includes("//") ? s : "/");
// The OAuth flow is bound to the browser that started it: a random value in a __Host- cookie (HttpOnly, SameSite=Lax),
// its hash in the state row and the handoff. A Google link or a #auth= link sent by someone else carries no cookie.
const BIND_COOKIE = "__Host-usaciv-oauth";
const cookieOf = (request) => /(?:^|;\s*)__Host-usaciv-oauth=([A-Za-z0-9_-]{20,100})/.exec(request.headers.get("Cookie") || "")?.[1] ?? null;
const bindHash = async (request) => { const c = cookieOf(request); return c ? sha256Hex(c) : null; };

/** POST {returnTo?} (optionally signed in: then the Google account is added to this player) → {url}. */
export async function googleStart(request, env) {
  if (!googleOn(env)) throw new HttpError(404, "Google sign-in is not set up on this site");
  await rateLimit(env, `si:${await ipHash(env, request)}`, ...AUTH.ipSignIn);
  const body = await readJson(request);
  const current = await tokenOwner(env, bearer(request));
  const state = randomToken(), verifier = randomToken() + randomToken(), nonce = randomToken();
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const bind = randomToken();
  await putToken(env, `oauth:${state}`, current?.id ?? null, { verifier, nonce, returnTo: safeReturn(body?.returnTo), provider: "google", bind: await sha256Hex(bind) }, AUTH.oauthMs);
  const u = new URL(GOOGLE.auth);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${site(request).origin}/api/auth/google/callback`, response_type: "code",
    scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return json({ url: u.toString() }, 200, { "Set-Cookie": `${BIND_COOKIE}=${bind}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900` });
}

/** Decode a JWT payload without checking its signature: allowed only for an ID token received straight from the
 *  provider's token endpoint over TLS (OpenID Connect Core §3.1.3.7, item 6). */
export function jwtPayload(jwt) {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) throw new HttpError(502, "Google sent no ID token");
  try { return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); } catch { throw new HttpError(502, "Google ID token unreadable"); }
}

/** GET ?code&state from Google → 302 to `${returnTo}#auth=<handoff>` (the page trades it for a token). */
export async function googleCallback(request, env) {
  const u = new URL(request.url);
  const back = (returnTo, frag) => new Response(null, { status: 302, headers: { Location: `${returnTo}#${frag}`, "Cache-Control": "no-store" } });
  const st = u.searchParams.get("state") ? await takeToken(env, `oauth:${u.searchParams.get("state")}`) : null;
  if (!st) return back("/", "auth-error=expired");
  const bound = await bindHash(request);
  if (!bound || bound !== st.data.bind) return back(st.data.returnTo, "auth-error=browser"); // not the browser that started it
  if (!u.searchParams.get("code")) return back(st.data.returnTo, "auth-error=cancelled");
  const res = await fetch(GOOGLE.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: u.searchParams.get("code"), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${u.origin}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: st.data.verifier,
    }),
  });
  if (!res.ok) return back(st.data.returnTo, "auth-error=google");
  const claims = jwtPayload((await res.json())?.id_token);
  const ok = GOOGLE.iss.includes(claims.iss) && claims.aud === env.GOOGLE_CLIENT_ID && claims.nonce === st.data.nonce
    && typeof claims.sub === "string" && claims.exp * 1000 > now();
  if (!ok) return back(st.data.returnTo, "auth-error=google");
  const player = await playerForIdentity(env, "google", claims, st.player);
  const hand = randomToken();
  await putToken(env, `hand:${await sha256Hex(hand)}`, player, { label: "google", from: st.player, bind: bound }, AUTH.handoffMs);
  return back(st.data.returnTo, `auth=${hand}`);
}

/** The player for a provider identity: the one it is attached to, else attach it to `current`, else a new player. */
export async function playerForIdentity(env, provider, claims, current) {
  const email = claims.email_verified === false ? null : typeof claims.email === "string" ? claims.email.slice(0, 200) : null;
  const known = await env.DB.prepare("SELECT player FROM identities WHERE provider = ? AND subject = ?").bind(provider, claims.sub).first();
  if (known) return known.player;
  let player = current;
  if (!player || !(await env.DB.prepare("SELECT id FROM players WHERE id = ?").bind(player).first())) {
    player = randomId();
    const c = checkName(claims.given_name || claims.name || "");
    await env.DB.prepare("INSERT INTO players (id, token_hash, name, created, ip_hash) VALUES (?, ?, ?, ?, NULL)")
      .bind(player, `revoked:${randomToken()}`, c.name || "Player", now()).run();
  }
  await env.DB.prepare("INSERT INTO identities (provider, subject, player, email, created) VALUES (?, ?, ?, ?, ?)")
    .bind(provider, claims.sub, player, email, now()).run();
  return player;
}

/** POST {code} (the #auth= value) → {id, name, token, merged}. */
export async function handoff(request, env) {
  await rateLimit(env, `si:${await ipHash(env, request)}`, ...AUTH.ipSignIn);
  const code = (await readJson(request))?.code;
  const t = typeof code === "string" && code.length < 100 ? await takeToken(env, `hand:${await sha256Hex(code)}`) : null;
  if (!t?.player) throw new HttpError(404, "Sign-in link expired, try again");
  if (!t.data?.bind || t.data.bind !== (await bindHash(request))) throw new HttpError(403, "This sign-in was started in another browser");
  const res = await signedIn(env, request, t.player, t.data?.label || "google");
  res.headers.append("Set-Cookie", `${BIND_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}

/** Remove a provider identity from this player (its devices stay signed in). */
export async function identityDelete(request, env, provider) {
  const me = await requirePlayer(env, request);
  await limitWrite(env, me.id);
  const r = await env.DB.prepare("DELETE FROM identities WHERE player = ? AND provider = ?").bind(me.id, provider).run();
  if (!r.meta?.changes) throw new HttpError(404, "Not linked");
  return json({ ok: true });
}
