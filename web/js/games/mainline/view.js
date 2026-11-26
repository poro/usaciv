// Map drawing for Mainline: static layers (cached with the map, re-rendered only when their sig() changes) and two
// overlays for the build preview and highlights (drawn per frame, but frames only happen on input: nothing animates).
//
//   region (z 59)   dims land outside the scenario's region (precomputed Path2D)
//   links  (z 56.5) your built links: casing + colour by status, stations on connected metros; hover tooltips
//   demand (z 84)   contract "desire lines" between the two ends (dashed = open, solid = served); hover tooltips
//   overlays        world (z 95): route preview, start / hover hex, highlighted contract; screen (z 101): cost label
import { esc, money } from "../../format.js";
import * as S from "./sim/index.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cr = (x) => `${(Math.round(x * 10) / 10).toFixed(1)} cr`;
export const usd = (credits) => money(credits * S.USD_PER_CREDIT);

/** Distance from point p to segment ab (all km). */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function makeView(ctx, game) {
  const app = ctx.app;
  const g = ctx.hexmap.grid;
  const hexPath = (p, c, k = 1) => {
    const x = g.cx(c), y = g.cy(c);
    for (let i = 0; i < 6; i++) {
      const [ox, oy] = g.corners[i];
      if (i === 0) p.moveTo(x + ox * k, y + oy * k);
      else p.lineTo(x + ox * k, y + oy * k);
    }
    p.closePath();
  };

  // --- cached geometry, rebuilt only when the network or the scenario changes ---
  let geoKey = "";
  let geo = null; // {ok: Path2D, hard: Path2D, dmg: Path2D, segs: [{key, x1, y1, x2, y2}], stations: [[x, y, served]]}
  function geometry() {
    const { env, state, ev } = game;
    const key = `${env.scenario.id}:${env.home?.id}:${state.nv}:${state.year}`;
    if (key === geoKey && geo) return geo;
    geoKey = key;
    const ok = new Path2D(), hard = new Path2D(), dmg = new Path2D();
    const segs = [];
    for (const k of Object.keys(state.links)) {
      const l = state.links[k];
      const x1 = g.cx(l.a), y1 = g.cy(l.a), x2 = g.cx(l.b), y2 = g.cy(l.b);
      const p = l.d ? dmg : l.h ? hard : ok;
      p.moveTo(x1, y1);
      p.lineTo(x2, y2);
      segs.push({ key: k, x1, y1, x2, y2 });
    }
    const net = S.networkCells(state);
    const stations = [];
    for (const c of env.cities) {
      if (c.id === env.home?.id && !c.cells.some((x) => net.has(x))) { stations.push([g.cx(c.cell), g.cy(c.cell), true, true]); continue; }
      if (!c.cells.some((x) => net.has(x))) continue;
      const at = c.cells.find((x) => x === c.cell && net.has(x)) ?? c.cells.find((x) => net.has(x));
      stations.push([g.cx(at), g.cy(at), ev.graph.comp.has(at), c.id === env.home?.id]);
    }
    geo = { ok, hard, dmg, segs, stations };
    return geo;
  }

  let regionKey = "", regionPath = null;
  function region() {
    const { env } = game;
    const key = `${env.scenario.id}`;
    if (key === regionKey) return regionPath;
    regionKey = key;
    regionPath = null;
    if (!env.scenario.states && !env.scenario.bounds) return null;
    const p = new Path2D();
    const owner = ctx.data.world.owner;
    for (let i = 0; i < g.size; i++) if (owner[i] >= 0 && !env.inRegion(i)) hexPath(p, i, 1.02);
    regionPath = p;
    return p;
  }

  const links = {
    id: "links", z: 56.5, minRpx: 0, snapshot: true,
    visible: () => !!game.state && game.ui.screen !== "picker",
    sig: () => (game.state ? `${game.env.scenario.id}:${game.state.nv}:${game.state.year}` : "none"),
    draw(c, vp, w, o) {
      const G = geometry();
      const s = vp.s, Rpx = o.Rpx;
      const lw = clamp(Rpx * 0.16, 3.2, 9);
      c.lineCap = "round";
      c.lineJoin = "round";
      // casing
      c.strokeStyle = "rgba(20,14,8,.85)";
      c.lineWidth = (lw + 2.6) / s;
      c.stroke(G.ok); c.stroke(G.hard); c.stroke(G.dmg);
      // hardened links get a steel-blue rim
      c.strokeStyle = "#8fd3ff";
      c.lineWidth = (lw + 1.4) / s;
      c.stroke(G.hard);
      c.strokeStyle = "#f08a2c";
      c.lineWidth = lw / s;
      c.stroke(G.ok);
      c.stroke(G.hard);
      // damaged: red dashes
      c.strokeStyle = "#ff4a3d";
      c.setLineDash([(lw * 1.4) / s, (lw * 1.1) / s]);
      c.stroke(G.dmg);
      c.setLineDash([]);
      // stations on metros the network reaches
      const r = clamp(Rpx * 0.2, 3, 10) / s;
      for (const [x, y, live, home] of G.stations) {
        if (x < vp.x0 - 50 || x > vp.x1 + 50 || y < vp.y0 - 50 || y > vp.y1 + 50) continue;
        c.beginPath();
        c.arc(x, y, home ? r * 1.35 : r, 0, Math.PI * 2);
        c.fillStyle = live ? "#fff4dc" : "#9a8f80";
        c.fill();
        c.lineWidth = Math.max(1.5, r * s * 0.35) / s;
        c.strokeStyle = home ? "#c9a45c" : "#2a1d10";
        c.stroke();
      }
    },
    hit(x, y, Rpx) {
      if (!game.state) return null;
      const tol = (7 * g.R) / Math.max(1, Rpx);
      let best = null, bd = tol;
      for (const sg of geometry().segs) {
        const d = segDist(x, y, sg.x1, sg.y1, sg.x2, sg.y2);
        if (d < bd) { bd = d; best = sg.key; }
      }
      return best ? { kind: "link", key: best } : null;
    },
    tooltip: (it) => linkTip(it.key),
  };

  function linkTip(key) {
    const { env, state } = game;
    const l = state?.links[key];
    if (!l) return null;
    const d = S.linkCost(env, l.a, l.b, true);
    const parts = [];
    if (d.rail != null) parts.push(`upgrades a real ${d.rail === 0 ? "main" : "secondary"} rail line (cheaper)`);
    if (d.river) parts.push(`crosses the ${esc(d.river.name)}`);
    const status = l.d ? `<span class="ml-bad">Damaged in ${l.dy || "a disaster"}</span> · repair ${cr(S.repairCost(env, l))} (≈ ${usd(S.repairCost(env, l))})`
      : l.h ? `<span class="ml-good">Hardened</span>: disasters cannot cut it`
      : `Intact · harden for ${cr(S.hardenCost(env, l))}`;
    return `<b>Your rail link</b><br>Built ${l.year} for ${cr(l.cost)} (≈ ${usd(l.cost)})<br>` +
      `<span class="muted">${esc(d.terrain?.join(" → ") || "")}${parts.length ? `<br>${parts.join(" · ")}` : ""}</span><br>${status}` +
      `<br><span class="muted">Click to select it.</span>`;
  }

  // --- demand lines ---
  let demandKey = "", demandSegs = [];
  function demand() {
    const { env, state, ev, ui } = game;
    const key = `${env.scenario.id}:${state.nv}:${state.year}:${ui.showDemand}`;
    if (key === demandKey) return demandSegs;
    demandKey = key;
    demandSegs = env.contracts.map((c) => ({
      id: c.id, served: ev.served.has(c.id), faf: c.kind === "faf",
      x1: g.cx(c.a.cell), y1: g.cy(c.a.cell), x2: g.cx(c.b.cell), y2: g.cy(c.b.cell),
      w: Math.log(1 + c.value / 1e9),
    }));
    return demandSegs;
  }
  const demandLayer = {
    id: "demand", z: 84, minRpx: 0, snapshot: false,
    visible: () => !!game.state && game.ui.screen === "game" && game.ui.showDemand,
    sig: () => (game.state ? `${game.env.scenario.id}:${game.state.nv}:${game.state.year}` : "none"),
    draw(c, vp, w, o) {
      const s = vp.s;
      c.lineCap = "round";
      for (const d of demand()) {
        const lw = clamp(d.w * 0.7, 1, 3.5);
        c.beginPath();
        c.moveTo(d.x1, d.y1);
        c.lineTo(d.x2, d.y2);
        if (d.served) {
          c.setLineDash([]);
          c.strokeStyle = "rgba(120,230,150,.55)";
        } else {
          c.setLineDash([6 / s, 5 / s]);
          c.strokeStyle = d.faf ? "rgba(255,214,120,.75)" : "rgba(220,200,160,.5)";
        }
        c.lineWidth = lw / s;
        c.stroke();
      }
      c.setLineDash([]);
    },
    hit(x, y, Rpx) {
      // only while not laying track, and never on the end hexes themselves (those are for clicking to build)
      if (!game.state || game.sel.start != null) return null;
      const tol = (4 * g.R) / Math.max(1, Rpx);
      const near = g.R * 0.9;
      let best = null, bd = tol;
      for (const d of demand()) {
        if (Math.hypot(x - d.x1, y - d.y1) < near || Math.hypot(x - d.x2, y - d.y2) < near) continue;
        const dd = segDist(x, y, d.x1, d.y1, d.x2, d.y2);
        if (dd < bd) { bd = dd; best = d.id; }
      }
      return best ? { kind: "contract", id: best } : null;
    },
    tooltip: (it) => game.contractTip(it.id),
  };

  const regionLayer = {
    id: "region", z: 59, minRpx: 0, snapshot: true,
    visible: () => !!game.state && game.ui.screen !== "picker" && !!region(),
    sig: () => (game.env ? game.env.scenario.id : "none"),
    draw(c) {
      const p = region();
      if (!p) return;
      c.fillStyle = "rgba(6,10,16,.55)";
      c.fill(p);
    },
  };

  // --- overlays ---
  const world = {
    id: "build", z: 95, space: "world", snapshot: false,
    draw(c, cam) {
      if (!game.state) return;
      const s = cam.scale;
      const { sel, ui, env } = game;
      // highlighted contract: its two ends
      const hid = ui.hover || ui.highlight;
      const hc = hid ? env.contractById.get(hid) : null;
      if (hc) {
        for (const [end, col] of [[hc.a, "rgba(255,214,120,.28)"], [hc.b, "rgba(255,214,120,.28)"]]) {
          const p = new Path2D();
          for (const x of end.cells) hexPath(p, x, 0.92);
          c.fillStyle = col;
          c.fill(p);
          c.strokeStyle = "rgba(255,214,120,.9)";
          c.lineWidth = 1.5 / s;
          c.stroke(p);
        }
        c.beginPath();
        c.moveTo(g.cx(hc.a.cell), g.cy(hc.a.cell));
        c.lineTo(g.cx(hc.b.cell), g.cy(hc.b.cell));
        c.strokeStyle = "rgba(255,214,120,.95)";
        c.setLineDash([8 / s, 6 / s]);
        c.lineWidth = 2.5 / s;
        c.stroke();
        c.setLineDash([]);
      }
      // selected link
      if (ui.link && game.state.links[ui.link]) {
        const l = game.state.links[ui.link];
        c.beginPath();
        c.moveTo(g.cx(l.a), g.cy(l.a));
        c.lineTo(g.cx(l.b), g.cy(l.b));
        c.strokeStyle = "rgba(255,255,255,.9)";
        c.lineWidth = 12 / s;
        c.lineCap = "round";
        c.globalAlpha = 0.45;
        c.stroke();
        c.globalAlpha = 1;
      }
      // route preview
      const pl = sel.plan;
      if (pl?.path && pl.path.length > 1) {
        const good = !pl.error;
        c.lineCap = "round";
        c.lineJoin = "round";
        const pts = pl.path;
        c.beginPath();
        c.moveTo(g.cx(pts[0]), g.cy(pts[0]));
        for (let k = 1; k < pts.length; k++) c.lineTo(g.cx(pts[k]), g.cy(pts[k]));
        c.strokeStyle = "rgba(10,10,10,.6)";
        c.lineWidth = 8 / s;
        c.stroke();
        c.strokeStyle = good ? "rgba(120,240,150,.95)" : "rgba(255,90,80,.95)";
        c.lineWidth = 4.5 / s;
        c.setLineDash([9 / s, 5 / s]);
        c.stroke();
        c.setLineDash([]);
      }
      // start hex, hover hex
      if (sel.start != null) {
        const p = new Path2D();
        hexPath(p, sel.start, 0.9);
        c.strokeStyle = "#ffd36b";
        c.lineWidth = 3 / s;
        c.stroke(p);
      }
      const hv = sel.end ?? sel.hover;
      if (hv != null && hv >= 0 && hv !== sel.start) {
        const p = new Path2D();
        hexPath(p, hv, 0.9);
        c.strokeStyle = sel.start != null ? (pl && !pl.error ? "rgba(120,240,150,.95)" : "rgba(255,90,80,.9)") : "rgba(255,240,200,.6)";
        c.lineWidth = 2 / s;
        c.stroke(p);
      }
    },
  };
  const label = {
    id: "build-label", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      const { sel } = game;
      const pl = sel.plan;
      if (!game.state || !pl?.path || pl.path.length < 2) return;
      const end = pl.path[pl.path.length - 1];
      const [sx, sy] = cam.toScreen(g.cx(end), g.cy(end));
      const text = pl.error && !pl.fresh ? pl.error : `${cr(pl.cost)} · ${pl.fresh} new link${pl.fresh === 1 ? "" : "s"}${pl.rail ? ` · ${pl.rail} on real rail` : ""}`;
      const sub = pl.error && pl.fresh ? pl.error : `≈ ${usd(pl.cost)} · ${pl.km} km`;
      c.font = "600 13px system-ui, sans-serif";
      const wTxt = Math.max(c.measureText(text).width, (c.font = "12px system-ui, sans-serif", c.measureText(sub).width));
      const bw = wTxt + 16, bh = 38;
      let x = sx + 16, y = sy - bh - 10;
      if (x + bw > cam.w - 8) x = sx - bw - 16;
      if (y < 56) y = sy + 16;
      c.fillStyle = "rgba(14,18,24,.92)";
      c.strokeStyle = pl.error ? "rgba(255,90,80,.9)" : "rgba(120,240,150,.9)";
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect ? c.roundRect(x, y, bw, bh, 5) : c.rect(x, y, bw, bh);
      c.fill();
      c.stroke();
      c.fillStyle = "#fff6dc";
      c.font = "600 13px system-ui, sans-serif";
      c.fillText(text, x + 8, y + 16);
      c.fillStyle = pl.error ? "#ffb4a8" : "#c8d4c0";
      c.font = "12px system-ui, sans-serif";
      c.fillText(sub, x + 8, y + 31);
    },
  };

  ctx.addLayer(regionLayer);
  ctx.addLayer(links);
  ctx.addLayer(demandLayer);
  ctx.addOverlay(world);
  ctx.addOverlay(label);

  return {
    redraw: () => app.requestDraw(),
    /** Static layers changed (network, year, toggles): their sig() covers it, but make sure a frame runs. */
    refresh: () => app.requestDraw(),
    reset() { geoKey = ""; demandKey = ""; regionKey = ""; },
    linkTip,
  };
}
