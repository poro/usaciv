-- Settle daily (docs/MULTIPLAYER.md "Settle daily"): the first finished game per player per day.
CREATE TABLE settle_daily (
  player     TEXT NOT NULL REFERENCES players(id),
  key        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score      INTEGER NOT NULL,          -- 1000 × your people ÷ par's, from the server
  sites_json TEXT NOT NULL,
  created    INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX settle_daily_board ON settle_daily (key, score DESC, created);
