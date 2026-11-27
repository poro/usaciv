-- State Shapes daily (docs/MULTIPLAYER.md "State Shapes daily"): the first finished game per player per day.
CREATE TABLE shapes_daily (
  player     TEXT NOT NULL REFERENCES players(id),
  key        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score      INTEGER NOT NULL,          -- 0..8 right answers, from the server
  picks_json TEXT NOT NULL,
  created    INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX shapes_daily_board ON shapes_daily (key, score DESC, created);
