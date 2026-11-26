// HTTP helpers for the Worker: JSON responses, body parsing, token auth, IP hashing and D1 rate limits.
// Same origin only: no CORS headers are ever sent, and a write whose Origin header names another site is refused.

export const VERSION = "0.3.0";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, ...extra } });
export const error = (status, message, extra) => json({ error: message }, status, extra);

/** Thrown inside handlers; index.js turns it into error(status, message). */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Parse a JSON body of at most maxBytes, or throw HttpError(400/413). */
export async function readJson(request, maxBytes = 16 * 1024) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > maxBytes) throw new HttpError(413, "Body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Body too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON"); }
}

/** False when the request carries an Origin header for a different site (cross-site write or socket). */
export function sameOrigin(request) {
  const o = request.headers.get("Origin");
  if (!o || o === "null") return !o; // no Origin (curl, same-origin GET) is fine; "null" is not
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const randomId = () => "p_" + hex(crypto.getRandomValues(new Uint8Array(8)));

/** Salted hash of the caller's IP (never stored raw). The salt is the IP_SALT secret/var. */
export async function ipHash(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return sha256Hex(`${env.IP_SALT || "usaciv-dev-salt"}|${ip}`);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** The player for a raw token, or null. */
export async function playerForToken(env, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return env.DB.prepare("SELECT id, name FROM players WHERE token_hash = ?").bind(await sha256Hex(token)).first();
}

/** The player from `Authorization: Bearer <token>`, or null. */
export function optionalPlayer(env, request) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("Authorization") || "");
  return m ? playerForToken(env, m[1]) : Promise.resolve(null);
}

/** The authenticated player, or throw 401. */
export async function requirePlayer(env, request) {
  const p = await optionalPlayer(env, request);
  if (!p) throw new HttpError(401, "Sign-in token missing or unknown");
  return p;
}

/**
 * Fixed-window counter in D1: allow `limit` hits per `windowMs` for `key`, else throw 429.
 * Old rows are swept now and then.
 */
export async function rateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, reset_at, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count, reset_at`,
  ).bind(key, now + windowMs, now).first();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now - 3600_000).run();
  if (row.count > limit) {
    const retry = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    throw Object.assign(new HttpError(429, "Too many requests, try again shortly"), { retry });
  }
}

/** Limits (docs/MULTIPLAYER.md "Rate limits"). */
export const LIMITS = {
  write: [12, 60_000], // per player per minute: renames, submits, room creation
  newPlayer: [10, 3600_000], // per IP per hour
};
export const limitWrite = (env, playerId) => rateLimit(env, `w:${playerId}`, ...LIMITS.write);
