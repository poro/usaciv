// Minimal WebAuthn (passkey) verification for the Worker: no npm, WebCrypto only. Pure functions, tested by
// tests/js/auth.test.mjs with a software authenticator.
//
// What it checks (W3C WebAuthn L2 §7.1 registration, §7.2 authentication), for attestation "none":
//   clientDataJSON: type, challenge (exact base64url match), origin (exact), not cross-origin
//   authenticatorData: rpIdHash = SHA-256(rpId), User Present flag, attested credential (registration)
//   signature (sign-in): over authenticatorData ‖ SHA-256(clientDataJSON) with the stored key; ES256 or RS256
//   signCount: refused if it goes backwards while both values are non-zero (a cloned authenticator)
// Attestation statements are not verified (we ask for "none"): a passkey is trusted because it is registered by an
// already signed-in player, not because of who made it.

export const ALGS = { ES256: -7, RS256: -257 };
const SUPPORTED = new Set([ALGS.ES256, ALGS.RS256]);

export class AuthError extends Error {}
const fail = (msg) => { throw new AuthError(msg); };

// --- base64url ----------------------------------------------------------------------------------------------------
export function b64urlEncode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) fail("bad base64url");
  const pad = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const utf8 = (s) => new TextEncoder().encode(s);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// --- CBOR (the subset authenticators emit) -------------------------------------------------------------------------
/** Decode one CBOR item at `pos`; returns {value, end}. Maps become Map (keys may be ints). */
export function cborDecode(bytes, pos = 0, depth = 0) {
  if (depth > 16) fail("CBOR too deep");
  const need = (n) => { if (pos + n > bytes.length) fail("CBOR truncated"); };
  need(1);
  const ib = bytes[pos++], major = ib >> 5, info = ib & 31;
  let len;
  if (info < 24) len = info;
  else if (info === 24) { need(1); len = bytes[pos]; pos += 1; }
  else if (info === 25) { need(2); len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
  else if (info === 26) { need(4); len = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]; pos += 4; }
  else if (info === 27) {
    need(8);
    const hi = ((bytes[pos] << 24) >>> 0) + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
    if (hi > 0x1fffff) fail("CBOR int too big");
    len = hi * 2 ** 32 + ((bytes[pos + 4] << 24) >>> 0) + (bytes[pos + 5] << 16) + (bytes[pos + 6] << 8) + bytes[pos + 7];
    pos += 8;
  } else fail("CBOR indefinite length not supported");
  switch (major) {
    case 0: return { value: len, end: pos };
    case 1: return { value: -1 - len, end: pos };
    case 2: need(len); return { value: bytes.slice(pos, pos + len), end: pos + len };
    case 3: need(len); return { value: new TextDecoder().decode(bytes.subarray(pos, pos + len)), end: pos + len };
    case 4: {
      if (len > 1000) fail("CBOR array too long");
      const arr = [];
      for (let i = 0; i < len; i++) { const r = cborDecode(bytes, pos, depth + 1); arr.push(r.value); pos = r.end; }
      return { value: arr, end: pos };
    }
    case 5: {
      if (len > 1000) fail("CBOR map too long");
      const m = new Map();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(bytes, pos, depth + 1); pos = k.end;
        const v = cborDecode(bytes, pos, depth + 1); pos = v.end;
        m.set(k.value, v.value);
      }
      return { value: m, end: pos };
    }
    case 6: return cborDecode(bytes, pos, depth + 1); // tag: ignore it, keep the item
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22 || info === 23) return { value: null, end: pos };
      fail("CBOR float/simple not supported");
  }
  fail("CBOR bad item");
}

// --- authenticator data ------------------------------------------------------------------------------------------
export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

/** Parse authenticatorData: {rpIdHash, flags, signCount, credId?, coseKey?}. */
export function parseAuthData(a) {
  if (!(a instanceof Uint8Array) || a.length < 37) fail("authenticator data too short");
  const out = {
    rpIdHash: a.slice(0, 32),
    flags: a[32],
    signCount: ((a[33] << 24) >>> 0) + (a[34] << 16) + (a[35] << 8) + a[36],
  };
  if (out.flags & FLAGS.AT) {
    if (a.length < 55) fail("attested credential data too short");
    const idLen = (a[53] << 8) | a[54];
    if (idLen < 16 || idLen > 1023 || a.length < 55 + idLen) fail("bad credential id length");
    out.credId = a.slice(55, 55 + idLen);
    const k = cborDecode(a, 55 + idLen);
    if (!(k.value instanceof Map)) fail("credential key is not a COSE map");
    out.coseKey = k.value;
  }
  return out;
}

/** COSE_Key → {alg, jwk} for ES256 (EC2 P-256) and RS256 (RSA). */
export function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (alg === ALGS.ES256) {
    if (kty !== 2 || m.get(-1) !== 1) fail("ES256 key must be EC2 P-256");
    const x = m.get(-2), y = m.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) fail("bad EC point");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y) } };
  }
  if (alg === ALGS.RS256) {
    if (kty !== 3) fail("RS256 key must be RSA");
    const n = m.get(-1), e = m.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256) fail("bad RSA key");
    return { alg, jwk: { kty: "RSA", n: b64urlEncode(n), e: b64urlEncode(e) } };
  }
  fail("unsupported key algorithm");
}

async function importKey(jwk, alg) {
  if (alg === ALGS.ES256) return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === ALGS.RS256) return crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  fail("unsupported key algorithm");
}

/** ECDSA signatures from authenticators are ASN.1 DER; WebCrypto wants raw r‖s (32 + 32 bytes for P-256). */
export function derToRaw(der) {
  const bad = () => fail("bad ECDSA signature");
  if (der.length < 8 || der[0] !== 0x30) bad();
  let p = 2;
  if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
  const part = () => {
    if (der[p] !== 0x02) bad();
    const len = der[p + 1];
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) bad();
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part(), s = part();
  const raw = new Uint8Array(64);
  raw.set(r, 0); raw.set(s, 32);
  return raw;
}

function checkClientData(bytes, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("client data is not JSON"); }
  if (cd?.type !== type) fail(`client data type must be ${type}`);
  if (typeof challenge !== "string" || cd.challenge !== challenge) fail("challenge does not match");
  if (cd.origin !== origin) fail("origin does not match");
  if (cd.crossOrigin === true) fail("cross-origin passkey use refused");
  return cd;
}

/**
 * Verify a registration (navigator.credentials.create) response.
 * @param {{id: string, clientDataJSON: Uint8Array, attestationObject: Uint8Array, challenge: string, origin: string, rpId: string}} p
 * @returns {Promise<{credId: string, alg: number, jwk: object, signCount: number, flags: number}>}
 */
export async function verifyRegistration(p) {
  checkClientData(p.clientDataJSON, "webauthn.create", p.challenge, p.origin);
  const att = cborDecode(p.attestationObject).value;
  if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) fail("bad attestation object");
  const ad = parseAuthData(att.get("authData"));
  if (!eq(ad.rpIdHash, await sha256(utf8(p.rpId)))) fail("passkey is for another site");
  if (!(ad.flags & FLAGS.UP)) fail("user was not present");
  if (!ad.credId) fail("no credential in the response");
  const credId = b64urlEncode(ad.credId);
  if (p.id !== undefined && p.id !== credId) fail("credential id mismatch");
  const { alg, jwk } = coseToJwk(ad.coseKey);
  if (!SUPPORTED.has(alg)) fail("unsupported key algorithm");
  await importKey(jwk, alg); // a key WebCrypto refuses is refused here, not at the first sign-in
  return { credId, alg, jwk, signCount: ad.signCount, flags: ad.flags };
}

/**
 * Verify a sign-in (navigator.credentials.get) response against a stored passkey.
 * @param {{clientDataJSON: Uint8Array, authenticatorData: Uint8Array, signature: Uint8Array, challenge: string, origin: string, rpId: string, jwk: object, alg: number, storedCount: number}} p
 * @returns {Promise<{signCount: number, flags: number}>}
 */
export async function verifyAssertion(p) {
  checkClientData(p.clientDataJSON, "webauthn.get", p.challenge, p.origin);
  const ad = parseAuthData(p.authenticatorData);
  if (!eq(ad.rpIdHash, await sha256(utf8(p.rpId)))) fail("passkey is for another site");
  if (!(ad.flags & FLAGS.UP)) fail("user was not present");
  const key = await importKey(p.jwk, p.alg);
  const signed = new Uint8Array(p.authenticatorData.length + 32);
  signed.set(p.authenticatorData, 0);
  signed.set(await sha256(p.clientDataJSON), p.authenticatorData.length);
  const ok = p.alg === ALGS.ES256
    ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(p.signature), signed)
    : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, p.signature, signed);
  if (!ok) fail("signature does not verify");
  if (ad.signCount !== 0 && p.storedCount !== 0 && ad.signCount <= p.storedCount) fail("passkey counter went backwards");
  return { signCount: ad.signCount, flags: ad.flags };
}
