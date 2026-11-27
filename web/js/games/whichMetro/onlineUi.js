// Which Metro? online play UI: nickname, daily leaderboard and live races (docs/MULTIPLAYER.md, ../shared/net.js).
// index.js owns the game; this module owns everything that talks to the server and the HTML for it. Nothing here
// shows (or throws) until net.available() is true, so the static dev server looks exactly as before.
//
// Slots: index.js puts empty <div data-slot="…"> placeholders in its views; paint() refills them in place, so a
// board arriving or a room update never re-renders the guess box. The "race" and "board" views are drawn whole.
import { esc } from "../../format.js";
import { puzzleNumber } from "./sim/puzzle.js";
import { totalScore, MAX_SCORE } from "./sim/game.js";
import {
  raceParam, boardEligible, dailyPayload, finishMsg, progressMsg, makeThrottle, backoffMs, standings, ordinal,
  cleanName, boardRows,
} from "./online.js";

/**
 * hooks = {view(), setView(v), render(), meta(), game(), today(), startRace(room, code), leaveToDaily(), rules, copy(text)}
 */
export function createOnline({ ctx, net, body, hooks }) {
  let online = false;
  let stopped = false;
  // The nickname form: open while a name is being picked (create) or changed (rename); `then` runs after success.
  let nick = { open: false, mode: "create", then: null, err: "", busy: false, why: "", focus: false };
  let submitting = null;            // date key of a submission in flight
  const submitErr = new Map();      // date key → error text (this session; not retried automatically)
  let board = { key: null, status: "idle", data: null, err: "", at: 0 };
  let race = null; // {code, room, ws, status, attempts, timer, closed, err, throttle, finishWs}

  const me = () => (online ? net.player() : null);
  // Signed in (or out) from the account panel: a pending "pick a nickname first" step goes ahead with that player.
  const offPlayer = net.onPlayer?.((p) => {
    if (stopped || !online) return;
    if (board.key) board.at = 0;
    if (p && nick.open && nick.mode === "create") {
      const then = nick.then;
      nick = { open: false, mode: "create", then: null, err: "", busy: false, why: "", focus: false };
      paint();
      then?.();
    } else paint();
    afterRender(hooks.view());
  });
  const sentKey = (key) => `sent:${key}`;

  function init() {
    return net.available().then((ok) => {
      if (stopped) return false;
      online = !!ok;
      if (online) { paint(); afterRender(hooks.view()); }
      return online;
    }, () => false);
  }

  // --- painting --------------------------------------------------------------------------------------------------
  // The nickname input keeps its text, focus and caret across repaints.
  function keepNick(fn) {
    const old = body.querySelector(".wm-nick-input");
    const saved = old ? { v: old.value, f: document.activeElement === old, s: old.selectionStart, e: old.selectionEnd } : null;
    fn();
    const inp = body.querySelector(".wm-nick-input");
    if (!inp) return;
    if (saved) {
      inp.value = saved.v;
      if (saved.f) { inp.focus({ preventScroll: true }); try { inp.setSelectionRange(saved.s, saved.e); } catch { /* ignore */ } }
    }
    if (nick.focus) { nick.focus = false; inp.focus({ preventScroll: true }); }
  }

  function paint() {
    if (stopped) return;
    const v = hooks.view();
    if (v === "race" || v === "board") { hooks.render(); return; }
    keepNick(() => {
      for (const el of body.querySelectorAll("[data-slot]")) el.innerHTML = slotInner(el.dataset.slot);
    });
  }
  /** index.js wraps its render() in this so the nickname input survives full renders too. */
  const wrapRender = (fn) => keepNick(fn);

  function slotInner(name) {
    if (!online) return "";
    if (name === "intro") return introInner();
    if (name === "board") return summaryBoardInner();
    if (name === "strip") return stripInner();
    if (name === "raceres") return raceResultsInner();
    return "";
  }
  const slot = (name) => `<div class="wm-online" data-slot="${name}">${slotInner(name)}</div>`;

  // --- nickname --------------------------------------------------------------------------------------------------
  function nameLine() {
    if (nick.open) return nickForm();
    const p = me();
    if (!p) return "";
    return `<p class="wm-me">Playing as <b>${esc(p.name)}</b> · <button class="wm-link" data-act="nick-change" type="button">change</button></p>`;
  }

  function nickForm() {
    const p = me();
    return `<form class="wm-nick" autocomplete="off">
        <label for="wm-nick-in">${esc(nick.why || (nick.mode === "rename" ? "Change your nickname" : "Pick a nickname for online play"))}</label>
        <div class="wm-nick-row">
          <input id="wm-nick-in" class="wm-nick-input" type="text" maxlength="20" placeholder="Nickname" spellcheck="false"
            autocapitalize="words" enterkeyhint="done" value="${esc(nick.mode === "rename" && p ? p.name : "")}">
          <button class="g-btn primary" type="submit"${nick.busy ? " disabled" : ""}>${nick.mode === "rename" ? "Save" : "Continue"}</button>
          <button class="g-btn" data-act="nick-cancel" type="button">Cancel</button>
        </div>
        ${nick.err ? `<p class="wm-err" role="alert">${esc(nick.err)}</p>` : ""}
        <p class="g-note">Shown on leaderboards and in races: 2–20 letters, digits, spaces or _ - . '</p>
        ${nick.mode === "rename" ? "" : `<p class="g-note">Played on another device? <button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`}
      </form>`;
  }

  function openNick(mode, why, then) {
    nick = { open: true, mode, then: then || null, err: "", busy: false, why: why || "", focus: true };
    paint();
  }

  /** Run `then` once the player has a nickname (asking for one first if needed). */
  function requireName(why, then) {
    if (net.player()) { then(); return; }
    openNick("create", why, then);
  }

  async function submitNick(form) {
    if (nick.busy) return;
    const name = cleanName(form.querySelector(".wm-nick-input")?.value);
    if (!name) { nick.err = "Type a nickname first."; paint(); return; }
    nick.busy = true;
    nick.err = "";
    paint();
    try {
      if (nick.mode === "rename" && net.player()) await net.rename(name);
      else await net.ensurePlayer(name);
    } catch (err) {
      nick.busy = false;
      nick.err = err?.message === "offline" ? "Could not reach the server. Try again." : (err?.message || "That name did not work.");
      paint();
      return;
    }
    const then = nick.then;
    nick = { open: false, mode: "create", then: null, err: "", busy: false, why: "", focus: false };
    if (board.key) board.at = 0; // your name on the board may have changed
    paint();
    then?.();
    afterRender(hooks.view());
  }

  // --- daily leaderboard -------------------------------------------------------------------------------------------
  const eligible = () => {
    const m = hooks.meta(), g = hooks.game();
    return online && !!m && !!g && boardEligible(m, hooks.today());
  };

  async function maybeSubmit() {
    if (!eligible()) return;
    const g = hooks.game();
    const key = g.key;
    if (!g.done || submitting === key || submitErr.has(key) || ctx.storage.get(sentKey(key)) || !net.player()) return;
    submitting = key;
    paint();
    const r = await net.post("/api/wm/daily", dailyPayload(g));
    submitting = null;
    if (stopped) return;
    if (r.ok) {
      ctx.storage.set(sentKey(key), { score: r.data?.score, rank: r.data?.rank, total: r.data?.total, at: Date.now() });
      loadBoard(key, true);
    } else {
      submitErr.set(key, r.error || "The server did not take the score.");
      paint();
    }
  }

  async function loadBoard(key, force = false) {
    if (!online) return;
    // Fresh for 20 s, errors included (the board view re-renders on every paint, so this must not loop).
    if (!force && board.key === key && (board.status === "loading" || (board.at && Date.now() - board.at < 20000))) return;
    board = { key, status: "loading", data: board.key === key ? board.data : null, err: "", at: 0 };
    paint();
    const r = await net.get(`/api/wm/daily/${encodeURIComponent(key)}?limit=10`);
    if (stopped || board.key !== key) return;
    board = r.ok ? { key, status: "ok", data: r.data, err: "", at: Date.now() } : { key, status: "error", data: board.data, err: r.error, at: Date.now() };
    paint();
  }

  function boardBody(key, mineScore) {
    if (board.key !== key || (!board.data && board.status === "loading")) return `<p class="g-note">Loading the leaderboard…</p>`;
    if (!board.data) return `<p class="wm-err">Could not load the leaderboard (${esc(board.err || "error")}). <button class="wm-link" data-act="lb-reload" type="button">Retry</button></p>`;
    const d = board.data;
    const total = d.total | 0;
    if (!total) return `<p class="g-note">No scores yet. Be the first.</p>`;
    const p = net.player();
    const rows = boardRows(d.top, d.you, p?.name);
    const you = d.you ? `<p class="wm-lb-you">You're <b>#${d.you.rank}</b> of ${total.toLocaleString("en-US")}</p>`
      : `<p class="g-note">${total.toLocaleString("en-US")} player${total === 1 ? "" : "s"} so far</p>`;
    const list = `<ol class="wm-lb">${rows.map((r) => (r.gap ? `<li class="wm-lb-gap" aria-hidden="true">⋯</li>`
      : `<li class="${r.mine ? "mine" : ""}"><span class="wm-lb-rank">${r.rank}</span><span class="wm-lb-name">${esc(r.name)}${r.mine ? ` <small>you</small>` : ""}</span><b>${r.score}</b></li>`)).join("")}</ol>`;
    return you + list + histHtml(d.histogram, d.you ? d.you.score : mineScore);
  }

  function histHtml(hist, mine) {
    if (!Array.isArray(hist) || !hist.length) return "";
    const max = Math.max(1, ...hist);
    const cols = hist.map((n, s) => `<i class="${s === mine ? "mine" : ""}" style="height:${n ? Math.max(6, (n / max) * 100).toFixed(0) : 0}%" title="${n} scored ${s}"></i>`).join("");
    return `<div class="wm-hist" role="img" aria-label="Score histogram">${cols}</div>
      <div class="wm-hist-axis" aria-hidden="true"><span>0</span><span>Score</span><span>${hist.length - 1}</span></div>`;
  }

  // Races are reachable from every results screen (not only the intro), including after today's daily.
  const raceRow = () => `<div class="g-row wm-online-btns"><button class="g-btn" data-act="race-new" type="button">Race friends</button></div>`;

  function summaryBoardInner() {
    if (!eligible()) return raceRow();
    const m = hooks.meta(), g = hooks.game();
    const key = g.key;
    const title = m.mode === "daily" ? "Today's leaderboard" : `Leaderboard · #${puzzleNumber(key)}`;
    const sent = ctx.storage.get(sentKey(key));
    let status = "";
    if (!net.player() && !sent) {
      status = nick.open ? nickForm()
        : `<div class="g-row"><button class="g-btn primary" data-act="lb-join" type="button">Join today's leaderboard</button></div>`;
    } else if (submitting === key) {
      status = `<p class="g-note">Sending your score…</p>`;
    } else if (submitErr.has(key)) {
      status = `<p class="wm-err" role="alert">${esc(submitErr.get(key))} <button class="wm-link" data-act="lb-retry" type="button">Try again</button></p>`;
    }
    const nameRow = net.player() && !(status && nick.open) ? nameLine() : "";
    return `<h3 class="g-section">${title}</h3>${status}${boardBody(key, totalScore(g))}${nameRow}${raceRow()}`;
  }

  function introInner() {
    return `<div class="g-section">Online</div>${nameLine()}
      <div class="g-row wm-online-btns">
        <button class="g-btn" data-act="race-new" type="button">Race friends</button>
        <button class="g-btn" data-act="lb-open" type="button">Today's leaderboard</button>
      </div>`;
  }

  function renderBoardView() {
    const key = hooks.today();
    keepNick(() => {
      body.innerHTML = `
        <div class="wm-hero">
          <div class="wm-kicker">Puzzle #${puzzleNumber(key)} · ${esc(key)}</div>
          <h3 class="wm-title">Today's leaderboard</h3>
        </div>
        ${nameLine()}
        ${boardBody(key, null)}
        <div class="g-row wm-more"><button class="g-btn" data-act="lb-back" type="button">Back</button></div>`;
    });
  }

  // --- races ---------------------------------------------------------------------------------------------------
  const raceUrl = (code) => `${location.origin}${location.pathname}#play=${encodeURIComponent(ctx.game.id)}~${encodeURIComponent(raceParam(code))}`;
  const myId = () => net.player()?.id ?? null;
  const inRaceGame = () => !!race && hooks.meta()?.mode === "race" && hooks.meta()?.code === race.code;

  function sendWs(msg) {
    const ws = race?.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  async function createRace() {
    const r = await net.post("/api/wm/race", {});
    if (stopped) return;
    if (!r.ok || !r.data?.code) { ctx.toast(`Could not make a race: ${r.error || "no code"}`); return; }
    joinRace(r.data.code);
  }

  /** Open a race room (from the URL, or one just made): check it exists, ask for a name, connect. */
  async function joinRace(code) {
    leaveRace();
    race = { code, room: null, ws: null, status: "checking", attempts: 0, timer: 0, closed: false, err: "", throttle: null, finishWs: null };
    const mine = race;
    mine.throttle = makeThrottle((m) => { if (race === mine) sendWs(m); }, 1000);
    hooks.setView("race");
    ctx.setParam(raceParam(code));
    hooks.render();
    const ok = await init();
    if (race !== mine) return;
    if (!ok) {
      race = null;
      ctx.toast("Races need the online version of the site.");
      hooks.leaveToDaily();
      return;
    }
    const r = await net.get(`/api/wm/race/${encodeURIComponent(code)}`);
    if (race !== mine) return;
    if (r.status === 404) { mine.status = "missing"; paint(); return; }
    mine.status = "connecting";
    requireName("Pick a nickname to join the race", () => { if (race === mine) connect(); });
    paint();
  }

  function connect() {
    const mine = race;
    if (!mine || mine.closed || stopped) return;
    mine.status = mine.attempts ? "lost" : "connecting";
    let ws;
    try { ws = net.socket(`/api/wm/race/${encodeURIComponent(mine.code)}/ws`); } catch { scheduleReconnect(); return; }
    mine.ws = ws;
    ws.addEventListener("open", () => {
      if (race !== mine || mine.ws !== ws) return;
      mine.status = "open";
      mine.attempts = 0;
      mine.err = "";
      paint();
    });
    ws.addEventListener("message", (ev) => {
      if (race !== mine || mine.ws !== ws) return;
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.t === "room" && msg.room) onRoom(msg.room);
      else if (msg?.t === "error") { mine.err = String(msg.error || "error"); ctx.toast(mine.err); paint(); }
    });
    ws.addEventListener("close", (ev) => {
      if (race !== mine || mine.ws !== ws || mine.closed) return;
      mine.ws = null;
      // 4xxx: the room said no (4001: started without you, or full; 4004: closed). Reconnecting will not help.
      if (ev.code >= 4000 && ev.code < 5000) {
        mine.status = ev.code === 4004 ? "gone" : "refused";
        if (!mine.err) mine.err = ev.reason || "The room refused the connection.";
        paint();
        return;
      }
      mine.status = "lost";
      paint();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    const mine = race;
    if (!mine || mine.closed) return;
    const n = mine.attempts++;
    clearTimeout(mine.timer);
    mine.timer = setTimeout(async () => {
      if (race !== mine || mine.closed) return;
      if (n >= 2) { // a few failures in a row: has the room gone, or does the server not know this player?
        const r = await net.get(`/api/wm/race/${encodeURIComponent(mine.code)}`);
        if (race !== mine || mine.closed) return;
        if (r.status === 404) { mine.status = "gone"; paint(); return; }
        const pr = await net.get("/api/player");
        if (race !== mine || mine.closed) return;
        if (pr.status === 401) {
          net.forget();
          mine.attempts = 0;
          mine.status = "connecting";
          requireName("This device's player was not recognised. Pick a nickname to rejoin", () => { if (race === mine) connect(); });
          return;
        }
      }
      connect();
    }, backoffMs(n));
  }

  function onRoom(room) {
    race.room = room;
    const meP = (room.players || []).find((p) => p.id === myId());
    if (room.status === "live" && !inRaceGame()) {
      hooks.startRace(room, race.code); // renders the play view
    }
    // Tell the room where we are (also after a reconnect: the server resends the room on connect).
    if (inRaceGame()) {
      const g = hooks.game();
      if (g.done && meP && !meP.done && race.finishWs !== race.ws && room.status === "live") {
        race.throttle.cancel();
        if (sendWs(finishMsg(g))) race.finishWs = race.ws;
      } else if (!g.done && meP && room.status === "live" && (meP.round !== progressMsg(g).round || meP.clues !== progressMsg(g).clues)) {
        race.throttle.push(progressMsg(g));
      }
    }
    paint();
  }

  /** After every move in index.js. */
  function afterAct(g) {
    if (inRaceGame()) {
      if (g.done) {
        race.throttle.cancel();
        if (race.room?.status !== "done" && sendWs(finishMsg(g))) race.finishWs = race.ws;
      } else {
        race.throttle.push(progressMsg(g));
      }
      return;
    }
    if (g.done) maybeSubmit();
  }

  function leaveRace() {
    if (!race) return;
    const r = race;
    race = null;
    r.closed = true;
    clearTimeout(r.timer);
    r.throttle?.cancel();
    try { r.ws?.close(1000, "left"); } catch { /* ignore */ }
  }

  const dot = (p) => `<i class="wm-dot${p.online === false ? "" : " on"}" title="${p.online === false ? "offline" : "online"}"></i>`;

  function playersList(room) {
    const id = myId();
    return `<ul class="wm-players">${(room.players || []).map((p) => `<li class="${p.id === id ? "me" : ""}">${dot(p)}<span>${esc(p.name)}</span>
        ${p.id === room.host ? `<small class="wm-tag">host</small>` : ""}${p.id === id ? `<small class="wm-tag">you</small>` : ""}</li>`).join("")}</ul>`;
  }

  function connLine() {
    if (!race) return "";
    if (race.status === "checking" || (race.status === "connecting" && !nick.open && net.player())) return `<p class="g-note">Connecting…</p>`;
    if (race.status === "lost") return `<p class="wm-err">Connection lost. Reconnecting…</p>`;
    if (race.status === "gone") return `<p class="wm-err">This race has closed.</p>`;
    if (race.status === "refused") return `<p class="wm-err" role="alert">${esc(race.err || "The room refused the connection.")}</p>`;
    return race.err ? `<p class="wm-err" role="alert">${esc(race.err)}</p>` : "";
  }

  function resultsList(room) {
    const id = myId();
    return `<ol class="wm-race-res">${standings(room.players).map((p) => `<li class="${p.id === id ? "mine" : ""}${p.done ? " done" : ""}">
        <span class="wm-rr-place">${p.place ? ordinal(p.place) : "–"}</span>${dot(p)}
        <span class="wm-rr-name">${esc(p.name)}${p.id === id ? ` <small>you</small>` : ""}</span>
        <span class="wm-rr-state">${p.done ? "finished" : room.status === "done" ? "did not finish" : `round ${Math.max(1, p.round | 0)}`}</span>
        <b>${p.score | 0}</b></li>`).join("")}</ol>`;
  }

  function renderRaceView() {
    const code = race?.code || "";
    let main = "";
    const room = race?.room;
    if (!race) {
      main = `<p class="g-note">Not in a race.</p>`;
    } else if (race.status === "missing" || (race.status === "gone" && !room) || (race.status === "refused" && !room)) {
      main = `${race.status === "refused" ? "" : `<p class="wm-err">No race with code <code>${esc(code)}</code>. It may have ended.</p>`}
        <div class="g-row"><button class="g-btn primary" data-act="race-new" type="button">Start a new race</button></div>`;
    } else if (nick.open) {
      main = nickForm();
    } else if (room?.status === "done") {
      main = `<h4 class="g-section">Final standings</h4>${resultsList(room)}
        <div class="g-row"><button class="g-btn primary" data-act="race-new" type="button">New race</button></div>`;
    } else if (room) {
      const host = room.host === myId();
      const n = (room.players || []).length;
      main = `
        <div class="wm-code-row"><span class="wm-code" aria-label="Room code">${esc(code)}</span>
          <button class="g-btn" data-act="race-copy" type="button">Copy link</button></div>
        <p class="g-note">Send the link to friends: up to 8 players, and everyone gets the same five metros.</p>
        <h4 class="g-section">Players <small>${n}/8</small></h4>
        ${playersList(room)}
        ${host
          ? `<div class="g-row"><button class="g-btn primary wm-big" data-act="race-start" type="button"${race.status === "open" ? "" : " disabled"}>Start the race</button></div>
             ${n < 2 ? `<p class="g-note">You can start alone, but it's more fun with company.</p>` : ""}`
          : `<p class="wm-wait">Waiting for the host to start…</p>`}`;
    }
    keepNick(() => {
      body.innerHTML = `
        <div class="wm-hero wm-race">
          <div class="wm-kicker">Race${code ? ` · <code>${esc(code)}</code>` : ""}</div>
          <h3 class="wm-title">Race friends</h3>
          ${connLine()}
          ${main}
        </div>
        ${nick.open ? "" : nameLine()}
        <details class="wm-race-rules"><summary>How to play</summary>${hooks.rules}</details>
        <div class="g-row wm-more">
          <button class="g-btn" data-act="race-leave" type="button">Leave race</button>
        </div>`;
    });
  }

  function stripInner() {
    if (!race || !inRaceGame()) return "";
    const room = race.room;
    const id = myId();
    const state = race.status === "lost" ? `<span class="wm-err">reconnecting…</span>` : room?.status === "done" ? "race over" : "live";
    const rows = room ? standings(room.players).map((p) => `<li class="${p.id === id ? "mine" : ""}${p.done ? " done" : ""}">${dot(p)}
        <span class="wm-rs-name">${esc(p.name)}</span><span class="wm-rs-round">${p.done ? "✓" : `R${Math.max(1, p.round | 0)}`}</span><b>${p.score | 0}</b></li>`).join("") : "";
    return `<div class="wm-race-strip"><div class="wm-rs-head">Race <code>${esc(race.code)}</code> · ${state}</div><ol>${rows}</ol></div>`;
  }

  function raceResultsInner() {
    if (!race || !inRaceGame() || !race.room) return "";
    const room = race.room;
    const left = (room.players || []).filter((p) => !p.done).length;
    return `<h3 class="g-section">Race <code>${esc(race.code)}</code>${room.status === "done" ? " · final" : ""}</h3>
      ${connLine()}
      ${resultsList(room)}
      ${room.status !== "done" && left ? `<p class="g-note">Waiting for ${left} more player${left === 1 ? "" : "s"}. Places use the server's checked scores, then finish time.</p>` : ""}`;
  }

  // --- events ------------------------------------------------------------------------------------------------------
  /** A [data-act] click; returns true when it was one of ours. */
  function onClick(a, btn) {
    if (!a) return false;
    switch (a) {
      case "nick-change": openNick("rename", "", null); return true;
      case "nick-cancel": nick = { open: false, mode: "create", then: null, err: "", busy: false, why: "", focus: false }; paint(); return true;
      case "lb-join": requireName("Pick a nickname for the leaderboard", () => maybeSubmit()); return true;
      case "lb-retry": { const g = hooks.game(); if (g?.key) submitErr.delete(g.key); maybeSubmit(); return true; }
      case "lb-reload": if (board.key) loadBoard(board.key, true); return true;
      case "lb-open": hooks.setView("board"); hooks.render(); return true;
      case "lb-back": hooks.setView(hooks.game() ? (hooks.game().done ? "summary" : "intro") : "intro"); hooks.render(); return true;
      case "race-new": requireName("Pick a nickname to start a race", () => createRace()); return true;
      case "race-start": if (!sendWs({ t: "start" })) ctx.toast("Not connected yet."); return true;
      case "race-copy":
        hooks.copy(raceUrl(race?.code || "")).then((ok) => {
          ctx.toast(ok ? "Race link copied: send it to your friends." : "Could not copy the link.");
          if (ok && btn?.isConnected) btn.textContent = "Copied ✓";
        });
        return true;
      case "race-leave": leaveRace(); hooks.leaveToDaily(); return true;
      default: return false;
    }
  }

  /** A form submit in the dock; returns true when it was the nickname form. */
  function onSubmit(form) {
    if (!form?.classList?.contains("wm-nick")) return false;
    submitNick(form);
    return true;
  }

  /** After index.js rendered a view: start any network work that view needs. */
  function afterRender(view) {
    if (!online) return;
    if (view === "board") loadBoard(hooks.today());
    if (view === "summary" && eligible()) {
      const g = hooks.game();
      if (g.done && net.player() && !ctx.storage.get(sentKey(g.key)) && !submitErr.has(g.key)) maybeSubmit();
      else loadBoard(g.key);
    }
  }

  return {
    get available() { return online; },
    get raceCode() { return race?.code ?? null; },
    init, paint, wrapRender, slot, afterRender, afterAct, onClick, onSubmit, joinRace, leaveRace,
    renderBoardView, renderRaceView,
    /** Esc: closes the nickname form; true when it did. */
    escape() {
      if (!nick.open) return false;
      nick = { open: false, mode: "create", then: null, err: "", busy: false, why: "", focus: false };
      paint();
      return true;
    },
    stop() { stopped = true; offPlayer?.(); leaveRace(); },
  };
}
