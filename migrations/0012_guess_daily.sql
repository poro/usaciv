-- Ballpark daily (docs/MULTIPLAYER.md "Ballpark daily"): the first finished game per player per day.
CREATE TABLE guess_daily (
  player       TEXT NOT NULL REFERENCES players(id),
  key          TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  score        INTEGER NOT NULL,          -- 0..600, from the server
  guesses_json TEXT NOT NULL,
  created      INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX guess_daily_board ON guess_daily (key, score DESC, created);
