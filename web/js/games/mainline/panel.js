// Dock HTML for Mainline: the scenario picker, the in-game panel and the end screen. Pure string builders (escape
// every data string); index.js wires the clicks with event delegation on data-act / data-contract attributes.
import { esc, money, pct } from "../../format.js";
import * as S from "./sim/index.js";
import { usd } from "./view.js";

const cr = (x) => `${(Math.round(x * 10) / 10).toFixed(1)} cr`;
const signed = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const crTitle = (x) => `${cr(x)} ≈ ${usd(x)} (1 cr ≈ ${money(S.USD_PER_CREDIT)} of construction)`;

export const HOW_TO = `<ol class="ml-how">
  <li><b>Lay track.</b> Click a hex in your home metro (or on your network), then another hex: rail follows the cheapest
  route. Hills, mountains, wetland, cities, water and river crossings cost more; upgrading a <i>real</i> rail line is much
  cheaper. <kbd>Z</kbd> undoes within the turn, <kbd>Esc</kbd> cancels.</li>
  <li><b>Serve contracts.</b> A contract pays every year once your network joins its two ends. FAF contracts are real
  2024 freight flows between states; "model" contracts come from a gravity model fitted to them. Long detours pay less.</li>
  <li><b>Grow the region.</b> Metros on your network grow faster than their real trend. Beat <i>baseline America</i>
  (the same metros with no network) by the scenario's goal by 2050.</li>
  <li><b>Weather the risk.</b> Each year counties roll disasters from their real FEMA record. Damaged links carry nothing
  until repaired; hardened links shrug them off. <kbd>E</kbd> ends the turn.</li>
</ol>`;

export function pickerHtml({ save, saveEnv, cities, defaults }) {
  const resume = save && saveEnv && !save.over
    ? `<button class="g-btn primary ml-wide" data-act="resume">Resume ${esc(saveEnv.scenario.name)}${save.home && saveEnv.scenario.id === "sandbox" ? ` (${esc(saveEnv.home?.name || "")})` : ""}, ${save.year}</button>`
    : "";
  const cards = S.SCENARIOS.map((sc) => `<label class="ml-scn${sc.id === defaults.scenario ? " on" : ""}">
      <input type="radio" name="ml-scn" value="${sc.id}"${sc.id === defaults.scenario ? " checked" : ""}>
      <span><b>${esc(sc.name)}</b><span class="g-note">${esc(sc.blurb)}</span>
      <small>Budget ${sc.cash} cr · goal ${signed(sc.goal)} GDP vs baseline by 2050</small></span></label>`).join("");
  const opts = cities.map((c) => `<option value="${c.id}"${c.id === defaults.home ? " selected" : ""}>${esc(c.name)}, ${esc(c.states.join("-"))}</option>`).join("");
  return `<div class="ml-picker">
    ${resume}
    <p class="g-note">Build the freight rail network that carries the real America from 2026 to 2050. Real cities,
    real FAF freight flows, real FEMA disaster records.</p>
    <div class="g-section">Scenario</div>
    <div class="ml-scns">${cards}</div>
    <div class="ml-home" ${defaults.scenario === "sandbox" ? "" : "hidden"}><label>Home metro <select data-field="home">${opts}</select></label></div>
    <div class="g-row ml-seedrow"><label>Seed <input data-field="seed" type="number" min="0" max="999999" value="${defaults.seed}"></label>
      <button class="g-btn" data-act="reseed" type="button" title="A new random seed">🎲</button></div>
    <button class="g-btn primary ml-wide" data-act="start">Start</button>
    <details class="ml-help"><summary>How to play</summary>${HOW_TO}</details>
  </div>`;
}

/** The in-game panel. m = {env, state, ev, sum, ui, sel, touch} */
export function gameHtml(m) {
  const { env, state, ev, sum, ui } = m;
  const turn = state.year - S.START_YEAR + 1;
  const net = ev.revenue - ev.maint;
  const goalPct = Math.max(0, Math.min(1, sum.uplift / (sum.goal * 1.5)));
  const goalMark = 1 / 1.5;
  const dmg = Object.keys(state.links).filter((k) => state.links[k].d);
  const repairAll = dmg.reduce((s, k) => s + S.repairCost(env, state.links[k]), 0);
  return `
  <div class="ml-top">
    <div class="ml-year"><b>${state.year}</b><span>turn ${turn} of 25</span></div>
    <div class="g-stat" title="${esc(crTitle(state.cash))}"><b>${cr(state.cash)}</b><span>cash</span></div>
    <div class="g-stat" title="${esc(`Freight revenue ${cr(ev.revenue)} minus upkeep ${cr(ev.maint)} a year, at today's network`)}"><b class="${net >= 0 ? "ml-good" : "ml-bad"}">${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}</b><span>per year</span></div>
  </div>
  <div class="g-row ml-actions">
    <button class="g-btn primary" data-act="end" title="End the year (E)">End ${state.year} <kbd>E</kbd></button>
    <button class="g-btn" data-act="undo" ${state.undo.length ? "" : "disabled"} title="Undo the last build, repair or hardening this turn (Z)">Undo <kbd>Z</kbd></button>
  </div>
  <div class="ml-goal" title="${esc(`Your region's metros: ${money(sum.you)} GDP; baseline America (same metros, real trend, no network): ${money(sum.base)}. Goal: ${signed(sum.goal)} by 2050.`)}">
    <div class="ml-goal-txt"><span>GDP vs baseline America</span><b class="${sum.uplift >= sum.goal ? "ml-good" : ""}">${signed(sum.uplift, 2)}</b><span class="muted">goal ${signed(sum.goal)}</span></div>
    <div class="ml-bar"><i style="width:${(goalPct * 100).toFixed(1)}%"></i><em style="left:${(goalMark * 100).toFixed(1)}%"></em></div>
  </div>
  <div id="ml-build" class="ml-build">${buildHtml(m)}</div>
  ${ui.link && state.links[ui.link] ? linkHtml(m) : ""}
  ${eventsHtml(state)}
  ${dmg.length ? `<div class="ml-dmg"><span><b class="ml-bad">${dmg.length}</b> damaged link${dmg.length === 1 ? "" : "s"} carry nothing</span>
    <button class="g-btn" data-act="repairAll" title="${esc(crTitle(repairAll))}">Repair all ${cr(repairAll)}</button></div>` : ""}
  ${contractsHtml(m)}
  <label class="ml-check"><input type="checkbox" data-act="demand" ${ui.showDemand ? "checked" : ""}> Show demand lines on the map</label>
  <div class="ml-foot g-note">
    <span>${esc(env.scenario.name)}${env.scenario.id === "sandbox" ? ` · ${esc(env.home?.name || "")}` : ""} · seed ${state.seed}</span>
    <span class="g-row"><button class="g-btn" data-act="help">How to play</button><button class="g-btn" data-act="new">New game</button></span>
  </div>
  ${ui.help ? `<div class="ml-helpbox">${HOW_TO}<button class="g-btn" data-act="help">Close</button></div>` : ""}`;
}

export function buildHtml(m) {
  const { env, sel, touch } = m;
  const pl = sel.plan;
  if (sel.start == null) {
    const net = Object.keys(m.state.links).length;
    return `<span class="ml-hint">${net ? "Click a hex on your network to extend it" : `Click a hex in <b>${esc(env.home?.name || "your home metro")}</b> (the gold station) to start laying track`}, or click a contract below to see its ends.</span>`;
  }
  if (!pl) return `<span class="ml-hint">Now click where the track should go. <kbd>Esc</kbd> cancels.</span>`;
  const head = pl.path ? `<div><b>${cr(pl.cost)}</b> <span class="muted">≈ ${usd(pl.cost)}</span> · ${pl.fresh} new link${pl.fresh === 1 ? "" : "s"}, ${pl.km} km</div>` : "";
  const detail = pl.path ? [pl.rail ? `${pl.rail} upgrade real rail` : "", pl.rivers ? `${pl.rivers} river crossing${pl.rivers === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") : "";
  const err = pl.error ? `<div class="ml-bad">${esc(pl.error)}</div>` : "";
  const confirm = touch && sel.end != null && !pl.error
    ? `<div class="g-row"><button class="g-btn primary" data-act="build">Build ${cr(pl.cost)}</button><button class="g-btn" data-act="cancel">Cancel</button></div>` : "";
  return `${head}${detail ? `<div class="g-note">${detail}</div>` : ""}${err}${confirm}`;
}

function linkHtml(m) {
  const { env, state, ui } = m;
  const l = state.links[ui.link];
  const rc = S.repairCost(env, l), hc = S.hardenCost(env, l);
  return `<div class="ml-link">
    <div class="g-row"><b>Selected link</b><span class="muted">built ${l.year}, ${cr(l.cost)}</span>
      <button class="icon-btn ml-x" data-act="unlink" aria-label="Deselect">✕</button></div>
    <div>${l.d ? `<span class="ml-bad">Damaged</span>` : l.h ? `<span class="ml-good">Hardened</span>` : "Intact, not hardened"}</div>
    <div class="g-row">
      ${l.d ? `<button class="g-btn" data-act="repair" title="${esc(crTitle(rc))}">Repair ${cr(rc)}</button>` : ""}
      ${l.h ? "" : `<button class="g-btn" data-act="harden" title="${esc(crTitle(hc))}. Levees, culverts and firebreaks: disasters no longer cut this link.">Harden ${cr(hc)}</button>`}
    </div></div>`;
}

function eventsHtml(state) {
  if (!state.events?.length || !state.last) return "";
  const cards = state.events.map((e) => `<div class="ml-card hz-${esc(e.type)}">
      <b>${esc(S.TYPE_NAME[e.type] || "Disaster")} in ${esc(e.name)}${e.state ? `, ${esc(e.state)}` : ""}</b>
      <div>${e.damaged ? `<span class="ml-bad">${e.damaged} link${e.damaged === 1 ? "" : "s"} damaged</span>` : "No links damaged"}${e.held ? ` · ${e.held} hardened link${e.held === 1 ? "" : "s"} held` : ""}</div>
      <small>Real rate: this county had ${e.count} ${esc((S.TYPE_NAME[e.type] || "disaster").toLowerCase())} declaration${e.count === 1 ? "" : "s"} (${e.total} of any kind) in ${e.years} years of FEMA records.</small>
    </div>`).join("");
  return `<div class="g-section">${state.last.year}: what happened</div>${cards}`;
}

function contractsHtml(m) {
  const { env, ev, ui } = m;
  const open = env.contracts.filter((c) => !ev.served.has(c.id));
  const served = env.contracts.filter((c) => ev.served.has(c.id));
  const list = ui.tab === "served" ? served : open;
  const rows = list.map((c) => {
    const s = ev.served.get(c.id);
    const full = S.payFor(c.value, 1);
    const pay = s ? `+${s.pay.toFixed(1)}` : `≤${full.toFixed(1)}`;
    return `<li data-contract="${esc(c.id)}" class="${s ? "served" : ""}${ui.highlight === c.id ? " on" : ""}" title="${esc(contractText(env, c, s))}">
      <span class="ml-kind ${c.kind}">${c.kind === "faf" ? "FAF" : "model"}</span>
      <span class="ml-cname">${esc(c.a.name)} ↔ ${esc(c.b.name)}</span>
      <span class="ml-val">${money(c.value)}</span>
      <span class="ml-pay ${s ? "ml-good" : "muted"}">${pay}</span></li>`;
  }).join("");
  return `<div class="ml-tabs" role="tablist">
      <button role="tab" data-act="tab" data-tab="open" aria-selected="${ui.tab !== "served"}">Open (${open.length})</button>
      <button role="tab" data-act="tab" data-tab="served" aria-selected="${ui.tab === "served"}">Served (${served.length})</button>
      <span class="g-note">value / yr · cr / yr</span></div>
    <ul class="ml-contracts">${rows || `<li class="muted ml-empty">${ui.tab === "served" ? "Nothing served yet." : "Every contract is served."}</li>`}</ul>`;
}

/** Plain-text description of a contract (native title tooltips and the map tooltip). */
export function contractText(env, c, s) {
  const lines = [`${c.a.name} ↔ ${c.b.name}`];
  if (c.kind === "faf") {
    lines.push(`Real freight flow, FAF5 2024 (rank ${c.rank} of the 40 largest interstate flows): ${money(c.value)} a year, ${Math.round(c.tons / 1e3).toLocaleString("en-US")}K tons${c.mode ? `, mostly by ${c.mode}` : ""}${c.commodity ? `; top commodity: ${c.commodity}` : ""}. FAF values are model estimates.`);
  } else {
    lines.push(`Model contract: a gravity model (GDP × GDP ÷ distance^${env.gravity.alpha.toFixed(2)}, fitted to the ${env.gravity.n} FAF metro-to-metro flows) puts it at ${money(c.value)} a year. Not a measured flow.`);
  }
  lines.push(`${c.km} km apart in a straight line.`);
  if (s) lines.push(`Served: ${s.km.toFixed(0)} km by rail (detour ${s.detour.toFixed(2)}×), pays ${s.pay.toFixed(1)} cr this year (≈ ${usd(s.pay)}).`);
  else lines.push(`Open: join both ends with intact track to earn up to ${S.payFor(c.value, 1).toFixed(1)} cr a year (more as the cities grow).`);
  return lines.join("\n");
}

export function endHtml(m, best) {
  const { env, state, sum } = m;
  const rows = S.byState(env, state).slice(0, 8).map((r) => `<tr><td>${esc(r.state)}</td><td>${money(r.you)}</td><td>${money(r.base)}</td><td class="${r.uplift > 0 ? "ml-good" : ""}">${signed(r.uplift, 2)}</td></tr>`).join("");
  const h = state.hist;
  const maxU = Math.max(sum.goal * 1.2, ...h.map((x) => x.uplift), 0.001);
  const W = 300, H = 70;
  const pts = h.map((x, k) => `${((k / Math.max(1, h.length - 1)) * W).toFixed(1)},${(H - (x.uplift / maxU) * H).toFixed(1)}`).join(" ");
  const gy = (H - (sum.goal / maxU) * H).toFixed(1);
  const links = Object.keys(state.links).length;
  return `<div class="ml-end">
    <div class="ml-verdict ${sum.beat ? "win" : "lose"}">${sum.beat ? "You beat baseline America" : "Baseline America wins"}</div>
    <p>${esc(env.scenario.name)}${env.scenario.id === "sandbox" ? ` from ${esc(env.home?.name || "")}` : ""}, 2026–2050 · seed ${state.seed}</p>
    <div class="ml-top">
      <div class="g-stat"><b class="${sum.beat ? "ml-good" : "ml-bad"}">${signed(sum.uplift, 2)}</b><span>GDP vs baseline</span></div>
      <div class="g-stat"><b>${signed(sum.goal)}</b><span>goal</span></div>
      <div class="g-stat"><b>${sum.score}</b><span>score${best != null ? ` · best ${best}` : ""}</span></div>
    </div>
    <svg class="ml-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GDP uplift by year">
      <line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="goal"/><polyline points="${pts}"/></svg>
    <div class="g-note">GDP uplift over baseline America each year; the line is the goal.</div>
    <table class="ml-table"><tr><th>Region</th><td colspan="3">${money(sum.you)} with your network vs ${money(sum.base)} baseline (${env.cities.length} metros)</td></tr>
      <tr><th>Freight</th><td colspan="3">${cr(state.totals.revenue)} earned (≈ ${usd(state.totals.revenue)}), ${links} links built for ${cr(state.totals.built)}</td></tr>
      <tr><th>Resilience</th><td colspan="3">${pct(sum.resilience, 0)} of possible revenue survived ${state.totals.hits} disasters (${state.totals.damaged} links damaged)</td></tr></table>
    <div class="g-section">By state</div>
    <table class="ml-table ml-states"><tr><th></th><th>You</th><th>Baseline</th><th>Δ</th></tr>${rows}</table>
    <div class="g-row ml-actions">
      <button class="g-btn primary" data-act="again">Play again</button>
      <button class="g-btn" data-act="new">Choose scenario</button>
      <button class="g-btn" data-act="share">Copy result</button>
    </div>
    <p class="g-note">Score = GDP uplift in basis points + credits earned ÷ 10, scaled by resilience. Growth bonuses and
    model contracts are game models; FAF flows, metro trends and FEMA rates are real data.</p>
  </div>`;
}

export function shareText(m) {
  const { env, state, sum } = m;
  return `Mainline · ${env.scenario.name}${env.scenario.id === "sandbox" ? ` (${env.home?.name})` : ""} · seed ${state.seed}\n` +
    `${sum.beat ? "Beat" : "Lost to"} baseline America: ${signed(sum.uplift, 2)} GDP by 2050 (goal ${signed(sum.goal)}) · score ${sum.score}\n` +
    `${Object.keys(state.links).length} links · ${cr(state.totals.revenue)} freight revenue · ${pct(sum.resilience, 0)} resilience`;
}
