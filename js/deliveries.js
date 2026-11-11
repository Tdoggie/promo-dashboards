// =========================================================================
// Promo Kings — Deliveries board (ES module), matching the Sales/Production
// GPL-grade look. Job cards only (is_job_card = true) from public.job_card
// (RLS-gated; needs a logged-in staff role).
//
//   renderDeliveries(root, ctx)
//   ctx = { supabase, profile, role, canSeeMoney, setFreshness }
//
// Answers: what is PENDING (not fully delivered) with on-time risk + partial
// progress, what was DELIVERED recently (done, last 14 days), the weekly
// completion TREND (rolling 16 weeks), and a server-side SEARCH. On-time risk
// only ever counts a genuine promise date (non-genuine -> "No firm date").
// Money is hidden from rider/designer (counts shown instead of KES).
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime, pct
} from "./common.js";
import {
  statTile, barChart, donut, disposeAll, compact, splitFig, theme, catColor, hasECharts
} from "./charts.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2023, 2024, 2025, 2026];
const DAY = 86400000;
const RECENT_DAYS = 14;
const SOON_DAYS = 7;
const TREND_WEEKS = 16;
const PAGE = 50;
const TABLE_PAGE = 40;

// ---- Nairobi civil time (EAT, UTC+3, no DST) -----------------------------
function nairobiShift(ms) { return new Date(ms + 3 * 3600 * 1000); } // UTC fields read as Nairobi civil
function nairobi(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const n = nairobiShift(dt.getTime());
  return { year: n.getUTCFullYear(), month: n.getUTCMonth(), day: n.getUTCDate() };
}
function yearBounds(year) {
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
}
/** Key for the Monday-of-week (Nairobi) containing ms. */
function weekKeyOf(ms) {
  const s = nairobiShift(ms);
  const dow = (s.getUTCDay() + 6) % 7; // Mon = 0
  const m = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() - dow);
  const d = new Date(m);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
const NOW = Date.now();
const TODAY = nairobi(NOW);
const CURRENT_YEAR = YEARS.includes(TODAY.year) ? TODAY.year : YEARS[YEARS.length - 1];

// ---- Data access ---------------------------------------------------------
const JC_COLS =
  "so_id,so_name,customer_id,customer_name,rep,team,order_date,promise,genuine_promise," +
  "value_kes,delivery_state,deliveries,done_deliveries,last_delivery_done,on_time,procurement_group,ship_to_id,currency,synced_at";

async function fetchYearJobCards(year) {
  const [start, end] = yearBounds(year);
  const size = 1000;
  let from = 0;
  const rows = [];
  for (let guard = 0; guard < 40; guard++) {
    const { data, error } = await supabase
      .from("job_card").select(JC_COLS)
      .eq("is_job_card", true)
      .gte("order_date", start).lt("order_date", end)
      .order("order_date", { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return rows;
}

let _delRows = null; // Map<year, rows[]>
async function loadAll() {
  if (_delRows) return _delRows;
  const m = new Map();
  await Promise.all(YEARS.map(async (y) => { m.set(y, await fetchYearJobCards(y)); }));
  _delRows = m;
  return m;
}

/** Fully-delivered job cards in the last RECENT_DAYS, newest first. */
async function fetchRecentlyDelivered() {
  const since = new Date(NOW - RECENT_DAYS * DAY).toISOString();
  const { data, error } = await supabase
    .from("job_card").select(JC_COLS)
    .eq("is_job_card", true).eq("delivery_state", "done")
    .gte("last_delivery_done", since)
    .order("last_delivery_done", { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
}

/** Completions in the rolling trend window (for the weekly bar). */
async function fetchTrendCompletions() {
  const since = new Date(NOW - (TREND_WEEKS + 1) * 7 * DAY).toISOString();
  const size = 1000;
  let from = 0;
  const rows = [];
  for (let guard = 0; guard < 8; guard++) {
    const { data, error } = await supabase
      .from("job_card").select("last_delivery_done,value_kes,on_time,genuine_promise,rep")
      .eq("is_job_card", true).eq("delivery_state", "done")
      .gte("last_delivery_done", since)
      .order("last_delivery_done", { ascending: false })
      .range(from, from + size - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return rows;
}

async function searchJobCards(term, page) {
  let q = supabase.from("job_card").select(JC_COLS, { count: "exact" }).eq("is_job_card", true);
  const s = (term || "").trim();
  if (s) {
    const safe = s.replace(/[%,()]/g, " ");
    q = q.or(`so_name.ilike.%${safe}%,customer_name.ilike.%${safe}%`);
  }
  const fromRow = page * PAGE;
  q = q.order("order_date", { ascending: false, nullsFirst: false }).range(fromRow, fromRow + PAGE - 1);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], total: count ?? 0 };
}

async function fetchFreshness() {
  const { data, error } = await supabase
    .from("job_card").select("synced_at")
    .order("synced_at", { ascending: false }).limit(1);
  if (error || !data || !data.length) return null;
  return data[0].synced_at;
}

// ---- Risk model ----------------------------------------------------------
function riskOf(row, nowMs) {
  const genuine = row.genuine_promise === true;
  const pMs = row.promise ? new Date(row.promise).getTime() : NaN;
  if (!genuine || !Number.isFinite(pMs)) return { key: "none", label: "No firm date", promiseMs: Infinity, daysLate: 0 };
  if (pMs < nowMs) return { key: "overdue", label: "Overdue", promiseMs: pMs, daysLate: Math.floor((nowMs - pMs) / DAY) };
  if (pMs <= nowMs + SOON_DAYS * DAY) return { key: "soon", label: "Due soon", promiseMs: pMs, daysLate: 0 };
  return { key: "track", label: "On track", promiseMs: pMs, daysLate: 0 };
}
const RISK_HEX = (t) => ({ overdue: t.red, soon: t.warn, track: t.success, none: t.slate });
function riskTint(key) { return key === "overdue" ? "jc--overdue" : key === "soon" ? "jc--soon" : key === "track" ? "jc--partial" : "jc--none"; }

// ---- Small UI builders ---------------------------------------------------
const nf = (n) => Number(n || 0).toLocaleString("en-KE");
const fmtMoneyC = (v) => kesCompact(v);

function stateBox(kind, title, sub) {
  const box = el("div", { class: "state" + (kind === "error" ? " state--error" : "") });
  if (kind === "loading") box.append(el("span", { class: "spinner spinner--ink" }));
  box.append(el("div", { class: "state-title", text: title }));
  if (sub) box.append(el("div", { class: "state-sub", text: sub }));
  return box;
}
function figNodes(str) {
  const { main, dec } = splitFig(str == null ? "—" : String(str));
  return [main, dec ? el("span", { class: "dec", text: dec }) : null];
}
function deliveryBadge(state) {
  const s = (state === "done" || state === "partial") ? state : "none";
  const cls = s === "done" ? "badge--done" : s === "partial" ? "badge--partial" : "badge--none";
  const label = s === "done" ? "Done" : s === "partial" ? "Partial" : "Not started";
  return el("span", { class: "badge " + cls, text: label });
}
function ontimeBadge(v) {
  if (v === true) return el("span", { class: "badge badge--ontime", text: "On time" });
  if (v === false) return el("span", { class: "badge badge--late", text: "Late" });
  return el("span", { class: "badge badge--na", text: "n/a" });
}
function riskBadge(risk) {
  const cls = risk.key === "overdue" ? "badge--late" : risk.key === "soon" ? "badge--partial" : risk.key === "track" ? "badge--done" : "badge--na";
  const label = risk.key === "overdue" ? `Overdue ${risk.daysLate}d` : risk.label;
  return el("span", { class: "badge " + cls, text: label });
}
function progressCell(done, total, state) {
  const dd = Number(done) || 0, td = Number(total) || 0;
  const frac = td > 0 ? Math.max(0, Math.min(1, dd / td)) : (state === "done" ? 1 : 0);
  const mod = state === "done" ? "done" : state === "partial" ? "partial" : "none";
  return el("div", { class: "prog" }, [
    el("div", { class: "prog-track" }, el("div", { class: "prog-fill prog-fill--" + mod, style: { width: (frac * 100).toFixed(0) + "%" } })),
    el("span", { class: "prog-label", text: `${dd}/${td || "—"}` })
  ]);
}
function card(title, sub, bodyId, tools) {
  const headKids = [el("h3", { text: title })];
  if (sub) headKids.push(el("span", { class: "subtle", text: sub }));
  if (tools) headKids.push(el("div", { class: "card-tools" }, tools));
  return el("div", { class: "card" }, [el("div", { class: "card-head" }, headKids), el("div", { id: bodyId })]);
}
function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) return "You may not have access to this data, or your session expired. Try signing in again.";
  return m;
}

// ---- Detail drawer (3-stage delivery pills) ------------------------------
function openJobDetail(row, canSeeMoney) {
  const r = row;
  const risk = riskOf(r, NOW);
  const dd = Number(r.done_deliveries) || 0, td = Number(r.deliveries) || 0;
  const done = r.delivery_state === "done", partial = r.delivery_state === "partial";
  const daysOpen = r.order_date ? Math.max(0, Math.floor((NOW - new Date(r.order_date).getTime()) / DAY)) : null;
  const stageIdx = done ? 2 : (partial ? 1 : 0);
  const pills = [
    { lbl: "Ordered", val: date(r.order_date), sub: "order placed", done: true },
    { lbl: "In progress", val: td ? `${dd} / ${td} delivered` : "—", sub: partial ? "part-delivered" : (done ? "complete" : "not started"), done },
    { lbl: "Delivered", val: done ? date(r.last_delivery_done) : "—", sub: done ? "fully delivered" : "pending", done }
  ];
  const pillStrip = el("div", { class: "seg-pills" }, pills.map((p, i) => el("div", {
    class: "seg-pill" + (i === stageIdx ? " seg-pill--on" : "") + (p.done ? " seg-pill--done" : "")
  }, [el("div", { class: "seg-pill-lbl", text: p.lbl }), el("div", { class: "seg-pill-val", text: p.val }), el("div", { class: "seg-pill-sub", text: p.sub })])));

  const qty = [
    canSeeMoney ? { lbl: "Value", val: kes(r.value_kes) } : null,
    { lbl: "Deliveries", val: `${dd} / ${td || "—"}` },
    { lbl: "Days open", val: daysOpen == null ? "—" : daysOpen + " d" },
    { lbl: "Days overdue", val: risk.key === "overdue" ? risk.daysLate + " d" : "0", alert: risk.key === "overdue" }
  ].filter(Boolean);
  const qtyCards = el("div", { class: "qty-cards" }, qty.map((q) => el("div", {
    class: "qty-card" + (q.alert ? " qty-card--alert" : "")
  }, [el("div", { class: "qty-card-lbl", text: q.lbl }), el("div", { class: "qty-card-val", text: q.val })])));

  const whereWords = done ? "Delivered" : risk.key === "overdue" ? `Overdue ${risk.daysLate} d`
    : partial ? `In progress ${dd}/${td || "?"}` : risk.key === "soon" ? "Due soon, not started" : "Not started";

  const fields = [
    ["SO", r.so_name], ["Customer", r.customer_name], ["Rep", r.rep || "—"], ["Team", r.team || "—"],
    ["Order date", dateTime(r.order_date)], ["Promise", dateTime(r.promise)], ["Genuine promise", r.genuine_promise ? "Yes" : "No"],
    ...(canSeeMoney ? [["Value", kes(r.value_kes)]] : []),
    ["Delivery state", r.delivery_state || "none"], ["Deliveries", `${dd} / ${td}`],
    ["Last delivery", dateTime(r.last_delivery_done)], ["On time", r.on_time === true ? "On time" : r.on_time === false ? "Late" : "n/a"],
    ["Procurement group", r.procurement_group ?? "—"], ["Synced", dateTime(r.synced_at)]
  ];
  const grid = el("dl", { class: "detail-grid" }, fields.map(([k, v]) => el("div", { class: "detail-row" }, [
    el("dt", { text: k }), el("dd", { text: (v == null || v === "") ? "—" : String(v) })
  ])));
  const summary = [`Ordered ${date(r.order_date)}`, r.promise ? `due ${date(r.promise)}` : "no firm date",
    risk.key === "overdue" ? `${risk.daysLate} d late` : (done ? "delivered" : "pending"),
    canSeeMoney ? kes(r.value_kes) : null].filter(Boolean).join(" · ");

  const close = () => scrim.remove();
  const scrim = el("div", { class: "drawer-scrim", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "drawer", on: { click: (e) => e.stopPropagation() } }, [
      el("div", { class: "drawer-head" }, [
        el("div", {}, [el("h3", { text: r.so_name || "Job card" }), el("div", { class: "subtle", text: `${r.customer_name || "—"}${r.rep ? " · " + r.rep : ""}` })]),
        el("button", { class: "drawer-close", type: "button", "aria-label": "Close", on: { click: close } }, "×")
      ]),
      el("div", { class: "subtle", text: summary, style: { marginBottom: "6px" } }),
      pillStrip, qtyCards,
      el("div", { class: "where-line" }, ["Where is it: ", el("strong", { text: whereWords })]),
      el("div", { class: "honesty", text: "Odoo order & delivery state via each order's procurement group — read as paperwork, not shop-floor progress." }),
      el("details", { style: { marginTop: "8px" } }, [el("summary", { class: "subtle", text: "All fields" }), grid])
    ])
  ]);
  scrim.addEventListener("click", close);
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  document.body.append(scrim);
}

// ---- Aggregation ---------------------------------------------------------
function pendingAgg(rows, rep, nowMs) {
  const scoped = rep ? rows.filter((r) => (r.rep || "") === rep) : rows;
  const pending = [];
  let value = 0, overdue = 0, soon = 0, track = 0, nofirm = 0, partial = 0;
  let deliveredCount = 0, deliveredValue = 0;
  for (const r of scoped) {
    if (r.delivery_state === "done") { deliveredCount += 1; deliveredValue += Number(r.value_kes) || 0; continue; }
    const risk = riskOf(r, nowMs);
    pending.push({ r, risk });
    value += Number(r.value_kes) || 0;
    if (risk.key === "overdue") overdue += 1;
    else if (risk.key === "soon") soon += 1;
    else if (risk.key === "track") track += 1;
    else nofirm += 1;
    if (r.delivery_state === "partial") partial += 1;
  }
  pending.sort((a, b) => a.risk.promiseMs - b.risk.promiseMs);
  return { scoped, pending, value, overdue, soon, track, nofirm, partial, deliveredCount, deliveredValue, count: pending.length };
}

// =========================================================================
// Main render
// =========================================================================
export async function renderDeliveries(root, ctx) {
  disposeAll();
  clear(root);
  const money = !!ctx.canSeeMoney;
  const t = theme();

  // ---- Controls: year + rep ----
  let selYear = CURRENT_YEAR;
  const yearSeg = el("div", { class: "seg", role: "group", "aria-label": "Year" },
    YEARS.map((y) => el("button", {
      type: "button", text: String(y), "aria-pressed": y === selYear ? "true" : "false",
      on: { click: () => { selYear = y; [...yearSeg.children].forEach((b) => b.setAttribute("aria-pressed", b.textContent === String(y) ? "true" : "false")); paint(); } }
    })));
  const repSel = el("select", { class: "select", id: "f-rep" }, [el("option", { value: "", text: "All reps" })]);

  const controls = el("div", { class: "controls" }, [
    el("div", { class: "control-grp" }, [el("span", { class: "eyebrow", text: "Year" }), yearSeg]),
    el("div", { class: "control-grp" }, [el("span", { class: "eyebrow", text: "Rep" }), repSel])
  ]);

  const head = el("div", { class: "section-head" }, [
    el("h2", { text: "Deliveries" }), el("div", { class: "subtle", id: "del-scope" }, "")
  ]);
  const scopeNote = el("div", { class: "scope-note", id: "del-note",
    html: "Pending and delivered status is from Odoo delivery state (via each order's procurement group). Risk reads off the genuine promise date only — a non-genuine promise shows as \"No firm date\". The weekly trend and \"delivered recently\" are rolling windows, independent of the year filter." });

  const tilesWrap = el("div", { class: "stat-tiles", id: "del-tiles" });

  const trendCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Deliveries completed per week" }), el("span", { class: "subtle", id: "del-trend-sub", text: `last ${TREND_WEEKS} weeks` })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-trend" }),
    el("div", { class: "chart-note", text: "Job cards whose final delivery landed in each week (Nairobi, Mon–Sun). A rolling operational view, not scoped to the selected year." })
  ]);
  const riskCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Pending by risk" }), el("span", { class: "subtle", id: "del-risk-sub", text: "open job cards" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-risk" })
  ]);
  const rowA = el("div", { class: "grid-2" }, [trendCard, riskCard]);

  // Pending table with filter chips
  const chipWrap = el("div", { class: "chips", id: "del-chips" });
  const pendSearch = el("input", { class: "input", id: "del-pend-search", type: "search", placeholder: "Filter SO / customer / rep…", autocomplete: "off" });
  const pendingBody = el("div", { id: "del-pending" });
  const pendingCard = el("div", { class: "card", id: "del-pending-card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Pending deliveries" }), el("span", { class: "subtle", id: "del-pending-sub", text: "most overdue first" })]),
    chipWrap,
    el("div", { class: "search-row", style: { marginTop: "10px" } }, [pendSearch]),
    pendingBody
  ]);

  const recentBody = el("div", { id: "del-recent" }, stateBox("loading", "Loading…"));
  const recentCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Delivered recently" }), el("span", { class: "subtle", id: "del-recent-sub", text: `last ${RECENT_DAYS} days` })]),
    recentBody
  ]);

  const searchInput = el("input", { class: "input", id: "del-search", type: "search", placeholder: "Search SO number or customer…", autocomplete: "off" });
  const searchBtn = el("button", { class: "btn btn--primary", type: "button", text: "Search" });
  const searchBody = el("div", { id: "del-search-body" });
  const searchCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Find a delivery" }), el("span", { class: "subtle", title: "Search all job cards by SO number or customer, newest first." }, "all job cards")]),
    el("div", { class: "search-row" }, [searchInput, searchBtn]),
    searchBody
  ]);

  root.append(head, controls, scopeNote, tilesWrap, rowA, pendingCard, recentCard, searchCard);
  tilesWrap.append(stateBox("loading", "Loading figures…"));

  // ---- Load (cached) ----
  let data;
  try { data = await loadAll(); }
  catch (err) { clear(tilesWrap); tilesWrap.append(stateBox("error", "Could not load deliveries", authy(err))); return; }
  if (typeof ctx.setFreshness === "function") fetchFreshness().then((ts) => { if (ts) ctx.setFreshness(ts); }).catch(() => {});

  // Populate reps
  (function populateReps() {
    const set = new Set();
    for (const y of YEARS) for (const r of (data.get(y) || [])) { const v = (r.rep || "").trim(); if (v) set.add(v); }
    [...set].sort((a, b) => a.localeCompare(b)).forEach((r) => repSel.append(el("option", { value: r, text: r })));
  })();
  repSel.addEventListener("change", paint);

  // Rolling-window data (fetched once; rep filter applied client-side)
  let recentRows = [], trendRows = [];
  const rolling = Promise.all([
    fetchRecentlyDelivered().then((r) => { recentRows = r; }).catch(() => { recentRows = null; }),
    fetchTrendCompletions().then((r) => { trendRows = r; }).catch(() => { trendRows = null; })
  ]);

  let AG = null;
  const tableState = { filter: "all", search: "", limit: TABLE_PAGE };

  function paint() {
    const rep = repSel.value || "";
    AG = pendingAgg(data.get(selYear) || [], rep, NOW);
    root.querySelector("#del-scope").textContent = `${selYear} · ${nf(AG.count)} pending` + (rep ? ` · ${rep}` : "");
    paintTiles(rep);
    paintTrend(rep);
    paintRiskDonut();
    tableState.limit = TABLE_PAGE;
    drawChips();
    drawPending();
    drawRecent(rep);
  }

  function paintTiles(rep) {
    clear(tilesWrap);
    tilesWrap.classList.toggle("stat-tiles--6", true);
    const go = (f) => () => { tableState.filter = f; tableState.limit = TABLE_PAGE; drawChips(); drawPending(); root.querySelector("#del-pending-card")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
    // recent on-time share (honour the genuine rule)
    let onN = 0, onD = 0;
    const rr = (recentRows || []).filter((r) => !rep || (r.rep || "") === rep);
    for (const r of rr) { if (r.genuine_promise === true && r.on_time != null) { onD += 1; if (r.on_time === true) onN += 1; } }
    const onShare = onD ? (onN / onD) * 100 : null;

    const tiles = [];
    tiles.push(statTile({ label: "Pending", value: nf(AG.count), color: t.cat[1], sub: money ? kesCompact(AG.value) + " at value" : "not fully delivered", caption: `${selYear} orders not yet complete`, onClick: go("all") }));
    tiles.push(statTile({ label: "Overdue", value: nf(AG.overdue), color: t.red, sub: "genuine promise past", caption: "Pending, promise date already passed", onClick: go("overdue") }));
    tiles.push(statTile({ label: "Due ≤ 7 days", value: nf(AG.soon), color: t.warn, sub: "genuine promise", caption: "Pending, promise within 7 days", onClick: go("soon") }));
    tiles.push(statTile({ label: "In progress", value: nf(AG.partial), color: t.cat[2], sub: "part-delivered", caption: "Delivery state is 'partial'", onClick: go("partial") }));
    tiles.push(statTile({ label: "Delivered (14d)", value: nf(rr.length), color: t.success, sub: "fully delivered", caption: `Completed in the last ${RECENT_DAYS} days` }));
    tiles.push(statTile({ label: "On-time (14d)", value: onShare == null ? "—" : pct(onShare), color: onShare == null ? t.slate : (onShare >= 90 ? t.success : t.warn), sub: onD ? `${nf(onD)} measurable` : "no measurable promises", caption: "On-time share of recent genuine promises" }));
    tiles.forEach((x) => tilesWrap.append(x));
  }

  function paintTrend(rep) {
    const node = root.querySelector("#ch-trend");
    if (trendRows === null) { clear(node); node.append(stateBox("info", "Trend unavailable", "Could not load recent completions.")); return; }
    // Build the last TREND_WEEKS week buckets (Mon-anchored, Nairobi).
    const s = nairobiShift(NOW);
    const dow = (s.getUTCDay() + 6) % 7;
    const thisMonday = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() - dow);
    const buckets = [], index = new Map();
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const mShift = thisMonday - i * 7 * DAY;
      const d = new Date(mShift);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      buckets.push({ key, label: `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`, count: 0 });
      index.set(key, buckets.length - 1);
    }
    for (const r of (trendRows || [])) {
      if (rep && (r.rep || "") !== rep) continue;
      if (!r.last_delivery_done) continue;
      const ms = new Date(r.last_delivery_done).getTime();
      if (isNaN(ms)) continue;
      const bi = index.get(weekKeyOf(ms));
      if (bi != null) buckets[bi].count += 1;
    }
    const total = buckets.reduce((a, b) => a + b.count, 0);
    root.querySelector("#del-trend-sub").textContent = `${nf(total)} in ${TREND_WEEKS} weeks`;
    if (!hasECharts()) { clear(node); node.append(stateBox("info", "Charts unavailable", "")); return; }
    barChart(node, { categories: buckets.map((b) => b.label), data: buckets.map((b) => b.count), color: catColor(1), valueFmt: compact, name: "Delivered", labelInterval: TREND_WEEKS > 10 ? 1 : 0 });
  }

  function paintRiskDonut() {
    const node = root.querySelector("#ch-risk");
    const items = [
      { name: "Overdue", value: AG.overdue, color: t.red },
      { name: "Due soon", value: AG.soon, color: t.warn },
      { name: "On track", value: AG.track, color: t.success },
      { name: "No firm date", value: AG.nofirm, color: t.slate }
    ];
    if (hasECharts()) donut(node, { items, valueFmt: compact, centerLabel: "pending", centerValue: nf(AG.count) });
    else { clear(node); node.append(stateBox("info", "Charts unavailable", "")); }
  }

  // -- Pending filter chips --
  function pendTest(key) {
    switch (key) {
      case "overdue": return (p) => p.risk.key === "overdue";
      case "soon": return (p) => p.risk.key === "soon";
      case "track": return (p) => p.risk.key === "track";
      case "none": return (p) => p.risk.key === "none";
      case "partial": return (p) => p.r.delivery_state === "partial";
      default: return () => true;
    }
  }
  function drawChips() {
    const defs = [["all", "All"], ["overdue", "Overdue"], ["soon", "Due ≤7"], ["partial", "In progress"], ["track", "On track"], ["none", "No firm date"]];
    clear(chipWrap);
    for (const [key, label] of defs) {
      const test = pendTest(key);
      const n = AG.pending.filter(test).length;
      chipWrap.append(el("button", {
        class: "chip", type: "button", "aria-pressed": tableState.filter === key ? "true" : "false",
        on: { click: () => { tableState.filter = key; tableState.limit = TABLE_PAGE; drawChips(); drawPending(); } }
      }, `${label} · ${nf(n)}`));
    }
  }

  function drawPending() {
    const body = pendingBody; clear(body);
    const test = pendTest(tableState.filter);
    const q = (tableState.search || "").trim().toLowerCase();
    let list = AG.pending.filter((p) => {
      if (!test(p)) return false;
      if (q) { const hay = `${p.r.so_name || ""} ${p.r.customer_name || ""} ${p.r.rep || ""}`.toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    const total = list.length;
    root.querySelector("#del-pending-sub").textContent = `${nf(total)} pending`;
    if (!total) { body.append(stateBox("info", "Nothing pending", "No job card matches the current filter.")); return; }
    const shown = list.slice(0, tableState.limit);

    const headCells = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Rep" }), el("th", { text: "Promised" }), el("th", { text: "Progress" }), el("th", { text: "Risk" })];
    if (money) headCells.push(el("th", { class: "num", text: "Value" }));
    const trs = shown.map(({ r, risk }) => {
      const cells = [
        el("td", { text: r.so_name || "—" }),
        el("td", { class: "wrap", text: r.customer_name || "—" }),
        el("td", { text: r.rep || "—" }),
        el("td", { title: dateTime(r.promise), text: r.promise ? date(r.promise) : "—" }),
        el("td", {}, progressCell(r.done_deliveries, r.deliveries, r.delivery_state)),
        el("td", {}, riskBadge(risk))
      ];
      if (money) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
      return el("tr", { class: "clickable " + riskTint(risk.key), tabindex: "0", on: {
        click: () => openJobDetail(r, money), keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openJobDetail(r, money); } }
      } }, cells);
    });
    body.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, headCells)), el("tbody", {}, trs)])));
    if (total > tableState.limit) {
      body.append(el("div", { class: "pager" }, [
        el("span", { class: "subtle", text: `Showing ${nf(shown.length)} of ${nf(total)}` }),
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Show more", on: { click: () => { tableState.limit += TABLE_PAGE; drawPending(); } } })
      ]));
    } else {
      body.append(el("div", { class: "pager" }, [el("span", { class: "subtle", text: `${nf(total)} shown` }), el("span")]));
    }
  }
  pendSearch.addEventListener("input", () => { tableState.search = pendSearch.value; tableState.limit = TABLE_PAGE; drawPending(); });

  function drawRecent(rep) {
    const rb = root.querySelector("#del-recent"); clear(rb);
    if (recentRows === null) { rb.append(stateBox("error", "Could not load recent deliveries", "Try again shortly.")); return; }
    const rows = (recentRows || []).filter((r) => !rep || (r.rep || "") === rep);
    root.querySelector("#del-recent-sub").textContent = `${nf(rows.length)} in last ${RECENT_DAYS} days`;
    if (!rows.length) { rb.append(stateBox("info", "Nothing in the last 14 days", "No job card was fully delivered recently.")); return; }
    const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Rep" }), el("th", { text: "Delivered" }), el("th", { text: "On time" })];
    if (money) head.push(el("th", { class: "num", text: "Value" }));
    const trs = rows.slice(0, 100).map((r) => {
      const cells = [
        el("td", { text: r.so_name || "—" }),
        el("td", { class: "wrap", text: r.customer_name || "—" }),
        el("td", { text: r.rep || "—" }),
        el("td", { title: dateTime(r.last_delivery_done), text: date(r.last_delivery_done) }),
        el("td", {}, ontimeBadge(r.on_time))
      ];
      if (money) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
      return el("tr", { class: "clickable", tabindex: "0", on: {
        click: () => openJobDetail(r, money), keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openJobDetail(r, money); } }
      } }, cells);
    });
    rb.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, trs)])));
  }

  // -- Server-side search --
  let searchTerm = "";
  async function runSearch(page) {
    clear(searchBody); searchBody.append(stateBox("loading", "Searching…"));
    try {
      const { rows, total } = await searchJobCards(searchTerm, page);
      clear(searchBody);
      if (!rows.length) { searchBody.append(stateBox("info", "No job cards found", searchTerm ? "Try a different SO number or customer name." : "No job cards available.")); return; }
      const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Promised" }), el("th", { text: "Progress" }), el("th", { text: "Delivery" }), el("th", { text: "On time" })];
      if (money) head.push(el("th", { class: "num", text: "Value" }));
      const trs = rows.map((r) => {
        const cells = [
          el("td", { text: r.so_name || "—" }),
          el("td", { class: "wrap", text: r.customer_name || "—" }),
          el("td", { title: dateTime(r.promise), text: r.promise ? date(r.promise) : "—" }),
          el("td", {}, progressCell(r.done_deliveries, r.deliveries, r.delivery_state)),
          el("td", {}, deliveryBadge(r.delivery_state)),
          el("td", {}, ontimeBadge(r.on_time))
        ];
        if (money) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
        return el("tr", { class: "clickable", tabindex: "0", on: {
          click: () => openJobDetail(r, money), keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openJobDetail(r, money); } }
        } }, cells);
      });
      searchBody.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, trs)])));
      const pages = Math.max(1, Math.ceil(total / PAGE));
      searchBody.append(el("div", { class: "pager" }, [
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "‹ Prev", disabled: page <= 0, on: { click: () => runSearch(page - 1) } }),
        el("span", { class: "subtle", text: `${nf(total)} result${total === 1 ? "" : "s"} · page ${page + 1} of ${pages}` }),
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Next ›", disabled: page >= pages - 1, on: { click: () => runSearch(page + 1) } })
      ]));
    } catch (err) { clear(searchBody); searchBody.append(stateBox("error", "Search failed", authy(err))); }
  }
  searchBtn.addEventListener("click", () => { searchTerm = searchInput.value; runSearch(0); });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { searchTerm = searchInput.value; runSearch(0); } });

  // ---- Kick off ----
  paint();                 // pending/tiles/donut from cached year rows (instant)
  rolling.then(() => { paint(); });  // repaint once rolling-window data lands (trend + recent + tiles)
  runSearch(0);
}
