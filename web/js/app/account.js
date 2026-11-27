// Account panel: the top-bar button and modal for login (docs/MULTIPLAYER.md "Login"). Hidden on the static dev
// server (no /api). A player starts as a nickname on one device; here they can save it with a passkey, link another
// device with a one-time code, sign in elsewhere (this device's scores merge in), sign out, or delete it.
import { net } from "../games/shared/net.js";
import { icon } from "../ui/icon.js";
import { scenarioById } from "../games/mainline/sim/scenarios.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never");
const mergedText = (m) => {
  if (!m || (!m.daily && !m.runs)) return "";
  const bits = [m.daily && `${m.daily} daily score${m.daily === 1 ? "" : "s"}`, m.runs && `${m.runs} Mainline run${m.runs === 1 ? "" : "s"}`].filter(Boolean);
  return ` This device's ${bits.join(" and ")} moved to your account.`;
};

export function initAccount({ toast } = {}) {
  const button = document.getElementById("btn-account");
  if (!button) return { open() {}, close() {}, get isOpen() { return false; } };
  const say = (m) => (toast ? toast(m) : console.log(m));

  const modal = document.createElement("div");
  modal.id = "account";
  modal.className = "modal";
  modal.hidden = true;
  modal.innerHTML = `<div class="acct-card panel" role="dialog" aria-modal="true" aria-labelledby="acct-title"></div>`;
  document.body.appendChild(modal);
  const card = modal.firstElementChild;

  // view: null (loading) | {acct, error, busy, code, codeExpires, confirmDelete, enter, renaming}
  let state = { stats: null, acct: null, error: null, busy: null, code: null, codeExpires: 0, enter: false, confirmDelete: false, renaming: null, cfg: null };
  let restore = null, timer = null;

  const label = () => {
    const p = net.player();
    button.innerHTML = `${icon("pop", "👤", { size: 15 })}<span class="lbl">${esc(p ? p.name : "Sign in")}</span>`;
    button.title = p ? `Your player: ${p.name}` : "Sign in or pick a nickname for online play";
    button.setAttribute("aria-label", p ? `Account: ${p.name}` : "Sign in");
  };

  const passkeyBtn = (act, text, primary = false) => net.passkeysSupported() && state.cfg?.passkeys
    ? `<button class="g-btn${primary ? " primary" : ""}" data-act="${act}" ${state.busy ? "disabled" : ""}>${icon(null, "🔑", { size: 14 })}${text}</button>` : "";

  function signInBlock(heading) {
    const g = state.cfg?.google ? `<button class="g-btn" data-act="google" ${state.busy ? "disabled" : ""}>Continue with Google</button>` : "";
    return `
      <h3>${heading}</h3>
      <div class="g-row">${passkeyBtn("pk-login", "Sign in with a passkey", true)}${g}
        <button class="g-btn" data-act="enter" ${state.busy ? "disabled" : ""}>Enter a code</button></div>
      ${state.enter ? `<form class="acct-form" data-form="code">
          <label>Code from your other device <input name="code" maxlength="12" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"></label>
          <button class="g-btn primary" ${state.busy ? "disabled" : ""}>Sign in</button></form>` : ""}
      ${net.passkeysSupported() ? "" : `<p class="g-note">This browser has no passkeys; use a code from a device that is signed in.</p>`}`;
  }

  function codeBlock() {
    if (!state.code) return `<button class="g-btn" data-act="link" ${state.busy ? "disabled" : ""}>Link another device</button>`;
    const left = Math.max(0, Math.round((state.codeExpires - Date.now()) / 1000));
    const pretty = `${state.code.slice(0, 4)}-${state.code.slice(4)}`;
    return left > 0
      ? `<div class="acct-code" aria-live="polite"><b>${pretty}</b><span>On the other device open <b>Sign in → Enter a code</b>. Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.</span></div>`
      : `<p class="g-note">That code expired.</p><button class="g-btn" data-act="link">New code</button>`;
  }

  function statsBlock() {
    const st = state.stats;
    if (!st) return "";
    const pct = (u) => `${u >= 0 ? "+" : ""}${(u * 100).toFixed(1)}%`;
    const dailyRow = (label, d, unit, href, f = (x) => `${x}${unit}`) => d?.played
      ? `<tr><th scope="row"><a href="${href}">${label}</a></th><td>${d.played}</td><td>${f(d.best)}</td><td>${f(d.avg)}</td><td>${d.streak ? `${d.streak} day${d.streak === 1 ? "" : "s"}` : "–"}</td></tr>`
      : `<tr><th scope="row"><a href="${href}">${label}</a></th><td colspan="4" class="g-note">not played yet</td></tr>`;
    const ml = st.ml.map((r) => `<li><b>${esc(scenarioById(r.scenario)?.name || r.scenario)}</b> ${pct(r.uplift)} GDP · #${r.rank} of ${r.total}</li>`).join("");
    return `
      <h3>Your record</h3>
      <table class="acct-stats"><thead><tr><th></th><th>Days</th><th>Best</th><th>Average</th><th>Streak</th></tr></thead><tbody>
        ${dailyRow("Which Metro?", st.wm, "", "#play=whichMetro")}
        ${dailyRow("Pinpoint", st.pp, "", "#play=pinpoint")}
        ${dailyRow("Metro Duel", st.dl, "", "#play=duel")}
        ${dailyRow("Road Trip", st.tr, "", "#play=trip")}
        ${dailyRow("Founders daily", st.fd, "", "#play=founders~daily")}
        ${dailyRow("Mainline daily", st.md, "", "#play=mainline~daily", (bp) => `${bp >= 0 ? "+" : ""}${(bp / 100).toFixed(2)}%`)}
      </tbody></table>
      ${ml ? `<p class="g-note">Mainline bests:</p><ul class="acct-ml">${ml}</ul>` : `<p class="g-note">No Mainline runs on the boards yet.</p>`}`;
  }

  function render() {
    const p = net.player();
    const a = state.acct;
    let body;
    if (!p) {
      body = `
        <p>Online play (leaderboards, races, versus rooms) uses a nickname. Your games always work without one.</p>
        ${signInBlock("Already have a player?")}
        <h3>New here?</h3>
        <form class="acct-form" data-form="new">
          <label>Pick a nickname <input name="name" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label>
          <button class="g-btn primary" ${state.busy ? "disabled" : ""}>Start</button>
        </form>`;
    } else if (!a) {
      body = state.error ? "" : `<p class="g-note">Loading…</p>`;
    } else {
      const keys = a.passkeys.map((k) => state.renaming === k.id
        ? `<li><form class="acct-form inline" data-form="pk-rename" data-id="${esc(k.id)}"><input name="name" maxlength="20" value="${esc(k.name)}" aria-label="Passkey name"><button class="g-btn">Save</button></form></li>`
        : `<li><span class="acct-key">${icon(null, "🔑", { size: 13 })}<b>${esc(k.name)}</b></span><span class="g-note">added ${day(k.created)} · used ${day(k.lastUsed)}</span>
            <span class="acct-key-acts"><button class="linkish" data-act="pk-rename" data-id="${esc(k.id)}">Rename</button><button class="linkish" data-act="pk-remove" data-id="${esc(k.id)}">Remove</button></span></li>`).join("");
      const ids = a.identities.map((i) => `<li><span class="acct-key"><b>${i.provider === "google" ? "Google" : esc(i.provider)}</b></span><span class="g-note">${esc(i.email || "")}</span>
            <span class="acct-key-acts"><button class="linkish" data-act="unlink" data-id="${esc(i.provider)}">Unlink</button></span></li>`).join("");
      body = `
        <p class="acct-who">Playing as <b>${esc(a.name)}</b> <button class="linkish" data-act="rename">Change nickname</button></p>
        ${state.renaming === "me" ? `<form class="acct-form" data-form="rename"><label>New nickname <input name="name" maxlength="20" value="${esc(a.name)}"></label><button class="g-btn primary">Save</button></form>` : ""}
        ${a.secured
          ? `<p class="acct-ok">${icon("check", "✓", { size: 14 })} Saved. Sign in on any device with your passkey${a.identities.length ? " or Google" : ""}.</p>`
          : `<p class="acct-warn">This player lives only in this browser. Clearing site data loses it. Save it with a passkey (Face ID, Touch ID, Windows Hello, your phone or a password manager) to sign in anywhere.</p>`}
        ${statsBlock()}
        <h3>Ways to sign in</h3>
        ${keys || ids ? `<ul class="acct-list">${keys}${ids}</ul>` : ""}
        <div class="g-row">${passkeyBtn("pk-add", a.secured ? "Add a passkey" : "Save with a passkey", !a.secured)}
          ${state.cfg?.google && !a.identities.some((i) => i.provider === "google") ? `<button class="g-btn" data-act="google" ${state.busy ? "disabled" : ""}>Add Google</button>` : ""}</div>
        ${net.passkeysSupported() ? "" : `<p class="g-note">This browser can't make passkeys. Link a device that can, or use a code.</p>`}
        <h3>Devices</h3>
        <p class="g-note">Signed in on ${a.devices} device${a.devices === 1 ? "" : "s"}.</p>
        <div class="g-row">${codeBlock()}${a.devices > 1 ? `<button class="g-btn" data-act="signout-others" ${state.busy ? "disabled" : ""}>Sign out other devices</button>` : ""}</div>
        <details class="acct-more"${state.enter ? " open" : ""}><summary>Use a different player</summary>
          ${signInBlock("Sign in to another player")}
          <p class="g-note">${a.secured ? "" : "This device's scores move into the player you sign in to, and this nickname is retired."}</p>
        </details>
        <h3>Leave</h3>
        <div class="g-row"><button class="g-btn" data-act="signout" ${state.busy ? "disabled" : ""}>Sign out of this device</button>
          <button class="g-btn danger" data-act="delete" ${state.busy ? "disabled" : ""}>Delete player…</button></div>
        ${!a.secured ? `<p class="g-note">Without a passkey, signing out loses this player for good.</p>` : ""}
        ${state.confirmDelete ? `<form class="acct-form" data-form="delete">
            <label>Type <b>${esc(a.name)}</b> to delete this player, its scores and every way to sign in. This can't be undone.
              <input name="confirm" maxlength="20" autocomplete="off"></label>
            <button class="g-btn danger">Delete for good</button></form>` : ""}`;
    }
    card.innerHTML = `
      <button class="icon-btn acct-close" data-close aria-label="Close">${icon("close", "✕", { size: 13 })}</button>
      <h2 id="acct-title">${icon("pop", "👤", { size: 22 })}<span>${p ? "Your player" : "Sign in"}</span></h2>
      ${state.error ? `<p class="acct-err" role="alert">${esc(state.error)}</p>` : ""}
      ${state.busy ? `<p class="g-note" aria-live="polite">${esc(state.busy)}</p>` : ""}
      ${body}
      <p class="g-note acct-foot">Passkeys never leave your device; the server keeps only the public half. No email or password is stored.</p>`;
  }

  async function refresh() {
    label();
    if (!net.player()) { state.acct = null; render(); return; }
    try {
      const [a, st] = await Promise.all([net.account(), net.get("/api/account/stats")]);
      state.acct = a; state.stats = st.ok ? st.data : null; state.error = null;
    } catch (err) { state.acct = null; state.stats = null; state.error = err.message; }
    label();
    render();
  }

  /** Run an async step with a busy note; errors land in the panel. */
  async function step(busy, f) {
    state.busy = busy; state.error = null; render();
    try { await f(); } catch (err) { state.error = err.message; }
    state.busy = null;
    await refresh();
  }

  const focusFirst = () => (card.querySelector("input") || card.querySelector("[data-act]") || card.querySelector("[data-close]"))?.focus();

  card.addEventListener("click", (e) => {
    if (e.target.closest('a[href^="#"]')) { close(); return; } // a game link: go there
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "pk-login": return step("Waiting for your passkey…", async () => {
        const r = await net.signInWithPasskey();
        state.enter = false;
        say(`Signed in as ${r.name}.${mergedText(r.merged)}`);
      });
      case "pk-add": return step("Waiting for your passkey…", async () => {
        const k = await net.addPasskey();
        say(`Passkey saved (${k.name}). You can sign in on any device now.`);
      });
      case "google": return step("Going to Google…", () => net.signInWithGoogle());
      case "enter": state.enter = !state.enter; render(); card.querySelector('[data-form="code"] input')?.focus(); return;
      case "link": return step("Making a code…", async () => {
        const c = await net.linkCode();
        state.code = c.code; state.codeExpires = c.expires;
        clearInterval(timer);
        timer = setInterval(() => { if (modal.hidden || Date.now() > state.codeExpires + 1000) clearInterval(timer); render(); }, 1000);
      });
      case "signout-others": return step("Signing out other devices…", async () => { await net.signOutOthers(); say("Other devices are signed out."); });
      case "signout":
        if (!state.acct?.secured && !confirm("This player has no passkey: signing out loses it and its scores for good. Sign out anyway?")) return;
        return step("Signing out…", async () => { await net.signOut(); state.code = null; say("Signed out of this device."); });
      case "delete": state.confirmDelete = !state.confirmDelete; render(); card.querySelector('[data-form="delete"] input')?.focus(); return;
      case "rename": state.renaming = state.renaming === "me" ? null : "me"; render(); card.querySelector('[data-form="rename"] input')?.select(); return;
      case "pk-rename": state.renaming = id; render(); card.querySelector('[data-form="pk-rename"] input')?.select(); return;
      case "pk-remove":
        if (!confirm(state.acct?.passkeys.length === 1 && !state.acct.identities.length ? "Remove your only passkey? You'll be able to sign in only on devices that are signed in now." : "Remove this passkey?")) return;
        return step("Removing…", async () => { await net.removePasskey(id); say("Passkey removed. You can also delete it from your device's password manager."); });
      case "unlink": return step("Unlinking…", async () => { await net.unlinkIdentity(id); });
    }
  });

  card.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target, v = (n) => f.elements[n]?.value || "";
    switch (f.dataset.form) {
      case "new": return step("Creating your player…", async () => { await net.ensurePlayer(v("name").trim()); say(`Welcome, ${net.player().name}.`); });
      case "code": return step("Signing in…", async () => {
        const r = await net.redeemCode(v("code"));
        state.enter = false;
        say(`Signed in as ${r.name}.${mergedText(r.merged)}`);
      });
      case "rename": return step("Saving…", async () => { await net.rename(v("name").trim()); state.renaming = null; });
      case "pk-rename": return step("Saving…", async () => { await net.renamePasskey(f.dataset.id, v("name").trim()); state.renaming = null; });
      case "delete": return step("Deleting…", async () => { await net.deleteAccount(v("confirm").trim()); state.confirmDelete = false; say("Player deleted."); });
    }
  });

  const close = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    button.setAttribute("aria-expanded", "false");
    clearInterval(timer);
    if (restore && document.contains(restore)) restore.focus();
    restore = null;
  };
  modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) close(); });
  modal.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the map and game hotkeys stay quiet while the panel is open
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    const f = [...card.querySelectorAll("button:not([disabled]), input, summary, [href]")].filter((el) => el.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });

  const api = {
    async open() {
      if (!modal.hidden) return;
      restore = document.activeElement;
      state = { ...state, error: null, busy: null, enter: false, confirmDelete: false, renaming: null };
      modal.hidden = false;
      button.setAttribute("aria-expanded", "true");
      render();
      focusFirst();
      await refresh();
      if (!modal.contains(document.activeElement)) focusFirst();
    },
    close,
    toggle() { modal.hidden ? api.open() : close(); },
    get isOpen() { return !modal.hidden; },
  };
  button.onclick = () => api.toggle();
  // Any [data-open-account] control (the games' nickname prompts) opens this panel.
  document.addEventListener("click", (e) => {
    const t = e.target.closest?.("[data-open-account]");
    if (!t || button.hidden) return;
    e.preventDefault();
    api.open();
  });
  net.onPlayer(() => { label(); if (!modal.hidden) refresh(); });

  (async () => {
    if (!(await net.available())) return; // static dev server: no accounts
    state.cfg = await net.authConfig();
    label();
    button.hidden = false;
    try {
      const r = await net.finishRedirect();
      if (r) { say(`Signed in as ${r.name}.${mergedText(r.merged)}`); api.open(); }
    } catch (err) { say(err.message); }
  })();

  return api;
}
