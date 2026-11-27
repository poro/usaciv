-- Metro Ranking daily (docs/MULTIPLAYER.md "Metro Ranking daily"): the first finished game per player per day.
CREATE TABLE rank_daily (
  player      TEXT NOT NULL REFERENCES players(id),
  key         TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score       INTEGER NOT NULL,          -- 0..500, from the server
  orders_json TEXT NOT NULL,
  created     INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX rank_daily_board ON rank_daily (key, score DESC, created);
