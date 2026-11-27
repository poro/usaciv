-- Road Trip daily (docs/MULTIPLAYER.md "Road Trip daily"): the first finished route per player per day.
CREATE TABLE trip_daily (
  player     TEXT NOT NULL REFERENCES players(id),
  key        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score      INTEGER NOT NULL,          -- 0..1000 = best loop ÷ yours × 1000, from the server
  km         INTEGER NOT NULL,
  order_json TEXT NOT NULL,
  created    INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX trip_daily_board ON trip_daily (key, score DESC, created);
