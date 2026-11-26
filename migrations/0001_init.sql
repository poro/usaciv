-- usaciv multiplayer schema v1 (docs/MULTIPLAYER.md). Tokens are stored only as SHA-256 hex; IPs only as a salted
-- SHA-256 (salt = the Worker's IP_SALT), never raw.

CREATE TABLE players (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created    INTEGER NOT NULL,          -- ms since epoch
  ip_hash    TEXT
);

-- Which Metro? daily: the first verified submission per player per date key.
CREATE TABLE wm_daily (
  player      TEXT NOT NULL REFERENCES players(id),
  key         TEXT NOT NULL,            -- YYYY-MM-DD
  score       INTEGER NOT NULL,
  rounds_json TEXT NOT NULL,            -- the replayed steps, canonical
  created     INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX wm_daily_board ON wm_daily (key, score DESC, created);

-- Mainline: each player's best verified run per scenario.
CREATE TABLE ml_runs (
  player   TEXT NOT NULL REFERENCES players(id),
  scenario TEXT NOT NULL,               -- texas | rust | northeast | sandbox
  seed     TEXT NOT NULL,
  home     TEXT,                        -- sandbox only (CBSA id)
  uplift   REAL NOT NULL,
  hash     TEXT NOT NULL,
  year     INTEGER NOT NULL,
  log_json TEXT,
  created  INTEGER NOT NULL,
  UNIQUE (player, scenario)
);
CREATE INDEX ml_runs_board ON ml_runs (scenario, uplift DESC, created);

-- Fixed-window rate limits: key = "w:<player>" (writes) or "ip:<ip_hash>" (new players).
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  reset_at INTEGER NOT NULL,
  count    INTEGER NOT NULL
);
