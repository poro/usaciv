// Dock HTML for Mainline versus (sim/versus.js): the picker section, the online lobby, the standings strip, last
// year's contract news and the end screen. Pure string builders; index.js wires the clicks (data-act).
//
// m.vs = {mode: "ai"|"online", vs (the versus game, or null in the lobby), me (seat index), room (online room or
//         null), code, ready (my ready flag), waiting (names not ready yet), deadline (ms or null), now (ms),
//         status ("connecting"|"lobby"|"live"|"done"|"closed"), error, player ({id, name} or null), nick}
import { esc } from "../../format.js";
import * as S from "./sim/index.js";

const signed = (x, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const dot = (p) => `<i class="ml-vs-dot" style="--c:${S.VS_COLORS[p] || "#999"}"></i>`;

export const VS_HOW = `<ul class="ml-how">
  <li>Up to four rail companies share one map. Everyone starts at the scenario's home metro with the same money.</li>
  <li><b>A contract pays only the company that holds it.</b> The first to join both ends takes it; if two do it in the
  same year, the shorter route wins.</li>
  <li>Keep serving it to keep it: if a storm cuts your line and a rival serves the contract before you repair, it is
  theirs.</li>
  <li>Everyone plays the year at once. It ends when all companies are ready (online: or 90 s after the first is).</li>
  <li>The highest GDP uplift over baseline America at the end wins.</li>
</ul>`;

/** The picker's versus section. online = the site has the backend; player = net.player() or null. */
export function vsPickerHtml({ online, player, defaults = {} }) {
  const bots = defaults.bots ?? 1, years = defaults.years ?? 10;
  const sel = (name, vals, cur, label) => `<select data-field="${name}">${vals.map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${label(v)}</option>`).join("")}</select>`;
  return `<div class="ml-vs-pick">
    <div class="g-section">Versus <span class="g-note">rival companies bid for the same contracts</span></div>
    <div class="g-row ml-vs-opts">
      <label>Length ${sel("vsYears", S.VS_YEARS, years, (v) => (v === 25 ? "2026–2050" : `${v} years`))}</label>
      <label>AI rivals ${sel("vsBots", [0, 1, 2, 3], bots, (v) => String(v))}</label>
    </div>
    <div class="g-row">
      <button class="g-btn" data-act="vsAi" type="button" title="You against the AI companies, on this device">Play vs AI</button>
      ${online ? `<button class="g-btn" data-act="vsCreate" type="button" title="A room friends join by link; AI rivals fill the seats you choose">Online room…</button>` : ""}
    </div>
    ${online && !player ? `<label class="ml-vs-nick">Nickname for online play <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label>` : ""}
    <details class="ml-help"><summary>Versus rules</summary>${VS_HOW}</details>
  </div>`;
}

/** Online room before the start. */
export function vsLobbyHtml(m) {
  const v = m.vs, r = v.room;
  const link = `${globalThis.location ? location.origin + location.pathname : ""}#play=mainline~vs-${v.code}`;
  if (!r) {
    return `<div class="ml-vs-lobby"><p class="muted">${v.error ? esc(v.error) : "Connecting to the room…"}</p>
      ${v.error ? `<div class="g-row"><button class="g-btn" data-act="vsLeave">Back</button></div>` : ""}</div>`;
  }
  const sc = S.scenarioById(r.scenario);
  const host = r.host === v.player?.id;
  const people = r.players.filter((p) => !p.bot);
  const seats = S.VS_MAX - r.bots;
  const rows = people.map((p) => `<li>${p.online ? "🟢" : "⚪"} ${esc(p.name)}${p.id === r.host ? ` <span class="g-note">host</span>` : ""}${p.id === v.player?.id ? ` <span class="g-note">you</span>` : ""}</li>`).join("")
    + Array.from({ length: r.bots }, (_, k) => `<li>🤖 ${esc(S.BOT_NAMES[k] || "AI")}</li>`).join("");
  const can = people.length + r.bots >= 2;
  return `<div class="ml-vs-lobby">
    <div class="ml-verdict">Versus room <b class="ml-vs-code">${esc(v.code)}</b></div>
    <p>${esc(sc?.name || r.scenario)}${r.home ? ` from ${esc(m.cityName(r.home))}` : ""} · ${r.years === 25 ? "2026–2050" : `${r.years} years, 2026–${2025 + r.years}`}</p>
    <div class="g-row"><input class="ml-vs-link" readonly value="${esc(link)}" aria-label="Room link"><button class="g-btn" data-act="vsCopy" data-link="${esc(link)}">Copy link</button></div>
    <p class="g-note">Send the link to up to ${seats - 1} friend${seats - 1 === 1 ? "" : "s"}. Joining closes when the host starts.</p>
    <ul class="ml-vs-people">${rows}</ul>
    <div class="g-row">
      ${host ? `<button class="g-btn primary" data-act="vsStart" ${can ? "" : "disabled"} title="${can ? "Start the game" : "Needs at least two companies (people or AI)"}">Start</button>` : `<span class="muted">Waiting for the host to start…</span>`}
      <button class="g-btn" data-act="vsLeave">Leave</button>
    </div>
    ${v.error ? `<p class="ml-bad">${esc(v.error)}</p>` : ""}
    <details class="ml-help"><summary>Versus rules</summary>${VS_HOW}</details>
  </div>`;
}

/** Standings strip in the game panel. */
export function vsStandingsHtml(m) {
  const v = m.vs, vs = v.vs;
  const rows = S.standings(m.env, vs);
  const roomP = v.room?.players || [];
  const body = rows.map((r) => {
    const rp = roomP[r.p];
    const mark = v.mode === "online" && !r.bot ? (rp?.ready ? `<span title="Ready">✓</span>` : rp && !rp.online ? `<span class="muted" title="Offline">⚪</span>` : `<span class="muted" title="Still playing">…</span>`) : "";
    return `<tr class="${r.p === v.me ? "me" : ""}"><td>${r.rank}</td><td>${dot(r.p)}${esc(r.name)}${r.p === v.me ? " <span class=\"g-note\">you</span>" : ""}</td>
      <td class="${r.uplift > 0 ? "ml-good" : ""}">${signed(r.uplift)}</td><td title="Contracts held">${r.held}</td><td>${mark}</td></tr>`;
  }).join("");
  return `<table class="ml-table ml-vs-table"><tr><th></th><th>Company</th><th>GDP</th><th title="Contracts held">Held</th><th></th></tr>${body}</table>`;
}

/** Last year's claim changes, the ones that touch you first. */
export function vsNewsHtml(m) {
  const v = m.vs, vs = v.vs;
  if (!vs.news.length) return "";
  const name = (p) => (p === v.me ? "You" : esc(vs.players[p]?.name || "?"));
  const items = [...vs.news].sort((a, b) => (b.to === v.me || b.from === v.me) - (a.to === v.me || a.from === v.me)).slice(0, 5).map((n) => {
    const c = m.env.contractById.get(n.id);
    const what = c ? `${esc(c.a.name)} ↔ ${esc(c.b.name)}` : esc(n.id);
    const verb = n.why === "lapsed" ? `took ${what} from ${n.from === v.me ? "you" : esc(vs.players[n.from]?.name || "?")}` : n.why === "contested" ? `won ${what} with the shortest route` : `took ${what}`;
    return `<li class="${n.to === v.me ? "ml-good" : n.from === v.me ? "ml-bad" : ""}">${dot(n.to)}${name(n.to)} ${verb}</li>`;
  }).join("");
  const more = vs.news.length > 5 ? `<li class="muted">and ${vs.news.length - 5} more</li>` : "";
  return `<div class="ml-vs-news"><div class="g-section">${vs.year - 1}: contracts changed hands</div><ul>${items}${more}</ul></div>`;
}

/** The End / Ready button for the actions row. */
export function vsReadyHtml(m) {
  const v = m.vs, y = v.vs.year;
  if (v.mode === "ai") return `<button class="g-btn primary" data-act="end" title="End the year for every company (E)">End ${y} <kbd>E</kbd></button>`;
  if (v.ready) {
    const left = v.deadline ? Math.max(0, Math.ceil((v.deadline - v.now) / 1000)) : null;
    const who = v.waiting.length ? `Waiting for ${v.waiting.map(esc).join(", ")}` : "Ending the year…";
    return `<button class="g-btn" data-act="unready" title="Keep playing this year">✓ Ready · ${who}${left != null ? ` (${left}s)` : ""}</button>`;
  }
  const hurry = v.deadline ? ` <span class="ml-bad">${Math.max(0, Math.ceil((v.deadline - v.now) / 1000))}s</span>` : "";
  return `<button class="g-btn primary" data-act="end" title="Ready: end ${y} when every company is (E)">Ready ${y}${hurry} <kbd>E</kbd></button>`;
}

/** End screen for a versus game. */
export function vsEndHtml(m) {
  const v = m.vs, vs = v.vs;
  const rows = S.standings(m.env, vs);
  const win = rows[0];
  const meRow = rows.find((r) => r.p === v.me);
  const verdict = win.p === v.me ? "Your company wins" : `${esc(win.name)} wins`;
  const W = 300, H = 80;
  const all = vs.hist.flat();
  const lo = Math.min(0, ...all), hi = Math.max(0.001, ...all);
  const line = (p) => vs.hist.map((row, k) => `${((k / Math.max(1, vs.hist.length - 1)) * W).toFixed(1)},${(H - ((row[p] - lo) / (hi - lo)) * H).toFixed(1)}`).join(" ");
  const lines = vs.players.map((_, p) => `<polyline points="${line(p)}" style="stroke:${S.VS_COLORS[p]}"${p === v.me ? ' class="me"' : ""}/>`).join("");
  const table = rows.map((r) => `<tr class="${r.p === v.me ? "me" : ""}"><td>${r.rank}</td><td>${dot(r.p)}${esc(r.name)}</td><td class="${r.uplift > 0 ? "ml-good" : ""}">${signed(r.uplift)}</td><td>${r.held}</td><td>${r.links}</td></tr>`).join("");
  const sc = m.env.scenario;
  return `<div class="ml-end">
    <div class="ml-verdict ${win.p === v.me ? "win" : "lose"}">${verdict}</div>
    <p>${esc(sc.name)}${sc.id === "sandbox" ? ` from ${esc(m.env.home?.name || "")}` : ""}, 2026–${vs.end} · ${vs.players.length} companies · seed ${vs.seed}</p>
    <div class="ml-top">
      <div class="g-stat"><b>${meRow.rank} of ${rows.length}</b><span>your place</span></div>
      <div class="g-stat"><b class="${meRow.uplift > 0 ? "ml-good" : ""}">${signed(meRow.uplift)}</b><span>your GDP uplift</span></div>
      <div class="g-stat"><b>${meRow.held}</b><span>contracts held</span></div>
    </div>
    <svg class="ml-spark ml-vs-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GDP uplift by year, one line per company">${lines}</svg>
    <div class="g-note">GDP uplift over baseline America each year, one line per company.</div>
    <table class="ml-table ml-vs-table"><tr><th></th><th>Company</th><th>GDP</th><th>Held</th><th>Links</th></tr>${table}</table>
    <div class="g-row ml-actions">
      ${v.mode === "ai" ? `<button class="g-btn primary" data-act="vsAgain">Play again</button>` : `<button class="g-btn primary" data-act="vsNewRoom">New room</button>`}
      <button class="g-btn" data-act="vsLeave">Choose scenario</button>
      <button class="g-btn" data-act="vsShare">Copy result</button>
    </div>
  </div>`;
}

export function vsShareText(m) {
  const v = m.vs, vs = v.vs;
  const rows = S.standings(m.env, vs);
  return [`Mainline versus: ${m.env.scenario.name}, 2026–${vs.end}`, ...rows.map((r) => `${r.rank}. ${r.name}${r.p === v.me ? " (me)" : ""}: ${signed(r.uplift)} GDP, ${r.held} contracts`)].join("\n");
}
