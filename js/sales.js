// =========================================================================
// Promo Kings — Sales dashboard (ES module)
//
// Reads public.job_card (RLS-gated; needs a logged-in staff role) and renders
// a GPL PlanView-grade sales dashboard adapted to Promo's job_card data:
// Pulse strip -> controls -> hero + stat tiles -> order-intake-by-month
// (stacked by team) -> by rep / top customers -> by team mix / delivery-state
// -> backlog + OTD trend -> year-over-year -> clients + concentration
// -> movers -> job-card search with drill drawer.
//
// All figures aggregate client-side from a paginated pull of each year's rows
// (cached across route switches). Money is hidden from rider/designer: every
// value widget falls back to order/job-card counts when ctx.canSeeMoney=false.
//   renderSales(root, ctx)   ctx = { supabase, profile, role, canSeeMoney, setFreshness }
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime, pct
} from "./common.js";
import {
  statTile, sparkline, stackedBar, hBar, lineArea, donut, legendChips,
  disposeAll, compact, fmtDelta, theme, catColor, hasECharts
} from "./charts.js";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2023, 2024, 2025, 2026];
const PAGE = 50;          // search table page size
const DAY = 86400000;

// ---- Nairobi civil-date parts (EAT, UTC+3, no DST) -----------------------
function nairobi(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const n = new Date(dt.getTime() + 3 * 3600 * 1000);
  return { year: n.getUTCFullYear(), month: n.getUTCMonth(), day: n.getUTCDate() };
}
function nairobiKey(d) {
  const p = nairobi(d);
  if (!p) return null;
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function yearBounds(year) {
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
}

const NOW = Date.now();
const TODAY = nairobi(NOW);
const CURRENT_YEAR = YEARS.includes(TODAY.year) ? TODAY.year : YEARS[YEARS.length - 1];

// ---- Data access ---------------------------------------------------------
const DASH_COLS =
  "value_kes,is_job_card,genuine_promise,on_time,delivery_state," +
  "customer_id,customer_name,rep,team,order_date,promise";

async function fetchYearRows(year) {
  const [start, end] = yearBounds(year);
  const size = 1000;
  let from = 0;
  const rows = [];
  for (let guard = 0; guard < 40; guard++) {
    const { data, error } = await supabase
      .from("job_card").select(DASH_COLS)
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

// Module-level cache so switching sections/years is instant after first load.
let _allRows = null; // Map<year, rows[]>
async function loadAll() {
  if (_allRows) return _allRows;
  const m = new Map();
  await Promise.all(YEARS.map(async (y) => { m.set(y, await fetchYearRows(y)); }));
  _allRows = m;
  return m;
}

async function fetchFreshness() {
  const { data, error } = await supabase
    .from("job_card").select("synced_at")
    .order("synced_at", { ascending: false }).limit(1);
  if (error || !data || !data.length) return null;
  return data[0].synced_at;
}

const SEARCH_COLS =
  "so_id,so_name,is_job_card,customer_id,customer_name,rep,team,order_date,promise," +
  "genuine_promise,value_kes,currency,procurement_group,ship_to_id,deliveries," +
  "done_deliveries,last_delivery_done,delivery_state,on_time,synced_at";

async function searchJobCards(term, page) {
  let q = supabase.from("job_card").select(SEARCH_COLS, { count: "exact" }).eq("is_job_card", true);
  const t = (term || "").trim();
  if (t) {
    const safe = t.replace(/[%,()]/g, " ");
    q = q.or(`so_name.ilike.%${safe}%,customer_name.ilike.%${safe}%`);
  }
  const fromRow = page * PAGE;
  q = q.order("order_date", { ascending: false, nullsFirst: false }).range(fromRow, fromRow + PAGE - 1);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], total: count ?? 0 };
}

// ---- Aggregation (client-side) ------------------------------------------
function summarize(rows, rep) {
  const scoped = rep ? rows.filter((r) => (r.rep || "") === rep) : rows;
  let intake = 0, orders = 0, jobCards = 0, open = 0, otdNum = 0, otdDen = 0, otdExcl = 0;
  const mInt = Array(12).fill(0), mCard = Array(12).fill(0), mOrders = Array(12).fill(0);
  const mOtdN = Array(12).fill(0), mOtdD = Array(12).fill(0);
  const custMap = new Map(), teamMap = new Map(), repMap = new Map();
  const dstate = { none: { count: 0, value: 0 }, partial: { count: 0, value: 0 }, done: { count: 0, value: 0 } };
  const backlog = { od30: 0, od1: 0, thismonth: 0, nextmonth: 0, later: 0, nopromise: 0 };
  const backlogV = { od30: 0, od1: 0, thismonth: 0, nextmonth: 0, later: 0, nopromise: 0 };
  const nn = nairobi(NOW);
  let nmY = nn.year, nmM = nn.month + 1; if (nmM > 11) { nmM = 0; nmY++; }

  for (const r of scoped) {
    const v = Number(r.value_kes) || 0;
    const p = nairobi(r.order_date);
    const m = p ? p.month : null;
    intake += v; orders += 1;
    if (m != null) { mInt[m] += v; mOrders[m] += 1; }

    const ck = r.customer_id != null ? "id:" + r.customer_id : "nm:" + (r.customer_name || "—");
    let c = custMap.get(ck);
    if (!c) { c = { name: r.customer_name || "—", value: 0, orders: 0, lastMs: 0, rep: r.rep || "" }; custMap.set(ck, c); }
    c.value += v; c.orders += 1; if (r.customer_name) c.name = r.customer_name;
    const oms = r.order_date ? new Date(r.order_date).getTime() : 0; if (oms > c.lastMs) c.lastMs = oms;

    const tk = (r.team || "").trim() || "Unassigned";
    let tm = teamMap.get(tk);
    if (!tm) { tm = { name: tk, value: 0, orders: 0, months: Array(12).fill(0), monthsC: Array(12).fill(0) }; teamMap.set(tk, tm); }
    tm.value += v; tm.orders += 1; if (m != null) { tm.months[m] += v; tm.monthsC[m] += 1; }

    const rk = (r.rep || "").trim() || "Unassigned";
    let rm = repMap.get(rk);
    if (!rm) { rm = { name: rk, value: 0, orders: 0 }; repMap.set(rk, rm); }
    rm.value += v; rm.orders += 1;

    if (r.is_job_card === true) {
      jobCards += 1; if (m != null) mCard[m] += 1;
      const st = (r.delivery_state === "done") ? "done" : (r.delivery_state === "partial") ? "partial" : "none";
      dstate[st].count += 1; dstate[st].value += v;
      if (st !== "done") open += 1;

      if (r.genuine_promise === true && r.on_time != null) {
        otdDen += 1; if (m != null) mOtdD[m] += 1;
        if (r.on_time === true) { otdNum += 1; if (m != null) mOtdN[m] += 1; }
      } else if (r.promise) { otdExcl += 1; }

      if (st !== "done") {
        let b;
        if (!(r.genuine_promise === true) || !r.promise) b = "nopromise";
        else {
          const pm = new Date(r.promise).getTime();
          if (isNaN(pm)) b = "nopromise";
          else if (pm < NOW - 30 * DAY) b = "od30";
          else if (pm < NOW) b = "od1";
          else {
            const pp = nairobi(r.promise);
            if (pp.year === nn.year && pp.month === nn.month) b = "thismonth";
            else if (pp.year === nmY && pp.month === nmM) b = "nextmonth";
            else b = "later";
          }
        }
        backlog[b] += 1; backlogV[b] += v;
      }
    }
  }
  const otd = otdDen ? (otdNum / otdDen) * 100 : null;
  const mOtd = mOtdD.map((d, i) => (d ? (mOtdN[i] / d) * 100 : null));
  return {
    count: scoped.length, intake, orders, jobCards, open, otd, otdDen, otdExcl,
    mInt, mCard, mOrders, mOtd, custMap, teamMap, repMap, dstate, backlog, backlogV
  };
}

// Pulse: today / MTD / YTD + a naive month pace, from the current year's rows.
function pulse(curRows, prevRows, rep, money) {
  const scope = (rows) => rep ? rows.filter((r) => (r.rep || "") === rep) : rows;
  const cur = scope(curRows), prev = scope(prevRows);
  const metric = (r) => money ? (Number(r.value_kes) || 0) : 1;
  const tday = nairobi(NOW);

  // Daily totals for current year (for sparklines + today/MTD).
  const daily = new Map(); // key -> sum
  for (const r of cur) { const k = nairobiKey(r.order_date); if (!k) continue; daily.set(k, (daily.get(k) || 0) + metric(r)); }

  // last 14 Nairobi days ending today
  const shiftNow = new Date(NOW + 3 * 3600 * 1000);
  const dayKey = (offset) => {
    const d = new Date(Date.UTC(shiftNow.getUTCFullYear(), shiftNow.getUTCMonth(), shiftNow.getUTCDate() - offset));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const spark14 = []; for (let i = 13; i >= 0; i--) spark14.push(daily.get(dayKey(i)) || 0);

  const todayKey = dayKey(0), yestKey = dayKey(1);
  const today = daily.get(todayKey) || 0;
  const yesterday = daily.get(yestKey) || 0;

  // MTD this month vs same-day range prior month
  const dim = tday.day;
  let mtd = 0; const mtdSpark = [];
  for (let d = 1; d <= dim; d++) {
    const k = `${tday.year}-${String(tday.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const val = daily.get(k) || 0; mtd += val; mtdSpark.push(val);
  }
  let pm = tday.month - 1, pmY = tday.year; if (pm < 0) { pm = 11; pmY--; }
  let prevMtd = 0;
  for (let d = 1; d <= dim; d++) {
    const k = `${pmY}-${String(pm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    prevMtd += daily.get(k) || 0;
  }

  // YTD this year vs prior year same date range
  const inYtd = (r) => { const p = nairobi(r.order_date); if (!p) return false; return (p.month < tday.month) || (p.month === tday.month && p.day <= tday.day); };
  let ytd = 0; for (const r of cur) if (inYtd(r)) ytd += metric(r);
  let prevYtd = 0; for (const r of prev) if (inYtd(r)) prevYtd += metric(r);

  // Naive month pace = MTD / elapsed days * days in month
  const dimTotal = new Date(Date.UTC(tday.year, tday.month + 1, 0)).getUTCDate();
  const pace = dim > 0 ? (mtd / dim) * dimTotal : 0;

  return {
    today, yesterday, mtd, prevMtd, ytd, prevYtd, pace,
    spark14, mtdSpark, dim, dimTotal
  };
}

// ---- Value / count helpers ----------------------------------------------
const nf = (n) => Number(n || 0).toLocaleString("en-KE");
const fmtMoney = (v) => kes(v);
const fmtMoneyC = (v) => kesCompact(v);
const pctAxis = (v) => Math.round(v) + "%";

// ---- Small UI builders ---------------------------------------------------
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
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, headKids),
    el("div", { id: bodyId })
  ]);
}
function deliveryBadge(state) {
  const s = state || "none";
  const cls = s === "done" ? "badge--done" : s === "partial" ? "badge--partial" : "badge--none";
  return el("span", { class: "badge " + cls, text: s });
}
function ontimeBadge(v) {
  if (v === true) return el("span", { class: "badge badge--ontime", text: "On time" });
  if (v === false) return el("span", { class: "badge badge--late", text: "Late" });
  return el("span", { class: "badge badge--na", text: "n/a" });
}

// ---- Detail drawer -------------------------------------------------------
function openDetail(row, canSeeMoney) {
  const fields = [
    ["SO", row.so_name], ["SO id", row.so_id], ["Job card", row.is_job_card ? "Yes" : "No"],
    ["Customer", row.customer_name], ["Customer id", row.customer_id],
    ["Rep", row.rep || "—"], ["Team", row.team || "—"],
    ["Order date", dateTime(row.order_date)], ["Promise", dateTime(row.promise)],
    ["Genuine promise", row.genuine_promise ? "Yes" : "No"],
    ...(canSeeMoney ? [["Value", kes(row.value_kes)], ["Currency", row.currency || "—"]] : []),
    ["Procurement group", row.procurement_group ?? "—"], ["Ship-to id", row.ship_to_id ?? "—"],
    ["Deliveries", `${row.done_deliveries ?? 0} / ${row.deliveries ?? 0}`],
    ["Delivery state", row.delivery_state || "none"], ["Last delivery", dateTime(row.last_delivery_done)],
    ["On time", row.on_time === true ? "On time" : row.on_time === false ? "Late" : "n/a"],
    ["Synced", dateTime(row.synced_at)]
  ];
  const grid = el("dl", { class: "detail-grid" },
    fields.map(([k, v]) => el("div", { class: "detail-row" }, [
      el("dt", { text: k }), el("dd", { text: (v == null || v === "") ? "—" : String(v) })
    ])));
  const close = () => scrim.remove();
  const scrim = el("div", { class: "drawer-scrim", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "drawer", on: { click: (e) => e.stopPropagation() } }, [
      el("div", { class: "drawer-head" }, [
        el("div", {}, [el("h3", { text: row.so_name || "Job card" }), el("div", { class: "subtle", text: row.customer_name || "" })]),
        el("button", { class: "drawer-close", type: "button", "aria-label": "Close", on: { click: close } }, "×")
      ]),
      grid
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
export async function renderSales(root, ctx) {
  disposeAll();
  clear(root);
  const money = !!ctx.canSeeMoney;
  const t = theme();

  // --- Controls: year segmented, rep select, compare toggle ---
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
    el("h2", { text: "Sales" }), el("div", { class: "subtle", id: "sales-scope" }, "")
  ]);
  const scopeNote = el("div", { class: "scope-note", id: "sales-note" });

  // --- Section scaffold (filled by paint) ---
  const pulseWrap = el("div", { class: "stat-tiles", id: "pulse" });
  const heroWrap = el("div", { id: "hero" });
  const tilesWrap = el("div", { class: "stat-tiles", id: "tiles" });

  const monthCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { id: "month-title", text: "Order intake by month" }), el("span", { class: "subtle", text: "stacked by team" })]),
    el("div", { class: "chart-box", id: "ch-month" }),
    el("div", { class: "legend", id: "lg-month" }),
    el("details", { style: { marginTop: "8px" } }, [el("summary", { class: "subtle", text: "Team totals (table)" }), el("div", { id: "tbl-month" })])
  ]);

  const repCard = card("By rep", "", "hb-rep");
  const topCard = card("Top customers", "", "hb-top");
  const rowB = el("div", { class: "grid-2" }, [repCard, topCard]);

  const teamCard = card("By team / line", "value mix", "hb-team");
  const delivCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Delivery state" }), el("span", { class: "subtle", text: "job cards" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-deliv" })
  ]);
  const rowC = el("div", { class: "grid-2" }, [teamCard, delivCard]);

  const backlogCard = card("Open job cards by promise", "backlog", "hb-backlog");
  const otdCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "On-time delivery" }), el("span", { class: "subtle", id: "otd-sub", text: "OTD % by month" })]),
    el("div", { class: "chart-box chart-box--sm", id: "ch-otd" })
  ]);
  const rowD = el("div", { class: "grid-2" }, [backlogCard, otdCard]);

  const yoyMeasures = [["value", "Order value"], ["orders", "Orders"], ["otd", "OTD %"]];
  let yoyMeasure = money ? "value" : "orders";
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

  const clientsCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Clients" }), el("div", { class: "card-tools", id: "clients-tools" })]),
    el("div", { class: "search-row", style: { marginBottom: "10px" } }, [el("input", { class: "input", id: "clients-find", type: "search", placeholder: "Find a client…", autocomplete: "off" })]),
    el("div", { id: "clients-body" })
  ]);
  const concCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Concentration" }), el("span", { class: "subtle", id: "conc-sub", text: "by value" })]),
    el("div", { class: "conc", id: "conc-body" })
  ]);
  const rowF = el("div", { class: "grid-2" }, [clientsCard, concCard]);

  const moversCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Movers" }), el("span", { class: "subtle", id: "movers-sub", text: "vs prior year" })]),
    el("div", { class: "grid-2" }, [
      el("div", {}, [el("div", { class: "hbar-grouphead", text: "Biggest gainers" }), el("div", { id: "hb-gain" })]),
      el("div", {}, [el("div", { class: "hbar-grouphead", text: "Biggest declines" }), el("div", { id: "hb-loss" })])
    ])
  ]);

  // Search card (kept; restyled by theme)
  const searchInput = el("input", { class: "input", id: "jc-search", type: "search", placeholder: "Search SO number or customer…", autocomplete: "off" });
  const searchBtn = el("button", { class: "btn btn--primary", type: "button", text: "Search" });
  const searchBody = el("div", { id: "jc-body" });
  const searchCard = el("div", { class: "card", id: "search-card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Job card search" }), el("span", { class: "subtle", title: "All job cards (is_job_card = true), newest first." }, "all job cards")]),
    el("div", { class: "search-row" }, [searchInput, searchBtn]),
    searchBody
  ]);

  root.append(head, controls, scopeNote, pulseWrap, heroWrap, tilesWrap,
    monthCard, rowB, rowC, rowD, yoyCard, rowF, moversCard, searchCard);

  // Loading placeholders
  pulseWrap.append(stateBox("loading", "Loading figures…"));

  // --- Load data (cached) ---
  let data;
  try {
    data = await loadAll();
  } catch (err) {
    clear(pulseWrap);
    pulseWrap.append(stateBox("error", "Could not load sales data", authy(err)));
    return;
  }
  fetchFreshness().then((ts) => { if (ts) ctx.setFreshness(ts); }).catch(() => {});

  // Populate rep dropdown from all years
  (function populateReps() {
    const set = new Set();
    for (const y of YEARS) for (const r of (data.get(y) || [])) { const v = (r.rep || "").trim(); if (v) set.add(v); }
    const reps = [...set].sort((a, b) => a.localeCompare(b));
    reps.forEach((r) => repSel.append(el("option", { value: r, text: r })));
  })();
  repSel.addEventListener("change", paint);

  // Shared state for paintYoY (depends on rep)
  let curA = null, prevA = null;

  function paint() {
    const rep = repSel.value || "";
    const curRows = data.get(selYear) || [];
    const prevRows = data.get(selYear - 1) || [];
    const A = curA = summarize(curRows, rep);
    const P = prevA = summarize(prevRows, rep);

    root.querySelector("#sales-scope").textContent =
      `${selYear} · ${nf(A.count)} orders` + (rep ? ` · ${rep}` : "");
    root.querySelector("#sales-note").innerHTML =
      `OTD counts only genuine, measurable promises — <strong>${nf(A.otdExcl)}</strong> job card(s) this year had a non-genuine or placeholder promise and are excluded. Order value is the order total (no invoice/credit split exists in this data).`;

    paintPulse(curRows, prevRows, rep);
    paintHeroTiles(A, P);
    paintMonth(A, P, rep);
    paintRankLists(A, P, rep);
    paintDeliveryBacklogOtd(A);
    paintYoY();
    paintClientsConc(A, P);
    paintMovers(A, P);
  }

  // -- Pulse --
  function paintPulse(curRows, prevRows, rep) {
    const pu = pulse(data.get(CURRENT_YEAR) || [], data.get(CURRENT_YEAR - 1) || [], rep, money);
    const fv = money ? fmtMoneyC : (n) => nf(n);
    const unit = money ? "" : " orders";
    const mk = (label, val, baseVal, caption, spark, baseLabel) => {
      const d = fmtDelta(val, baseVal);
      return statTile({
        label, value: fv(val) + (money ? "" : ""), color: t.cat[0],
        sub: "", caption, spark,
        delta: baseVal ? { dir: d.dir, text: d.text, base: baseLabel } : null
      });
    };
    clear(pulseWrap);
    pulseWrap.append(
      mk("Today", pu.today, pu.yesterday, money ? "Value booked today" : "Orders booked today", pu.spark14, "vs yesterday"),
      mk("Month to date", pu.mtd, pu.prevMtd, `Through day ${pu.dim} of the month`, pu.mtdSpark, "vs last month"),
      mk("Year to date", pu.ytd, pu.prevYtd, `${CURRENT_YEAR}, to today`, null, "vs last year"),
      statTile({ label: "Month pace", value: fv(pu.pace), color: t.cat[1], caption: "Naive run-rate: MTD ÷ elapsed days × days in month (not a forecast)", delta: null })
    );
  }

  // -- Hero + stat tiles --
  function paintHeroTiles(A, P) {
    clear(heroWrap);
    const heroVal = money ? A.intake : A.orders;
    const heroBase = money ? P.intake : P.orders;
    const hd = fmtDelta(heroVal, heroBase);
    const hero = el("div", { class: "hero" }, [
      el("div", { class: "hero-main" }, [
        el("div", { class: "hero-label", text: money ? "Order value" : "Orders" }),
        el("div", { class: "hero-value" }, money ? richKes(A.intake) : [nf(A.orders)])
      ]),
      el("div", { class: "hero-side" }, [
        heroBase ? el("div", { class: "hero-delta delta--" + hd.dir, text: hd.text + " vs " + (selYear - 1) }) : null,
        el("div", { class: "hero-sub", text: `${nf(A.count)} orders · ${nf(A.jobCards)} job cards` })
      ])
    ]);
    heroWrap.append(hero);

    clear(tilesWrap);
    tilesWrap.classList.toggle("stat-tiles--6", money);
    const tiles = [];
    tiles.push(statTile({ label: "Orders", value: nf(A.orders), color: t.cat[1], caption: "Leaf orders / job cards placed", spark: A.mOrders, sub: "" }));
    tiles.push(statTile({ label: "Job cards", value: nf(A.jobCards), color: t.cat[2], caption: "Rows flagged is_job_card = true" }));
    const od = P.otd != null && A.otd != null ? fmtDelta(A.otd, P.otd) : null;
    tiles.push(statTile({ label: "OTD %", value: A.otd == null ? "—" : pct(A.otd), color: t.success,
      sub: A.otdDen ? `${nf(A.otdDen)} measurable` : "no measurable promises",
      caption: "On-time share of genuine, measurable promises", spark: A.mOtd.map((x) => x == null ? null : x),
      delta: od ? { dir: od.dir, text: od.text, base: "vs " + (selYear - 1) } : null }));
    tiles.push(statTile({ label: "Open job cards", value: nf(A.open), color: t.warn, caption: "Not yet fully delivered (none or partial)" }));
    tiles.push(statTile({ label: "Customers", value: nf(A.custMap.size), color: t.cat[5], caption: "Distinct customers in the period" }));
    if (money) tiles.push(statTile({ label: "Avg order value", value: kesCompact(A.orders ? A.intake / A.orders : 0), color: t.cat[3], caption: "Order value ÷ orders" }));
    tiles.forEach((x) => tilesWrap.append(x));
  }

  // -- Order intake by month, stacked by team --
  function paintMonth(A, P, rep) {
    root.querySelector("#month-title").textContent = money ? "Order intake by month" : "Job cards by month";
    const teams = [...A.teamMap.values()].sort((a, b) => money ? b.value - a.value : b.orders - a.orders);
    const top = teams.slice(0, 6), rest = teams.slice(6);
    const series = top.map((tm, i) => ({ name: tm.name, data: money ? tm.months : tm.monthsC, color: catColor(i) }));
    if (rest.length) {
      const om = Array(12).fill(0);
      for (const tm of rest) { const src = money ? tm.months : tm.monthsC; for (let i = 0; i < 12; i++) om[i] += src[i]; }
      series.push({ name: "Other", data: om, color: t.catOther });
    }
    const compareLine = compareOn ? { name: String(selYear - 1), data: money ? P.mInt : P.mOrders } : null;
    const node = root.querySelector("#ch-month");
    if (!hasECharts()) { clear(node); node.append(stateBox("info", "Charts unavailable", "Could not load the charting library.")); return; }
    const inst = stackedBar(node, { categories: MONTHS, series, valueFmt: money ? fmtMoneyC : compact, compareLine });
    legendChips(root.querySelector("#lg-month"), inst,
      [...series.map((s) => ({ name: s.name, color: s.color })), ...(compareLine ? [{ name: compareLine.name, color: t.axisInk }] : [])]);

    // Relief-rule companion table (team totals)
    const tbl = root.querySelector("#tbl-month"); clear(tbl);
    const head2 = [el("th", { text: "Team" }), el("th", { class: "num", text: money ? "Value" : "Orders" }), el("th", { class: "num", text: money ? "Orders" : "" })];
    const body = teams.map((tm) => el("tr", {}, [
      el("td", { class: "wrap", text: tm.name }),
      el("td", { class: "num", text: money ? kes(tm.value) : nf(tm.orders) }),
      el("td", { class: "num", text: money ? nf(tm.orders) : "" })
    ]));
    tbl.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head2)), el("tbody", {}, body)])));
  }

  // -- By rep + Top customers (money-bar lists) --
  function paintRankLists(A, P, rep) {
    const repRows = [...A.repMap.values()].sort((a, b) => money ? b.value - a.value : b.orders - a.orders).slice(0, 10)
      .map((rm) => {
        const prev = P.repMap.get(rm.name);
        const cur = money ? rm.value : rm.orders;
        const pv = prev ? (money ? prev.value : prev.orders) : 0;
        const d = compareOn && pv ? fmtDelta(cur, pv) : null;
        return {
          label: rm.name, value: cur, display: money ? kesCompact(rm.value) : nf(rm.orders),
          color: t.red, tickValue: compareOn ? pv : null,
          delta: d ? { dir: d.dir, text: d.text } : null,
          onClick: rep ? null : () => { repSel.value = rm.name; paint(); }
        };
      });
    hBar(root.querySelector("#hb-rep"), { rows: repRows, emptyText: "No reps in range" });

    const topRows = [...A.custMap.values()].sort((a, b) => money ? b.value - a.value : b.orders - a.orders).slice(0, 10)
      .map((c) => {
        const d = null;
        return {
          label: c.name, value: money ? c.value : c.orders, display: money ? kesCompact(c.value) : nf(c.orders),
          color: t.cat[2], delta: d,
          onClick: () => runSearchFor(c.name)
        };
      });
    hBar(root.querySelector("#hb-top"), { rows: topRows, emptyText: "No customers in range" });

    // By team / line mix
    const teams = [...A.teamMap.values()].sort((a, b) => money ? b.value - a.value : b.orders - a.orders).slice(0, 10);
    const teamRows = teams.map((tm, i) => ({
      label: tm.name, value: money ? tm.value : tm.orders,
      display: money ? kesCompact(tm.value) : nf(tm.orders), color: catColor(i)
    }));
    hBar(root.querySelector("#hb-team"), { rows: teamRows, emptyText: "No teams in range" });
  }

  // -- Delivery state donut + Backlog + OTD line --
  function paintDeliveryBacklogOtd(A) {
    const ds = A.dstate;
    const items = [
      { name: "Done", value: money ? ds.done.value : ds.done.count, color: t.success },
      { name: "Partial", value: money ? ds.partial.value : ds.partial.count, color: t.warn },
      { name: "None", value: money ? ds.none.value : ds.none.count, color: t.muted }
    ];
    const node = root.querySelector("#ch-deliv");
    if (hasECharts()) donut(node, { items, valueFmt: money ? fmtMoneyC : compact, centerLabel: "job cards", centerValue: nf(A.jobCards) });
    else { clear(node); node.append(stateBox("info", "Charts unavailable", "")); }

    // Backlog
    const order = [
      ["od30", "Overdue > 30 days", t.warn], ["od1", "Overdue 1–30 days", t.warn],
      ["thismonth", "Due this month", t.red], ["nextmonth", "Due next month", t.cat[5]],
      ["later", "Later", t.muted], ["nopromise", "No firm promise", t.catOther]
    ];
    const bRows = order.map(([k, label, color]) => ({
      label, value: A.backlog[k], display: nf(A.backlog[k]), color,
      sub: money && A.backlogV[k] ? kesCompact(A.backlogV[k]) : null
    })).filter((r) => r.value > 0);
    hBar(root.querySelector("#hb-backlog"), { rows: bRows, emptyText: "No open job cards" });

    // OTD by month line
    const node2 = root.querySelector("#ch-otd");
    root.querySelector("#otd-sub").textContent = A.otd == null ? "no measurable promises" : `${pct(A.otd)} overall`;
    if (hasECharts()) {
      lineArea(node2, {
        categories: MONTHS,
        series: [{ name: String(selYear), data: A.mOtd, kind: "current", color: t.success, target: { value: 90, label: "Target 90%" } }],
        valueFmt: (v) => v == null ? "—" : pct(v), yMax: 100, endLabels: false, areaOnCurrent: false
      });
    } else { clear(node2); node2.append(stateBox("info", "Charts unavailable", "")); }
  }

  // -- Year over year --
  function paintYoY() {
    const rep = repSel.value || "";
    const node = root.querySelector("#ch-yoy");
    if (!hasECharts()) { clear(node); node.append(stateBox("info", "Charts unavailable", "")); return; }
    const measure = yoyMeasure;
    const series = YEARS.map((y) => {
      const S = summarize(data.get(y) || [], rep);
      const dataArr = measure === "value" ? S.mInt : measure === "orders" ? S.mOrders : S.mOtd;
      const kind = y === CURRENT_YEAR ? "current" : y === CURRENT_YEAR - 1 ? "prev" : "older";
      const color = kind === "current" ? t.yearCurrent : kind === "prev" ? t.yearPrev : t.yearOlder;
      return { name: String(y), data: dataArr, kind, color };
    });
    const vfmt = measure === "value" ? fmtMoneyC : measure === "orders" ? compact : (v) => v == null ? "—" : pct(v);
    const inst = lineArea(node, { categories: MONTHS, series, valueFmt: vfmt, yMax: measure === "otd" ? 100 : undefined });
    legendChips(root.querySelector("#lg-yoy"), inst, series.map((s) => ({ name: s.name, color: s.color })));
  }

  // -- Clients table + Concentration --
  let clientsState = { filter: "all", find: "", sortKey: money ? "value" : "orders", sortDir: -1, limit: 25 };
  function paintClientsConc(A, P) {
    // Merge current + prior customers
    const keys = new Set([...A.custMap.keys(), ...P.custMap.keys()]);
    const rows = [];
    for (const k of keys) {
      const a = A.custMap.get(k), p = P.custMap.get(k);
      const name = a ? a.name : p.name;
      rows.push({
        name, rep: a ? a.rep : (p ? p.rep : ""),
        value: a ? a.value : 0, orders: a ? a.orders : 0,
        lastMs: Math.max(a ? a.lastMs : 0, p ? p.lastMs : 0),
        status: (a && a.orders > 0) ? "active" : "dormant"
      });
    }
    const totalCur = A.intake || 1;
    const totalOrders = A.orders || 1;
    renderClients(rows, totalCur, totalOrders);

    // Concentration (current year)
    const sub = root.querySelector("#conc-sub"); sub.textContent = money ? "by value" : "by orders";
    const arr = [...A.custMap.values()].map((c) => money ? c.value : c.orders).sort((x, y) => y - x);
    const tot = arr.reduce((s, v) => s + v, 0) || 1;
    const sumN = (n) => arr.slice(0, n).reduce((s, v) => s + v, 0);
    let cum = 0, to80 = 0; for (const v of arr) { cum += v; to80++; if (cum / tot >= 0.8) break; }
    const cells = [
      ["Largest customer", arr.length ? pct(arr[0] / tot * 100) : "—"],
      ["Top 5", arr.length ? pct(sumN(5) / tot * 100) : "—"],
      ["Top 10", arr.length ? pct(sumN(10) / tot * 100) : "—"],
      ["Customers to 80%", arr.length ? nf(to80) : "—"]
    ];
    const cb = root.querySelector("#conc-body"); clear(cb);
    cells.forEach(([lbl, val]) => cb.append(el("div", { class: "conc-cell" }, [
      el("div", { class: "conc-val", text: val }), el("div", { class: "conc-lbl", text: lbl })
    ])));
  }

  function renderClients(rows, totalCur, totalOrders) {
    const tools = root.querySelector("#clients-tools"); clear(tools);
    const chips = ["all", "active", "dormant"].map((f) => el("button", {
      class: "chip", type: "button", text: f[0].toUpperCase() + f.slice(1), "aria-pressed": clientsState.filter === f ? "true" : "false",
      on: { click: () => { clientsState.filter = f; clientsState.limit = 25; drawClients(); } }
    }));
    tools.append(el("div", { class: "chips" }, chips));
    const findInput = root.querySelector("#clients-find");
    findInput.oninput = () => { clientsState.find = findInput.value.trim().toLowerCase(); clientsState.limit = 25; drawClients(); };

    function drawClients() {
      [...tools.querySelectorAll(".chip")].forEach((c) => c.setAttribute("aria-pressed", c.textContent.toLowerCase() === clientsState.filter ? "true" : "false"));
      const body = root.querySelector("#clients-body"); clear(body);
      let list = rows.slice();
      if (clientsState.filter !== "all") list = list.filter((r) => r.status === clientsState.filter);
      if (clientsState.find) list = list.filter((r) => (r.name || "").toLowerCase().includes(clientsState.find));
      const sk = clientsState.sortKey, dir = clientsState.sortDir;
      list.sort((a, b) => {
        let av = a[sk], bv = b[sk];
        if (sk === "name") return dir * String(av).localeCompare(String(bv));
        return dir * ((av || 0) - (bv || 0));
      });
      const total = list.length;
      const shown = list.slice(0, clientsState.limit);

      const cols = [["name", "Client"], ["status", "Status"], ["rep", "Rep"], ["orders", "Orders"]];
      if (money) cols.push(["value", "Value"], ["share", "Share"]);
      cols.push(["lastMs", "Last order"], ["quiet", "Quiet for"]);
      const numCols = new Set(["orders", "value", "share", "quiet"]);
      const sortable = new Set(["name", "orders", "value", "lastMs"]);
      const ths = cols.map(([k, lbl]) => {
        const isSort = sortable.has(k);
        const active = clientsState.sortKey === k;
        return el("th", {
          class: (numCols.has(k) ? "num " : "") + (isSort ? "sortable" : ""),
          on: isSort ? { click: () => { if (clientsState.sortKey === k) clientsState.sortDir *= -1; else { clientsState.sortKey = k; clientsState.sortDir = k === "name" ? 1 : -1; } drawClients(); } } : {}
        }, [lbl, active ? el("span", { class: "sort-ar", text: clientsState.sortDir < 0 ? " ▼" : " ▲" }) : null]);
      });
      const trs = shown.map((r) => {
        const quiet = r.lastMs ? Math.max(0, Math.round((NOW - r.lastMs) / DAY)) : null;
        const cells = [
          el("td", { class: "wrap", text: r.name }),
          el("td", {}, el("span", { class: "badge " + (r.status === "active" ? "badge--done" : "badge--na"), text: r.status })),
          el("td", { text: r.rep || "—" }),
          el("td", { class: "num", text: nf(r.orders) })
        ];
        if (money) {
          cells.push(el("td", { class: "num", text: kes(r.value) }));
          cells.push(el("td", { class: "num", text: pct(r.value / totalCur * 100) }));
        }
        cells.push(el("td", { text: r.lastMs ? date(r.lastMs) : "—" }));
        cells.push(el("td", { class: "num", text: quiet == null ? "—" : quiet + "d" }));
        return el("tr", { class: "clickable", tabindex: "0", on: {
          click: () => runSearchFor(r.name),
          keydown: (e) => { if (e.key === "Enter") runSearchFor(r.name); }
        } }, cells);
      });
      if (!shown.length) { body.append(stateBox("info", "No clients", "No customers match the current filter.")); return; }
      body.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, ths)), el("tbody", {}, trs)])));
      if (total > clientsState.limit) {
        body.append(el("div", { class: "pager" }, [
          el("span", { class: "subtle", text: `Showing ${nf(clientsState.limit)} of ${nf(total)}` }),
          el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Show more", on: { click: () => { clientsState.limit += 25; drawClients(); } } })
        ]));
      } else {
        body.append(el("div", { class: "pager" }, [el("span", { class: "subtle", text: `${nf(total)} client${total === 1 ? "" : "s"}` }), el("span")]));
      }
    }
    drawClients();
  }

  // -- Movers --
  function paintMovers(A, P) {
    const sub = root.querySelector("#movers-sub");
    const gBox = root.querySelector("#hb-gain"), lBox = root.querySelector("#hb-loss");
    if (!compareOn || !P.custMap.size) {
      sub.textContent = compareOn ? "no prior-year data" : "comparison off";
      hBar(gBox, { rows: [], emptyText: "—" }); hBar(lBox, { rows: [], emptyText: "—" });
      return;
    }
    sub.textContent = `vs ${selYear - 1}`;
    const keys = new Set([...A.custMap.keys(), ...P.custMap.keys()]);
    const diffs = [];
    for (const k of keys) {
      const a = A.custMap.get(k), p = P.custMap.get(k);
      const cur = a ? (money ? a.value : a.orders) : 0;
      const prev = p ? (money ? p.value : p.orders) : 0;
      diffs.push({ name: (a ? a.name : p.name), d: cur - prev });
    }
    const disp = (v) => (v >= 0 ? "+" : "−") + (money ? kesCompact(Math.abs(v)) : nf(Math.abs(v)));
    const gain = diffs.filter((x) => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 6)
      .map((x) => ({ label: x.name, value: x.d, display: disp(x.d), color: t.success, onClick: () => runSearchFor(x.name) }));
    const loss = diffs.filter((x) => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 6)
      .map((x) => ({ label: x.name, value: Math.abs(x.d), display: disp(x.d), color: t.danger, onClick: () => runSearchFor(x.name) }));
    hBar(gBox, { rows: gain, emptyText: "No gainers" });
    hBar(lBox, { rows: loss, emptyText: "No declines" });
  }

  // --- Search table ---
  let searchPage = 0, searchTerm = "";
  function runSearchFor(term) {
    searchInput.value = term; searchTerm = term; runSearch(0);
    document.getElementById("search-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function runSearch(page) {
    searchPage = page;
    clear(searchBody); searchBody.append(stateBox("loading", "Searching…"));
    try {
      const { rows, total } = await searchJobCards(searchTerm, page);
      clear(searchBody);
      if (!rows.length) {
        searchBody.append(stateBox("info", "No job cards found", searchTerm ? "Try a different SO number or customer name." : "No job cards available."));
        return;
      }
      const headCells = [el("th", { text: "SO" }), el("th", { text: "Customer" })];
      if (money) headCells.push(el("th", { class: "num", text: "Value" }));
      headCells.push(el("th", { text: "Ordered" }), el("th", { text: "Promise" }), el("th", { text: "Delivery" }), el("th", { text: "On time" }));
      const trs = rows.map((r) => {
        const cells = [el("td", { text: r.so_name || "—" }), el("td", { class: "wrap", text: r.customer_name || "—" })];
        if (money) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
        cells.push(el("td", { text: date(r.order_date) }), el("td", { text: date(r.promise) }),
          el("td", {}, deliveryBadge(r.delivery_state)), el("td", {}, ontimeBadge(r.on_time)));
        return el("tr", { class: "clickable", tabindex: "0", on: {
          click: () => openDetail(r, money),
          keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(r, money); } }
        } }, cells);
      });
      searchBody.append(el("div", { class: "table-scroll" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, headCells)), el("tbody", {}, trs)])));
      const pages = Math.max(1, Math.ceil(total / PAGE));
      searchBody.append(el("div", { class: "pager" }, [
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "‹ Prev", disabled: page <= 0, on: { click: () => runSearch(page - 1) } }),
        el("span", { class: "subtle", text: `${nf(total)} result${total === 1 ? "" : "s"} · page ${page + 1} of ${pages}` }),
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Next ›", disabled: page >= pages - 1, on: { click: () => runSearch(page + 1) } })
      ]));
    } catch (err) {
      clear(searchBody); searchBody.append(stateBox("error", "Search failed", authy(err)));
    }
  }
  searchBtn.addEventListener("click", () => { searchTerm = searchInput.value; runSearch(0); });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { searchTerm = searchInput.value; runSearch(0); } });

  // --- Kick off ---
  paint();
  runSearch(0);
}

// Rich KES for the hero: whole number big, " KES" small/muted lead handled by splitting.
function richKes(n) {
  const full = kes(n); // "KES 1,234,567"
  const m = full.match(/^KES\s+(.*)$/);
  if (!m) return [full];
  return [m[1], el("span", { class: "dec", text: " KES" })];
}

function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) {
    return "You may not have access to this data, or your session expired. Try signing in again.";
  }
  return m;
}
