// Head-to-head races for the short games (Pinpoint, Metro Duel, Road Trip). A race is a room (worker/race.js,
// game-aware since 2026-11-27) on a practice seed: everyone plays the same puzzle at once, and the room scores what
// each player finishes with (worker/racegames.js). The game keeps playing as usual; this controller owns the room:
//
//   const race = makeRace({ ctx, game: "pinpoint", onLive: (seed) => startPracticeWith(seed), onChange: refresh });
//   race.create()             make a room (needs a player) and join it; the URL becomes #play=<game>~race-<CODE>
//   race.join(code)           join by link (asks for a nickname first when there is no player)
//   race.progress({round, score}); race.finish(payload)
//   race.html()               lobby / standings for the top of the game's panel ("" when not in a race)
//   race.click(act, el)       handles data-act="race-…" (returns true when it did)
//   race.leave()
import { net } from "./net.js";
import { esc } from "../../format.js";

const PLACE = ["🥇", "🥈", "🥉"];

export function makeRace({ ctx, game, onLive, onChange, label = (p) => String(p.score) }) {
  let r = null; // {code, ws, room, tries, error, needNick, started}
  const me = () => net.player()?.id;
  const changed = () => { try { onChange?.(); } catch (e) { console.error(e); } };

  async function create() {
    if (!(await net.available())) { ctx.toast("This copy of the site has no online play"); return; }
    if (!net.player()) { r = { code: null, needNick: true, creating: true, room: null, error: null }; changed(); return; }
    const res = await net.post("/api/race", { game });
    if (!res.ok) { ctx.toast(`Could not make a race: ${res.error}`); return; }
    join(res.data.code);
  }
  function join(code) {
    leave({ quiet: true });
    r = { code, ws: null, room: null, tries: 0, error: null, needNick: !net.player(), started: false };
    ctx.setParam(`race-${code}`);
    if (!r.needNick) connect();
    changed();
  }
  function connect() {
    if (!r?.code) return;
    const mine = r;
    const ws = net.socket(`/api/race/${encodeURIComponent(r.code)}/ws`);
    r.ws = ws;
    ws.onopen = () => { mine.tries = 0; };
    ws.onmessage = (e) => {
      if (r !== mine) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "room") {
        mine.room = m.room;
        mine.error = null;
        if (m.room.game && m.room.game !== game) { mine.error = `That room is a ${m.room.game} race`; leave({ quiet: true, keep: true }); return; }
        if (m.room.status !== "lobby" && !mine.started && m.room.seed) {
          mine.started = true;
          const myRow = m.room.players.find((p) => p.id === me());
          if (!myRow?.done) onLive(m.room.seed);
        }
        changed();
      } else if (m.t === "error") { mine.error = m.error; changed(); }
    };
    ws.onclose = (e) => {
      if (r !== mine || mine.left) return;
      if (e.code === 4001) { mine.error = "This race already started or is full"; mine.left = true; changed(); return; }
      if (mine.room?.status === "done") return;
      if (++mine.tries <= 6) setTimeout(() => { if (r === mine) connect(); }, Math.min(8000, 700 * 2 ** mine.tries));
      else { mine.error = "Lost the connection to the race"; changed(); }
    };
  }
  const send = (m) => { if (r?.ws?.readyState === 1) r.ws.send(JSON.stringify(m)); };
  function leave({ quiet = false, keep = false } = {}) {
    if (!r) return;
    r.left = true;
    try { r.ws?.close(1000, "left"); } catch { /* ignore */ }
    if (!keep) r = null;
    if (!quiet) { ctx.setParam(null); changed(); }
  }

  function standings() {
    const room = r.room;
    const rows = [...room.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.score - a.score)
      .map((p) => `<li class="${p.id === me() ? "me" : ""}${p.online ? "" : " off"}"><span class="pl">${p.place && room.status !== "lobby" && p.done ? PLACE[p.place - 1] || `#${p.place}` : ""}</span>
        <span class="nm">${esc(p.name)}${room.host === p.id ? " <small>host</small>" : ""}</span>
        <span class="sc">${room.status === "lobby" ? (p.online ? "ready" : "away") : `${esc(label(p))}${p.done ? " ✓" : ""}`}</span></li>`).join("");
    return `<ol class="race-list">${rows}</ol>`;
  }
  function html() {
    if (!r) return "";
    if (r.needNick) {
      return `<div class="race-box"><b>Race${r.code ? ` ${esc(r.code)}` : ""}</b>
        <div class="g-row"><label class="race-nick">Nickname <input data-field="race-nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label>
        <button class="g-btn primary" data-act="race-nick">${r.creating ? "Make the race" : "Join"}</button></div>
        <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p></div>`;
    }
    const room = r.room;
    if (!room) return `<div class="race-box"><b>Race ${esc(r.code || "")}</b><p class="g-note">${esc(r.error || "Connecting…")}</p><button class="g-btn" data-act="race-leave">Leave</button></div>`;
    const link = `${location.origin}${location.pathname}#play=${game}~race-${room.code}`;
    if (room.status === "lobby") {
      return `<div class="race-box"><b>Race ${esc(room.code)}</b> <span class="g-note">waiting to start · up to 8 players</span>
        <div class="g-row race-link"><input readonly value="${esc(link)}" aria-label="Race link"><button class="g-btn" data-act="race-copy" data-link="${esc(link)}">Copy link</button></div>
        ${standings()}
        <div class="g-row">${room.host === me() ? `<button class="g-btn primary" data-act="race-start" ${room.players.length < 1 ? "disabled" : ""}>Start the race</button>` : `<span class="g-note">The host starts the race.</span>`}
          <button class="g-btn" data-act="race-leave">Leave</button></div>
        ${r.error ? `<p class="race-err">${esc(r.error)}</p>` : ""}</div>`;
    }
    return `<div class="race-box"><b>Race ${esc(room.code)}</b> <span class="g-note">${room.status === "done" ? "finished" : "live"}</span>${standings()}
      ${room.status === "done" ? `<div class="g-row"><button class="g-btn" data-act="race-new">New race</button><button class="g-btn" data-act="race-leave">Leave</button></div>` : ""}
      ${r.error ? `<p class="race-err">${esc(r.error)}</p>` : ""}</div>`;
  }
  async function click(act, el) {
    switch (act) {
      case "race-new": await create(); return true;
      case "race-start": send({ t: "start" }); return true;
      case "race-leave": leave(); return true;
      case "race-copy": navigator.clipboard?.writeText(el.dataset.link).then(() => ctx.toast("Link copied"), () => ctx.toast("Could not copy")); return true;
      case "race-nick": {
        const name = el.closest(".race-box")?.querySelector('[data-field="race-nick"]')?.value?.trim();
        if (!name) { ctx.toast("Pick a nickname first"); return true; }
        try { await net.ensurePlayer(name); } catch (err) { ctx.toast(err.message); return true; }
        if (r.creating) { r = null; await create(); } else { r.needNick = false; connect(); changed(); }
        return true;
      }
    }
    return false;
  }
  const off = net.onPlayer?.((p) => { if (p && r?.needNick) { if (r.creating) { r = null; create(); } else { r.needNick = false; connect(); changed(); } } });
  ctx.onCleanup(() => { off?.(); leave({ quiet: true }); });

  return {
    create, join, leave, html, click,
    progress: (p) => send({ t: "progress", ...p }),
    finish: (payload) => send({ t: "finish", ...payload }),
    get active() { return !!r; },
    get live() { return r?.room?.status === "live"; },
    get code() { return r?.code || null; },
  };
}
