-- Founders daily challenge (docs/MULTIPLAYER.md "Founders daily"): the first verified finished game per player per day.
CREATE TABLE fd_daily (
  player   TEXT NOT NULL REFERENCES players(id),
  key      TEXT NOT NULL,             -- YYYY-MM-DD (UTC day of the seed)
  score    INTEGER NOT NULL,          -- prosperity at the end, from the server's replay
  towns    INTEGER NOT NULL,
  log_json TEXT NOT NULL,             -- the replayed action log, canonical
  created  INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX fd_daily_board ON fd_daily (key, score DESC, created);
