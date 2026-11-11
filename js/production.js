// =========================================================================
// Promo Kings — Production board ("what is where"), GPL PlanView grammar
// adapted to Promo's job_card data (ES module).
//
// Job cards only (is_job_card = true), read from public.job_card
// (RLS-gated; needs a logged-in staff role). Every figure is derived
// client-side from a paginated, cached pull of each year's rows.
//
//   renderProduction(root, ctx)
//   ctx = { supabase, profile, role, canSeeMoney, setFreshness }
//
// HONEST TRANSLATION (vs GPL): job_card has no physical quantity, no unit,
// no routes/BoM/work-centres and no floor timing. So this board reads the
// Odoo order + delivery STATE as "what is where" paperwork, not shop-floor
// progress. Measures are COUNT, VALUE (KES) and DELIVERY STATE only — never kg.
//
// Panels: hero OTD% + KPI tiles -> delivery-state by month (stacked) +
// created-vs-delivered + state donut -> ageing histogram + by rep -> year
// over year -> the "what is where" job table with filter chips + drill
// drawer -> data-attention. OTD honours the genuine-promise rule throughout.
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime, pct
} from "./common.js";
import {
  statTile, stackedBar, barChart, hBar, lineArea, donut, legendChips,
  disposeAll, compact, fmtDelta, splitFig, theme, catColor, hasECharts
} from "./charts.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2023, 2024, 2025, 2026];
const DAY = 86400000;
const SOON_DAYS = 7;
const TABLE_PAGE = 40;

// ---- Nairobi civil-date parts (EAT, UTC+3, no DST) -----------------------
function nairobi(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const n = new Date(dt.getTime() + 3 * 3600 * 1000);
  return { year: n.getUTCFullYear(), month: n.getUTCMonth(), day: n.getUTCDate() };
}
function yearBounds(year) {
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
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

// Module-level cache: switching year / rep / measure is instant after first load.
let _jcRows = null; // Map<year, rows[]>
async function loadAll() {
  if (_jcRows) return _jcRows;
  const m = new Map();
  await Promise.all(YEARS.map(async (y) => { m.set(y, await fetchYearJobCards(y)); }));
  _jcRows = m;
  return m;
}

async function fetchFreshness() {
  const { data, error } = await supabase
    .from("job_card").select("synced_at")
    .order("synced_at", { ascending: false }).limit(1);
  if (error || !data || !data.length) return null;
  return data[0].synced_at;
}

// ---- "Where is it" (plain words + urgency) -------------------------------
function whereInfo(r, nowMs) {
  const done = r.delivery_state === "done";
  const partial = r.delivery_state === "partial";
  const genuine = r.genuine_promise === true;
  const pMs = r.promise ? new Date(r.promise).getTime() : NaN;
  const hasPromise = Number.isFinite(pMs);
  const lastMs = r.last_delivery_done ? new Date(r.last_delivery_done).getTime() : 0;
  const overdue = !done && genuine && hasPromise && pMs < nowMs;
  const daysLate = overdue ? Math.floor((nowMs - pMs) / DAY) : 0;
  const dueSoon = !done && !overdue && genuine && hasPromise && pMs >= nowMs && pMs <= nowMs + SOON_DAYS * DAY;
  const dd = Number(r.done_deliveries) || 0, td = Number(r.deliveries) || 0;
  let key, label;
  if (done) { key = "done"; label = "Delivered"; }
  else if (overdue) { key = "overdue"; label = `Overdue ${daysLate} d`; }
  else if (partial) { key = "partial"; label = `In progress ${dd}/${td || "?"}`; }
  else { key = "none"; label = hasPromise && genuine ? "Not started" : "Not started · no firm date"; }
  return { key, label, done, partial, overdue, dueSoon, daysLate, pMs: hasPromise ? pMs : Infinity, lastMs, hasPromise, genuine };
}
const WHERE_HEX = (t) => ({ overdue: t.red, done: t.success, partial: t.warn, soon: t.warn, none: t.slate });
function rankOf(w) { if (w.done) return 4; if (w.overdue) return 0; if (w.dueSoon) return 1; if (w.partial) return 2; return 3; }

// ---- Data-attention flags ------------------------------------------------
function flagsOf(r, w) {
  const out = [];
  const dd = Number(r.done_deliveries) || 0, td = Number(r.deliveries) || 0;
  if (td > 0 && dd > td) out.push("done > planned");
  if (r.delivery_state === "done" && td > 0 && dd < td) out.push("marked done, deliveries short");
  if (!w.done && !r.promise) out.push("open, no promise date");
  if (!w.done && r.promise && r.genuine_promise !== true) out.push("promise excluded from OTD");
  return out;
}

// ---- Aggregation (client-side) ------------------------------------------
function summarize(rows, rep, nowMs) {
  const scoped = rep ? rows.filter((r) => (r.rep || "") === rep) : rows;
  let total = 0, open = 0, overdue = 0, soon = 0;
  let openValue = 0, deliveredCount = 0, deliveredValue = 0;
  let otdNum = 0, otdDen = 0, otdExcl = 0;
  const mCard = Array(12).fill(0), mValue = Array(12).fill(0), mDelivered = Array(12).fill(0);
  const mOpen = Array(12).fill(0), mOtdN = Array(12).fill(0), mOtdD = Array(12).fill(0);
  const mState = { none: Array(12).fill(0), partial: Array(12).fill(0), done: Array(12).fill(0) };
  const dstate = { none: { count: 0, value: 0 }, partial: { count: 0, value: 0 }, done: { count: 0, value: 0 } };
  const age = { track: 0, w1: 0, w8: 0, w31: 0, w90: 0 };
  const repMap = new Map(), teamMap = new Map();
  let flagCount = 0;

  for (const r of scoped) {
    total += 1;
    const v = Number(r.value_kes) || 0;
    const p = nairobi(r.order_date); const m = p ? p.month : null;
    if (m != null) { mCard[m] += 1; mValue[m] += v; }
    const st = (r.delivery_state === "done") ? "done" : (r.delivery_state === "partial") ? "partial" : "none";
    dstate[st].count += 1; dstate[st].value += v;
    if (m != null) mState[st][m] += 1;

    const w = whereInfo(r, nowMs);
    if (st === "done") {
      deliveredCount += 1; deliveredValue += v;
      const dp = nairobi(r.last_delivery_done);
      if (dp) mDelivered[dp.month] += 1;
    } else {
      open += 1; openValue += v; if (m != null) mOpen[m] += 1;
      if (w.overdue) {
        overdue += 1;
        if (w.daysLate <= 7) age.w1 += 1;
        else if (w.daysLate <= 30) age.w8 += 1;
        else if (w.daysLate <= 90) age.w31 += 1;
        else age.w90 += 1;
      } else {
        age.track += 1;
        if (w.dueSoon) soon += 1;
      }
    }

    // OTD (genuine, measurable promises only)
    if (r.genuine_promise === true && r.on_time != null) {
      otdDen += 1; if (m != null) mOtdD[m] += 1;
      if (r.on_time === true) { otdNum += 1; if (m != null) mOtdN[m] += 1; }
    } else if (r.promise) { otdExcl += 1; }

    if (flagsOf(r, w).length) flagCount += 1;

    // by rep / team
    const addTo = (map, name) => {
      let e = map.get(name);
      if (!e) { e = { name, count: 0, value: 0, open: 0, openValue: 0, overdue: 0, otdN: 0, otdD: 0 }; map.set(name, e); }
      e.count += 1; e.value += v;
      if (st !== "done") { e.open += 1; e.openValue += v; if (w.overdue) e.overdue += 1; }
      if (r.genuine_promise === true && r.on_time != null) { e.otdD += 1; if (r.on_time === true) e.otdN += 1; }
    };
    addTo(repMap, (r.rep || "").trim() || "Unassigned");
    addTo(teamMap, (r.team || "").trim() || "Unassigned");
  }

  const otd = otdDen ? (otdNum / otdDen) * 100 : null;
  const mOtd = mOtdD.map((d, i) => (d ? (mOtdN[i] / d) * 100 : null));
  return {
    count: scoped.length, total, open, overdue, soon, openValue,
    deliveredCount, deliveredValue, otd, otdNum, otdDen, otdExcl,
    mCard, mValue, mDelivered, mOpen, mOtd, mState, dstate, age,
    repMap, teamMap, flagCount
  };
}

// ---- Small UI builders ---------------------------------------------------
const nf = (n) => Number(n || 0).toLocaleString("en-KE");
const fmtMoneyC = (v) => kesCompact(v);
const pctAxis = (v) => Math.round(v) + "%";

function stateBox(kind, title, sub) {
  const box = el("div", { class: "state" + (kind === "error" ? " state--error" : "") });
  if (kind === "loading") box.append(el("span", { class: "spinner spinner--ink" }));
  box.append(el("div", { class: "state-title", text: title }));
  if (sub) box.append(el("div", { class: "state-sub", text: sub }));
  return box;
}
function card(title, sub, bodyId, tools) {
  const headKids = [el("h3", { text: title })];
  if (sub) headKids.push(el("span", { class: "subtle", text: sub }));
  if (tools) headKids.push(el("div", { class: "card-tools" }, tools));
  return el("div", { class: "card" }, [el("div", { class: "card-head" }, headKids), el("div", { id: bodyId })]);
}
function figNodes(str) {
  const { main, dec } = splitFig(str == null ? "—" : String(str));
  return [main, dec ? el("span", { class: "dec", text: dec }) : null];
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
function wherePill(w, t) {
  const color = WHERE_HEX(t)[w.overdue ? "overdue" : w.key] || t.slate;
  return el("span", { class: "where" }, [el("span", { class: "dot", style: { background: color } }), w.label]);
}
function rowTint(w) {
  if (w.overdue) return "jc--overdue";
  if (w.dueSoon) return "jc--soon";
  if (w.partial) return "jc--partial";
  if (w.done) return "jc--done";
  return "jc--none";
}
function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) {
    return "You may not have access to this data, or your session expired. Try signing in again.";
  }
  return m;
}

// ---- Detail drawer (3-stage delivery pills, honestly reduced) ------------
function openJobDetail(row, canSeeMoney) {
  const t = theme();
  const w = whereInfo(row, NOW);
  const dd = Number(row.done_deliveries) || 0, td = Number(row.deliveries) || 0;
  const daysOpen = row.order_date ? Math.max(0, Math.floor((NOW - new Date(row.order_date).getTime()) / DAY)) : null;

  // 3 delivery milestones: Ordered -> In progress -> Delivered. Ring the current one.
  const stageIdx = w.done ? 2 : (w.partial ? 1 : 0);
  const pills = [
    { lbl: "Ordered", val: date(row.order_date), sub: "order placed", done: true },
    { lbl: "In progress", val: td ? `${dd} / ${td} delivered` : "—", sub: w.partial ? "part-delivered" : (w.done ? "complete" : "not started"), done: w.done },
    { lbl: "Delivered", val: w.done ? date(row.last_delivery_done) : "—", sub: w.done ? "fully delivered" : "pending", done: w.done }
  ];
  const pillStrip = el("div", { class: "seg-pills" }, pills.map((p, i) => el("div", {
    class: "seg-pill" + (i === stageIdx ? " seg-pill--on" : "") + (p.done ? " seg-pill--done" : "")
  }, [
    el("div", { class: "seg-pill-lbl", text: p.lbl }),
    el("div", { class: "seg-pill-val", text: p.val }),
    el("div", { class: "seg-pill-sub", text: p.sub })
  ])));

  const qty = [
    canSeeMoney ? { lbl: "Value", val: kes(row.value_kes) } : null,
    { lbl: "Deliveries", val: `${dd} / ${td || "—"}` },
    { lbl: "Days open", val: daysOpen == null ? "—" : daysOpen + " d" },
    { lbl: "Days overdue", val: w.overdue ? w.daysLate + " d" : "0", alert: w.overdue }
  ].filter(Boolean);
  const qtyCards = el("div", { class: "qty-cards" }, qty.map((q) => el("div", {
    class: "qty-card" + (q.alert ? " qty-card--alert" : "")
  }, [el("div", { class: "qty-card-lbl", text: q.lbl }), el("div", { class: "qty-card-val", text: q.val })])));

  const fields = [
    ["SO", row.so_name], ["Customer", row.customer_name], ["Rep", row.rep || "—"], ["Team", row.team || "—"],
    ["Order date", dateTime(row.order_date)], ["Promise", dateTime(row.promise)],
    ["Genuine promise", row.genuine_promise ? "Yes" : "No"],
    ...(canSeeMoney ? [["Value", kes(row.value_kes)]] : []),
    ["Delivery state", row.delivery_state || "none"],
    ["Deliveries", `${dd} / ${td}`], ["Last delivery", dateTime(row.last_delivery_done)],
    ["On time", row.on_time === true ? "On time" : row.on_time === false ? "Late" : "n/a"],
    ["Procurement group", row.procurement_group ?? "—"], ["Synced", dateTime(row.synced_at)]
  ];
  const grid = el("dl", { class: "detail-grid" },
    fields.map(([k, v]) => el("div", { class: "detail-row" }, [
      el("dt", { text: k }), el("dd", { text: (v == null || v === "") ? "—" : String(v) })
    ])));

  const summary = [
    `Ordered ${date(row.order_date)}`,
    row.promise ? `due ${date(row.promise)}` : "no firm date",
    w.overdue ? `${w.daysLate} d late` : (w.done ? "delivered" : "on track"),
    canSeeMoney ? kes(row.value_kes) : null
  ].filter(Boolean).join(" · ");

  const close = () => scrim.remove();
  const scrim = el("div", { class: "drawer-scrim", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "drawer", on: { click: (e) => e.stopPropagation() } }, [
      el("div", { class: "drawer-head" }, [
        el("div", {}, [
          el("h3", { text: row.so_name || "Job card" }),
          el("div", { class: "subtle", text: `${row.customer_name || "—"}${row.rep ? " · " + row.rep : ""}` })
        ]),
        el("button", { class: "drawer-close", type: "button", "aria-label": "Close", on: { click: close } }, "×")
      ]),
      el("div", { class: "subtle", text: summary, style: { marginBottom: "6px" } }),
      pillStrip,
      qtyCards,
      el("div", { class: "where-line" }, ["Where is it: ", el("strong", { text: w.label })]),
      el("div", { class: "honesty", text: "Odoo order & delivery state — read as paperwork, not shop-floor progress. These are 3 delivery milestones, not production stages." }),
      el("details", { style: { marginTop: "8px" } }, [el("summary", { class: "subtle", text: "All fields" }), grid])
    ])
  ]);
  scrim.addEventListener("click", close);
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  document.body.append(scrim);
}

// =========================================================================
// Main render
// =========================================================================
export async function renderProduction(root, ctx) {
  disposeAll();
  clear(root);
  const money = !!ctx.canSeeMoney;
  const t = theme();

  // ---- Controls: year segmented, rep select, compare toggle ----
  let selYear = CURRENT_YEAR;
  let compareOn = true;

  const yearSeg = el("div", { class: "seg", role: "group", "aria-label": "Year" },
    YEARS.map((y) => el("button", {
      type: "button", text: String(y), "aria-pressed": y === selYear ? "true" : "false",
      on: { click: () => { selYear = y; [...yearSeg.children].forEach((b) => b.setAttribute("aria-pressed", b.textContent === String(y) ? "true" : "false")); paint(); } }
    })));
  const repSel = el("select", { class: "select", id: "f-rep" }, [el("option", { value: "", text: "All reps" })]);
  const cmpInput = el("input", { type: "checkbox", checked: true, on: { change: () => { compareOn = cmpInput.checked; paint(); } } });
  const cmpToggle = el("label", { class: "toggle" }, [cmpInput, el("span", { class: "track" }), el("span", { text: "Compare prior year" })]);

  const controls = el("div", { class: "controls" }, [
    el("div", { class: "control-grp" }, [el("span", { class: "eyebrow", text: "Year" }), yearSeg]),
    el("div", { class: "control-grp" }, [el("span", { class: "eyebrow", text: "Rep" }), repSel]),
    el("div", { class: "control-grp" }, [el("span", { class: "eyebrow", text: "Compare" }), cmpToggle])
  ]);

  const head = el("div", { class: "section-head" }, [
    el("h2", { text: "Production" }), el("div", { class: "subtle", id: "prod-scope" }, "")
  ]);
  const scopeNote = el("div", { class: "scope-note", id: "prod-note" });

  // ---- Scaffold ----
  const heroWrap = el("div", { id: "prod-hero" });
  const tilesWrap = el("div", { class: "stat-tiles", id: "prod-tiles" });

  const monthCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { id: "prod-month-title", text: "Delivery state by month" }), el("span", { class: "subtle", text: "where the year's work sits" })]),
    el("div", { class: "chart-box", id: "ch-state" }),
    el("div", { class: "legend", id: "lg-state" }),
    el("div", { class: "chart-note", text: "Each month's job cards split by their current delivery state. Months with no orders render blank, not zero." }),
    el("details", { style: { marginTop: "8px" } }, [el("summary", { class: "subtle", text: "Monthly table" }), el("div", { id: "tbl-state" })])
  ]);

  const flowCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Created vs delivered" }), el("span", { class: "subtle", text: "job cards / month" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-flow" }),
    el("div", { class: "chart-note", text: "Bars = job cards created (by order date). Line = job cards fully delivered (by last delivery date)." })
  ]);
  const donutCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Delivery state" }), el("span", { class: "subtle", id: "prod-donut-sub", text: "job cards" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-donut" }),
    el("div", { id: "prod-funnel" })
  ]);
  const rowFlow = el("div", { class: "grid-2" }, [flowCard, donutCard]);

  const ageCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Ageing of open jobs" }), el("span", { class: "subtle", text: "by days overdue" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-age" }),
    el("div", { class: "chart-note", text: "Open job cards bucketed by how far past a genuine promise date they are. On track = not overdue (or no firm date)." })
  ]);
  const repToolWrap = el("div", { class: "card-tools", id: "prod-rep-tools" });
  const repCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "By rep" }), repToolWrap]),
    el("div", { id: "hb-rep" })
  ]);
  const rowMid = el("div", { class: "grid-2" }, [ageCard, repCard]);

  const yoyMeasures = [["card", "Job cards"], ["value", "Value"], ["delivered", "Delivered"], ["otd", "OTD %"]];
  let yoyMeasure = "card";
  const yoySeg = el("div", { class: "seg", role: "group", "aria-label": "Measure" },
    yoyMeasures.filter(([k]) => money || k !== "value").map(([k, lbl]) => el("button", {
      type: "button", text: lbl, "aria-pressed": k === yoyMeasure ? "true" : "false",
      on: { click: () => { yoyMeasure = k; [...yoySeg.children].forEach((b) => b.setAttribute("aria-pressed", b.textContent === lbl ? "true" : "false")); paintYoY(); } }
    })));
  const yoyCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Year over year" }), el("div", { class: "card-tools" }, [yoySeg])]),
    el("div", { class: "chart-box chart-box--lg", id: "ch-yoy" }),
    el("div", { class: "legend", id: "lg-yoy" })
  ]);

  // Job table ("what is where")
  const chipWrap = el("div", { class: "chips", id: "prod-chips" });
  const searchInput = el("input", { class: "input", id: "prod-search", type: "search", placeholder: "Filter SO / customer / rep…", autocomplete: "off" });
  const tableBody = el("div", { id: "prod-table-body" });
  const tableCard = el("div", { class: "card", id: "prod-table-card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Where is it" }), el("span", { class: "subtle", id: "prod-table-sub", text: "one row per job card" })]),
    chipWrap,
    el("div", { class: "search-row", style: { marginTop: "10px" } }, [searchInput]),
    tableBody
  ]);

  const attnBody = el("div", { id: "prod-attn-body" });
  const attnCard = el("div", { class: "card", id: "prod-attn-card", hidden: true }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Data attention" }), el("span", { class: "subtle", text: "inconsistencies to check" })]),
    attnBody
  ]);

  root.append(head, controls, scopeNote, heroWrap, tilesWrap, monthCard, rowFlow, rowMid, yoyCard, tableCard, attnCard);

  // Loading
  tilesWrap.append(stateBox("loading", "Loading figures…"));

  // ---- Load (cached) ----
  let data;
  try { data = await loadAll(); }
  catch (err) { clear(tilesWrap); tilesWrap.append(stateBox("error", "Could not load production data", authy(err))); return; }
  if (typeof ctx.setFreshness === "function") fetchFreshness().then((ts) => { if (ts) ctx.setFreshness(ts); }).catch(() => {});

  // Populate reps
  (function populateReps() {
    const set = new Set();
    for (const y of YEARS) for (const r of (data.get(y) || [])) { const v = (r.rep || "").trim(); if (v) set.add(v); }
    [...set].sort((a, b) => a.localeCompare(b)).forEach((r) => repSel.append(el("option", { value: r, text: r })));
  })();
  repSel.addEventListener("change", paint);

  // Shared current aggregate for the job table + yoy
  let A = null, P = null, scopedRows = [];
  const tableState = { filter: "open", search: "", limit: TABLE_PAGE };

  function paint() {
    const rep = repSel.value || "";
    const curRows = data.get(selYear) || [];
    const prevRows = data.get(selYear - 1) || [];
    scopedRows = rep ? curRows.filter((r) => (r.rep || "") === rep) : curRows;
    A = summarize(curRows, rep, NOW);
    P = summarize(prevRows, rep, NOW);

    root.querySelector("#prod-scope").textContent = `${selYear} · ${nf(A.count)} job cards` + (rep ? ` · ${rep}` : "");
    root.querySelector("#prod-note").innerHTML =
      `Order & delivery state from Odoo — read as paperwork, not shop-floor progress (no routes, BoMs or floor timing exist in this data). ` +
      `OTD counts only genuine, measurable promises — <strong>${nf(A.otdExcl)}</strong> job card(s) this year had a non-genuine or placeholder promise and are excluded.`;

    paintHeroTiles();
    paintStateMonth();
    paintFlowDonut();
    paintAgeRep();
    paintYoY();
    tableState.limit = TABLE_PAGE;
    drawChips();
    drawTable();
    paintAttention();
  }

  // -- Hero (OTD%) + KPI tiles --
  function paintHeroTiles() {
    clear(heroWrap);
    const hd = (P.otd != null && A.otd != null) ? fmtDelta(A.otd, P.otd) : null;
    const hero = el("div", { class: "hero" }, [
      el("div", { class: "hero-main" }, [
        el("div", { class: "hero-label", text: "On-time delivery" }),
        el("div", { class: "hero-value" }, A.otd == null ? ["—"] : figNodes(pct(A.otd)))
      ]),
      el("div", { class: "hero-side" }, [
        hd ? el("div", { class: "hero-delta delta--" + hd.dir, text: hd.text + " vs " + (selYear - 1) }) : null,
        el("div", { class: "hero-sub", text: A.otdDen ? `${nf(A.otdDen)} measurable · ${nf(A.otdExcl)} excluded` : "no measurable promises this year" })
      ])
    ]);
    heroWrap.append(hero);

    clear(tilesWrap);
    tilesWrap.classList.toggle("stat-tiles--6", true);
    const go = (f) => () => { tableState.filter = f; tableState.limit = TABLE_PAGE; drawChips(); drawTable(); root.querySelector("#prod-table-card")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
    const tiles = [];
    tiles.push(statTile({ label: "Open job cards", value: nf(A.open), color: t.cat[1],
      sub: money ? kesCompact(A.openValue) + " open" : "", caption: "Not fully delivered (none or partial)",
      spark: A.mOpen, onClick: go("open") }));
    tiles.push(statTile({ label: "Overdue", value: nf(A.overdue), color: t.red,
      sub: "genuine promise past", caption: "Open, genuine promise date already passed", onClick: go("overdue") }));
    tiles.push(statTile({ label: "Due ≤ 7 days", value: nf(A.soon), color: t.warn,
      sub: "genuine promise", caption: "Open, genuine promise within 7 days", onClick: go("soon") }));
    tiles.push(statTile({ label: "In progress", value: nf(A.dstate.partial.count), color: t.cat[2],
      sub: "part-delivered", caption: "Delivery state is 'partial'", onClick: go("partial") }));
    tiles.push(statTile({ label: "Not started", value: nf(A.dstate.none.count), color: t.slate,
      sub: "no deliveries yet", caption: "Delivery state is 'none'", onClick: go("none") }));
    tiles.push(statTile({ label: money ? "Delivered value" : "Delivered", value: money ? kesCompact(A.deliveredValue) : nf(A.deliveredCount),
      color: t.success, sub: money ? `${nf(A.deliveredCount)} job cards` : "fully delivered",
      caption: `${selYear} orders now fully delivered`, onClick: go("done") }));
    tiles.forEach((x) => tilesWrap.append(x));
  }

  // -- Delivery state by month (stacked) --
  function paintStateMonth() {
    root.querySelector("#prod-month-title").textContent = "Delivery state by month";
    const series = [
      { name: "Not started", data: A.mState.none.slice(), color: t.slate },
      { name: "In progress", data: A.mState.partial.slice(), color: t.warn },
      { name: "Delivered", data: A.mState.done.slice(), color: t.success }
    ];
    // Coverage honesty: a month with zero job cards renders blank, not 0.
    for (let i = 0; i < 12; i++) {
      if (A.mCard[i] === 0) series.forEach((s) => { s.data[i] = null; });
    }
    const compareLine = compareOn ? { name: `${selYear - 1} created`, data: P.mCard.map((v, i) => P.mCard[i] === 0 ? null : v) } : null;
    const node = root.querySelector("#ch-state");
    if (!hasECharts()) { clear(node); node.append(stateBox("info", "Charts unavailable", "Could not load the charting library.")); return; }
    const inst = stackedBar(node, { categories: MONTHS, series, valueFmt: compact, compareLine });
    legendChips(root.querySelector("#lg-state"), inst,
      [...series.map((s) => ({ name: s.name, color: s.color })), ...(compareLine ? [{ name: compareLine.name, color: t.axisInk }] : [])]);

    // Monthly table
    const tbl = root.querySelector("#tbl-state"); clear(tbl);
    const head2 = [el("th", { text: "Month" }), el("th", { class: "num", text: "Not started" }), el("th", { class: "num", text: "In progress" }), el("th", { class: "num", text: "Delivered" }), el("th", { class: "num", text: "Total" })];
    const body = MONTHS.map((mo, i) => el("tr", {}, [
      el("td", { text: mo }),
      el("td", { class: "num", text: nf(A.mState.none[i]) }),
      el("td", { class: "num", text: nf(A.mState.partial[i]) }),
      el("td", { class: "num", text: nf(A.mState.done[i]) }),
      el("td", { class: "num", text: nf(A.mCard[i]) })
    ]));
    tbl.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head2)), el("tbody", {}, body)])));
  }

  // -- Created vs delivered + state donut + whole-year funnel --
  function paintFlowDonut() {
    const flowNode = root.querySelector("#ch-flow");
    if (hasECharts()) {
      stackedBar(flowNode, {
        categories: MONTHS,
        series: [{ name: "Created", data: A.mCard.map((v, i) => A.mCard[i] === 0 ? null : v), color: catColor(1) }],
        valueFmt: compact,
        compareLine: { name: "Delivered", data: A.mDelivered.slice() }
      });
    } else { clear(flowNode); flowNode.append(stateBox("info", "Charts unavailable", "")); }

    const ds = A.dstate;
    root.querySelector("#prod-donut-sub").textContent = money ? "by value" : "job cards";
    const items = [
      { name: "Not started", value: money ? ds.none.value : ds.none.count, color: t.slate },
      { name: "In progress", value: money ? ds.partial.value : ds.partial.count, color: t.warn },
      { name: "Delivered", value: money ? ds.done.value : ds.done.count, color: t.success }
    ];
    const dNode = root.querySelector("#ch-donut");
    if (hasECharts()) donut(dNode, { items, valueFmt: money ? fmtMoneyC : compact, centerLabel: money ? "value" : "job cards", centerValue: money ? kesCompact(ds.none.value + ds.partial.value + ds.done.value) : nf(A.total) });
    else { clear(dNode); dNode.append(stateBox("info", "Charts unavailable", "")); }

    // whole-year 3-segment funnel bar (count)
    const fWrap = root.querySelector("#prod-funnel"); clear(fWrap);
    const segs = [
      { v: ds.none.count, c: t.slate, lbl: "Not started" },
      { v: ds.partial.count, c: t.warn, lbl: "In progress" },
      { v: ds.done.count, c: t.success, lbl: "Delivered" }
    ];
    const tot = segs.reduce((a, s) => a + s.v, 0) || 1;
    fWrap.append(el("div", { class: "funnel", title: segs.map((s) => `${s.lbl}: ${nf(s.v)}`).join(" · ") },
      segs.filter((s) => s.v > 0).map((s) => el("div", { class: "funnel-seg", style: { flex: String(s.v), background: s.c }, title: `${s.lbl}: ${nf(s.v)}` }, s.v / tot > 0.08 ? nf(s.v) : ""))));
  }

  // -- Ageing histogram + by-rep list --
  let repMeasure = money ? "count" : "count";
  function paintAgeRep() {
    const ageNode = root.querySelector("#ch-age");
    const cats = ["On track", "1–7 d", "8–30 d", "31–90 d", "90+ d"];
    const vals = [A.age.track, A.age.w1, A.age.w8, A.age.w31, A.age.w90];
    const ramp = [t.muted, "#cbb26a", "#d98c3f", t.red, "#8f2a2c"];
    if (hasECharts()) barChart(ageNode, { categories: cats, data: vals, colors: ramp, valueFmt: compact, name: "Open jobs" });
    else { clear(ageNode); ageNode.append(stateBox("info", "Charts unavailable", "")); }

    // rep measure toggle (money only)
    const rt = root.querySelector("#prod-rep-tools"); clear(rt);
    if (money) {
      const seg = el("div", { class: "seg", role: "group", "aria-label": "Rep measure" },
        [["count", "Count"], ["value", "Value"]].map(([k, lbl]) => el("button", {
          type: "button", text: lbl, "aria-pressed": k === repMeasure ? "true" : "false",
          on: { click: () => { repMeasure = k; [...seg.children].forEach((b) => b.setAttribute("aria-pressed", b.textContent === lbl ? "true" : "false")); drawRep(); } }
        })));
      rt.append(seg);
    }
    drawRep();
  }
  function drawRep() {
    const useValue = money && repMeasure === "value";
    const rows = [...A.repMap.values()]
      .filter((e) => e.open > 0 || e.count > 0)
      .sort((a, b) => useValue ? b.openValue - a.openValue : b.open - a.open)
      .slice(0, 10)
      .map((e) => {
        const otd = e.otdD ? (e.otdN / e.otdD) * 100 : null;
        const sub = `${otd == null ? "OTD n/a" : "OTD " + pct(otd)}${e.overdue ? " · " + nf(e.overdue) + " overdue" : ""}`;
        return {
          label: e.name, sub, value: useValue ? e.openValue : e.open,
          display: useValue ? kesCompact(e.openValue) : nf(e.open),
          color: e.overdue > 0 ? t.red : t.cat[1],
          onClick: () => { repSel.value = e.name === "Unassigned" ? "" : e.name; paint(); }
        };
      });
    hBar(root.querySelector("#hb-rep"), { rows, emptyText: "No open job cards for any rep" });
  }

  // -- Year over year --
  function paintYoY() {
    const rep = repSel.value || "";
    const node = root.querySelector("#ch-yoy");
    if (!hasECharts()) { clear(node); node.append(stateBox("info", "Charts unavailable", "")); return; }
    const series = YEARS.map((y) => {
      const S = summarize(data.get(y) || [], rep, NOW);
      const arr = yoyMeasure === "value" ? S.mValue : yoyMeasure === "delivered" ? S.mDelivered : yoyMeasure === "otd" ? S.mOtd : S.mCard;
      const kind = y === CURRENT_YEAR ? "current" : y === CURRENT_YEAR - 1 ? "prev" : "older";
      const color = kind === "current" ? t.yearCurrent : kind === "prev" ? t.yearPrev : t.yearOlder;
      return { name: String(y), data: arr, kind, color };
    });
    const vfmt = yoyMeasure === "value" ? fmtMoneyC : yoyMeasure === "otd" ? ((v) => v == null ? "—" : pct(v)) : compact;
    const inst = lineArea(node, { categories: MONTHS, series, valueFmt: vfmt, yMax: yoyMeasure === "otd" ? 100 : undefined });
    legendChips(root.querySelector("#lg-yoy"), inst, series.map((s) => ({ name: s.name, color: s.color })));
  }

  // -- Filter chips with live counts --
  function cohortTest(key) {
    switch (key) {
      case "open": return (w) => !w.done;
      case "overdue": return (w) => w.overdue;
      case "soon": return (w) => w.dueSoon;
      case "partial": return (w, r) => r.delivery_state === "partial";
      case "none": return (w, r) => r.delivery_state !== "partial" && r.delivery_state !== "done";
      case "done": return (w, r) => r.delivery_state === "done";
      case "flags": return (w, r) => flagsOf(r, w).length > 0;
      default: return () => true;
    }
  }
  function drawChips() {
    const defs = [
      ["open", "Open"], ["overdue", "Overdue"], ["soon", "Due ≤7"], ["partial", "In progress"],
      ["none", "Not started"], ["done", "Delivered"], ["all", "All"], ["flags", "Flags"]
    ];
    clear(chipWrap);
    for (const [key, label] of defs) {
      const test = cohortTest(key);
      let n = 0;
      for (const r of scopedRows) { if (test(whereInfo(r, NOW), r)) n++; }
      chipWrap.append(el("button", {
        class: "chip", type: "button", "aria-pressed": tableState.filter === key ? "true" : "false",
        on: { click: () => { tableState.filter = key; tableState.limit = TABLE_PAGE; drawChips(); drawTable(); } }
      }, `${label} · ${nf(n)}`));
    }
  }

  // -- The "what is where" table --
  function drawTable() {
    const body = tableBody; clear(body);
    const test = cohortTest(tableState.filter);
    const q = (tableState.search || "").trim().toLowerCase();
    let jobs = [];
    for (const r of scopedRows) {
      const w = whereInfo(r, NOW);
      if (!test(w, r)) continue;
      if (q) {
        const hay = `${r.so_name || ""} ${r.customer_name || ""} ${r.rep || ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      jobs.push({ r, w });
    }
    const totalMatch = jobs.length;
    jobs.sort((a, b) => {
      const ra = rankOf(a.w), rb = rankOf(b.w);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return b.w.daysLate - a.w.daysLate;
      if (ra === 4) return (b.w.lastMs || 0) - (a.w.lastMs || 0);
      return a.w.pMs - b.w.pMs;
    });
    const shown = jobs.slice(0, tableState.limit);
    root.querySelector("#prod-table-sub").textContent = `${nf(totalMatch)} job card${totalMatch === 1 ? "" : "s"}`;

    if (!shown.length) { body.append(stateBox("info", "Nothing here", "No job card matches the current filter.")); return; }

    const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Rep" }),
      el("th", { text: "Where is it" }), el("th", { text: "Progress" }), el("th", { class: "num", text: "Days open" }), el("th", { text: "Due" })];
    if (money) head.push(el("th", { class: "num", text: "Value" }));

    const trs = shown.map(({ r, w }) => {
      const daysOpen = r.order_date ? Math.max(0, Math.floor((NOW - new Date(r.order_date).getTime()) / DAY)) : null;
      const cells = [
        el("td", { text: r.so_name || "—" }),
        el("td", { class: "wrap", text: r.customer_name || "—" }),
        el("td", { text: r.rep || "—" }),
        el("td", {}, wherePill(w, t)),
        el("td", {}, progressCell(r.done_deliveries, r.deliveries, r.delivery_state)),
        el("td", { class: "num", text: daysOpen == null ? "—" : daysOpen + "d" }),
        el("td", { title: dateTime(r.promise), text: r.promise ? date(r.promise) : "—" })
      ];
      if (money) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
      return el("tr", {
        class: "clickable " + rowTint(w), tabindex: "0",
        on: { click: () => openJobDetail(r, money), keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openJobDetail(r, money); } } }
      }, cells);
    });
    body.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, trs)])));
    if (totalMatch > tableState.limit) {
      body.append(el("div", { class: "pager" }, [
        el("span", { class: "subtle", text: `Showing ${nf(shown.length)} of ${nf(totalMatch)}` }),
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Show more", on: { click: () => { tableState.limit += TABLE_PAGE; drawTable(); } } })
      ]));
    } else {
      body.append(el("div", { class: "pager" }, [el("span", { class: "subtle", text: `${nf(totalMatch)} shown` }), el("span")]));
    }
  }
  searchInput.addEventListener("input", () => { tableState.search = searchInput.value; tableState.limit = TABLE_PAGE; drawTable(); });

  // -- Data attention --
  function paintAttention() {
    const items = [];
    for (const r of scopedRows) {
      const w = whereInfo(r, NOW);
      const fl = flagsOf(r, w);
      for (const f of fl) if (f !== "promise excluded from OTD") items.push({ r, msg: f });
    }
    const excl = A.otdExcl;
    const card = root.querySelector("#prod-attn-card");
    if (!items.length && !excl) { card.hidden = true; return; }
    card.hidden = false;
    clear(attnBody);
    attnBody.append(el("div", { class: "subtle", style: { marginBottom: "8px" },
      html: `<strong>${nf(excl)}</strong> promise(s) are non-genuine / placeholder and are excluded from OTD (not listed below). The rows below are true data inconsistencies.` }));
    if (!items.length) { attnBody.append(el("div", { class: "hbar-empty", text: "No row-level inconsistencies." })); return; }
    const shown = items.slice(0, 40);
    for (const { r, msg } of shown) {
      attnBody.append(el("div", { class: "attention-item clickable", tabindex: "0", on: {
        click: () => openJobDetail(r, money), keydown: (e) => { if (e.key === "Enter") openJobDetail(r, money); }
      } }, [
        el("span", { class: "ai-code", text: r.so_name || "—" }),
        el("span", { class: "ai-msg", text: msg }),
        el("span", { class: "subtle", text: r.customer_name || "" })
      ]));
    }
    if (items.length > shown.length) attnBody.append(el("div", { class: "subtle", style: { marginTop: "8px" }, text: `+ ${nf(items.length - shown.length)} more` }));
  }

  // ---- Kick off ----
  paint();
}
