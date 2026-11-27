-- Rail Link daily (docs/MULTIPLAYER.md "Rail Link daily"): the first finished network per player per day.
CREATE TABLE link_daily (
  player     TEXT NOT NULL REFERENCES players(id),
  key        TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score      INTEGER NOT NULL,          -- 1000 × (par ÷ cost)³, from the server
  edges_json TEXT NOT NULL,
  created    INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX link_daily_board ON link_daily (key, score DESC, created);
