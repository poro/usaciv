-- usaciv login (docs/MULTIPLAYER.md "Login"). A player can now hold several devices (sessions), passkeys and, later,
-- OAuth identities. The original players.token_hash stays valid as that player's first device. Every secret (tokens,
-- link codes) is stored only as SHA-256 hex.

-- Extra signed-in devices. players.token_hash is the device that created the player; each later sign-in adds a row.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  player     TEXT NOT NULL REFERENCES players(id),
  created    INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  label      TEXT                       -- how it signed in: passkey | code | google
);
CREATE INDEX sessions_player ON sessions (player);

-- WebAuthn passkeys (discoverable credentials, attestation "none").
CREATE TABLE passkeys (
  id         TEXT PRIMARY KEY,          -- credential id, base64url
  player     TEXT NOT NULL REFERENCES players(id),
  jwk        TEXT NOT NULL,             -- public key as JSON Web Key
  alg        INTEGER NOT NULL,          -- COSE alg: -7 (ES256) or -257 (RS256)
  sign_count INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,             -- a label the player sees ("Passkey 1", or the device kind)
  transports TEXT,                      -- JSON array from the browser, passed back as a hint
  created    INTEGER NOT NULL,
  last_used  INTEGER
);
CREATE INDEX passkeys_player ON passkeys (player);

-- OAuth/OIDC identities (Google now, Apple later): one provider account → one player.
CREATE TABLE identities (
  provider TEXT NOT NULL,               -- google | apple
  subject  TEXT NOT NULL,               -- the provider's stable user id ("sub")
  player   TEXT NOT NULL REFERENCES players(id),
  email    TEXT,                        -- shown only to the player themself
  created  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_player ON identities (player);

-- Short-lived single-use values: WebAuthn challenges, device-link codes, OAuth states and handoffs.
CREATE TABLE auth_tokens (
  key     TEXT PRIMARY KEY,             -- kind-prefixed: "ch:<id>", "link:<sha256(code)>", "oauth:<state>", "hand:<sha256>"
  player  TEXT,                         -- who asked (null for a sign-in challenge)
  data    TEXT,                         -- JSON payload (challenge, PKCE verifier, return path…)
  expires INTEGER NOT NULL
);
CREATE INDEX auth_tokens_expires ON auth_tokens (expires);
