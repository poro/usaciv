// The end-screen share image: the map framed on your network (render/snapshot.js renderToCanvas, with the app's
// static layers, which include Mainline's own links and region shading) under a title strip with the scenario, the
// score against baseline America and the site URL. → Promise<Blob | null> (PNG)
import { renderToCanvas } from "../../render/snapshot.js";
import * as S from "./sim/index.js";

export const SHARE_URL = "usaciv.mark-ollila.workers.dev";
const W = 1200, H = 675, STRIP = 104, DPR = 1.5; // 1800×1013 px, a few MB at most

export async function shareImage(ctx, game, m) {
  const app = ctx.app;
  const { env, state, sum } = m;
  const g = ctx.hexmap.grid;

  // frame: every built link (or the region, for an empty network), padded
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (c) => {
    const x = g.cx(c), y = g.cy(c);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  for (const l of Object.values(state.links)) { grow(l.a); grow(l.b); }
  if (!(x1 > x0) && env.ext) ({ x0, y0, x1, y1 } = env.ext);
  if (!(x1 >= x0)) return null;
  const pad = Math.max(80, 0.12 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const mapH = H - STRIP;
  const scale = Math.min(W / (x1 - x0), mapH / (y1 - y0));

  // the map, off-screen
  const map = document.createElement("canvas");
  map.width = W * DPR;
  map.height = mapH * DPR;
  const mc = map.getContext("2d");
  mc.fillStyle = "#0b1a2a";
  mc.fillRect(0, 0, map.width, map.height);
  const shot = { ...app.state, hoverCell: -1, selectedCity: null, selectedState: null, highlight: null };
  renderToCanvas(map, app.cam, app.w, shot, app.data.nation, {
    banners: true, overlay: false, dpr: DPR, scale, x: (x0 + x1) / 2, y: (y0 + y1) / 2, app,
    staticLayers: app.staticLayers().filter((l) => l.snapshot !== false),
  });

  // compose
  const out = document.createElement("canvas");
  out.width = W * DPR;
  out.height = H * DPR;
  const c = out.getContext("2d");
  c.drawImage(map, 0, STRIP * DPR);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = c.createLinearGradient(0, 0, 0, STRIP);
  grad.addColorStop(0, "#1b1308");
  grad.addColorStop(1, "#120d07");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, STRIP);
  c.fillStyle = "#c9a45c";
  c.fillRect(0, STRIP - 2, W, 2);

  const serif = "Georgia, 'Times New Roman', serif", sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  const scn = `${env.scenario.name}${env.scenario.id === "sandbox" ? ` from ${env.home?.name || ""}` : ""}`;
  c.textBaseline = "alphabetic";
  c.fillStyle = "#e8c46a";
  c.font = `600 15px ${sans}`;
  c.fillText(`MAINLINE · ${scn.toUpperCase()} · 2026–2050`, 28, 32);
  const pctS = (x, d) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
  c.font = `700 34px ${serif}`;
  c.fillStyle = sum.beat ? "#c8f5d2" : "#ffd0c8";
  const head = `${pctS(sum.uplift, 2)} GDP vs baseline America`;
  c.fillText(head, 28, 74);
  const hw = c.measureText(head).width;
  c.font = `500 16px ${sans}`;
  c.fillStyle = "#d9cdb4";
  c.fillText(`goal ${pctS(sum.goal, 1)} · ${sum.beat ? "beat it" : "missed it"} · score ${sum.score}`, 28 + hw + 16, 72);
  c.font = `400 13px ${sans}`;
  c.fillStyle = "#a99c84";
  const links = Object.keys(state.links).length;
  c.fillText(`${links} links · ${state.totals.revenue.toFixed(0)} cr freight · ${Math.round(sum.resilience * 100)}% resilience · seed ${state.seed}`, 28, 94);
  c.textAlign = "right";
  c.font = `600 15px ${sans}`;
  c.fillStyle = "#e8c46a";
  c.fillText(SHARE_URL, W - 28, 32);
  c.font = `400 12px ${sans}`;
  c.fillStyle = "#a99c84";
  c.fillText("Real FAF freight, metro trends and FEMA records", W - 28, 94);
  c.textAlign = "left";

  // a small legend chip bottom-left on the map
  c.fillStyle = "rgba(14,18,24,.78)";
  c.fillRect(16, H - 40, 236, 26);
  c.lineCap = "round";
  c.strokeStyle = "#f08a2c";
  c.lineWidth = 4;
  c.beginPath(); c.moveTo(26, H - 27); c.lineTo(50, H - 27); c.stroke();
  c.fillStyle = "#fff6dc";
  c.font = `500 12px ${sans}`;
  c.fillText(`Your network, ${S.END_YEAR}`, 58, H - 23);

  return new Promise((res) => out.toBlob((b) => res(b), "image/png"));
}
