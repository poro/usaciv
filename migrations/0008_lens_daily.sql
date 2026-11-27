-- Lens Detective daily (docs/MULTIPLAYER.md "Lens Detective daily"): the first finished game per player per day.
CREATE TABLE lens_daily (
  player     TEXT NOT NULL REFERENCES players(id),
  key        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score      INTEGER NOT NULL,          -- 0..6 right answers, from the server
  picks_json TEXT NOT NULL,
  created    INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX lens_daily_board ON lens_daily (key, score DESC, created);
