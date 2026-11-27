import { readFileSync } from "node:fs";
const R0 = new URL("../../", import.meta.url).pathname;
const B = process.env.USACIV_URL || "https://usaciv.mark-ollila.workers.dev";
const T = await import(R0 + "web/js/games/trip/sim/trip.js");
const pool = T.tripPool(JSON.parse(readFileSync(R0 + "web/data/cities.json")));
const call = async (m, p, body, token) => { const r = await fetch(B + p, { method: m, headers: { Origin: B, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, d: await r.json().catch(() => null) }; };
await new Promise((r) => setTimeout(r, 4000));
const me = (await call("POST", "/api/player", { name: "Smoke Test" })).d;
const { code } = (await call("POST", "/api/race", { game: "trip" }, me.token)).d;
console.log("status", JSON.stringify((await call("GET", `/api/race/${code}`)).d));
const ws = new WebSocket(`${B.replace(/^http/, "ws")}/api/race/${code}/ws?token=${me.token}`, { headers: { Origin: B } });
const rooms = [];
await new Promise((res, rej) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t !== "room") { console.log("msg", e.data); return; }
    rooms.push(m.room);
    if (m.room.status === "lobby" && rooms.length === 1) ws.send(JSON.stringify({ t: "start" }));
    else if (m.room.status === "live" && !m.room.players[0].done) {
      const trip = T.tripFor(pool, `trip-practice:${m.room.seed}`);
      ws.send(JSON.stringify({ t: "finish", order: trip.best.order }));
    } else if (m.room.status === "done") res();
  };
  ws.onerror = rej;
  setTimeout(() => rej(new Error("timeout")), 15000);
});
ws.close();
const last = rooms.at(-1);
console.log("final", JSON.stringify({ game: last.game, status: last.status, players: last.players.map((p) => [p.name, p.score, p.place]) }));
console.log("delete", JSON.stringify(await call("DELETE", "/api/account", { confirm: "Smoke Test" }, me.token)));
