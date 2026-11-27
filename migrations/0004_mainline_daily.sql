-- Mainline daily challenge (docs/MULTIPLAYER.md "Mainline daily"): the first verified finished run per player per day.
CREATE TABLE ml_daily (
  player   TEXT NOT NULL REFERENCES players(id),
  key      TEXT NOT NULL,             -- YYYY-MM-DD; scenario and seed follow from it (sim/daily.js)
  scenario TEXT NOT NULL,
  uplift   REAL NOT NULL,
  hash     TEXT NOT NULL,
  log_json TEXT NOT NULL,
  created  INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX ml_daily_board ON ml_daily (key, uplift DESC, created);
