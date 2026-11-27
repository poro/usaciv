// Dock HTML for Founders multiplayer (sim/match.js): the setup section, the online lobby, the hotseat hand-off,
// standings, last turn's news between nations, the Ready button and the end screen. Pure string builders;
// index.js wires the clicks (data-act).
//
// mp = {mode: "ai"|"hot"|"online", m (the match, or null in the lobby), me (seat), room, code, ready, waiting,
//       deadline, now, error, player, done (hotseat: seats finished this turn)}
import { esc, int } from "../../format.js";
import * as S from "./sim/index.js";

const dot = (p) => `<i class="fd-mp-dot" style="--c:${S.NATION_COLORS[p] || "#999"}"></i>`;

export const MP_HOW = `<ul class="fd-mp-how">
  <li>Two to four nations settle the same empty country at once. <b>Neighbours</b> (the default) starts every nation
  in one part of the country, 8–18 hexes apart, so borders meet early; <b>Whole country</b> gives each a region of
  its own.</li>
  <li><b>Land goes to the oldest town.</b> Where borders meet, the town founded first holds the hex; you cannot settle,
  work or improve a rival's land. Parties and roads may cross it.</li>
  <li>If two nations found towns within ${S.RULES.minTownDist} hexes of each other in the same turn, the nation with
  priority that turn keeps its town (it rotates every turn) and the other party waits on the spot.</li>
  <li>Everyone plays the turn together; it ends when every nation is ready (online: or 90 s after the first). The
  highest score at the end wins.</li>
</ul>`;

/** The setup panel's multiplayer section. */
export const MAP_LABEL = { near: "Neighbours", far: "Whole country" };
export function mpSetupHtml({ online, player, prefs = {}, resume = null }) {
  const people = prefs.people ?? 1, bots = prefs.bots ?? 1, turns = prefs.turns ?? 30, map = S.MATCH_MAPS.includes(prefs.map) ? prefs.map : "near";
  const sel = (name, vals, cur, label) => `<select data-field="${name}">${vals.map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${label(v)}</option>`).join("")}</select>`;
  return `<div class="fd-mp-pick">
    <h3 class="g-section">Multiplayer <span class="g-note">rival nations race for the same land</span></h3>
    ${resume ? `<button class="g-btn" data-act="mpResume">${esc(resume)}</button>` : ""}
    <div class="g-row fd-mp-opts">
      <label>Turns ${sel("mpTurns", S.MATCH_TURNS, turns, (v) => (v === 60 ? "60 (to 2026)" : `${v} (to ${S.yearOf(v) + S.RULES.yearsPerTurn})`))}</label>
      <label>People here ${sel("mpPeople", [1, 2, 3, 4], people, String)}</label>
      <label>AI nations ${sel("mpBots", [0, 1, 2, 3], bots, String)}</label>
      <label title="Neighbours: every nation starts in one part of the country, close enough to meet. Whole country: one region each.">Starts ${sel("mpMap", S.MATCH_MAPS, map, (v) => MAP_LABEL[v])}</label>
    </div>
    <div class="g-row">
      <button class="g-btn" data-act="mpLocal" type="button" title="On this device: you against AI nations, or friends taking turns at the keyboard (hotseat)">Play on this device</button>
      ${online ? `<button class="g-btn" data-act="mpCreate" type="button" title="A room friends join by link; AI nations fill the seats you choose">Online room…</button>` : ""}
    </div>
    ${online && !player ? `<label class="fd-mp-nick">Nickname for online play <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label>` : ""}
    <details><summary>Multiplayer rules</summary>${MP_HOW}</details>
  </div>`;
}

/** Online room before the start. */
export function mpLobbyHtml(mp) {
  const r = mp.room;
  const link = `${globalThis.location ? location.origin + location.pathname : ""}#play=founders~mp-${mp.code}`;
  if (!r) {
    return `<div class="fd-mp-lobby"><p class="g-note">${mp.error ? esc(mp.error) : "Connecting to the room…"}</p>
      <div class="g-row"><button class="g-btn" data-act="mpLeave">Back</button></div></div>`;
  }
  const host = r.host === mp.player?.id;
  const people = r.players.filter((p) => !p.bot);
  const seats = S.MATCH_MAX - r.bots;
  const rows = people.map((p) => `<li>${p.online ? "🟢" : "⚪"} ${esc(p.name)}${p.id === r.host ? ` <span class="g-note">host</span>` : ""}${p.id === mp.player?.id ? ` <span class="g-note">you</span>` : ""}</li>`).join("")
    + Array.from({ length: r.bots }, (_, k) => `<li>🤖 ${esc(S.BOT_NATIONS[k] || "AI")}</li>`).join("");
  const can = people.length + r.bots >= 2;
  return `<div class="fd-mp-lobby">
    <h3 class="fd-verdict">Founders room <b class="fd-mp-code">${esc(mp.code)}</b></h3>
    <p>${r.turns} turns, 1790–${S.yearOf(r.turns) + S.RULES.yearsPerTurn} · starts: ${MAP_LABEL[r.map === "near" ? "near" : "far"]}</p>
    <div class="g-row"><input class="fd-mp-link" readonly value="${esc(link)}" aria-label="Room link"><button class="g-btn" data-act="mpCopy" data-link="${esc(link)}">Copy link</button></div>
    <p class="g-note">Send the link to up to ${seats - 1} friend${seats - 1 === 1 ? "" : "s"}. Joining closes when the host starts.</p>
    <ul class="fd-mp-people">${rows}</ul>
    <div class="g-row">
      ${host ? `<button class="g-btn primary" data-act="mpStart" ${can ? "" : "disabled"} title="${can ? "Start the game" : "Needs at least two nations (people or AI)"}">Start</button>` : `<span class="g-note">Waiting for the host to start…</span>`}
      <button class="g-btn" data-act="mpLeave">Leave</button>
    </div>
    ${mp.error ? `<p class="fd-warn">${esc(mp.error)}</p>` : ""}
    <details><summary>Multiplayer rules</summary>${MP_HOW}</details>
  </div>`;
}

/** Hotseat: cover the panel between two people's turns. */
export function mpHandoffHtml(mp) {
  const pl = mp.m.players[mp.me];
  return `<div class="fd-mp-handoff">
    <p class="fd-kicker">${S.yearOf(mp.m.turn)} · turn ${mp.m.turn} of ${mp.m.turns}</p>
    <h3 class="fd-verdict">${dot(mp.me)}${esc(pl.name)}'s turn</h3>
    <p class="g-note">Pass the device to ${esc(pl.name)}.</p>
    <button class="g-btn primary" data-act="mpGo">Start ${esc(pl.name)}'s turn</button>
  </div>`;
}

/** Standings strip under the top stats. */
export function mpStandingsHtml(env, mp) {
  const rows = S.standings(env, mp.m);
  const roomP = mp.room?.players || [];
  const body = rows.map((r) => {
    let mark = "";
    if (mp.mode === "online" && !r.bot) {
      const rp = roomP[r.p];
      mark = rp?.ready ? `<span title="Ready">✓</span>` : rp && !rp.online ? `<span class="g-note" title="Offline">⚪</span>` : `<span class="g-note" title="Still playing">…</span>`;
    } else if (mp.mode === "hot" && !r.bot) mark = mp.done?.includes(r.p) ? `<span title="Done this turn">✓</span>` : "";
    return `<tr class="${r.p === mp.me ? "me" : ""}"><td>${r.rank}</td><td>${dot(r.p)}${esc(r.name)}${r.p === mp.me ? ` <span class="g-note">you</span>` : ""}</td>
      <td>${int(r.score)}</td><td>${r.towns}</td><td>${r.pop}</td><td>${mark}</td></tr>`;
  }).join("");
  return `<table class="fd-mp-table"><tr><th></th><th>Nation</th><th>Score</th><th title="Towns">Towns</th><th title="People">Pop</th><th></th></tr>${body}</table>`;
}

/** What happened between nations last turn. */
export function mpNewsHtml(mp) {
  const m = mp.m;
  if (!m.news.length) return "";
  const name = (p) => (p === mp.me ? "You" : esc(m.players[p]?.name || "?"));
  const items = m.news.filter((n) => n.kind === "turnedBack" || n.seat !== mp.me).slice(0, 6).map((n) => n.kind === "turnedBack"
    ? `<li class="${n.seat === mp.me ? "fd-warn" : ""}">${dot(n.seat)}${name(n.seat)} could not found ${esc(n.name)}: ${name(n.by)} settled nearby first</li>`
    : `<li>${dot(n.seat)}${name(n.seat)} founded ${esc(n.name)}</li>`).join("");
  return items ? `<div class="fd-mp-news"><h3 class="g-section">${S.yearOf(m.turn - 1)}: between nations</h3><ul>${items}</ul></div>` : "";
}

/** End turn / Ready button. */
export function mpEndButton(mp, needsFirstTown) {
  const dis = needsFirstTown ? "" : "";
  if (mp.mode !== "online") {
    const last = mp.mode === "hot" && mp.m.players.some((pl, p) => !pl.bot && p !== mp.me && !mp.done?.includes(p));
    return `<button class="g-btn primary fd-end" data-act="end" ${dis} title="${last ? "Done: pass to the next player" : "End the turn for every nation"} (Enter or E)">${last ? "Done · next player" : "End turn"} <kbd>⏎</kbd></button>`;
  }
  const secs = mp.deadline ? Math.max(0, Math.ceil((mp.deadline - mp.now) / 1000)) : null;
  if (mp.ready) {
    const who = mp.waiting.length ? `Waiting for ${mp.waiting.map(esc).join(", ")}` : "Ending the turn…";
    return `<button class="g-btn fd-end" data-act="mpUnready" title="Keep playing this turn">✓ Ready · ${who}${secs != null ? ` (${secs}s)` : ""}</button>`;
  }
  return `<button class="g-btn primary fd-end" data-act="end" title="Ready: end the turn when every nation is (Enter or E)">Ready${secs != null ? ` <span class="fd-warn">${secs}s</span>` : ""} <kbd>⏎</kbd></button>`;
}

/** End screen for a match (the solo "You vs. history" follows it, for your own nation). */
export function mpEndHtml(env, mp) {
  const m = mp.m;
  const rows = S.standings(env, m);
  const win = rows[0];
  const meRow = rows.find((r) => r.p === mp.me);
  const W = 300, H = 80;
  const hi = Math.max(1, ...m.hist.flat());
  const line = (p) => m.hist.map((row, k) => `${((k / Math.max(1, m.hist.length - 1)) * W).toFixed(1)},${(H - (row[p] / hi) * H).toFixed(1)}`).join(" ");
  const lines = m.players.map((_, p) => `<polyline points="${line(p)}" style="stroke:${S.NATION_COLORS[p]}"${p === mp.me ? ' class="me"' : ""}/>`).join("");
  const table = rows.map((r) => `<tr class="${r.p === mp.me ? "me" : ""}"><td>${r.rank}</td><td>${dot(r.p)}${esc(r.name)}</td><td>${int(r.score)}</td><td>${r.towns}</td><td>${r.pop}</td></tr>`).join("");
  const head = mp.mode === "hot" ? `${esc(win.name)} wins` : win.p === mp.me ? "Your nation wins" : `${esc(win.name)} wins`;
  return `<div class="fd-endscreen fd-mp-end">
    <p class="fd-kicker">Founders multiplayer · 1790–${S.yearOf(m.turns) + S.RULES.yearsPerTurn}</p>
    <h3 class="fd-verdict">${head}</h3>
    ${mp.mode === "hot" ? "" : `<p class="fd-verdict-sub">You placed ${meRow.rank} of ${rows.length} with ${int(meRow.score)} points.</p>`}
    <svg class="fd-mp-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Score by turn, one line per nation">${lines}</svg>
    <table class="fd-mp-table"><tr><th></th><th>Nation</th><th>Score</th><th>Towns</th><th>Pop</th></tr>${table}</table>
    <div class="g-row">
      ${mp.mode === "online" ? `<button class="g-btn primary" data-act="mpNewRoom">New room</button>` : `<button class="g-btn primary" data-act="mpAgain">Play again</button>`}
      <button class="g-btn" data-act="mpShare">Copy result</button>
      <button class="g-btn" data-act="mpLeave">Leave</button>
    </div>
  </div>`;
}

export function mpShareText(env, mp) {
  const rows = S.standings(env, mp.m);
  return [`Founders multiplayer, 1790–${S.yearOf(mp.m.turns) + S.RULES.yearsPerTurn}`, ...rows.map((r) => `${r.rank}. ${r.name}${r.p === mp.me && mp.mode !== "hot" ? " (me)" : ""}: ${r.score} points, ${r.towns} towns, ${r.pop} people`)].join("\n");
}
