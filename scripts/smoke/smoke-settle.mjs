import { readFileSync } from "node:fs";
const R0 = new URL("../../", import.meta.url).pathname;
const B = process.env.USACIV_URL || "https://usaciv.mark-ollila.workers.dev";
const S = await import(R0 + "web/js/games/settle/sim/settle.js");
const { makeHexMap } = await import(R0 + "web/js/games/shared/hexmap.js");
const Dd = (n) => JSON.parse(readFileSync(R0 + `web/data/${n}.json`));
const world = Dd("world");
const E = S.settleEnv({ world, counties: Dd("counties") }, makeHexMap(world));
const call = async (m, p, body, token) => { const r = await fetch(B + p, { method: m, headers: { Origin: B, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, d: await r.json().catch(() => null) }; };
await new Promise((r) => setTimeout(r, 8000));
const me = (await call("POST", "/api/player", { name: "Smoke Test" })).d;
try {
  const key = new Date().toISOString().slice(0, 10);
  const sites = S.parSites(E, S.settlePuzzle(S.dailySeed(key))).sites;
  console.log("daily expect 1000:", JSON.stringify(await call("POST", "/api/settle/daily", { key, sites }, me.token)));
  console.log("today.settle", JSON.stringify((await call("GET", "/api/today", undefined, me.token)).d.games.settle));
  console.log("stats.st.best", (await call("GET", "/api/account/stats", undefined, me.token)).d.st.best);
  const { code } = (await call("POST", "/api/race", { game: "settle" }, me.token)).d;
  const ws = new WebSocket(`${B.replace(/^http/, "ws")}/api/race/${code}/ws?token=${me.token}`, { headers: { Origin: B } });
  const rooms = [];
  await new Promise((res, rej) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== "room") { console.log("msg", e.data); return; }
      rooms.push(m.room);
      if (m.room.status === "lobby" && rooms.length === 1) ws.send(JSON.stringify({ t: "start" }));
      else if (m.room.status === "live" && !m.room.players[0].done) ws.send(JSON.stringify({ t: "finish", sites: S.parSites(E, S.settlePuzzle(S.practiceSeed(m.room.seed))).sites }));
      else if (m.room.status === "done") res();
    };
    ws.onerror = rej;
    setTimeout(() => rej(new Error("timeout")), 15000);
  });
  ws.close();
  const last = rooms.at(-1);
  console.log("race (expect 1000)", JSON.stringify({ game: last.game, status: last.status, players: last.players.map((p) => [p.name, p.score, p.place]) }));
} finally {
  console.log("delete", JSON.stringify(await call("DELETE", "/api/account", { confirm: "Smoke Test" }, me.token)));
}
