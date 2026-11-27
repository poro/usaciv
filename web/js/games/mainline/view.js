// Map drawing for Mainline: static layers (cached with the map, re-rendered only when their sig() changes) and
// overlays for the build preview, highlights and trains (drawn per frame; frames happen on input, plus the train loop).
//
//   region (z 59)   dims land outside the scenario's region (precomputed Path2D)
//   links  (z 56.5) your built links: casing + colour by status, stations on connected metros; hover tooltips
//   demand (z 84)   contract "desire lines" between the two ends (dashed = open, solid = served); hover tooltips
//   overlays        world (z 95): route preview, start / hover hex, highlighted contract; screen (z 101): cost label
//                   world (z 94): trains on served routes (trains.js), only while the train loop below runs
//
// Train loop: a requestAnimationFrame loop asks the engine for a frame at most TRAIN_FPS times a second. It runs only
// while the Trains toggle is on, a game is in play (not over), something is served, the tab is visible and the user
// has not asked for reduced motion; otherwise it stops and the trains overlay draws nothing. Exiting the game stops it
// (ctx.onCleanup). Animation is view-only: it reads game.ev / game.state and never writes them.
import { esc, money } from "../../format.js";
import * as S from "./sim/index.js";
import { buildRoutes, trainsAt } from "./trains.js";

const TRAIN_FPS = 30;

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
  let geo = null; // {ok, hard, dmg, dbl: Path2D, segs: [{key, x1, y1, x2, y2}], stations: [[x, y, live, home, hub level]]}
  function geometry() {
    const { env, state, ev } = game;
    const key = `${env.scenario.id}:${env.home?.id}:${state.nv}:${state.year}:${state.seed}:${game.vs ? `vs${game.vs.me}` : ""}`;
    if (key === geoKey && geo) return geo;
    geoKey = key;
    const ok = new Path2D(), hard = new Path2D(), dmg = new Path2D(), dbl = new Path2D();
    const segs = [];
    for (const k of Object.keys(state.links)) {
      const l = state.links[k];
      const x1 = g.cx(l.a), y1 = g.cy(l.a), x2 = g.cx(l.b), y2 = g.cy(l.b);
      const p = l.d ? dmg : l.h ? hard : ok;
      p.moveTo(x1, y1);
      p.lineTo(x2, y2);
      if (l.dt && !l.d) { dbl.moveTo(x1, y1); dbl.lineTo(x2, y2); }
      segs.push({ key: k, x1, y1, x2, y2 });
    }
    const net = S.networkCells(state);
    const stations = [];
    for (const c of env.cities) {
      if (c.id === env.home?.id && !c.cells.some((x) => net.has(x))) { stations.push([g.cx(c.cell), g.cy(c.cell), true, true, 0]); continue; }
      if (!c.cells.some((x) => net.has(x))) continue;
      const at = c.cells.find((x) => x === c.cell && net.has(x)) ?? c.cells.find((x) => net.has(x));
      stations.push([g.cx(at), g.cy(at), ev.graph.comp.has(at), c.id === env.home?.id, state.hubs?.[c.id] || 0]);
    }
    geo = { ok, hard, dmg, dbl, segs, stations };
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
    sig: () => (game.state ? `${game.env.scenario.id}:${game.state.seed}:${game.state.nv}:${game.state.year}:${game.vs ? `vs${game.vs.me}` : ""}` : "none"),
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
      c.strokeStyle = game.vs ? S.VS_COLORS[game.vs.me] : "#f08a2c";
      c.lineWidth = lw / s;
      c.stroke(G.ok);
      c.stroke(G.hard);
      // double track: a dark centre line splits the stroke into two rails
      c.strokeStyle = "rgba(40,20,6,.9)";
      c.lineWidth = Math.max(1, lw * 0.28) / s;
      c.stroke(G.dbl);
      // damaged: red dashes
      c.strokeStyle = "#ff4a3d";
      c.setLineDash([(lw * 1.4) / s, (lw * 1.1) / s]);
      c.stroke(G.dmg);
      c.setLineDash([]);
      // stations on metros the network reaches
      const r = clamp(Rpx * 0.2, 3, 10) / s;
      for (const [x, y, live, home, hub] of G.stations) {
        if (x < vp.x0 - 50 || x > vp.x1 + 50 || y < vp.y0 - 50 || y > vp.y1 + 50) continue;
        c.beginPath();
        const rr = (home ? r * 1.35 : r) * (hub ? 1.15 : 1);
        if (hub) c.rect(x - rr, y - rr, rr * 2, rr * 2); // terminals are square
        else c.arc(x, y, rr, 0, Math.PI * 2);
        c.fillStyle = live ? "#fff4dc" : "#9a8f80";
        c.fill();
        c.lineWidth = Math.max(1.5, r * s * 0.35) / s;
        c.strokeStyle = home || hub ? "#c9a45c" : "#2a1d10";
        c.stroke();
        // one gold pip per terminal level, under the station
        for (let k = 0; k < hub; k++) {
          c.beginPath();
          c.arc(x + (k - (hub - 1) / 2) * rr * 0.9, y + rr * 1.7, rr * 0.32, 0, Math.PI * 2);
          c.fillStyle = "#e8c46a";
          c.fill();
        }
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
    const hz = S.hardenOptions(env, l);
    const held = hz.filter((h) => h.done).map((h) => S.TYPE_NAME[h.type].toLowerCase());
    const open = hz.filter((h) => !h.done).map((h) => S.TYPE_NAME[h.type].toLowerCase());
    const status = (l.d ? `<span class="ml-bad">Damaged in ${l.dy || "a disaster"}</span> · repair ${cr(S.repairCost(env, l))} (≈ ${usd(S.repairCost(env, l))})`
      : `Intact${l.dt ? " · <span class=\"ml-good\">double track</span>" : ""}`) +
      (held.length ? `<br><span class="ml-good">Hardened against ${esc(held.join(", "))}</span>` : "") +
      (open.length ? `<br><span class="muted">Exposed to ${esc(open.join(", "))}</span>` : "");
    return `<b>Your rail link</b><br>Built ${l.year} for ${cr(l.cost)} (≈ ${usd(l.cost)})<br>` +
      `<span class="muted">${esc(d.terrain?.join(" → ") || "")}${parts.length ? `<br>${parts.join(" · ")}` : ""}</span><br>${status}` +
      `<br><span class="muted">Click to select it.</span>`;
  }

  // --- power and fibre (sim/utility.js): lines, plants and research metros ---
  const UCOL = { power: "#ffd24a", fibre: "#6fe3ff" };
  let utilKey = "", utilGeo = null;
  function utilGeometry() {
    const { env, state, ev } = game;
    const key = `${env.scenario.id}:${env.home?.id}:${state.nv}:${state.year}:${state.seed}`;
    if (key === utilKey && utilGeo) return utilGeo;
    utilKey = key;
    const power = new Path2D(), fibre = new Path2D();
    for (const [k, l] of Object.entries(state.lines || {})) {
      const p = k[0] === "p" ? power : fibre;
      p.moveTo(g.cx(l.a), g.cy(l.a));
      p.lineTo(g.cx(l.b), g.cy(l.b));
    }
    const u = env.utility || { power: [], talent: [], talentHubs: [] };
    const plants = u.power.map((c) => ({ c, x: g.cx(c.cell), y: g.cy(c.cell), on: ev.utility?.power.has(c.id) }));
    const servedHubs = new Set();
    for (const t of u.talent) if (ev.utility?.talent.has(t.id)) { servedHubs.add(t.a); servedHubs.add(t.b); }
    const hubs = u.talentHubs.map((id) => { const m = env.cities[env.cityIdx.get(id)]; return { id, x: g.cx(m.cell), y: g.cy(m.cell), on: servedHubs.has(id) }; });
    utilGeo = { power, fibre, plants, hubs, any: !!state.lines };
    return utilGeo;
  }
  const utilityLayer = {
    id: "utility", z: 56.6, minRpx: 0, snapshot: true,
    visible: () => !!game.state && game.ui.screen !== "picker" && !game.vs && !!game.env.utility,
    sig: () => (game.state ? `${game.env.scenario.id}:${game.state.seed}:${game.state.nv}:${game.state.year}:${game.ui.net}` : "none"),
    draw(c, vp, w, o) {
      const G = utilGeometry();
      const s = vp.s, Rpx = o.Rpx;
      const lw = clamp(Rpx * 0.08, 1.6, 4.5);
      const mode = game.ui.net;
      c.lineCap = "round";
      c.lineJoin = "round";
      if (G.any) {
        c.strokeStyle = "rgba(12,10,6,.8)";
        c.lineWidth = (lw + 2) / s;
        c.stroke(G.power); c.stroke(G.fibre);
        c.strokeStyle = UCOL.power;
        c.lineWidth = lw / s;
        c.stroke(G.power);
        c.strokeStyle = UCOL.fibre;
        c.setLineDash([(lw * 2.2) / s, (lw * 1.4) / s]);
        c.stroke(G.fibre);
        c.setLineDash([]);
      }
      // plants: always when served; all of them while building power
      const r = clamp(Rpx * 0.2, 3, 10) / s;
      for (const p of G.plants) {
        if (!p.on && mode !== "power") continue;
        if (p.x < vp.x0 - 40 || p.x > vp.x1 + 40 || p.y < vp.y0 - 40 || p.y > vp.y1 + 40) continue;
        c.beginPath();
        c.moveTo(p.x, p.y - r * 1.25); c.lineTo(p.x + r * 1.1, p.y); c.lineTo(p.x, p.y + r * 1.25); c.lineTo(p.x - r * 1.1, p.y); c.closePath();
        c.fillStyle = p.on ? UCOL.power : "rgba(255,210,74,.35)";
        c.fill();
        c.lineWidth = Math.max(1, r * s * 0.3) / s;
        c.strokeStyle = p.c.type === "coal_plant" || p.c.type === "gas_plant" ? "#6b4a2a" : "#2a1d10";
        c.stroke();
      }
      // research metros: rings, while building fibre or once linked
      for (const h of G.hubs) {
        if (!h.on && mode !== "fibre") continue;
        c.beginPath();
        c.arc(h.x, h.y, r * 1.9, 0, Math.PI * 2);
        c.lineWidth = Math.max(1.5, r * s * 0.45) / s;
        c.strokeStyle = h.on ? UCOL.fibre : "rgba(111,227,255,.45)";
        c.stroke();
      }
    },
    hit(x, y, Rpx) {
      if (!game.state || (!game.ui.net || game.ui.net === "rail") && !game.state.lines) return null;
      const tol = (6 * g.R) / Math.max(1, Rpx);
      let best = null, bd = tol;
      for (const p of utilGeometry().plants) {
        if (!p.on && game.ui.net !== "power") continue;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < bd) { bd = d; best = p.c; }
      }
      return best ? { kind: "plant", id: best.id } : null;
    },
    tooltip: (it) => plantTip(it.id),
  };
  function plantTip(id) {
    const { env, state, ev } = game;
    const c = env.utility?.byId.get(id);
    if (!c) return null;
    const city = env.cities[env.cityIdx.get(c.city)];
    const on = ev.utility?.power.get(id);
    const tr = S.transitionShare(c.type, state.year);
    return `<b>${esc(c.name)}</b><br>${esc(TYPE_LABEL[c.type] || c.type)} · ${c.mw.toLocaleString("en-US")} MW <span class="muted">(EIA-860M)</span><br>` +
      `Supplies <b>${esc(city.name)}</b>, ${c.km} km: ${on != null ? `<span class="ml-good">wired, +${on.toFixed(1)} cr/yr</span>` : `${c.base.toFixed(1)} cr/yr once a power line reaches downtown`}` +
      (tr ? `<br><span class="muted">Transition cost: −${Math.round(tr * 100)}% of its pay this decade (a game model)</span>` : "");
  }
  const TYPE_LABEL = { nuclear: "Nuclear", hydro: "Hydro", wind: "Wind", solar: "Solar", geothermal: "Geothermal", gas_plant: "Gas plant", coal_plant: "Coal plant" };

  // --- demand lines ---
  let demandKey = "", demandSegs = [];
  function demand() {
    const { env, state, ev, ui } = game;
    const key = `${env.scenario.id}:${state.nv}:${state.year}:${ui.showDemand}:${game.vsRev || 0}`;
    if (key === demandKey) return demandSegs;
    demandKey = key;
    const claims = game.vs?.vs?.claims;
    demandSegs = env.contracts.map((c) => ({
      id: c.id, served: ev.served.has(c.id), faf: c.kind === "faf",
      rival: claims && claims[c.id] != null && claims[c.id] !== game.vs.me ? claims[c.id] : null,
      x1: g.cx(c.a.cell), y1: g.cy(c.a.cell), x2: g.cx(c.b.cell), y2: g.cy(c.b.cell),
      w: Math.log(1 + c.value / 1e9),
    }));
    return demandSegs;
  }
  const demandLayer = {
    id: "demand", z: 84, minRpx: 0, snapshot: false,
    visible: () => !!game.state && game.ui.screen === "game" && game.ui.showDemand,
    sig: () => (game.state ? `${game.env.scenario.id}:${game.state.nv}:${game.state.year}:${game.vsRev || 0}` : "none"),
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
        } else if (d.rival != null) {
          // versus: held by a rival company (thin, in its colour)
          c.setLineDash([2 / s, 4 / s]);
          c.strokeStyle = S.VS_COLORS[d.rival];
          c.globalAlpha = 0.55;
        } else {
          c.setLineDash([6 / s, 5 / s]);
          c.strokeStyle = d.faf ? "rgba(255,214,120,.75)" : "rgba(220,200,160,.5)";
        }
        c.lineWidth = lw / s;
        c.stroke();
        c.globalAlpha = 1;
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

  // --- versus: rival companies' track (thinner, in their colours, under yours) ---
  let rivalKey = "", rivalPaths = null;
  function rivalGeometry() {
    const v = game.vs;
    const key = `${game.vsRev || 0}:${v?.me}`;
    if (key === rivalKey && rivalPaths) return rivalPaths;
    rivalKey = key;
    rivalPaths = [];
    for (const [p, pl] of (v?.vs?.players || []).entries()) {
      if (p === v.me) continue;
      const ok = new Path2D(), dmg = new Path2D();
      for (const l of Object.values(pl.state.links)) {
        const path = l.d ? dmg : ok;
        path.moveTo(g.cx(l.a), g.cy(l.a));
        path.lineTo(g.cx(l.b), g.cy(l.b));
      }
      rivalPaths.push({ p, ok, dmg });
    }
    return rivalPaths;
  }
  const rivalLayer = {
    id: "rivals", z: 56.4, minRpx: 0, snapshot: true,
    visible: () => !!game.vs?.vs && game.ui.screen !== "picker",
    sig: () => `${game.vsRev || 0}:${game.vs?.me}`,
    draw(c, vp, w, o) {
      const s = vp.s;
      const lw = clamp(o.Rpx * 0.13, 2.6, 7);
      c.lineCap = "round";
      c.lineJoin = "round";
      for (const r of rivalGeometry()) {
        c.strokeStyle = "rgba(14,10,6,.8)";
        c.lineWidth = (lw + 2) / s;
        c.stroke(r.ok); c.stroke(r.dmg);
        c.strokeStyle = S.VS_COLORS[r.p];
        c.lineWidth = lw / s;
        c.stroke(r.ok);
        c.setLineDash([(lw * 1.4) / s, (lw * 1.2) / s]);
        c.stroke(r.dmg);
        c.setLineDash([]);
      }
    },
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
      // highlighted power or talent contract: its two end hexes
      const uc = hid && !hc ? env.utility?.byId.get(hid) : null;
      if (uc) {
        const centre = (id) => env.cities[env.cityIdx.get(id)].cell;
        const ends = uc.kind === "power" ? [uc.cell, centre(uc.city)] : [centre(uc.a), centre(uc.b)];
        const col = uc.kind === "power" ? "255,210,74" : "111,227,255";
        for (const x of ends) {
          const p = new Path2D();
          hexPath(p, x, 1.1);
          c.fillStyle = `rgba(${col},.3)`;
          c.fill(p);
          c.strokeStyle = `rgba(${col},.95)`;
          c.lineWidth = 2 / s;
          c.stroke(p);
        }
        c.beginPath();
        c.moveTo(g.cx(ends[0]), g.cy(ends[0]));
        c.lineTo(g.cx(ends[1]), g.cy(ends[1]));
        c.strokeStyle = `rgba(${col},.9)`;
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
        c.strokeStyle = !good ? "rgba(255,90,80,.95)" : pl.net === "power" ? "rgba(255,210,74,.95)" : pl.net === "fibre" ? "rgba(111,227,255,.95)" : "rgba(120,240,150,.95)";
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

  // --- trains (overlay only; never cached, never in the share image) ---
  const reduceMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let routesEv = null, routes = [];
  function trainRoutes() {
    // evaluate() makes a new ev on every action, so its identity is the cache key: rebuilt per network change only
    if (routesEv !== game.ev) {
      routesEv = game.ev;
      routes = game.ev ? buildRoutes({ served: game.ev.served, links: game.state.links, express: game.state.express, cx: g.cx, cy: g.cy, minGap: g.R * 2.2 }) : [];
    }
    return routes;
  }
  /** Should trains move right now? */
  function trainsOn() {
    return !!(game.ui.trains && game.state && !game.state.over && game.ui.screen === "game" && game.ev?.served.size &&
      !reduceMotion?.matches && (typeof document === "undefined" || document.visibilityState !== "hidden"));
  }
  const trainLayer = {
    id: "trains", z: 94, space: "world", snapshot: false,
    draw(c, cam) {
      if (!trainsOn()) return;
      const s = cam.scale;
      const hw = cam.w / 2 / s, hh = cam.h / 2 / s, m = 20 / s;
      const x0 = cam.x - hw - m, x1 = cam.x + hw + m, y0 = cam.y - hh - m, y1 = cam.y + hh + m;
      const t = performance.now() / 1000;
      // marker size in screen px, a little bigger zoomed in; drawn in world units
      const L = clamp(4 + s * 1.5, 7, 13) / s, W = L * 0.48, r = W * 0.45;
      c.lineWidth = 1.4 / s;
      c.strokeStyle = "rgba(16,10,4,.9)";
      for (const rt of trainRoutes()) {
        c.fillStyle = rt.express ? "#bfe8ff" : "#ffe6b0";
        for (const p of trainsAt(rt, t)) {
          if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
          c.save();
          c.translate(p.x, p.y);
          c.rotate(p.a);
          c.beginPath();
          if (c.roundRect) c.roundRect(-L / 2, -W / 2, L, W, r);
          else c.rect(-L / 2, -W / 2, L, W);
          c.fill();
          c.stroke();
          // a dark nose shows which way it runs
          c.fillStyle = "rgba(40,24,8,.85)";
          c.fillRect(L / 2 - L * 0.22, -W / 2 + c.lineWidth, L * 0.16, W - 2 * c.lineWidth);
          c.restore(); // back to this route's fill
        }
      }
    },
  };

  let raf = 0, lastTick = 0, wasOn = false;
  function tick(now) {
    raf = 0;
    if (!trainsOn()) { syncTrains(); return; }
    if (now - lastTick >= 1000 / TRAIN_FPS - 2) { lastTick = now; app.requestDraw(); }
    raf = requestAnimationFrame(tick);
  }
  /** Start or stop the loop to match trainsOn(); cheap, so call it after anything that might change the answer. */
  function syncTrains() {
    const on = trainsOn();
    if (on && !raf) raf = requestAnimationFrame(tick);
    else if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
    if (wasOn && !on) app.requestDraw(); // one more frame so the stopped trains disappear
    wasOn = on;
  }
  const onVis = () => syncTrains();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  reduceMotion?.addEventListener?.("change", onVis);
  ctx.onCleanup(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    reduceMotion?.removeEventListener?.("change", onVis);
  });

  ctx.addLayer(regionLayer);
  ctx.addLayer(rivalLayer);
  ctx.addLayer(links);
  ctx.addLayer(utilityLayer);
  ctx.addLayer(demandLayer);
  ctx.addOverlay(trainLayer);
  ctx.addOverlay(world);
  ctx.addOverlay(label);

  return {
    redraw: () => { syncTrains(); app.requestDraw(); },
    /** Static layers changed (network, year, toggles): their sig() covers it, but make sure a frame runs. */
    refresh: () => { syncTrains(); app.requestDraw(); },
    reset() { geoKey = ""; demandKey = ""; regionKey = ""; rivalKey = ""; routesEv = null; },
    /** Re-check the train loop (after the Trains toggle changes). */
    syncTrains,
    /** Can trains animate at all here (false with prefers-reduced-motion)? */
    motionOk: () => !reduceMotion?.matches,
    linkTip,
  };
}
