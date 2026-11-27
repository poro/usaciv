import { readFileSync } from "node:fs";
const R0 = new URL("../../", import.meta.url).pathname;
const B = process.env.USACIV_URL || "https://usaciv.mark-ollila.workers.dev";
const K = await import(R0 + "web/js/games/link/sim/link.js");
const { makeHexMap } = await import(R0 + "web/js/games/shared/hexmap.js");
const Dd = (n) => JSON.parse(readFileSync(R0 + `web/data/${n}.json`));
const world = Dd("world");
const L = K.linkEnv({ world, infrastructure: Dd("infrastructure") }, makeHexMap(world));
const pool = K.linkPool(Dd("cities"), L);
const call = async (m, p, body, token) => { const t = Date.now(); const r = await fetch(B + p, { method: m, headers: { Origin: B, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, ms: Date.now() - t, d: await r.json().catch(() => null) }; };
await new Promise((r) => setTimeout(r, 8000));
const me = (await call("POST", "/api/player", { name: "Smoke Test" })).d;
try {
  const key = new Date().toISOString().slice(0, 10);
  const p = K.linkPuzzle(pool, L, K.dailySeed(key));
  const par = K.parNetwork(L, p.cells);
  console.log("daily expect 1000:", JSON.stringify(await call("POST", "/api/link/daily", { key, edges: par.edges }, me.token)));
  console.log("today.link", JSON.stringify((await call("GET", "/api/today", undefined, me.token)).d.games.link));
  console.log("stats.lk.best", (await call("GET", "/api/account/stats", undefined, me.token)).d.lk.best);
  const { code } = (await call("POST", "/api/race", { game: "link" }, me.token)).d;
  const ws = new WebSocket(`${B.replace(/^http/, "ws")}/api/race/${code}/ws?token=${me.token}`, { headers: { Origin: B } });
  const rooms = [];
  await new Promise((res, rej) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t !== "room") { console.log("msg", e.data); return; }
      rooms.push(m.room);
      if (m.room.status === "lobby" && rooms.length === 1) ws.send(JSON.stringify({ t: "start" }));
      else if (m.room.status === "live" && !m.room.players[0].done) {
        const pp = K.linkPuzzle(pool, L, K.practiceSeed(m.room.seed));
        ws.send(JSON.stringify({ t: "finish", edges: K.parNetwork(L, pp.cells).edges }));
      } else if (m.room.status === "done") res();
    };
    ws.onerror = rej;
    setTimeout(() => rej(new Error("timeout")), 20000);
  });
  ws.close();
  const last = rooms.at(-1);
  console.log("race (expect 1000)", JSON.stringify({ game: last.game, status: last.status, players: last.players.map((p) => [p.name, p.score, p.place]) }));
} finally {
  console.log("delete", JSON.stringify(await call("DELETE", "/api/account", { confirm: "Smoke Test" }, me.token)));
}
