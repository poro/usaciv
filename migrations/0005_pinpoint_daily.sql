-- Pinpoint daily (docs/MULTIPLAYER.md "Pinpoint daily"): the first finished game per player per day.
CREATE TABLE pp_daily (
  player       TEXT NOT NULL REFERENCES players(id),
  key          TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  score        INTEGER NOT NULL,        -- 0..8000, scored by the server from the guesses
  guesses_json TEXT NOT NULL,           -- the eight guessed hexes
  created      INTEGER NOT NULL,
  UNIQUE (player, key)
);
CREATE INDEX pp_daily_board ON pp_daily (key, score DESC, created);
