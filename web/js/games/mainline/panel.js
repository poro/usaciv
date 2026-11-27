// Dock HTML for Mainline: the scenario picker, the in-game panel and the end screen. Pure string builders (escape
// every data string); index.js wires the clicks with event delegation on data-act / data-contract attributes.
import { esc, money, pct } from "../../format.js";
import * as S from "./sim/index.js";
import { usd } from "./view.js";
import { vsStandingsHtml, vsNewsHtml, vsReadyHtml } from "./vspanel.js";

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
  until repaired (on credit if you must). Click a link to harden it against one hazard at a time: each is priced by
  how often it strikes there. <kbd>E</kbd> ends the turn.</li>
  <li><b>Spend the surplus.</b> Double-track busy links (+${Math.round(S.DOUBLE_BONUS * 100)}% pay on routes over them) and
  build terminals in connected metros (the <i>Terminals</i> tab): a real port or cargo airport pays the most, and every
  level speeds the metro's growth.</li>
  <li><b>Run express trains.</b> Once a served contract's whole route is double track, launch passenger and express
  service on it (the <i>Express</i> tab). It costs a launch price and a yearly operating cost, and speeds the growth of
  every metro it stops at: the late game's way to turn cash into growth. Its growth effect is a game model.</li>
  <li><b>Wire power and fibre.</b> Switch the builder to <i>Power</i> (<kbd>2</kbd>) or <i>Fibre</i> (<kbd>3</kbd>).
  A power line from a real plant (EIA capacity) to the metro it supplies pays every year; coal and gas pay less each
  decade. Fibre between research metros pays a little and speeds both metros' growth. Lines are cheaper than track and
  disasters don't cut them. Their pay is a game model (the <i>Power &amp; fibre</i> tab). In versus every company earns from its own lines.</li>
</ol>`;

/** The first-run coach: three short steps (index.js moves them on as you play). */
const COACH = [
  (m) => `<b>Lay track.</b> Click a hex in <b>${esc(m.env.home?.name || "your home metro")}</b> (the gold station), then a hex
    toward another city: rail follows the cheapest route. The box below previews the cost before you build. Hills,
    mountains, cities, wetland and river crossings cost more; upgrading a real rail line costs much less.`,
  (m) => `${m.ev.served.size ? `<span class="ml-good">${m.ev.served.size} contract${m.ev.served.size === 1 ? "" : "s"} served.</span> ` : ""}<b>Serve a contract.</b>
    A contract pays every year once your track joins <i>both</i> of its cities. Click one in the Open list to see its ends
    on the map, then lay track to them.`,
  (m) => `<b>End the turn.</b> Press <b>End ${m.state.year}</b> (or <kbd>E</kbd>): contracts pay, disasters roll, metros grow.
    Keep going to 2050 and beat baseline America.`,
];
export const COACH_STEPS = COACH.length;

function coachHtml(m) {
  const k = m.ui.coach;
  if (k == null || k >= COACH.length || !COACH[k]) return "";
  return `<div class="ml-coach" role="note">
    <div class="g-row"><span class="ml-coach-n">Tutorial ${k + 1} of ${COACH.length}</span>
      <button class="icon-btn ml-x" data-act="coachSkip" aria-label="Skip the tutorial" title="Skip the tutorial">✕</button></div>
    <p>${COACH[k](m)}</p>
    <div class="g-row"><button class="g-btn" data-act="coachNext">${k + 1 < COACH.length ? "Next" : "Got it"}</button>
      <button class="g-btn ml-link-btn" data-act="coachSkip">Skip tutorial</button></div>
  </div>`;
}

const HZ_ICON = { hurricane: "🌀", flood: "🌊", fire: "🔥", severe_storm: "⛈️", winter: "❄️", other: "⚠️" };

export function pickerHtml({ save, saveEnv, cities, defaults, online = false, vs = "", daily = null }) {
  const resume = save && saveEnv && !save.over
    ? `<button class="g-btn primary ml-wide" data-act="resume">Resume ${esc(saveEnv.scenario.name)}${save.home && saveEnv.scenario.id === "sandbox" ? ` (${esc(saveEnv.home?.name || "")})` : ""}, ${save.year}</button>`
    : "";
  const cards = S.SCENARIOS.map((sc) => `<label class="ml-scn${sc.id === defaults.scenario ? " on" : ""}">
      <input type="radio" name="ml-scn" value="${sc.id}"${sc.id === defaults.scenario ? " checked" : ""}>
      <span><b>${esc(sc.name)}</b><span class="g-note">${esc(sc.blurb)}</span>
      <small>Budget ${sc.cash} cr · goal ${signed(sc.goal)} GDP vs baseline by 2050</small></span></label>`).join("");
  const opts = cities.map((c) => `<option value="${c.id}"${c.id === defaults.home ? " selected" : ""}>${esc(c.name)}, ${esc(c.states.join("-"))}</option>`).join("");
  const day = daily ? `<button class="g-btn ml-wide ml-daily-btn" data-act="daily" title="Same scenario and seed for everyone today; 10 years; one leaderboard">
      📅 Daily challenge: <b>${esc(daily.name)}</b>, 10 years${daily.status === "done" ? " · played" : daily.status ? ` · resume ${daily.status}` : ""}</button>` : "";
  return `<div class="ml-picker">
    ${resume}
    ${day}
    <p class="g-note">Build the freight rail network that carries the real America from 2026 to 2050. Real cities,
    real FAF freight flows, real FEMA disaster records.</p>
    <div class="g-section">Scenario</div>
    <div class="ml-scns">${cards}</div>
    <div class="ml-home" ${defaults.scenario === "sandbox" ? "" : "hidden"}><label>Home metro <select data-field="home">${opts}</select></label></div>
    <div class="g-row ml-seedrow"><label>Seed <input data-field="seed" type="number" min="0" max="999999" value="${defaults.seed}"></label>
      <button class="g-btn" data-act="reseed" type="button" title="A new random seed">🎲</button></div>
    <button class="g-btn primary ml-wide" data-act="start">Start</button>
    <button class="g-btn ml-link-btn ml-boards-link" data-act="boards" type="button"${online ? "" : " hidden"}>🏆 Leaderboards</button>
    <div class="ml-vs-slot">${vs}</div>
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
  ${ui.help ? `<div class="ml-helpbox"><div class="g-row"><b>How to play</b><button class="icon-btn ml-x" data-act="help" aria-label="Close">✕</button></div>${HOW_TO}<div class="g-row"><button class="g-btn primary" data-act="help">Got it</button><button class="g-btn" data-act="coachReplay">Replay the tutorial</button></div></div>` : ""}
  ${coachHtml(m)}
  <div class="ml-top">
    <div class="ml-year"><b>${state.year}</b><span>turn ${turn} of ${(state.end ?? 2050) - S.START_YEAR + 1}</span></div>
    <div class="g-stat" title="${esc(crTitle(state.cash))}${state.cash < 0 ? esc(` · in debt: ${Math.round(S.DEBT_RATE * 100)}% interest a year, nothing but repairs until it is paid off`) : ""}"><b class="${state.cash < 0 ? "ml-bad" : ""}">${cr(state.cash)}</b><span>${state.cash < 0 ? "debt" : "cash"}</span></div>
    <div class="g-stat" title="${esc(`Freight revenue ${cr(ev.revenue)} minus upkeep ${cr(ev.maint)} a year, at today's network`)}"><b class="${net >= 0 ? "ml-good" : "ml-bad"}">${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}</b><span>per year</span></div>
  </div>
  <div class="g-row ml-actions">
    ${m.vs ? `<span class="ml-vs-ready">${vsReadyHtml(m)}</span>` : `<button class="g-btn primary${ui.coach === 2 ? " ml-pulse" : ""}" data-act="end" title="End the year (E)">End ${state.year} <kbd>E</kbd></button>`}
    <button class="g-btn" data-act="undo" ${state.undo.length ? "" : "disabled"} title="Undo the last build, repair or hardening this turn (Z)">Undo <kbd>Z</kbd></button>
  </div>
  ${m.vs ? `${vsStandingsHtml(m)}${vsNewsHtml(m)}` : `  <div class="ml-goal" title="${esc(`Your region's metros: ${money(sum.you)} GDP; baseline America (same metros, real trend, no network): ${money(sum.base)}. Goal: ${signed(sum.goal)} by 2050.`)}">
    <div class="ml-goal-txt"><span>GDP vs baseline America</span><b class="${sum.uplift >= sum.goal ? "ml-good" : ""}">${signed(sum.uplift, 2)}</b><span class="muted">${state.daily ? `daily · ends ${state.end}` : `goal ${signed(sum.goal)}`}</span></div>
    <div class="ml-bar"><i style="width:${(goalPct * 100).toFixed(1)}%"></i><em style="left:${(goalMark * 100).toFixed(1)}%"></em></div>
  </div>`}
  ${env.grant && state.year === S.START_YEAR ? `<div class="g-note ml-grant" title="${esc(`Contracts with both ends within ${env.scenario.grant.km} km of ${env.home?.name} pay ${env.market} cr a year in all; the grant tops up homes below ${env.scenario.grant.ref}.`)}">Frontier grant: <b>+${env.grant} cr</b> at the start, because ${esc(env.home?.name || "your home")} has little freight within ${env.scenario.grant.km} km. A game model for balance, after the 1862 Pacific Railway Act's federal bonds.</div>` : ""}
  <div id="ml-build" class="ml-build">${buildHtml(m)}</div>
  ${ui.link && state.links[ui.link] ? linkHtml(m) : ""}
  ${eventsHtml(state)}
  ${dmg.length ? `<div class="ml-dmg"><span><b class="ml-bad">${dmg.length}</b> damaged link${dmg.length === 1 ? "" : "s"} carry nothing</span>
    <button class="g-btn" data-act="repairAll" title="${esc(crTitle(repairAll))}">Repair all ${cr(repairAll)}</button></div>` : ""}
  ${contractsHtml(m)}
  <div class="ml-checks">
    <label class="ml-check"><input type="checkbox" data-act="demand" ${ui.showDemand ? "checked" : ""}> Demand lines</label>
    <label class="ml-check"${ui.motion === false ? ` title="Off: your system asks for reduced motion"` : ` title="Animate trains on served routes"`}><input type="checkbox" data-act="trains" ${ui.trains && ui.motion !== false ? "checked" : ""}${ui.motion === false ? " disabled" : ""}> Trains</label>
    <label class="ml-check" title="Short synthesised sounds for building, End turn and disasters"><input type="checkbox" data-act="sound" ${ui.sound ? "checked" : ""}> Sound</label>
  </div>
  <div class="ml-foot g-note">
    <span>${esc(env.scenario.name)}${env.scenario.id === "sandbox" ? ` · ${esc(env.home?.name || "")}` : ""} · seed ${state.seed}</span>
    <span class="g-row"><button class="g-btn" data-act="help" title="How to play (H)">How to play</button>${m.vs ? `<button class="g-btn" data-act="vsLeave" title="${m.vs.mode === "online" ? "Leave the room (your company keeps its track; you can rejoin by the link)" : "Back to the scenarios (this game is saved)"}">Leave</button>` : `<button class="g-btn" data-act="new">New game</button>`}</span>
  </div>`;
}

const NET_LABEL = { rail: "Rail", power: "Power", fibre: "Fibre" };
function netSwitch(m) {
  if (!m.env.utility) return "";
  const cur = m.ui.net || "rail";
  return `<div class="ml-nets" role="radiogroup" aria-label="What to build">${["rail", "power", "fibre"].map((n, k) =>
    `<button role="radio" class="ml-net ml-net-${n}" data-act="net" data-net="${n}" aria-checked="${cur === n}" title="${NET_LABEL[n]} (${k + 1})">${NET_LABEL[n]}</button>`).join("")}</div>`;
}

export function buildHtml(m) {
  const { env, sel, touch } = m;
  const pl = sel.plan;
  const mode = m.ui.net || "rail";
  const sw = netSwitch(m);
  if (sel.start == null) {
    if (mode === "power") return `${sw}<span class="ml-hint">Click a <b>power plant</b> (yellow diamond) or a line of yours, then the metro it supplies. Each wired plant pays every year; the <i>Power &amp; fibre</i> tab lists them.</span>`;
    if (mode === "fibre") return `${sw}<span class="ml-hint">Click a <b>research metro</b> (blue ring), then another. Each linked pair pays a little and speeds both metros' growth.</span>`;
    const net = Object.keys(m.state.links).length;
    return `${sw}<span class="ml-hint">${net ? "Click a hex on your network to extend it" : `Click a hex in <b>${esc(env.home?.name || "your home metro")}</b> (the gold station) to start laying track`}, or click a contract below to see its ends.</span>`;
  }
  if (!pl) return `${sw}<span class="ml-hint">Now click where the ${mode === "rail" ? "track" : mode === "power" ? "power line" : "fibre"} should go. <kbd>Esc</kbd> cancels.</span>`;
  const unit = pl.net ? `${pl.net === "power" ? "power line" : "fibre"} segment` : "link";
  const head = pl.path ? `${sw}<div><b>${cr(pl.cost)}</b> <span class="muted">≈ ${usd(pl.cost)}</span> · ${pl.fresh} new ${unit}${pl.fresh === 1 ? "" : "s"}, ${pl.km} km</div>` : sw;
  const detail = pl.path ? [pl.rail ? `${pl.rail} upgrade real rail` : "", pl.rivers ? `${pl.rivers} river crossing${pl.rivers === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") : "";
  const err = pl.error ? `<div class="ml-bad">${esc(pl.error)}</div>` : "";
  const confirm = touch && sel.end != null && !pl.error
    ? `<div class="g-row"><button class="g-btn primary" data-act="build">Build ${cr(pl.cost)}</button><button class="g-btn" data-act="cancel">Cancel</button></div>` : "";
  return `${head}${detail ? `<div class="g-note">${detail}</div>` : ""}${err}${confirm}`;
}

function linkHtml(m) {
  const { env, state, ev, ui } = m;
  const l = state.links[ui.link];
  const rc = S.repairCost(env, l), dc = S.doubleCost(env, l);
  const ld = ev.loads.get(ui.link);
  const gain = ld ? S.DOUBLE_BONUS * ld.base : 0;
  const extra = Math.max(0.05, S.MAINT_RATE * l.cost) * (S.DOUBLE_MAINT - 1);
  const hz = S.hardenOptions(env, l);
  const where = [...new Set(hz.flatMap((h) => h.counties))].join(" / ");
  const rows = hz.map((h) => `<li class="${h.done ? "done" : ""}">
      <span>${HZ_ICON[h.type] || ""} ${esc(S.TYPE_NAME[h.type])}</span>
      <span class="muted" title="${esc(`${h.count} FEMA declaration${h.count === 1 ? "" : "s"} of this type in ${h.years} years in ${h.counties.join(" and ")}`)}">${h.count} in ${Math.round(h.years)} yr · ${(h.lam * 0.6 * 100).toFixed(1)}%/yr</span>
      ${h.done ? `<span class="ml-good">held</span>` : `<button class="g-btn" data-act="harden" data-hz="${esc(h.type)}" title="${esc(`${crTitle(h.cost)}. ${HARDEN_HOW[h.type] || ""}`)}">${cr(h.cost)}</button>`}</li>`).join("");
  return `<div class="ml-link">
    <div class="g-row"><b>Selected link</b><span class="muted">built ${l.year}, ${cr(l.cost)}</span>
      <button class="icon-btn ml-x" data-act="unlink" aria-label="Deselect">✕</button></div>
    <div>${l.d ? `<span class="ml-bad">Damaged</span>` : "Intact"} · ${l.dt ? `<span class="ml-good">double track</span>` : "single track"} ·
      ${ld ? `carries ${ld.n} contract${ld.n === 1 ? "" : "s"} (${ld.pay.toFixed(1)} cr/yr)` : `<span class="muted">carries no contract</span>`}</div>
    <div class="g-row">
      ${l.d ? `<button class="g-btn" data-act="repair" title="${esc(crTitle(rc))}">Repair ${cr(rc)}</button>` : ""}
      ${l.dt || l.d ? "" : `<button class="g-btn" data-act="double" title="${esc(`${crTitle(dc)}. Routes over it pay ${Math.round(S.DOUBLE_BONUS * 100)}% more on the share of their km it covers; upkeep ${S.DOUBLE_MAINT}×.`)}">Double-track ${cr(dc)}${ld ? ` <small>+${(gain - extra).toFixed(1)}/yr</small>` : ""}</button>`}
    </div>
    ${hz.length ? `<div class="g-note">Harden against one hazard at a time (FEMA record, ${esc(where)}):</div><ul class="ml-hz">${rows}</ul>` : `<div class="g-note">No FEMA disaster record in these counties: nothing to harden.</div>`}
    </div>`;
}

const HARDEN_HOW = {
  hurricane: "Raised embankment, storm-surge walls and anchored bridges.",
  flood: "Levees, bigger culverts and raised track.",
  fire: "Firebreaks, cleared right of way and steel ties.",
  severe_storm: "Wind-rated signals and buried lines.",
  winter: "Switch heaters and snow sheds.",
  other: "Seismic and coastal reinforcement.",
};

function hubsHtml(m) {
  const { env, state, ev } = m;
  const conn = S.connectedCities(env, state).sort((a, b) => state.cities[b.id].gdp - state.cities[a.id].gdp);
  if (!conn.length) return `<ul class="ml-contracts"><li class="muted ml-empty">Connect a metro to your network to build a terminal there.</li></ul>`;
  const rows = conn.map((c) => {
    const site = env.hubs.get(c.id);
    const lv = state.hubs?.[c.id] || 0;
    const cost = S.hubCost(env, state, c.id);
    let n = 0, pay = 0;
    for (const [id, sv] of ev.served) {
      const ct = env.contractById.get(id);
      if (ct.a.cities.includes(c.id) || ct.b.cities.includes(c.id)) { n++; pay += sv.base; }
    }
    const pips = Array.from({ length: S.HUB_MAX }, (_, k) => `<i class="${k < lv ? "on" : ""}"></i>`).join("");
    const tip = `${site.name}${site.detail ? `: ${site.detail}` : ""}. Each level: +${Math.round(site.rate * 100)}% pay on contracts touching ${c.name} and +${(S.HUB_GROWTH * 100).toFixed(2)}% GDP growth a year (× its network access); upkeep ${Math.round(S.HUB_MAINT * 100)}% of the cost a year.`;
    return `<li class="ml-hub" title="${esc(tip)}">
      <span class="ml-kind hub-${site.kind}">${esc(S.HUB_KIND[site.kind].label)}</span>
      <span class="ml-cname">${esc(c.name)}<small class="muted">${n ? ` · ${n} contract${n === 1 ? "" : "s"}, +${(pay * site.rate).toFixed(1)} cr/yr a level` : " · no contracts yet"}</small></span>
      <span class="ml-pips" aria-label="level ${lv} of ${S.HUB_MAX}">${pips}</span>
      ${cost == null ? `<span class="ml-good ml-pay">max</span>` : `<button class="g-btn ml-hubbtn" data-act="hub" data-city="${esc(c.id)}" ${cost > state.cash ? "disabled" : ""}>${lv ? "Raise" : "Build"} ${cost}</button>`}</li>`;
  }).join("");
  return `<ul class="ml-contracts ml-hubs">${rows}</ul>`;
}

function expressHtml(m) {
  const { env, state, ev } = m;
  const list = S.corridors(env, state, ev.served);
  const intro = `<li class="g-note ml-xnote">Passenger and express trains between metros on an all-double-track route. Each
    stop grows up to ${(S.EXPRESS_GROWTH * 100).toFixed(1)}% a year faster (more when the other stops are big; at most
    ${(S.EXPRESS_CAP * 100).toFixed(1)}% a metro), for a launch price and ${Math.round(S.EXPRESS_OPS * 100)}% of it a year
    in upkeep. The growth effect is a game model, not a forecast.</li>`;
  if (!list.length) return `<ul class="ml-contracts ml-hubs">${intro}<li class="muted ml-empty">Serve a contract between two metros first.</li></ul>`;
  const rows = list.map((k) => {
    const dc = k.keys.reduce((t, key) => t + (state.links[key] && !state.links[key].d ? S.doubleCost(env, state.links[key]) : 0), 0);
    const tip = `${k.a.name} ↔ ${k.b.name}: ${k.stops} metro${k.stops === 1 ? "" : "s"} with a station on the route. At today's sizes about ${money(k.gain)} more GDP a year before the per-metro cap (a game model). Launch ${cr(k.cost)}, upkeep ${cr(k.ops)} a year.`;
    let right;
    if (k.on) {
      right = `${k.ok ? `<span class="ml-good">running</span>` : `<span class="ml-bad" title="${esc(k.why || "")}">suspended</span>`}
        <button class="icon-btn ml-x" data-act="closeExpress" data-id="${esc(k.id)}" title="Close this service (no refund)" aria-label="Close">✕</button>`;
    } else if (k.ok) {
      right = `<button class="g-btn ml-hubbtn" data-act="express" data-id="${esc(k.id)}" ${k.cost > state.cash ? "disabled" : ""} title="${esc(`${crTitle(k.cost)}; then ${cr(k.ops)} a year`)}">Launch ${k.cost.toFixed(0)}</button>`;
    } else if (k.keys.length) {
      right = `<button class="g-btn ml-hubbtn" data-act="dtroute" data-id="${esc(k.id)}" ${dc > state.cash ? "disabled" : ""} title="${esc(`Double-track the ${k.keys.length} single-track link${k.keys.length === 1 ? "" : "s"} left on the route: ${crTitle(dc)}`)}">2× track ${dc.toFixed(0)}</button>`;
    } else right = `<span class="muted" title="${esc(k.why || "")}">blocked</span>`;
    return `<li class="ml-xrow${k.on ? " served" : ""}" title="${esc(tip)}">
      <span class="ml-kind ${k.c.kind}">${k.c.kind === "faf" ? "FAF" : "model"}</span>
      <span class="ml-cname">${esc(k.a.name)} ↔ ${esc(k.b.name)}<small class="muted"> · ${k.stops} stops, +${money(k.gain)}/yr${k.on || k.ok ? "" : ` · ${k.keys.length} single`}</small></span>
      <span class="ml-xact">${right}</span></li>`;
  }).join("");
  return `<ul class="ml-contracts ml-hubs">${intro}${rows}</ul>`;
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
  const { env, state, ev, ui } = m;
  const net = S.networkCells(state);
  for (const x of env.homeCells) net.add(x);
  const onNet = (end) => end.cells.some((x) => net.has(x));
  const full = (c) => S.payFor(c.value, 1, c.km);
  // open: best pay first, and the ones you are already halfway to on top of their pay band
  // versus: a contract a rival holds can't pay you (it sinks to the bottom, marked with the holder)
  const holder = (c) => { const h = m.vs?.vs?.claims[c.id]; return h != null && h !== m.vs.me ? h : null; };
  const open = env.contracts.filter((c) => !ev.served.has(c.id))
    .map((c) => ({ c, pay: full(c), ends: (onNet(c.a) ? 1 : 0) + (onNet(c.b) ? 1 : 0), rival: holder(c) }))
    .sort((x, y) => (x.rival != null) - (y.rival != null) || y.pay - x.pay || y.ends - x.ends);
  const served = env.contracts.filter((c) => ev.served.has(c.id)).map((c) => ({ c, pay: ev.served.get(c.id).pay })).sort((x, y) => y.pay - x.pay);
  const tab = ui.tab;
  const list = tab === "served" ? served : open;
  const top = Math.max(1, ...list.map((r) => r.pay));
  const rows = list.map(({ c, pay, ends, rival = null }) => {
    const s = ev.served.get(c.id);
    const boost = s && s.base > 0 ? s.pay / s.base : 1;
    const rname = rival != null ? m.vs.vs.players[rival]?.name || "a rival" : "";
    const mark = rival != null ? `<i class="ml-vs-dot" style="--c:${S.VS_COLORS[rival]}" title="${esc(`${rname} holds it`)}"></i>`
      : !s && ends ? `<i class="ml-half" title="One end is already on your network"></i>` : "";
    const tip = contractText(env, c, s) + (rival != null ? `\nHeld by ${rname}: it pays them, not you, while their track serves it. If their route is cut and yours serves it, it becomes yours.` : "");
    return `<li data-contract="${esc(c.id)}" class="${s ? "served" : ""}${rival != null ? " rival" : ""}${ui.highlight === c.id ? " on" : ""}" title="${esc(tip)}" style="--w:${((pay / top) * 100).toFixed(0)}%">
      <span class="ml-kind ${c.kind}">${c.kind === "faf" ? "FAF" : "model"}</span>
      <span class="ml-cname">${mark}${esc(c.a.name)} ↔ ${esc(c.b.name)}</span>
      <span class="ml-val">${money(c.value)} · ${c.km} km</span>
      <span class="ml-pay ${s ? "ml-good" : ""}">${s ? "+" : ""}${pay.toFixed(1)}${boost > 1.005 ? `<small title="Double track and terminals: ×${boost.toFixed(2)}">×${boost.toFixed(2)}</small>` : ""}</span></li>`;
  }).join("");
  const nHubs = Object.values(state.hubs || {}).reduce((a, b) => a + b, 0);
  const nExp = Object.keys(state.express || {}).length;
  const nUtil = (ev.utility?.power.size || 0) + (ev.utility?.talent.size || 0);
  const utilTab = env.utility ? `<button role="tab" data-act="tab" data-tab="utility" aria-selected="${tab === "utility"}">Power &amp; fibre${nUtil ? ` (${nUtil})` : ""}</button>` : "";
  return `<div class="ml-tabs" role="tablist">
      <button role="tab" data-act="tab" data-tab="open" aria-selected="${tab === "open"}">Open (${open.length})</button>
      <button role="tab" data-act="tab" data-tab="served" aria-selected="${tab === "served"}">Served (${served.length})</button>
      <button role="tab" data-act="tab" data-tab="hubs" aria-selected="${tab === "hubs"}">Terminals${nHubs ? ` (${nHubs})` : ""}</button>
      <button role="tab" data-act="tab" data-tab="express" aria-selected="${tab === "express"}">Express${nExp ? ` (${nExp})` : ""}</button>
      ${utilTab}
      <span class="g-note">${tab === "hubs" ? "level · cost cr" : tab === "express" ? "stops · cost cr" : tab === "utility" ? "cr / yr" : "value · cr / yr"}</span></div>
    ${tab === "hubs" ? hubsHtml(m) : tab === "express" ? expressHtml(m) : tab === "utility" && utilTab ? utilityHtml(m) : `<ul class="ml-contracts">${rows || `<li class="muted ml-empty">${tab === "served" ? "Nothing served yet." : "Every contract is served."}</li>`}</ul>`}`;
}

const PLANT = { nuclear: "Nuclear", hydro: "Hydro", wind: "Wind", solar: "Solar", geothermal: "Geothermal", gas_plant: "Gas", coal_plant: "Coal" };
function utilityHtml(m) {
  const { env, state, ev, ui } = m;
  const u = env.utility;
  const cityName = (id) => env.cities[env.cityIdx.get(id)]?.name || id;
  const row = (c, pay, on, label, sub, title) => `<li data-ucontract="${esc(c.id)}" class="${on ? "served" : ""}${ui.highlight === c.id ? " on" : ""}" title="${esc(title)}">
      <span class="ml-kind ${c.kind}">${label}</span><span class="ml-cname">${sub}</span>
      <span class="ml-pay ${on ? "ml-good" : ""}">${on ? "+" : ""}${pay.toFixed(1)}</span></li>`;
  const power = u.power.map((c) => {
    const got = ev.utility?.power.get(c.id);
    const tr = S.transitionShare(c.type, state.year);
    const pay = got ?? c.base * (1 - tr);
    return { on: got != null, pay, html: row(c, pay, got != null, PLANT[c.type] || c.type, `${esc(c.name)} → ${esc(cityName(c.city))} <span class="muted">${c.mw.toLocaleString("en-US")} MW · ${c.km} km</span>`,
      `${c.name}: ${c.mw} MW (EIA-860M) for ${cityName(c.city)}, ${c.km} km.${tr ? ` Transition cost this decade: −${Math.round(tr * 100)}% (a game model).` : ""} Pay is a game model: ln(1 + MW/100) × metro size.`) };
  }).sort((a, b) => b.on - a.on || b.pay - a.pay);
  const talent = u.talent.map((c) => {
    const got = ev.utility?.talent.get(c.id);
    return { on: got != null, pay: got ?? c.base, html: row(c, got ?? c.base, got != null, "talent", `${esc(cityName(c.a))} ↔ ${esc(cityName(c.b))} <span class="muted">${c.km} km</span>`,
      `Fibre between two research metros (Science yield, cities.json). Pays a little and adds ${(S.TALENT_GROWTH * 100).toFixed(2)}% GDP growth a year at both ends (a game model).`) };
  }).sort((a, b) => b.on - a.on || b.pay - a.pay);
  const nP = power.filter((r) => r.on).length, nT = talent.filter((r) => r.on).length;
  return `<p class="g-note">Lines cost ${Math.round(S.LINE_FACTOR.power * 100)}% (power) or ${Math.round(S.LINE_FACTOR.fibre * 100)}% (fibre) of rail on the same hexes, upkeep ${Math.round(S.LINE_MAINT * 100)}% a year, and are not hit by disasters. Press <kbd>2</kbd> or <kbd>3</kbd> to build them.</p>
    <div class="ml-util-h">Power plants <span class="muted">${nP} of ${power.length} wired</span></div>
    <ul class="ml-contracts">${power.map((r) => r.html).join("") || `<li class="muted ml-empty">No large plants in this region.</li>`}</ul>
    <div class="ml-util-h">Research links <span class="muted">${nT} of ${talent.length} linked</span></div>
    <ul class="ml-contracts">${talent.map((r) => r.html).join("") || `<li class="muted ml-empty">Too few research metros here.</li>`}</ul>`;
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
  if (s) {
    lines.push(`Served: ${s.km.toFixed(0)} km by rail (detour ${s.detour.toFixed(2)}×), pays ${s.pay.toFixed(1)} cr this year (≈ ${usd(s.pay)}).`);
    if (s.pay > s.base + 0.05) lines.push(`Upgrades add ${(s.pay - s.base).toFixed(1)} cr: ${Math.round((s.dkm / Math.max(1, s.km)) * 100)}% of the route on double track${s.hub ? `, terminals +${Math.round(s.hub * 100)}%` : ""}.`);
  }
  else lines.push(`Open: join both ends with intact track to earn up to ${S.payFor(c.value, 1, c.km).toFixed(1)} cr a year (more as the cities grow).`);
  return lines.join("\n");
}

/** End screen. online = the board model (see boardHtml), or null when the site has no multiplayer backend. */
export function endHtml(m, best, online = null) {
  const { env, state, sum } = m;
  const rows = S.byState(env, state).slice(0, 8).map((r) => `<tr><td>${esc(r.state)}</td><td>${money(r.you)}</td><td>${money(r.base)}</td><td class="${r.uplift > 0 ? "ml-good" : ""}">${signed(r.uplift, 2)}</td></tr>`).join("");
  const h = state.hist;
  const maxU = Math.max(sum.goal * 1.2, ...h.map((x) => x.uplift), 0.001);
  const W = 300, H = 70;
  const pts = h.map((x, k) => `${((k / Math.max(1, h.length - 1)) * W).toFixed(1)},${(H - (x.uplift / maxU) * H).toFixed(1)}`).join(" ");
  const gy = (H - (sum.goal / maxU) * H).toFixed(1);
  const links = Object.keys(state.links).length;
  return `<div class="ml-end">
    ${state.daily ? `<div class="ml-verdict win">Daily challenge · ${esc(state.daily)}</div>
    <p>${esc(env.scenario.name)}, 2026–${state.end} · the same map and seed for everyone today</p>`
    : `<div class="ml-verdict ${sum.beat ? "win" : "lose"}">${sum.beat ? "You beat baseline America" : "Baseline America wins"}</div>
    <p>${esc(env.scenario.name)}${env.scenario.id === "sandbox" ? ` from ${esc(env.home?.name || "")}` : ""}, 2026–2050 · seed ${state.seed}</p>`}
    <div class="ml-top">
      <div class="g-stat"><b class="${sum.beat ? "ml-good" : "ml-bad"}">${signed(sum.uplift, 2)}</b><span>GDP vs baseline</span></div>
      ${state.daily ? "" : `<div class="g-stat"><b>${signed(sum.goal)}</b><span>goal</span></div>`}
      <div class="g-stat"><b>${sum.score}</b><span>score${best != null ? ` · best ${best}` : ""}</span></div>
    </div>
    <svg class="ml-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GDP uplift by year">
      <line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="goal"/><polyline points="${pts}"/></svg>
    <div class="g-note">GDP uplift over baseline America each year; the line is the goal.</div>
    ${online ? boardHtml(online) : ""}
    <table class="ml-table"><tr><th>Region</th><td colspan="3">${money(sum.you)} with your network vs ${money(sum.base)} baseline (${env.cities.length} metros)</td></tr>
      <tr><th>Freight</th><td colspan="3">${cr(state.totals.revenue)} earned (≈ ${usd(state.totals.revenue)}), ${links} links built for ${cr(state.totals.built)}</td></tr>
      <tr><th>Upgrades</th><td colspan="3">${cr(state.totals.upgrades || 0)} on double track and terminals, ${cr(state.totals.hardening)} on hardening</td></tr>
      <tr><th>Express</th><td colspan="3">${Object.keys(state.express || {}).length} service${Object.keys(state.express || {}).length === 1 ? "" : "s"} launched for ${cr(state.totals.express || 0)}; ${cr(state.cash)} left unspent</td></tr>
      <tr><th>Resilience</th><td colspan="3">${pct(sum.resilience, 0)} of possible revenue survived ${state.totals.hits} disasters (${state.totals.damaged} links damaged)</td></tr></table>
    <div class="g-section">By state</div>
    <table class="ml-table ml-states"><tr><th></th><th>You</th><th>Baseline</th><th>Δ</th></tr>${rows}</table>
    <div class="g-row ml-actions">
      <button class="g-btn primary" data-act="again">Play again</button>
      <button class="g-btn" data-act="new">Choose scenario</button>
      <button class="g-btn" data-act="share">Copy result</button>
      <button class="g-btn" data-act="image">Download image</button>
    </div>
    <p class="g-note">Score = GDP uplift in basis points + credits earned ÷ 10, scaled by resilience. Growth bonuses,
    express services, the frontier grant and model contracts are game models; FAF flows, metro trends and FEMA rates are
    real data.</p>
  </div>`;
}

export function shareText(m) {
  const { env, state, sum } = m;
  return `Mainline${state.daily ? ` daily ${state.daily}` : ""} · ${env.scenario.name}${env.scenario.id === "sandbox" ? ` (${env.home?.name})` : ""} · seed ${state.seed}\n` +
    `${sum.beat ? "Beat" : "Lost to"} baseline America: ${signed(sum.uplift, 2)} GDP by 2050 (goal ${signed(sum.goal)}) · score ${sum.score}\n` +
    `${Object.keys(state.links).length} links · ${cr(state.totals.revenue)} freight revenue · ${pct(sum.resilience, 0)} resilience`;
}

// --- online boards (only when net.available(); docs/MULTIPLAYER.md) ---

export const boardName = (sc) => (sc.id === "sandbox" ? "Sandbox" : sc.name);

/** Board rows: rank, name, uplift (and home for Sandbox). you = the response's `you` ({rank, …} or null). */
function boardTable(rows, { you = null, sandbox = false, cityName = (id) => id } = {}) {
  if (!rows?.length) return `<p class="g-note">No runs yet. Be the first.</p>`;
  let marked = false;
  const tr = rows.map((r) => {
    const mine = !marked && you && r.rank === you.rank && (you.uplift == null || r.uplift === you.uplift);
    if (mine) marked = true;
    return `<tr${mine ? ' class="ml-you"' : ""}><td>${r.rank}</td><td>${esc(r.name)}${mine ? ' <span class="ml-you-tag">you</span>' : ""}</td>` +
      `${sandbox ? `<td>${esc(r.home ? cityName(r.home) : "")}</td>` : ""}<td class="${r.uplift >= 0 ? "ml-good" : "ml-bad"}">${signed(r.uplift, 2)}</td></tr>`;
  }).join("");
  return `<table class="ml-table ml-board"><tr><th>#</th><th>Player</th>${sandbox ? "<th>Home</th>" : ""}<th>GDP</th></tr>${tr}</table>`;
}

/**
 * The end screen's board section. o = {scenario (the scenario object), hasLog, player ({name} | null), nick,
 * status: "idle" | "sending" | "done", error, result ({uplift, beat, rank, total, best, improved}), board ({top, you, total}),
 * cityName(id)}
 */
export function boardHtml(o) {
  const name = o.daily ? `daily ${o.daily}` : boardName(o.scenario);
  const sandbox = o.scenario.id === "sandbox";
  let inner;
  if (!o.hasLog) {
    inner = `<p class="g-note">This game was saved before Mainline kept a move log, so it can't be submitted to the board.
      Your next game can be.</p>`;
  } else if (o.status === "done" && o.result) {
    const r = o.result;
    const bestNote = o.daily ? (r.stored ? " Only your first finished game of the day counts." : "")
      : r.improved === true ? " A new personal best."
      : typeof r.best === "number" && r.best > r.uplift ? ` Your best stays ${signed(r.best, 2)}.` : "";
    inner = `<p>Rank <b>#${r.rank}</b> of ${r.total} on the ${esc(name)} board with ${signed(r.uplift, 2)}.${bestNote}</p>
      ${o.board ? boardTable(o.board.top, { you: o.board.you, sandbox, cityName: o.cityName }) : ""}`;
  } else {
    const sending = o.status === "sending";
    inner = `<form class="ml-submit" data-form="submit">
      ${o.player ? `<span class="g-note">Posting as <b>${esc(o.player.name)}</b></span>`
        : `<label class="ml-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters" value="${esc(o.nick || "")}"></label>`}
      <button class="g-btn primary" type="submit"${sending ? " disabled" : ""}>${sending ? "Submitting…" : `Submit to the ${esc(name)} board`}</button>
    </form>
    <p class="g-note">The server replays your moves to check the score.</p>`;
  }
  return `<div class="ml-online"><div class="g-section">Online board</div>${inner}
    ${o.error ? `<p class="ml-bad ml-err" role="alert">${esc(o.error)}</p>` : ""}</div>`;
}

/**
 * The picker's Leaderboards view: each scenario's top 5. boards = {scenarioId: {top, total} | {error}} or null while
 * loading.
 */
export function boardsHtml({ boards, cityName = (id) => id }) {
  const secs = S.SCENARIOS.map((sc) => {
    const b = boards?.[sc.id];
    const body = !boards ? `<p class="g-note">Loading…</p>`
      : b?.error ? `<p class="ml-bad ml-err">${esc(b.error)}</p>`
      : `${boardTable(b?.top, { sandbox: sc.id === "sandbox", cityName })}${b?.total > (b?.top?.length || 0) ? `<p class="g-note">${b.total} runs in all</p>` : ""}`;
    return `<div class="g-section">${esc(sc.name)}</div>${body}`;
  }).join("");
  return `<div class="ml-boards">
    <div class="g-row"><b>Leaderboards</b><button class="g-btn" data-act="boardsBack">Back</button></div>
    <p class="g-note">The best GDP uplift over baseline America by 2050, one run per player. The server replays every run.</p>
    ${secs}
  </div>`;
}
