-- Metro Duel daily (docs/MULTIPLAYER.md "Metro Duel daily"): the first finished run per player per day.
CREATE TABLE duel_daily (
  player       TEXT NOT NULL REFERENCES players(id),
  key          TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  streak       INTEGER NOT NULL,        -- 0..30, counted by the server from the answers
  answers_json TEXT NOT NULL,
  created      INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX duel_daily_board ON duel_daily (key, streak DESC, created);
