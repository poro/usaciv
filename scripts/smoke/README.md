# Live smoke tests

End-to-end checks against a running site (the live Worker by default). Each script creates a throwaway player
called "Smoke Test" (Which Metro?'s: "Smoke A/B/C"), plays through the API with the answers rebuilt from the same
`web/js/games/*/sim` code, prints what the server said, and deletes the player with `DELETE /api/account`.

```bash
node scripts/smoke/smoke-link.mjs                                   # the live site
USACIV_URL=http://localhost:8788 node scripts/smoke/smoke-link.mjs  # `npx wrangler@4 dev --port 8788`
```

Most wait 8 seconds first (a fresh deploy can 404 new routes briefly). Expected values are printed next to the
results ("daily expect 1000: …").

| Script | Checks |
|---|---|
| smoke-auth.mjs | passkey registration and sign-in with a software authenticator, device codes |
| smoke-wm.mjs | Which Metro? daily and race (local dev by default) |
| smoke-pp, -duel, -trip, -lens, -rank, -shapes, -guess, -link, -settle | that mode's daily board, `/api/today`, account stats; most also a race |
| smoke-race.mjs, smoke-race-lens.mjs | races for Pinpoint/Duel/Trip and Lens Detective |
| smoke-fd.mjs, smoke-ml.mjs | Founders and Mainline dailies |
