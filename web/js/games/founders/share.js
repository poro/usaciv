// Founders: the end-screen share image. Two maps side by side, framed on your country (render/snapshot.js
// renderToCanvas with the app's static layers, as Mainline's share.js does):
//   left   your America: the real cities still covered (the "cover" layer), your borders, roads, rail and towns
//   right  the real country today: real city banners with your borders laid over it
// under a title strip with the verdict, the score, the headline comparison with history, the seed and the site URL.
//
//   shareImage(ctx, model, sum) → Promise<Blob | null> (PNG)
//     sum = {head, rank, score, towns, pop, nearCount, top, popInside, popShare, endYear} (index.js builds it from the end
//     screen, so the image and the panel always agree)
import { renderToCanvas } from "../../render/snapshot.js";
import { popShort } from "../../format.js";
import { COLORS } from "./render.js";

export const SHARE_URL = "usaciv.mark-ollila.workers.dev";
const W = 1200, H = 675, STRIP = 104, GAP = 4, DPR = 1.5; // 1800×1013 px

export async function shareImage(ctx, model, sum) {
  const app = ctx.app;
  const { state } = model;
  const g = model.grid;
  if (!state?.towns.length) return null;

  // Frame: every hex you hold (and every town), padded.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (c) => {
    const x = g.cx(c), y = g.cy(c);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  for (const c of model.land?.cells || []) grow(c);
  for (const t of state.towns) grow(t.cell);
  const pad = Math.max(4 * g.R, 0.1 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const pw = (W - GAP) / 2, ph = H - STRIP;
  const scale = Math.min(pw / (x1 - x0), ph / (y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  const layers = app.staticLayers().filter((l) => l.snapshot !== false);
  const panel = (real) => {
    const cv = document.createElement("canvas");
    cv.width = Math.round(pw * DPR);
    cv.height = Math.round(ph * DPR);
    const mc = cv.getContext("2d");
    mc.fillStyle = "#0b1a2a";
    mc.fillRect(0, 0, cv.width, cv.height);
    const shot = {
      ...app.state, hoverCell: -1, selectedCity: null, selectedState: null, highlight: null, showResources: false,
      hideCities: !real,
    };
    // The cover layer shows only while the country is hidden (model.revealed false). Flip it for the left panel
    // just for this synchronous draw; the live map's cache never sees the change.
    const was = model.revealed;
    model.revealed = real;
    try {
      renderToCanvas(cv, app.cam, app.w, shot, app.data.nation, {
        banners: real, overlay: false, dpr: DPR, scale, x: cx, y: cy, app,
        // Right panel: your borders and links over the real map, without your town art, so the real names read.
        staticLayers: real ? layers.filter((l) => !/:(towns|yields)$/.test(l.id || "")) : layers.filter((l) => !/:yields$/.test(l.id || "")),
      });
    } finally {
      model.revealed = was;
    }
    return cv;
  };
  const left = panel(false), right = panel(true);

  // Compose.
  const out = document.createElement("canvas");
  out.width = W * DPR;
  out.height = H * DPR;
  const c = out.getContext("2d");
  c.fillStyle = "#120d07";
  c.fillRect(0, 0, out.width, out.height);
  c.drawImage(left, 0, STRIP * DPR);
  c.drawImage(right, Math.round((pw + GAP) * DPR), STRIP * DPR);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = c.createLinearGradient(0, 0, 0, STRIP);
  grad.addColorStop(0, "#0d1f20");
  grad.addColorStop(1, "#081414");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, STRIP);
  c.fillStyle = COLORS.flag;
  c.fillRect(0, STRIP - 2, W, 2);

  const serif = "Georgia, 'Times New Roman', serif", sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  c.textBaseline = "alphabetic";
  c.fillStyle = "#e8c46a";
  c.font = `600 15px ${sans}`;
  c.fillText(`FOUNDERS · YOU VS. HISTORY · 1790–${sum.endYear}`, 28, 32);
  c.font = `700 34px ${serif}`;
  c.fillStyle = "#dffffb";
  c.fillText(sum.head, 28, 74);
  const hw = c.measureText(sum.head).width;
  c.font = `500 16px ${sans}`;
  c.fillStyle = "#d9cdb4";
  c.fillText(`score ${Math.round(sum.score).toLocaleString("en-US")} · ${sum.rank}`, 28 + hw + 16, 72);
  c.font = `400 13px ${sans}`;
  c.fillStyle = "#a9b8b4";
  const pctS = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  c.fillText(`${sum.nearCount}/${sum.towns} towns on real top-${sum.top} metro sites · ${popShort(sum.popInside)} real Americans live inside these borders today (${pctS(sum.popShare)}) · ${sum.pop} people · seed ${state.seed}`, 28, 94);
  c.textAlign = "right";
  c.font = `600 15px ${sans}`;
  c.fillStyle = "#e8c46a";
  c.fillText(SHARE_URL, W - 28, 32);
  c.textAlign = "left";

  // Panel chips.
  const chip = (x, text, swatch) => {
    c.font = `500 12px ${sans}`;
    const tw = c.measureText(text).width;
    c.fillStyle = "rgba(10,16,20,.8)";
    c.fillRect(x, H - 40, tw + 44, 26);
    c.lineCap = "round";
    c.strokeStyle = swatch;
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(x + 10, H - 27); c.lineTo(x + 30, H - 27); c.stroke();
    c.fillStyle = "#fff6dc";
    c.fillText(text, x + 36, H - 23);
  };
  chip(16, `Your America, ${sum.endYear}`, COLORS.border);
  chip(pw + GAP + 16, "The real country today, under your borders", COLORS.border);
  c.textAlign = "right";
  c.font = `400 11px ${sans}`;
  c.fillStyle = "rgba(10,16,20,.7)";
  const credit = "usaciv · real terrain, ACS county population, BEA metro GDP";
  c.fillRect(W - 20 - c.measureText(credit).width, STRIP + 8, c.measureText(credit).width + 12, 18);
  c.fillStyle = "rgba(255,246,220,.8)";
  c.fillText(credit, W - 14, STRIP + 21);
  c.textAlign = "left";

  return new Promise((res) => out.toBlob((b) => res(b), "image/png"));
}
