// =========================================================================
// Promo Kings — Production board ("what is where")
//
// Job cards only (is_job_card = true), read from public.job_card
// (RLS-gated; needs a logged-in staff role).
//
// Exposes: renderProduction(root, ctx)
//   root : the #content element to render into
//   ctx  : { supabase, profile, role, canSeeMoney, setFreshness }
//
// What it answers:
//   - the selected year's job cards grouped by delivery_state (none/partial/done)
//     with counts + value;
//   - a LATE-RISK list (genuine promise, not done, promise already past);
//   - an IN-PROGRESS list (delivery_state = 'partial');
//   - a NOT-STARTED list (none, with a genuine future promise).
//
// Scope note shown in the UI: Odoo gives the order/delivery *state*. Shop-floor
// "ready" timing will come from the production workbooks later — so these read
// as order/delivery status, not floor progress.
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime
} from "./common.js";

const YEARS = [2026, 2025, 2024, 2023];
const DAY_MS = 24 * 3600 * 1000;

// ---- Nairobi civil-date bounds (EAT, UTC+3, no DST) ----------------------
function yearBounds(year) {
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
}

// ---- Data access ---------------------------------------------------------

const JC_COLS =
  "so_id,so_name,customer_name,rep,team,order_date,promise,genuine_promise," +
  "value_kes,delivery_state,deliveries,done_deliveries,last_delivery_done,on_time";

/** Pull every job card (is_job_card = true) ordered in the Nairobi year. */
async function fetchYearJobCards(year) {
  const [start, end] = yearBounds(year);
  const size = 1000;
  let from = 0;
  const rows = [];
  for (let guard = 0; guard < 40; guard++) {
    const { data, error } = await supabase
      .from("job_card")
      .select(JC_COLS)
      .eq("is_job_card", true)
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

// ---- Aggregation (client-side) ------------------------------------------

function aggregate(rows, nowMs) {
  const states = {
    none:    { count: 0, value: 0 },
    partial: { count: 0, value: 0 },
    done:    { count: 0, value: 0 }
  };
  const lateRisk = [];   // genuine, not done, promise already past
  const inProgress = []; // delivery_state = partial
  const notStarted = []; // none, genuine future promise

  for (const r of rows) {
    const v = Number(r.value_kes) || 0;
    const st = states[r.delivery_state] ? r.delivery_state : "none";
    states[st].count += 1;
    states[st].value += v;

    const promiseMs = r.promise ? new Date(r.promise).getTime() : NaN;
    const hasPromise = Number.isFinite(promiseMs);
    const genuine = r.genuine_promise === true;

    if (st !== "done" && genuine && hasPromise && promiseMs < nowMs) {
      lateRisk.push({ ...r, _daysLate: Math.floor((nowMs - promiseMs) / DAY_MS) });
    }
    if (st === "partial") {
      inProgress.push({ ...r, _promiseMs: hasPromise ? promiseMs : Infinity });
    }
    if (st === "none" && genuine && hasPromise && promiseMs >= nowMs) {
      notStarted.push({ ...r, _promiseMs: promiseMs });
    }
  }

  lateRisk.sort((a, b) => b._daysLate - a._daysLate);                 // most overdue first
  inProgress.sort((a, b) => a._promiseMs - b._promiseMs);            // soonest promise first
  notStarted.sort((a, b) => a._promiseMs - b._promiseMs);           // soonest promise first

  const total = rows.length;
  const open = states.none.count + states.partial.count;
  const openValue = states.none.value + states.partial.value;

  return { states, lateRisk, inProgress, notStarted, total, open, openValue };
}

// ---- Small UI builders (local, mirroring sales.js) -----------------------

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
  const s = (state === "done" || state === "partial") ? state : "none";
  const cls = s === "done" ? "badge--done" : s === "partial" ? "badge--partial" : "badge--none";
  const label = s === "done" ? "Done" : s === "partial" ? "Partial" : "Not started";
  return el("span", { class: "badge " + cls, text: label });
}

function card(titleText, subText, subTitle, bodyNode) {
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: titleText }),
      subText ? el("span", { class: "subtle", title: subTitle || "" }, subText) : null
    ]),
    bodyNode
  ]);
}

// Friendly message for a Supabase/PostgREST error (esp. RLS/permission).
function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) {
    return "You may not have access to this data, or your session expired. Try signing in again.";
  }
  return m;
}

const nf = (n) => Number(n || 0).toLocaleString("en-KE");

// ---- List renderers ------------------------------------------------------

function listEmpty(msg) {
  return stateBox("info", msg);
}

/** Late-risk table: so_name, customer, promise, days late, (value). */
function lateRiskTable(rows, canSeeMoney) {
  if (!rows.length) return listEmpty("Nothing overdue. No job card with a genuine promise is past its date.");
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }),
    el("th", { text: "Promised" }), el("th", { class: "num", text: "Days late" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));
  head.push(el("th", { text: "Delivery" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { text: date(r.promise) }),
      el("td", { class: "num", title: dateTime(r.promise), text: nf(r._daysLate) })
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    cells.push(el("td", {}, deliveryBadge(r.delivery_state)));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

/** In-progress (partial) table: so_name, customer, promise, progress, (value). */
function inProgressTable(rows, canSeeMoney) {
  if (!rows.length) return listEmpty("No job card is part-delivered right now.");
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }),
    el("th", { text: "Promised" }), el("th", { class: "num", text: "Progress" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { text: date(r.promise) }),
      el("td", { class: "num", text: `${nf(r.done_deliveries)} / ${nf(r.deliveries)}` })
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

/** Not-started (none, future genuine promise) table. */
function notStartedTable(rows, canSeeMoney) {
  if (!rows.length) return listEmpty("No not-started job card has a genuine future promise date.");
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Promised" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { title: dateTime(r.promise), text: date(r.promise) })
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

/** Breakdown-by-state table: State | Job cards | (Value). */
function breakdownTable(states, canSeeMoney) {
  const order = [
    ["none", states.none], ["partial", states.partial], ["done", states.done]
  ];
  const head = [el("th", { text: "State" }), el("th", { class: "num", text: "Job cards" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));
  const body = order.map(([key, s]) => {
    const cells = [
      el("td", {}, deliveryBadge(key)),
      el("td", { class: "num", text: nf(s.count) })
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(s.value) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

// ---- Main render ---------------------------------------------------------

export async function renderProduction(root, ctx) {
  clear(root);
  const canSeeMoney = !!ctx.canSeeMoney;

  // --- Static scaffold ---
  const yearSel = el("select", { class: "select", id: "f-year" },
    YEARS.map((y) => el("option", { value: String(y), text: String(y), selected: y === YEARS[0] })));

  const head = el("div", { class: "section-head" }, [
    el("h2", { text: "Production" }),
    el("div", { class: "subtle", id: "prod-scope" }, "")
  ]);

  const note = el("div", { class: "card" }, [
    el("div", { class: "subtle", text:
      "Status comes from Odoo order & delivery state — read it as \"what is where\" by paperwork. " +
      "Shop-floor \"ready\" timing will come from the production workbooks later, so don't over-read these as floor progress." })
  ]);

  const filters = el("div", { class: "filters" }, [
    el("label", { class: "filter" }, [el("span", { text: "Year" }), yearSel])
  ]);

  const kpis = el("div", { class: "kpis", id: "prod-kpis" }, stateBox("loading", "Loading figures…"));

  const breakdownBody = el("div", { id: "prod-breakdown" }, stateBox("loading", "Loading…"));
  const breakdownCard = card("By delivery state", "none · partial · done",
    "The selected year's job cards grouped by Odoo delivery_state, with counts and value.", breakdownBody);

  const lateBody = el("div", { id: "prod-late" }, stateBox("loading", "Loading…"));
  const lateCard = card("Late risk", "most overdue first",
    "Job cards with a genuine promise, not yet delivered, whose promise date has already passed.", lateBody);

  const progBody = el("div", { id: "prod-progress" }, stateBox("loading", "Loading…"));
  const progCard = card("In progress", "part-delivered",
    "Job cards whose delivery_state is 'partial' (some but not all deliveries done).", progBody);

  const todoBody = el("div", { id: "prod-todo" }, stateBox("loading", "Loading…"));
  const todoCard = card("Not started", "genuine future promise",
    "Job cards with delivery_state 'none' and a genuine promise date still in the future.", todoBody);

  root.append(head, note, filters, kpis, breakdownCard, lateCard, progCard, todoCard);

  // --- State ---
  let currentYear = YEARS[0];

  function paint(agg) {
    // scope line
    root.querySelector("#prod-scope").textContent =
      `${currentYear} · ${nf(agg.total)} job cards`;

    // KPIs
    const tiles = [];
    tiles.push(kpiTile("Job cards", nf(agg.total), currentYear + " total",
      "Count of job cards (is_job_card = true) ordered in the selected year."));
    tiles.push(kpiTile("Open", nf(agg.open), "not fully delivered",
      "Job cards whose delivery_state is not 'done' (none or partial)."));
    tiles.push(kpiTile("Overdue", nf(agg.lateRisk.length), "genuine promise past",
      "Open job cards with a genuine promise whose promise date has already passed."));
    if (canSeeMoney) {
      tiles.push(kpiTile("Open value", kesCompact(agg.openValue), "not-done job cards",
        "Sum of value_kes for job cards that are not fully delivered (USD-converted, in KES)."));
    } else {
      tiles.push(kpiTile("Delivered", nf(agg.states.done.count), "fully done",
        "Job cards whose delivery_state is 'done'."));
    }
    const kpiBox = root.querySelector("#prod-kpis");
    clear(kpiBox); tiles.forEach((t) => kpiBox.append(t));

    // Breakdown + lists
    const bd = root.querySelector("#prod-breakdown"); clear(bd); bd.append(breakdownTable(agg.states, canSeeMoney));
    const lt = root.querySelector("#prod-late"); clear(lt); lt.append(lateRiskTable(agg.lateRisk, canSeeMoney));
    const pr = root.querySelector("#prod-progress"); clear(pr); pr.append(inProgressTable(agg.inProgress, canSeeMoney));
    const td = root.querySelector("#prod-todo"); clear(td); td.append(notStartedTable(agg.notStarted, canSeeMoney));
  }

  function setLoading() {
    const kpiBox = root.querySelector("#prod-kpis");
    clear(kpiBox); kpiBox.append(stateBox("loading", "Loading figures…"));
    for (const id of ["#prod-breakdown", "#prod-late", "#prod-progress", "#prod-todo"]) {
      const n = root.querySelector(id); clear(n); n.append(stateBox("loading", "Loading…"));
    }
  }

  function setError(msg) {
    const kpiBox = root.querySelector("#prod-kpis");
    clear(kpiBox); kpiBox.append(stateBox("error", "Could not load production data", msg));
    for (const id of ["#prod-breakdown", "#prod-late", "#prod-progress", "#prod-todo"]) {
      clear(root.querySelector(id));
    }
  }

  async function loadYear(year) {
    currentYear = year;
    setLoading();
    try {
      const rows = await fetchYearJobCards(year);
      paint(aggregate(rows, Date.now()));
    } catch (err) {
      setError(authy(err));
    }
  }

  // --- Wire + kick off ---
  yearSel.addEventListener("change", () => loadYear(Number(yearSel.value)));
  await loadYear(Number(yearSel.value));

  // Refresh the freshness line (best-effort; shared across sections via ctx).
  if (typeof ctx.setFreshness === "function") {
    fetchFreshness().then((ts) => { if (ts) ctx.setFreshness(ts); }).catch(() => {});
  }
}
