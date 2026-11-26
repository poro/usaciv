// Founders: map art. Static layers go into the cached map (redrawn only when their sig() changes); the overlay
// draws the selection and the move preview every frame, cheaply.
//
//   z 61  cover      paints plain terrain over every real city tile, metro spill and urban hex (just above CITIES 60),
//                    then redraws rivers and state lines clipped to those hexes, so the land reads as untouched
//   z 62  land       your territory tint and border, roads and rail, improvements
//   z 64  yields     small food / materials / trade pips on land hexes (toggle; zoomed in only)
//   z 66  towns      your towns, founding parties and labels; hit() + tooltip() explain any hex's output
//   overlay          selection ring, worked hexes, the party's move preview, the "too close" zone, start markers
import { css, mix, shade } from "../../color.js";
import { hash01 } from "../../hex.js";
import { drawRivers, strokeSegs } from "../../render/art/water.js";
import { metroSpill } from "../../render/art/city.js";
import { esc } from "../../format.js";
import { baseYields, explainHex, hexYield, IMPROVEMENTS, owners, townAt, landPath, foundBlocker, RULES, townOutput, RELIEF_NAME } from "./sim/index.js";
import { moveCost } from "./sim/yields.js";

export const COLORS = {
  land: [63, 208, 201],
  border: "#8ff3ec",
  borderDark: "rgba(4,30,32,.75)",
  roof: "#b4473a",
  wall: "#efe2c2",
  flag: "#2fc4bc",
  food: "#7fcf4a",
  materials: "#d08a3a",
  trade: "#f0c94a",
};

const PCT_COVER = { forest: 1, crop: 7, pasture: 6, grass: 5, shrub: 4, wetland: 8 };

/** Hex outline path at cell i, grown by factor f. */
function hexPath(ctx, grid, i, f = 1) {
  const x = grid.cx(i), y = grid.cy(i);
  ctx.moveTo(x + grid.corners[0][0] * f, y + grid.corners[0][1] * f);
  for (let k = 1; k < 6; k++) ctx.lineTo(x + grid.corners[k][0] * f, y + grid.corners[k][1] * f);
  ctx.closePath();
}
const inVp = (vp, x, y, m) => x > vp.x0 - m && x < vp.x1 + m && y > vp.y0 - m && y < vp.y1 + m;

// --- cover: hide the real cities ---------------------------------------------------------------------------------

/** Cells that would give a real city away, with a plain terrain colour for each. */
export function prepareCover(w, cities) {
  const set = new Set();
  for (const c of cities) if (c.cell != null && w.raw.owner[c.cell] >= 0) set.add(c.cell);
  for (const cell of metroSpill(w).keys()) set.add(cell);
  for (let i = 0; i < w.grid.size; i++) if (w.cover[i] === 9 && !w.water[i]) set.add(i);
  const cells = [...set].sort((a, b) => a - b);
  const items = cells.map((i) => {
    // The cell's mix of open land (developed land left out), like world.js landRGB.
    let best = 5, bestP = -1, tot = 0, r = 0, g = 0, b = 0;
    for (const [key, id] of Object.entries(PCT_COVER)) {
      const p = w.pct?.[key]?.[i] || 0;
      const col = w.coverRGB[id];
      if (!col) continue;
      if (p > bestP) { bestP = p; best = id; }
      if (p) { tot += p; r += col[0] * p; g += col[1] * p; b += col[2] * p; }
    }
    let c = w.coverRGB[best] || [169, 179, 90];
    if (tot > 0) c = mix(c, [r / tot, g / tot, b / tot], 0.35);
    const elev = w.raw.elev[i];
    c = mix(c, [176, 160, 128], Math.max(0, Math.min(1, (elev - 300) / 2800)) * 0.28);
    const rel = w.relief[i];
    if (rel >= 2) c = mix(c, rel === 3 ? [200, 204, 208] : [128, 116, 102], rel === 3 ? 0.45 : 0.32);
    else if (rel === 1) c = shade(c, -0.05);
    c = shade(c, (hash01(i, 7) - 0.5) * 0.08 + (w.shadeK?.[i] || 0));
    return { cell: i, color: css(c), glyph: best, x: w.grid.cx(i), y: w.grid.cy(i) };
  });
  return { cells, items, set };
}

export function coverLayer(model) {
  return {
    id: "cover", z: 61, snapshot: true,
    visible: () => !model.revealed,
    sig: () => "c1",
    draw(ctx, vp, w, o) {
      const { grid } = w;
      const R = grid.R, s = o.s;
      const grow = (R + 1.4 / s) / R;
      const m = 2 * R;
      const vis = model.cover.items.filter((it) => inVp(vp, it.x, it.y, m));
      if (!vis.length) return;
      const clip = new Path2D();
      for (const it of vis) {
        const x = it.x, y = it.y;
        clip.moveTo(x + grid.corners[0][0] * grow, y + grid.corners[0][1] * grow);
        for (let k = 1; k < 6; k++) clip.lineTo(x + grid.corners[k][0] * grow, y + grid.corners[k][1] * grow);
        clip.closePath();
      }
      for (const it of vis) {
        ctx.beginPath();
        hexPath(ctx, grid, it.cell, grow);
        ctx.fillStyle = it.color;
        ctx.fill();
      }
      if (o.Rpx > 10) drawCoverGlyphs(ctx, vis, R, s);
      // Rivers and state lines through those hexes, as the base map draws them.
      ctx.save();
      ctx.clip(clip);
      try { drawRivers(ctx, w, { s, Rpx: o.Rpx, lod: o.lod, lens: false }); } catch { /* art module changed: skip */ }
      if (w.bands) {
        for (const [st, segs] of w.bands) {
          ctx.beginPath();
          for (let k = 0; k < segs.length; k += 8) {
            ctx.moveTo(segs[k], segs[k + 1]);
            ctx.lineTo(segs[k + 2], segs[k + 3]);
            ctx.lineTo(segs[k + 6], segs[k + 7]);
            ctx.lineTo(segs[k + 4], segs[k + 5]);
            ctx.closePath();
          }
          ctx.fillStyle = css(w.stateColor[st], 0.62);
          ctx.fill();
        }
      }
      if (w.stateLines) strokeSegs(ctx, w.stateLines, "rgba(15,10,5,.55)", Math.max(0.8, Math.min(2, o.Rpx * 0.08)) / s);
      if (w.nationLines) strokeSegs(ctx, w.nationLines, "rgba(255,232,160,.85)", Math.max(1.2, Math.min(3, o.Rpx * 0.12)) / s);
      ctx.restore();
    },
  };
}

function drawCoverGlyphs(ctx, items, R, s) {
  for (const it of items) {
    const h = (k) => hash01(it.cell, 40 + k);
    if (it.glyph === 7 || it.glyph === 6) {
      // field strips
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate((h(0) - 0.5) * 0.6);
      ctx.fillStyle = it.glyph === 7 ? "rgba(120,100,30,.22)" : "rgba(60,90,30,.18)";
      for (let k = -2; k <= 2; k++) ctx.fillRect(-0.5 * R, k * 0.17 * R, R, 0.07 * R);
      ctx.restore();
    } else if (it.glyph === 1) {
      ctx.fillStyle = "rgba(30,60,28,.55)";
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.arc(it.x + (h(k) - 0.5) * 0.9 * R, it.y + (h(k + 9) - 0.5) * 0.8 * R, 0.12 * R, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = "rgba(70,80,30,.35)";
      ctx.lineWidth = 1 / s;
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const x = it.x + (h(k) - 0.5) * R, y = it.y + (h(k + 9) - 0.5) * 0.8 * R;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 0.04 * R, y - 0.1 * R);
      }
      ctx.stroke();
    }
  }
}

// --- land: territory, links, improvements --------------------------------------------------------------------------

/** Geometry derived from the state (once per state change). */
export function prepareLand(env, state) {
  const { T, map } = env;
  const grid = map.grid;
  const own = owners(env, state);
  const cells = [];
  for (const c of T.landCells) if (own[c]) cells.push(c);
  // Border edges: between an owned cell and a cell with another (or no) owner.
  const edges = []; // [x0, y0, x1, y1, ...]
  for (const c of cells) {
    for (let d = 0; d < 6; d++) {
      const n = grid.neighbour(c, d);
      if (n >= 0 && own[n] === own[c]) continue;
      // Edge d runs from corner d to corner d+1 (hex.js), but corners are indexed from -30°; edge to dir d.
      const a = grid.corners[(d + 0) % 6], b = grid.corners[(d + 1) % 6];
      const x = grid.cx(c), y = grid.cy(c);
      edges.push(x + a[0], y + a[1], x + b[0], y + b[1], n >= 0 && own[n] ? 1 : 0);
    }
  }
  return { cells, edges, own };
}

export function landLayer(model) {
  return {
    id: "land", z: 62, snapshot: true,
    sig: () => `l${model.ver}`,
    visible: () => !!model.state && model.state.phase !== "setup",
    draw(ctx, vp, w, o) {
      const { env, state } = model;
      const geo = model.land;
      if (!state || !geo) return;
      const { grid } = w;
      const R = grid.R, s = o.s;
      const m = R * 2;
      // Territory tint.
      ctx.beginPath();
      for (const c of geo.cells) if (inVp(vp, grid.cx(c), grid.cy(c), m)) hexPath(ctx, grid, c, (R + 0.6 / s) / R);
      ctx.fillStyle = css(COLORS.land, 0.17);
      ctx.fill();
      // Border: a dark under-line then the bright line; inner edges between two of your towns are thin.
      const outer = new Path2D(), inner = new Path2D();
      const e = geo.edges;
      for (let k = 0; k < e.length; k += 5) {
        if (!inVp(vp, e[k], e[k + 1], m)) continue;
        const p = e[k + 4] ? inner : outer;
        p.moveTo(e[k], e[k + 1]);
        p.lineTo(e[k + 2], e[k + 3]);
      }
      ctx.lineCap = "round";
      ctx.strokeStyle = COLORS.borderDark;
      ctx.lineWidth = Math.max(2.6, o.Rpx * 0.16) / s;
      ctx.stroke(outer);
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = Math.max(1.3, o.Rpx * 0.08) / s;
      ctx.stroke(outer);
      ctx.setLineDash([3 / s, 3 / s]);
      ctx.strokeStyle = "rgba(143,243,236,.5)";
      ctx.lineWidth = 1 / s;
      ctx.stroke(inner);
      ctx.setLineDash([]);
      // Links.
      for (const l of state.links) drawLink(ctx, grid, l, o);
      // Improvements.
      if (o.Rpx >= 6) {
        for (const [cellS, kind] of Object.entries(state.improvements)) {
          const c = +cellS;
          const x = grid.cx(c), y = grid.cy(c);
          if (!inVp(vp, x, y, m)) continue;
          drawImprovement(ctx, kind, x + 0.28 * R, y + 0.3 * R, R * 0.42, s);
        }
      }
      void env;
    },
  };
}

function drawLink(ctx, grid, l, o) {
  const s = o.s;
  ctx.beginPath();
  l.path.forEach((c, k) => (k ? ctx.lineTo(grid.cx(c), grid.cy(c)) : ctx.moveTo(grid.cx(c), grid.cy(c))));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const wpx = Math.max(1.6, Math.min(5, o.Rpx * 0.12));
  if (l.kind === "rail") {
    ctx.strokeStyle = "#2b2622";
    ctx.lineWidth = (wpx * 2.2) / s;
    ctx.setLineDash([wpx * 0.5 / s, wpx * 1.1 / s]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = (wpx * 0.9) / s;
    ctx.strokeStyle = "#4a4038";
    ctx.stroke();
    ctx.lineWidth = (wpx * 0.35) / s;
    ctx.strokeStyle = "#c9c0b0";
    ctx.stroke();
  } else {
    ctx.strokeStyle = "rgba(60,40,18,.65)";
    ctx.lineWidth = (wpx * 1.6) / s;
    ctx.stroke();
    ctx.strokeStyle = "#c79a5a";
    ctx.lineWidth = wpx / s;
    ctx.stroke();
  }
}

/** Improvement glyph centred at (x, y), about `size` km across (world transform). */
export function drawImprovement(ctx, kind, x, y, size, s) {
  const u = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = 0.8 / s;
  ctx.strokeStyle = "rgba(20,12,4,.8)";
  // round plaque
  ctx.beginPath();
  ctx.arc(0, 0, u * 1.05, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,24,20,.55)";
  ctx.fill();
  switch (kind) {
    case "farmstead":
      ctx.fillStyle = "#d8b84a";
      ctx.fillRect(-u * 0.8, u * 0.15, u * 1.6, u * 0.45);
      ctx.fillStyle = "#b03a2e";
      ctx.fillRect(-u * 0.45, -u * 0.35, u * 0.9, u * 0.5);
      ctx.beginPath();
      ctx.moveTo(-u * 0.55, -u * 0.35); ctx.lineTo(0, -u * 0.8); ctx.lineTo(u * 0.55, -u * 0.35); ctx.closePath();
      ctx.fillStyle = "#6e2219";
      ctx.fill();
      break;
    case "mine":
      ctx.beginPath();
      ctx.moveTo(-u * 0.8, u * 0.55); ctx.lineTo(0, -u * 0.55); ctx.lineTo(u * 0.8, u * 0.55); ctx.closePath();
      ctx.fillStyle = "#5a4a3a";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, u * 0.3, u * 0.28, Math.PI, 0);
      ctx.fillStyle = "#151010";
      ctx.fill();
      ctx.strokeStyle = "#e0c08a";
      ctx.lineWidth = Math.max(0.8 / s, u * 0.12);
      ctx.beginPath();
      ctx.moveTo(-u * 0.5, -u * 0.6); ctx.lineTo(u * 0.5, u * 0.1);
      ctx.stroke();
      break;
    case "quarry":
      ctx.fillStyle = "#a9a39a";
      ctx.fillRect(-u * 0.75, 0, u * 0.7, u * 0.5);
      ctx.fillRect(-u * 0.1, -u * 0.35, u * 0.8, u * 0.85);
      ctx.fillStyle = "#7d776f";
      ctx.fillRect(-u * 0.1, -u * 0.35, u * 0.8, u * 0.2);
      break;
    case "dock":
      ctx.fillStyle = "#3d7fb0";
      ctx.fillRect(-u * 0.85, u * 0.1, u * 1.7, u * 0.55);
      ctx.fillStyle = "#8a6438";
      ctx.fillRect(-u * 0.7, -u * 0.05, u * 1.1, u * 0.25);
      ctx.beginPath();
      ctx.moveTo(u * 0.2, -u * 0.15); ctx.lineTo(u * 0.2, -u * 0.8); ctx.lineTo(u * 0.65, -u * 0.2); ctx.closePath();
      ctx.fillStyle = "#efe6d0";
      ctx.fill();
      break;
  }
  ctx.restore();
}

// --- yields pips ---------------------------------------------------------------------------------------------------

export function yieldsLayer(model) {
  return {
    id: "yields", z: 64, minRpx: 13, snapshot: false,
    visible: () => model.showYields && !!model.state && model.state.phase !== "over",
    sig: () => `y${model.ver}`,
    draw(ctx, vp, w, o) {
      const { env, state } = model;
      const { T } = env;
      const { grid } = w;
      const R = grid.R, s = o.s;
      const r = Math.max(2.6, Math.min(4.5, o.Rpx * 0.11)) / s;
      const gap = r * 2.4;
      const cols = [COLORS.food, COLORS.materials, COLORS.trade];
      for (const c of o.cells) {
        if (!T.land[c]) continue;
        if (townAt(state, c)) continue;
        const y = hexYield(T, c, state.improvements[c] || null, false);
        const v = [y.food, y.materials, y.trade];
        const n = v[0] + v[1] + v[2];
        if (!n) continue;
        const x0 = grid.cx(c), y0 = grid.cy(c) - 0.52 * R;
        // Rows: one per yield, centred, up to 5 pips each.
        let row = 0;
        for (let k = 0; k < 3; k++) {
          const cnt = Math.min(5, v[k]);
          if (!cnt) continue;
          const yy = y0 + row * gap * 0.9;
          for (let q = 0; q < cnt; q++) {
            const xx = x0 + (q - (cnt - 1) / 2) * gap;
            ctx.beginPath();
            ctx.arc(xx, yy, r, 0, Math.PI * 2);
            ctx.fillStyle = cols[k];
            ctx.fill();
            ctx.lineWidth = 0.7 / s;
            ctx.strokeStyle = "rgba(0,0,0,.6)";
            ctx.stroke();
          }
          row++;
        }
      }
    },
  };
}

// --- towns and parties ---------------------------------------------------------------------------------------------

export function townsLayer(model) {
  return {
    id: "towns", z: 66, snapshot: true,
    sig: () => `t${model.ver}`,
    visible: () => !!model.state,
    draw(ctx, vp, w, o) {
      const { state } = model;
      const { grid } = w;
      const R = grid.R, s = o.s;
      const m = 3 * R;
      for (const t of state.towns) {
        const x = grid.cx(t.cell), y = grid.cy(t.cell);
        if (!inVp(vp, x, y, m)) continue;
        drawTown(ctx, x, y, R, t.pop, s, o.Rpx, t.cell);
      }
      for (const p of state.parties) {
        const x = grid.cx(p.cell), y = grid.cy(p.cell);
        if (!inVp(vp, x, y, m)) continue;
        drawParty(ctx, x + (townAt(state, p.cell) ? 0.45 * R : 0), y, R, s, o.Rpx);
      }
      // Labels in screen space.
      if (o.Rpx >= 4) {
        o.screen();
        ctx.textBaseline = "middle";
        const fs = o.Rpx < 8 ? 10 : 11.5;
        ctx.font = `600 ${fs}px "Palatino Linotype", Palatino, Georgia, serif`;
        for (const t of state.towns) {
          const wx = grid.cx(t.cell), wy = grid.cy(t.cell);
          if (!inVp(vp, wx, wy, m)) continue;
          const [sx, sy0] = o.toScreen(wx, wy);
          const sy = sy0 + Math.max(10, R * s * 0.62) + 8;
          const label = t.name;
          const tw = ctx.measureText(label).width;
          const pw = fs + 6;
          const W = tw + pw + 14, H = fs + 7;
          const x0 = sx - W / 2, y0 = sy - H / 2;
          ctx.fillStyle = "rgba(8,22,24,.86)";
          roundRect(ctx, x0, y0, W, H, 4);
          ctx.fill();
          ctx.strokeStyle = COLORS.border;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = COLORS.flag;
          roundRect(ctx, x0 + 2, y0 + 2, pw, H - 4, 3);
          ctx.fill();
          ctx.fillStyle = "#04201e";
          ctx.textAlign = "center";
          ctx.fillText(String(t.pop), x0 + 2 + pw / 2, sy + 0.5);
          ctx.fillStyle = "#f3ecd6";
          ctx.textAlign = "left";
          ctx.fillText(label, x0 + pw + 8, sy + 0.5);
        }
        o.world();
      }
    },
    hit(x, y) {
      const c = model.grid.cellAt(x, y);
      if (c < 0 || !model.env.T.land[c]) return null;
      return { cell: c };
    },
    tooltip: (item) => hexTooltip(model, item.cell),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const HOUSES = [[0.28, 0.12], [-0.3, 0.16], [0.05, 0.36], [-0.12, -0.3], [0.36, -0.22], [-0.42, -0.1], [0.3, 0.42], [-0.32, 0.44], [0.48, 0.08]];
export function drawTown(ctx, x, y, R, pop, s, Rpx, seed = 0) {
  if (Rpx < 5) {
    const r = Math.max(3.2 / s, R * (0.32 + Math.min(0.3, pop * 0.02)));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.wall;
    ctx.fill();
    ctx.lineWidth = 2 / s;
    ctx.strokeStyle = COLORS.flag;
    ctx.stroke();
    return;
  }
  // ground
  ctx.beginPath();
  ctx.ellipse(x, y + 0.06 * R, 0.74 * R, 0.62 * R, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(196,170,120,.85)";
  ctx.fill();
  ctx.lineWidth = Math.max(1.4 / s, 0.04 * R);
  ctx.strokeStyle = COLORS.flag;
  ctx.stroke();
  const n = Math.min(HOUSES.length, 1 + Math.floor(pop / 2));
  const hw = 0.21 * R, hh = 0.15 * R;
  const list = HOUSES.slice(0, n).map(([dx, dy], k) => [x + dx * R, y + dy * R, 0.85 + hash01(seed, k) * 0.3]).sort((a, b) => a[1] - b[1]);
  for (const [hx, hy, k] of list) house(ctx, hx, hy, hw * k, hh * k, s);
  // hall + flag
  house(ctx, x, y - 0.02 * R, 0.32 * R, 0.21 * R, s, "#8a5a2a");
  ctx.strokeStyle = "#2a1c10";
  ctx.lineWidth = Math.max(1 / s, 0.025 * R);
  ctx.beginPath();
  ctx.moveTo(x + 0.02 * R, y - 0.2 * R);
  ctx.lineTo(x + 0.02 * R, y - 0.62 * R);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 0.02 * R, y - 0.62 * R);
  ctx.lineTo(x + 0.3 * R, y - 0.54 * R);
  ctx.lineTo(x + 0.02 * R, y - 0.45 * R);
  ctx.closePath();
  ctx.fillStyle = COLORS.flag;
  ctx.fill();
}

function house(ctx, x, y, w, h, s, roof = COLORS.roof) {
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.fillRect(x - w / 2 + w * 0.12, y, w, h * 0.55);
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(x - w / 2, y - h * 0.5, w, h);
  ctx.beginPath();
  ctx.moveTo(x - w * 0.6, y - h * 0.45);
  ctx.lineTo(x, y - h * 1.2);
  ctx.lineTo(x + w * 0.6, y - h * 0.45);
  ctx.closePath();
  ctx.fillStyle = roof;
  ctx.fill();
  ctx.lineWidth = 0.6 / s;
  ctx.strokeStyle = "rgba(30,15,5,.7)";
  ctx.stroke();
}

export function drawParty(ctx, x, y, R, s, Rpx) {
  const u = Rpx < 6 ? Math.max(4 / s, 0.3 * R) : 0.3 * R;
  ctx.save();
  ctx.translate(x, y);
  // shadow
  ctx.beginPath();
  ctx.ellipse(0, u * 0.62, u * 1.0, u * 0.25, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fill();
  // wagon bed
  ctx.fillStyle = "#7a4e26";
  ctx.fillRect(-u * 0.8, u * 0.0, u * 1.6, u * 0.32);
  // canvas cover
  ctx.beginPath();
  ctx.moveTo(-u * 0.75, u * 0.02);
  ctx.bezierCurveTo(-u * 0.75, -u * 0.95, u * 0.75, -u * 0.95, u * 0.75, u * 0.02);
  ctx.closePath();
  ctx.fillStyle = "#f4ead2";
  ctx.fill();
  ctx.lineWidth = Math.max(0.8 / s, u * 0.06);
  ctx.strokeStyle = "#3a2410";
  ctx.stroke();
  // wheels
  for (const dx of [-0.48, 0.48]) {
    ctx.beginPath();
    ctx.arc(dx * u, u * 0.4, u * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = "#3a2410";
    ctx.fill();
  }
  // flag
  ctx.beginPath();
  ctx.moveTo(u * 0.1, -u * 0.6);
  ctx.lineTo(u * 0.1, -u * 1.25);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(u * 0.1, -u * 1.25);
  ctx.lineTo(u * 0.65, -u * 1.08);
  ctx.lineTo(u * 0.1, -u * 0.9);
  ctx.closePath();
  ctx.fillStyle = COLORS.flag;
  ctx.fill();
  ctx.restore();
}

// --- tooltip -------------------------------------------------------------------------------------------------------

const fmtPart = (p) => {
  const bits = [];
  if (p.food) bits.push(`<span class="fd-food">+${p.food} food</span>`);
  if (p.materials) bits.push(`<span class="fd-mat">+${p.materials} materials</span>`);
  if (p.trade) bits.push(`<span class="fd-trade">+${p.trade} trade</span>`);
  if (p.note) bits.push(`<span class="muted">${esc(p.note)}</span>`);
  return `${esc(p.label)} → ${bits.join(", ") || '<span class="muted">nothing</span>'}`;
};

export function hexTooltip(model, cell) {
  const { env, state } = model;
  const { T } = env;
  const e = explainHex(T, cell);
  const lines = [];
  const town = state ? townAt(state, cell) : null;
  if (town) {
    const o = townOutput(env, state, town);
    lines.push(`<b>${esc(town.name)}</b> <span class="muted">· population ${town.pop}</span>`);
    lines.push(`<span class="fd-food">Food ${o.food}</span> (eats ${o.eat}) · <span class="fd-mat">Materials ${o.materials}</span> · <span class="fd-trade">Trade ${o.trade}</span>`);
    lines.push(`<span class="muted">Click to manage the town</span>`);
    return lines.join("<br>");
  }
  const cv = T.coverTable.find((c) => c.id === T.cover[cell]);
  // Urban cover would give real cities away: name the open land under it instead.
  const coverName = !cv || cv.id === 9 ? "Open land" : cv.name;
  lines.push(`<b>${esc(coverName)}</b> <span class="muted">· ${RELIEF_NAME[T.relief[cell]]} · ${T.elev[cell]} m</span>`);
  const own = state && state.phase !== "setup" ? owners(env, state)[cell] : 0;
  if (own) lines.push(`<span class="muted">Inside ${esc(state.towns.find((t) => t.id === own)?.name || "your")}'s border</span>`);
  for (const p of e.parts) lines.push(fmtPart(p));
  const imp = state?.improvements?.[cell];
  if (imp) {
    const I = IMPROVEMENTS[imp];
    lines.push(fmtPart({ label: I.name, food: I.food, materials: I.materials, trade: I.trade }));
  }
  const y = hexYield(T, cell, imp || null);
  lines.push(`<b>= <span class="fd-food">Food ${y.food}</span> · <span class="fd-mat">Materials ${y.materials}</span> · <span class="fd-trade">Trade ${y.trade}</span></b>`);
  if (state?.phase === "play" && model.selParty) {
    const why = foundBlocker(env, state, cell);
    lines.push(why ? `<span class="fd-warn">${esc(why)}</span>` : `<span class="muted">Click to move the party here</span>`);
  }
  return lines.join("<br>");
}

// --- overlay -------------------------------------------------------------------------------------------------------

export function makeOverlay(model) {
  return {
    id: "sel", z: 20, space: "world",
    draw(ctx, cam) {
      const { env, state } = model;
      if (!state) return;
      const grid = model.grid;
      const s = cam.scale, R = grid.R;
      const ring = (c, color, f = 0.92, lw = 2.4) => {
        ctx.beginPath();
        hexPath(ctx, grid, c, f);
        ctx.lineWidth = (lw + 2) / s;
        ctx.strokeStyle = "rgba(0,0,0,.6)";
        ctx.stroke();
        ctx.lineWidth = lw / s;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      if (state.phase === "setup") {
        state.starts.forEach((st, k) => {
          const x = grid.cx(st.cell), y = grid.cy(st.cell);
          ring(st.cell, "#ffe08a", 1.0, 3);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(7 / s, 0.42 * R), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(20,14,4,.85)";
          ctx.fill();
          ctx.fillStyle = "#ffe08a";
          ctx.font = `700 ${Math.max(10 / s, 0.5 * R)}px Georgia, serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(k + 1), x, y + 0.5 / s);
        });
        if (model.selCell != null) ring(model.selCell, "#ffffff");
        return;
      }
      // Selected town: worked hexes.
      const town = model.selTown != null ? state.towns.find((t) => t.id === model.selTown) : null;
      if (town) {
        const o = townOutput(env, state, town);
        const pins = new Set(town.pins || []);
        for (const c of o.worked) {
          ctx.beginPath();
          ctx.arc(grid.cx(c), grid.cy(c) + 0.55 * R, Math.max(2.5 / s, 0.08 * R), 0, Math.PI * 2);
          ctx.fillStyle = pins.has(c) ? "#ffe08a" : "#ffffff";
          ctx.fill();
          ctx.lineWidth = 1 / s;
          ctx.strokeStyle = "rgba(0,0,0,.7)";
          ctx.stroke();
        }
        ring(town.cell, "#ffe08a", 1.0, 3);
      }
      const party = model.selParty != null ? state.parties.find((p) => p.id === model.selParty) : null;
      if (party) {
        // "Too close" zone around towns.
        ctx.beginPath();
        for (const t of state.towns) for (const c of env.map.within(t.cell, RULES.minTownDist - 1)) if (env.T.land[c]) hexPath(ctx, grid, c, 0.98);
        ctx.fillStyle = "rgba(200,50,40,.32)";
        ctx.fill();
        ring(party.cell, "#ffe08a", 1.0, 3);
        const tgt = model.hoverCell != null && model.hoverCell !== party.cell ? model.hoverCell : party.target;
        if (tgt != null && env.T.land[tgt]) {
          const r = landPath(env, party.cell, tgt);
          if (r) drawPathPreview(ctx, env, grid, party, r.path, s);
        }
      }
      if (model.selCell != null && !town) ring(model.selCell, "#ffffff");
    },
  };
}

function drawPathPreview(ctx, env, grid, party, path, s) {
  let moves = party.moves, turn = 0;
  const steps = [];
  for (let k = 1; k < path.length; k++) {
    const c = moveCost(env.T, path[k]);
    if (c > moves && moves < RULES.partyMoves) { turn++; moves = RULES.partyMoves; }
    moves = Math.max(0, moves - c);
    steps.push(turn);
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    ctx.beginPath();
    ctx.moveTo(grid.cx(a), grid.cy(a));
    ctx.lineTo(grid.cx(b), grid.cy(b));
    ctx.setLineDash(steps[k - 1] === 0 ? [] : [5 / s, 5 / s]);
    ctx.lineWidth = 5 / s;
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.stroke();
    ctx.lineWidth = 2.6 / s;
    ctx.strokeStyle = steps[k - 1] === 0 ? "#ffe08a" : "rgba(255,224,138,.75)";
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const end = path[path.length - 1];
  const turns = steps.length ? steps[steps.length - 1] : 0; // end turns before it arrives (0 = this turn)
  const x = grid.cx(end), y = grid.cy(end);
  ctx.beginPath();
  ctx.arc(x, y, 9 / s, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,14,4,.9)";
  ctx.fill();
  ctx.fillStyle = "#ffe08a";
  ctx.font = `700 ${11 / s}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(turns ? String(turns) : "✓", x, y + 0.5 / s);
}

export { baseYields };
