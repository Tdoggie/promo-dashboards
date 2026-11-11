// =========================================================================
// Promo Kings — Sales section
//
// Reads public.job_card (RLS-gated; needs a logged-in staff role).
// Exposes: renderSales(root, ctx)
//   root : the #content element to render into (cleared by the caller)
//   ctx  : { supabase, profile, role, canSeeMoney, setFreshness }
//
// Aggregation is done client-side from a paginated pull of the selected
// year's rows, so it needs no server functions or PostgREST aggregate config.
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime, pct
} from "./common.js";

// ---- Chart.js: loaded lazily so a CDN hiccup can't break login/app -------
let _chartPromise = null;
function loadChart() {
  if (!_chartPromise) {
    _chartPromise = import("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/auto/+esm")
      .then((m) => m.default)
      .catch((err) => { console.warn("Chart.js failed to load:", err); return null; });
  }
  return _chartPromise;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2026, 2025, 2024, 2023];
const PAGE = 50; // search table page size

// Charts created in this section, destroyed before each re-render.
let _charts = [];
function destroyCharts() { _charts.forEach((c) => { try { c.destroy(); } catch {} }); _charts = []; }

// ---- Nairobi civil-date parts (EAT, UTC+3, no DST) -----------------------
function nairobi(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const n = new Date(dt.getTime() + 3 * 3600 * 1000);
  return { year: n.getUTCFullYear(), month: n.getUTCMonth() }; // month 0-11
}
function yearBounds(year) {
  // Nairobi (UTC+3) start/end of year, as offset-aware ISO strings.
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
}

// ---- Data access ---------------------------------------------------------

/** Pull every job_card/order row in the given Nairobi year (paginated). */
async function fetchYearRows(year) {
  const [start, end] = yearBounds(year);
  const cols = "value_kes,is_job_card,genuine_promise,on_time,delivery_state," +
               "customer_id,customer_name,rep,order_date";
  const size = 1000;
  let from = 0;
  const rows = [];
  // Safety cap well above the largest known year (~6.7k rows).
  for (let guard = 0; guard < 40; guard++) {
    const { data, error } = await supabase
      .from("job_card")
      .select(cols)
      .gte("order_date", start)
      .lt("order_date", end)
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

/** Most recent synced_at across the table (data freshness). */
async function fetchFreshness() {
  const { data, error } = await supabase
    .from("job_card")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0].synced_at;
}

const SEARCH_COLS =
  "so_id,so_name,is_job_card,customer_id,customer_name,rep,team,order_date,promise," +
  "genuine_promise,value_kes,currency,procurement_group,ship_to_id,deliveries," +
  "done_deliveries,last_delivery_done,delivery_state,on_time,synced_at";

/** Server-side search of job cards (is_job_card=true), paged, newest first. */
async function searchJobCards(term, page) {
  let q = supabase
    .from("job_card")
    .select(SEARCH_COLS, { count: "exact" })
    .eq("is_job_card", true);
  const t = (term || "").trim();
  if (t) {
    const safe = t.replace(/[%,()]/g, " ");
    q = q.or(`so_name.ilike.%${safe}%,customer_name.ilike.%${safe}%`);
  }
  const fromRow = page * PAGE;
  q = q.order("order_date", { ascending: false, nullsFirst: false })
       .range(fromRow, fromRow + PAGE - 1);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], total: count ?? 0 };
}

// ---- Aggregation (client-side) ------------------------------------------

function aggregate(rows, repFilter) {
  const scoped = repFilter ? rows.filter((r) => (r.rep || "") === repFilter) : rows;

  let intake = 0, jobCards = 0, open = 0;
  let otdNum = 0, otdDen = 0;
  const monthIntake = Array(12).fill(0);
  const monthCards = Array(12).fill(0);
  const monthOtdNum = Array(12).fill(0);
  const monthOtdDen = Array(12).fill(0);
  const custMap = new Map();

  for (const r of scoped) {
    const v = Number(r.value_kes) || 0;
    const np = nairobi(r.order_date);
    const m = np ? np.month : null;

    intake += v;
    if (m != null) monthIntake[m] += v;

    const ckey = r.customer_id != null ? "id:" + r.customer_id : "nm:" + (r.customer_name || "—");
    const c = custMap.get(ckey) || { name: r.customer_name || "—", value: 0, orders: 0 };
    c.value += v; c.orders += 1;
    if (r.customer_name) c.name = r.customer_name;
    custMap.set(ckey, c);

    if (r.is_job_card === true) {
      jobCards += 1;
      if (m != null) monthCards[m] += 1;
      if (r.delivery_state !== "done") open += 1;
      if (r.genuine_promise === true && r.on_time !== null && r.on_time !== undefined) {
        otdDen += 1;
        if (m != null) monthOtdDen[m] += 1;
        if (r.on_time === true) { otdNum += 1; if (m != null) monthOtdNum[m] += 1; }
      }
    }
  }

  const otd = otdDen ? (otdNum / otdDen) * 100 : null;
  const monthOtd = monthOtdDen.map((d, i) => (d ? (monthOtdNum[i] / d) * 100 : null));
  const topCustomers = [...custMap.values()]
    .sort((a, b) => b.value - a.value || b.orders - a.orders)
    .slice(0, 10);

  return {
    intake, jobCards, open, otd, otdDen,
    monthIntake, monthCards, monthOtd,
    topCustomers, count: scoped.length
  };
}

// ---- Small UI builders ---------------------------------------------------

function stateBox(kind, title, sub) {
  const box = el("div", { class: "state" + (kind === "error" ? " state--error" : "") });
  if (kind === "loading") box.append(el("span", { class: "spinner spinner--ink" }));
  box.append(el("div", { class: "state-title", text: title }));
  if (sub) box.append(el("div", { class: "state-sub", text: sub }));
  return box;
}

function kpiTile(label, value, sub, def) {
  return el("div", { class: "kpi", title: def }, [
    el("div", { class: "kpi-label" }, [
      label,
      el("span", { class: "hint", title: def, "aria-label": def }, "?")
    ]),
    el("div", { class: "kpi-value", text: value }),
    sub ? el("div", { class: "kpi-sub", text: sub }) : null
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
    ["SO", row.so_name],
    ["SO id", row.so_id],
    ["Job card", row.is_job_card ? "Yes" : "No"],
    ["Customer", row.customer_name],
    ["Customer id", row.customer_id],
    ["Rep", row.rep || "—"],
    ["Team", row.team || "—"],
    ["Order date", dateTime(row.order_date)],
    ["Promise", dateTime(row.promise)],
    ["Genuine promise", row.genuine_promise ? "Yes" : "No"],
    ...(canSeeMoney ? [["Value", kes(row.value_kes)], ["Currency", row.currency || "—"]] : []),
    ["Procurement group", row.procurement_group ?? "—"],
    ["Ship-to id", row.ship_to_id ?? "—"],
    ["Deliveries", `${row.done_deliveries ?? 0} / ${row.deliveries ?? 0}`],
    ["Delivery state", row.delivery_state || "none"],
    ["Last delivery", dateTime(row.last_delivery_done)],
    ["On time", row.on_time === true ? "On time" : row.on_time === false ? "Late" : "n/a"],
    ["Synced", dateTime(row.synced_at)]
  ];

  const grid = el("dl", { class: "detail-grid" },
    fields.map(([k, v]) => el("div", { class: "detail-row" }, [
      el("dt", { text: k }),
      el("dd", { text: (v == null || v === "") ? "—" : String(v) })
    ]))
  );

  const close = () => scrim.remove();
  const scrim = el("div", { class: "drawer-scrim", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "drawer", on: { click: (e) => e.stopPropagation() } }, [
      el("div", { class: "drawer-head" }, [
        el("div", {}, [
          el("h3", { text: row.so_name || "Job card" }),
          el("div", { class: "subtle", text: row.customer_name || "" })
        ]),
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

// ---- Charts --------------------------------------------------------------

async function drawCharts(canvasIntake, canvasOtd, agg, canSeeMoney) {
  const Chart = await loadChart();
  if (!Chart) {
    for (const cv of [canvasIntake, canvasOtd]) {
      const p = cv.parentElement;
      clear(p); p.append(stateBox("info", "Charts unavailable", "Could not load the charting library."));
    }
    return;
  }
  const grid = "rgba(19,35,63,.08)";
  const baseOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false } }, y: { grid: { color: grid }, beginAtZero: true } }
  };

  // Left chart: money -> intake (KES); money-blind -> job-card counts.
  const barData = canSeeMoney ? agg.monthIntake : agg.monthCards;
  const bar = new Chart(canvasIntake, {
    type: "bar",
    data: {
      labels: MONTHS,
      datasets: [{
        data: barData,
        backgroundColor: "#1b3a6b",
        borderRadius: 4, maxBarThickness: 34
      }]
    },
    options: {
      ...baseOpts,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => canSeeMoney ? kes(c.parsed.y) : `${c.parsed.y} job cards` } }
      },
      scales: {
        ...baseOpts.scales,
        y: { ...baseOpts.scales.y, ticks: { callback: (v) => canSeeMoney ? kesCompact(v) : v } }
      }
    }
  });

  // Right chart: OTD % by month (line).
  const otdLine = new Chart(canvasOtd, {
    type: "line",
    data: {
      labels: MONTHS,
      datasets: [{
        data: agg.monthOtd,
        borderColor: "#1f9254",
        backgroundColor: "rgba(31,146,84,.12)",
        fill: true, tension: .3, spanGaps: false,
        pointRadius: 3, pointBackgroundColor: "#1f9254"
      }]
    },
    options: {
      ...baseOpts,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y == null ? "no measurable promises" : pct(c.parsed.y) } }
      },
      scales: {
        ...baseOpts.scales,
        y: { ...baseOpts.scales.y, suggestedMax: 100, ticks: { callback: (v) => v + "%" } }
      }
    }
  });

  _charts.push(bar, otdLine);
}

// ---- Main render ---------------------------------------------------------

export async function renderSales(root, ctx) {
  destroyCharts();
  clear(root);
  const canSeeMoney = !!ctx.canSeeMoney;

  // --- Static scaffold ---
  const yearSel = el("select", { class: "select", id: "f-year" },
    YEARS.map((y) => el("option", { value: String(y), text: String(y), selected: y === YEARS[0] })));
  const repSel = el("select", { class: "select", id: "f-rep" }, [el("option", { value: "", text: "All reps" })]);

  const head = el("div", { class: "section-head" }, [
    el("h2", { text: "Sales" }),
    el("div", { class: "subtle", id: "sales-scope" }, "")
  ]);
  const filters = el("div", { class: "filters" }, [
    el("label", { class: "filter" }, [el("span", { text: "Year" }), yearSel]),
    el("label", { class: "filter" }, [el("span", { text: "Rep" }), repSel])
  ]);

  const kpis = el("div", { class: "kpis", id: "sales-kpis" }, stateBox("loading", "Loading figures…"));

  const barTitle = canSeeMoney ? "Monthly order intake" : "Job cards per month";
  const barDef = canSeeMoney
    ? "Sum of order value (KES) by month the order was placed."
    : "Number of job cards opened per month.";
  const chartCards = el("div", { class: "grid-2" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h3", { text: barTitle }), el("span", { class: "subtle", title: barDef }, "by month")]),
      el("div", { class: "chart-wrap" }, el("canvas", { id: "chart-intake" }))
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h3", { text: "On-time delivery" }), el("span", { class: "subtle", title: "OTD % by month: of job cards with a genuine, measurable promise, the share delivered on time." }, "OTD % by month")]),
      el("div", { class: "chart-wrap" }, el("canvas", { id: "chart-otd" }))
    ])
  ]);

  const topCard = el("div", { class: "card", id: "top-card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Top 10 customers" }), el("span", { class: "subtle" }, canSeeMoney ? "by value" : "by orders")]),
    el("div", { id: "top-body" }, stateBox("loading", "Loading…"))
  ]);

  // Search card
  const searchInput = el("input", { class: "input", id: "jc-search", type: "search", placeholder: "Search SO number or customer…", autocomplete: "off" });
  const searchBtn = el("button", { class: "btn btn--primary", type: "button", text: "Search" });
  const searchBody = el("div", { id: "jc-body" });
  const searchCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Job card search" }), el("span", { class: "subtle", title: "All job cards (is_job_card = true), newest first. Filter by SO number or customer." }, "all job cards")]),
    el("div", { class: "search-row" }, [searchInput, searchBtn]),
    searchBody
  ]);

  root.append(head, filters, kpis, chartCards, topCard, searchCard);

  // --- State ---
  let yearRows = [];
  let currentYear = YEARS[0];

  // --- Renderers that depend on the aggregate ---
  function paintAggregate() {
    const repFilter = repSel.value || "";
    const agg = aggregate(yearRows, repFilter);

    // scope line
    const scope = root.querySelector("#sales-scope");
    scope.textContent = `${currentYear} · ${agg.count.toLocaleString("en-KE")} orders` +
      (repFilter ? ` · ${repFilter}` : "");

    // KPIs
    const tiles = [];
    if (canSeeMoney) {
      tiles.push(kpiTile("Order intake", kes(agg.intake), currentYear + " total",
        "Sum of value_kes for all orders placed in the selected year (USD-converted, in KES)."));
    }
    tiles.push(kpiTile("Job cards", agg.jobCards.toLocaleString("en-KE"), "opened this year",
      "Count of rows with is_job_card = true in the selected year."));
    tiles.push(kpiTile("OTD", agg.otd == null ? "—" : pct(agg.otd),
      agg.otdDen ? `${agg.otdDen.toLocaleString("en-KE")} measurable` : "no measurable promises",
      "Of job cards with a genuine promise and a known outcome, the share delivered on time."));
    tiles.push(kpiTile("Open job cards", agg.open.toLocaleString("en-KE"), "not yet fully delivered",
      "Job cards whose delivery_state is not 'done' (none or partial)."));
    const kpiBox = root.querySelector("#sales-kpis");
    clear(kpiBox); tiles.forEach((t) => kpiBox.append(t));

    // Top customers
    const topBody = root.querySelector("#top-body");
    clear(topBody);
    if (!agg.topCustomers.length) {
      topBody.append(stateBox("info", "No customers", "No orders match the current filters."));
    } else {
      const sorted = canSeeMoney ? agg.topCustomers
        : [...agg.topCustomers].sort((a, b) => b.orders - a.orders);
      const headCells = [el("th", { text: "#" }), el("th", { text: "Customer" }), el("th", { class: "num", text: "Orders" })];
      if (canSeeMoney) headCells.push(el("th", { class: "num", text: "Value" }));
      const body = sorted.slice(0, 10).map((c, i) => {
        const cells = [
          el("td", { class: "rank", text: String(i + 1) }),
          el("td", { class: "wrap", text: c.name }),
          el("td", { class: "num", text: c.orders.toLocaleString("en-KE") })
        ];
        if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(c.value) }));
        return el("tr", {}, cells);
      });
      topBody.append(el("div", { class: "table-scroll" },
        el("table", { class: "data" }, [el("thead", {}, el("tr", {}, headCells)), el("tbody", {}, body)])));
    }

    // Charts
    drawCharts(root.querySelector("#chart-intake"), root.querySelector("#chart-otd"), agg, canSeeMoney);
  }

  function populateReps() {
    const reps = [...new Set(yearRows.map((r) => (r.rep || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const prev = repSel.value;
    clear(repSel);
    repSel.append(el("option", { value: "", text: "All reps" }));
    reps.forEach((r) => repSel.append(el("option", { value: r, text: r })));
    if (prev && reps.includes(prev)) repSel.value = prev; else repSel.value = "";
  }

  async function loadYear(year) {
    currentYear = year;
    destroyCharts();
    const kpiBox = root.querySelector("#sales-kpis");
    clear(kpiBox); kpiBox.append(stateBox("loading", "Loading figures…"));
    clear(root.querySelector("#top-body")); root.querySelector("#top-body").append(stateBox("loading", "Loading…"));
    try {
      yearRows = await fetchYearRows(year);
      populateReps();
      paintAggregate();
    } catch (err) {
      const msg = authy(err);
      clear(kpiBox); kpiBox.append(stateBox("error", "Could not load sales data", msg));
      clear(root.querySelector("#top-body"));
    }
  }

  // --- Search table ---
  let searchPage = 0;
  let searchTerm = "";
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
      if (canSeeMoney) headCells.push(el("th", { class: "num", text: "Value" }));
      headCells.push(el("th", { text: "Ordered" }), el("th", { text: "Promise" }), el("th", { text: "Delivery" }), el("th", { text: "On time" }));

      const trs = rows.map((r) => {
        const cells = [
          el("td", { text: r.so_name || "—" }),
          el("td", { class: "wrap", text: r.customer_name || "—" })
        ];
        if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
        cells.push(
          el("td", { text: date(r.order_date) }),
          el("td", { text: date(r.promise) }),
          el("td", {}, deliveryBadge(r.delivery_state)),
          el("td", {}, ontimeBadge(r.on_time))
        );
        return el("tr", { class: "clickable", tabindex: "0", on: {
          click: () => openDetail(r, canSeeMoney),
          keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(r, canSeeMoney); } }
        } }, cells);
      });

      searchBody.append(el("div", { class: "table-scroll" },
        el("table", { class: "data" }, [el("thead", {}, el("tr", {}, headCells)), el("tbody", {}, trs)])));

      const pages = Math.max(1, Math.ceil(total / PAGE));
      const prevBtn = el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "‹ Prev", disabled: page <= 0,
        on: { click: () => runSearch(page - 1) } });
      const nextBtn = el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Next ›", disabled: page >= pages - 1,
        on: { click: () => runSearch(page + 1) } });
      searchBody.append(el("div", { class: "pager" }, [
        prevBtn,
        el("span", { class: "subtle", text: `${(total).toLocaleString("en-KE")} result${total === 1 ? "" : "s"} · page ${page + 1} of ${pages}` }),
        nextBtn
      ]));
    } catch (err) {
      clear(searchBody); searchBody.append(stateBox("error", "Search failed", authy(err)));
    }
  }

  // --- Wire events ---
  yearSel.addEventListener("change", () => loadYear(Number(yearSel.value)));
  repSel.addEventListener("change", () => paintAggregate());
  searchBtn.addEventListener("click", () => { searchTerm = searchInput.value; runSearch(0); });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { searchTerm = searchInput.value; runSearch(0); } });

  // --- Kick off ---
  await loadYear(Number(yearSel.value));
  runSearch(0);
}

// Friendly message for a Supabase/PostgREST error (esp. RLS/permission).
function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) {
    return "You may not have access to this data, or your session expired. Try signing in again.";
  }
  return m;
}
