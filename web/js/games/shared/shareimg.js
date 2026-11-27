// Share images for the short games: the map framed on a box, with the game's own overlays drawn on it, under a title
// strip (render/snapshot.js renderToCanvas, as Mainline's and Founders' share images do).
//   const blob = await mapImage(app, { box: {x0, y0, x1, y1}, overlays: [myOverlay], kicker, title, sub });
//   downloadBlob(blob, "pinpoint-2026-11-27.png");
import { renderToCanvas } from "../../render/snapshot.js";

export const SHARE_URL = "usaciv.mark-ollila.workers.dev";
const W = 1200, H = 675, STRIP = 96, DPR = 1.5;

export async function mapImage(app, { box, overlays = [], kicker = "", title = "", sub = "", banners = false }) {
  const ph = H - STRIP;
  const scale = Math.min(W / (box.x1 - box.x0), ph / (box.y1 - box.y0));
  const map = document.createElement("canvas");
  map.width = W * DPR;
  map.height = Math.round(ph * DPR);
  const mc = map.getContext("2d");
  mc.fillStyle = "#0b1a2a";
  mc.fillRect(0, 0, map.width, map.height);
  const shot = { ...app.state, hoverCell: -1, selectedCity: null, selectedState: null, showResources: false, hideCities: !banners };
  renderToCanvas(map, app.cam, app.w, shot, app.data.nation, {
    banners, overlay: true, dpr: DPR, scale, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, app, overlays,
    staticLayers: [],
  });

  const out = document.createElement("canvas");
  out.width = W * DPR;
  out.height = H * DPR;
  const c = out.getContext("2d");
  c.drawImage(map, 0, STRIP * DPR);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = c.createLinearGradient(0, 0, 0, STRIP);
  grad.addColorStop(0, "#1b2a3a");
  grad.addColorStop(1, "#101b27");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, STRIP);
  c.fillStyle = "#c9a45c";
  c.fillRect(0, STRIP - 2, W, 2);
  const serif = "Georgia, 'Times New Roman', serif", sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  c.fillStyle = "#e8c46a";
  c.font = `600 14px ${sans}`;
  c.fillText(kicker.toUpperCase(), 28, 30);
  c.fillStyle = "#fff6dc";
  c.font = `700 32px ${serif}`;
  c.fillText(title, 28, 68);
  const tw = c.measureText(title).width;
  c.font = `500 16px ${sans}`;
  c.fillStyle = "#d9cdb4";
  c.fillText(sub, 28 + tw + 16, 66);
  c.font = `500 13px ${sans}`;
  c.fillStyle = "#a9b8c4";
  c.textAlign = "right";
  c.fillText(SHARE_URL, W - 24, 30);
  c.textAlign = "left";
  return new Promise((res) => out.toBlob((b) => res(b), "image/png"));
}

export function downloadBlob(blob, name) {
  if (!blob) return false;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
