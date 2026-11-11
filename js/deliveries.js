// =========================================================================
// Promo Kings — Deliveries board
//
// Job cards only (is_job_card = true), read from public.job_card
// (RLS-gated; needs a logged-in staff role).
//
// Exposes: renderDeliveries(root, ctx)
//   root : the #content element to render into
//   ctx  : { supabase, profile, role, canSeeMoney, setFreshness }
//
// What it answers:
//   - PENDING deliveries for the selected year (delivery_state != 'done'):
//     promise, customer, value, on-time risk, partial progress;
//   - DELIVERED RECENTLY (delivery_state = 'done', last_delivery_done within
//     14 days), newest first;
//   - a server-side SEARCH by SO number / customer.
//
// On-time risk never treats a non-genuine promise as a commitment
// (genuine_promise = false => "No firm date").
// =========================================================================

import {
  supabase, el, clear, kes, kesCompact, date, dateTime
} from "./common.js";

const YEARS = [2026, 2025, 2024, 2023];
const DAY_MS = 24 * 3600 * 1000;
const RECENT_DAYS = 14;
const SOON_DAYS = 7;
const PAGE = 50;

// ---- Nairobi civil-date bounds (EAT, UTC+3, no DST) ----------------------
function yearBounds(year) {
  return [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`];
}

const JC_COLS =
  "so_id,so_name,customer_name,rep,team,order_date,promise,genuine_promise," +
  "value_kes,delivery_state,deliveries,done_deliveries,last_delivery_done,on_time";

// ---- Data access ---------------------------------------------------------

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

/** Job cards fully delivered in the last RECENT_DAYS, newest first. */
async function fetchRecentlyDelivered() {
  const since = new Date(Date.now() - RECENT_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("job_card")
    .select(JC_COLS)
    .eq("is_job_card", true)
    .eq("delivery_state", "done")
    .gte("last_delivery_done", since)
    .order("last_delivery_done", { ascending: false })
    .limit(300);
  if (error) throw error;
  return data || [];
}

/** Server-side search of job cards by SO number / customer, paged. */
async function searchJobCards(term, page) {
  let q = supabase
    .from("job_card")
    .select(JC_COLS, { count: "exact" })
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

// ---- Risk model ----------------------------------------------------------
//
// For a pending (not-done) job card:
//   - no genuine promise / no date  -> "No firm date"  (neutral)
//   - promise already past          -> "Overdue"       (red)
//   - promise within SOON_DAYS      -> "Due soon"      (amber)
//   - otherwise                     -> "On track"      (neutral green-ish)
function riskOf(row, nowMs) {
  const genuine = row.genuine_promise === true;
  const promiseMs = row.promise ? new Date(row.promise).getTime() : NaN;
  if (!genuine || !Number.isFinite(promiseMs)) {
    return { key: "none", label: "No firm date", cls: "badge--na", promiseMs: Infinity, daysLate: 0 };
  }
  if (promiseMs < nowMs) {
    return { key: "overdue", label: "Overdue", cls: "badge--late", promiseMs,
             daysLate: Math.floor((nowMs - promiseMs) / DAY_MS) };
  }
  if (promiseMs <= nowMs + SOON_DAYS * DAY_MS) {
    return { key: "soon", label: "Due soon", cls: "badge--partial", promiseMs, daysLate: 0 };
  }
  return { key: "track", label: "On track", cls: "badge--done", promiseMs, daysLate: 0 };
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

function ontimeBadge(v) {
  if (v === true) return el("span", { class: "badge badge--ontime", text: "On time" });
  if (v === false) return el("span", { class: "badge badge--late", text: "Late" });
  return el("span", { class: "badge badge--na", text: "n/a" });
}

function riskBadge(risk) {
  const label = risk.key === "overdue" ? `Overdue ${risk.daysLate}d` : risk.label;
  return el("span", { class: "badge " + risk.cls, text: label });
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

function authy(err) {
  const m = (err && (err.message || err.error_description)) || "Unexpected error.";
  if (/permission|rls|policy|JWT|401|403/i.test(m)) {
    return "You may not have access to this data, or your session expired. Try signing in again.";
  }
  return m;
}

const nf = (n) => Number(n || 0).toLocaleString("en-KE");

// ---- Row/table builders --------------------------------------------------

/** Pending deliveries table: SO, customer, promise, progress, risk, (value). */
function pendingTable(rows, canSeeMoney) {
  if (!rows.length) {
    return stateBox("info", "Nothing pending", "Every job card in this year is fully delivered.");
  }
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }),
    el("th", { text: "Promised" }), el("th", { class: "num", text: "Progress" }),
    el("th", { text: "Risk" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { title: dateTime(r.promise), text: date(r.promise) }),
      el("td", { class: "num", text: `${nf(r.done_deliveries)} / ${nf(r.deliveries)}` }),
      el("td", {}, riskBadge(r._risk))
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

/** Recently-delivered table: SO, customer, delivered, on-time, (value). */
function recentTable(rows, canSeeMoney) {
  if (!rows.length) {
    return stateBox("info", "Nothing in the last 14 days", "No job card was fully delivered recently.");
  }
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }),
    el("th", { text: "Delivered" }), el("th", { text: "On time" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { title: dateTime(r.last_delivery_done), text: date(r.last_delivery_done) }),
      el("td", {}, ontimeBadge(r.on_time))
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

/** Search-results table: SO, customer, promise, progress, delivery, on-time, (value). */
function searchTable(rows, canSeeMoney) {
  const head = [el("th", { text: "SO" }), el("th", { text: "Customer" }), el("th", { text: "Promised" }),
    el("th", { class: "num", text: "Progress" }), el("th", { text: "Delivery" }), el("th", { text: "On time" })];
  if (canSeeMoney) head.push(el("th", { class: "num", text: "Value" }));

  const body = rows.map((r) => {
    const cells = [
      el("td", { text: r.so_name || "—" }),
      el("td", { class: "wrap", text: r.customer_name || "—" }),
      el("td", { title: dateTime(r.promise), text: date(r.promise) }),
      el("td", { class: "num", text: `${nf(r.done_deliveries)} / ${nf(r.deliveries)}` }),
      el("td", {}, deliveryBadge(r.delivery_state)),
      el("td", {}, ontimeBadge(r.on_time))
    ];
    if (canSeeMoney) cells.push(el("td", { class: "num", text: kes(r.value_kes) }));
    return el("tr", {}, cells);
  });
  return el("div", { class: "table-scroll" },
    el("table", { class: "data" }, [el("thead", {}, el("tr", {}, head)), el("tbody", {}, body)]));
}

// ---- Aggregation for the pending list -----------------------------------

function pendingAgg(rows, nowMs) {
  const pending = [];
  let value = 0, overdue = 0, soon = 0, partial = 0;
  for (const r of rows) {
    const st = r.delivery_state;
    if (st === "done") continue;
    const risk = riskOf(r, nowMs);
    pending.push({ ...r, _risk: risk, _promiseMs: risk.promiseMs });
    value += Number(r.value_kes) || 0;
    if (risk.key === "overdue") overdue += 1;
    if (risk.key === "soon") soon += 1;
    if (st === "partial") partial += 1;
  }
  // Most overdue first, then soonest, then far future, then no-date.
  pending.sort((a, b) => a._promiseMs - b._promiseMs);
  return { pending, value, overdue, soon, partial, count: pending.length };
}

// ---- Main render ---------------------------------------------------------

export async function renderDeliveries(root, ctx) {
  clear(root);
  const canSeeMoney = !!ctx.canSeeMoney;

  // --- Static scaffold ---
  const yearSel = el("select", { class: "select", id: "f-year" },
    YEARS.map((y) => el("option", { value: String(y), text: String(y), selected: y === YEARS[0] })));

  const head = el("div", { class: "section-head" }, [
    el("h2", { text: "Deliveries" }),
    el("div", { class: "subtle", id: "del-scope" }, "")
  ]);

  const note = el("div", { class: "card" }, [
    el("div", { class: "subtle", text:
      "Pending and delivered status is from Odoo delivery state (via each order's procurement group). " +
      "Risk is read off the genuine promise date only — a non-genuine promise shows as \"No firm date\"." })
  ]);

  const filters = el("div", { class: "filters" }, [
    el("label", { class: "filter" }, [el("span", { text: "Year" }), yearSel])
  ]);

  const kpis = el("div", { class: "kpis", id: "del-kpis" }, stateBox("loading", "Loading figures…"));

  const pendingBody = el("div", { id: "del-pending" }, stateBox("loading", "Loading…"));
  const pendingCard = card("Pending deliveries", "most overdue first",
    "Job cards ordered in the selected year that are not fully delivered, sorted by promise date (most overdue first).",
    pendingBody);

  const recentBody = el("div", { id: "del-recent" }, stateBox("loading", "Loading…"));
  const recentCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Delivered recently" }),
      el("span", { class: "subtle", id: "del-recent-sub", title: "Job cards fully delivered in the last 14 days, newest first." }, "last 14 days")
    ]),
    recentBody
  ]);

  // Search card
  const searchInput = el("input", { class: "input", id: "del-search", type: "search",
    placeholder: "Search SO number or customer…", autocomplete: "off" });
  const searchBtn = el("button", { class: "btn btn--primary", type: "button", text: "Search" });
  const searchBody = el("div", { id: "del-search-body" });
  const searchCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Find a delivery" }),
      el("span", { class: "subtle", title: "Search all job cards by SO number or customer, newest first." }, "all job cards")
    ]),
    el("div", { class: "search-row" }, [searchInput, searchBtn]),
    searchBody
  ]);

  root.append(head, note, filters, kpis, pendingCard, recentCard, searchCard);

  // --- State ---
  let currentYear = YEARS[0];

  function paintPending(agg) {
    root.querySelector("#del-scope").textContent =
      `${currentYear} · ${nf(agg.count)} pending`;

    const tiles = [];
    tiles.push(kpiTile("Pending", nf(agg.count), currentYear + ", not done",
      "Job cards ordered in the selected year whose delivery_state is not 'done'."));
    tiles.push(kpiTile("Overdue", nf(agg.overdue), "genuine promise past",
      "Pending job cards with a genuine promise whose date has already passed."));
    tiles.push(kpiTile("Due soon", nf(agg.soon), "≤ 7 days",
      "Pending job cards with a genuine promise falling within the next 7 days."));
    if (canSeeMoney) {
      tiles.push(kpiTile("Pending value", kesCompact(agg.value), "not-done job cards",
        "Sum of value_kes for pending job cards (USD-converted, in KES)."));
    } else {
      tiles.push(kpiTile("Partial", nf(agg.partial), "part-delivered",
        "Pending job cards whose delivery_state is 'partial'."));
    }
    const kpiBox = root.querySelector("#del-kpis");
    clear(kpiBox); tiles.forEach((t) => kpiBox.append(t));

    const pb = root.querySelector("#del-pending");
    clear(pb); pb.append(pendingTable(agg.pending, canSeeMoney));
  }

  async function loadYear(year) {
    currentYear = year;
    const kpiBox = root.querySelector("#del-kpis");
    clear(kpiBox); kpiBox.append(stateBox("loading", "Loading figures…"));
    const pb = root.querySelector("#del-pending"); clear(pb); pb.append(stateBox("loading", "Loading…"));
    try {
      const rows = await fetchYearJobCards(year);
      paintPending(pendingAgg(rows, Date.now()));
    } catch (err) {
      clear(kpiBox); kpiBox.append(stateBox("error", "Could not load deliveries", authy(err)));
      clear(pb);
    }
  }

  async function loadRecent() {
    const rb = root.querySelector("#del-recent"); clear(rb); rb.append(stateBox("loading", "Loading…"));
    try {
      const rows = await fetchRecentlyDelivered();
      clear(rb); rb.append(recentTable(rows, canSeeMoney));
      root.querySelector("#del-recent-sub").textContent = `${nf(rows.length)} in last 14 days`;
    } catch (err) {
      clear(rb); rb.append(stateBox("error", "Could not load recent deliveries", authy(err)));
    }
  }

  // --- Search ---
  let searchPage = 0;
  let searchTerm = "";
  async function runSearch(page) {
    searchPage = page;
    clear(searchBody); searchBody.append(stateBox("loading", "Searching…"));
    try {
      const { rows, total } = await searchJobCards(searchTerm, page);
      clear(searchBody);
      if (!rows.length) {
        searchBody.append(stateBox("info", "No job cards found",
          searchTerm ? "Try a different SO number or customer name." : "No job cards available."));
        return;
      }
      searchBody.append(searchTable(rows, canSeeMoney));
      const pages = Math.max(1, Math.ceil(total / PAGE));
      const prevBtn = el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "‹ Prev",
        disabled: page <= 0, on: { click: () => runSearch(page - 1) } });
      const nextBtn = el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Next ›",
        disabled: page >= pages - 1, on: { click: () => runSearch(page + 1) } });
      searchBody.append(el("div", { class: "pager" }, [
        prevBtn,
        el("span", { class: "subtle", text: `${nf(total)} result${total === 1 ? "" : "s"} · page ${page + 1} of ${pages}` }),
        nextBtn
      ]));
    } catch (err) {
      clear(searchBody); searchBody.append(stateBox("error", "Search failed", authy(err)));
    }
  }

  // --- Wire + kick off ---
  yearSel.addEventListener("change", () => loadYear(Number(yearSel.value)));
  searchBtn.addEventListener("click", () => { searchTerm = searchInput.value; runSearch(0); });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { searchTerm = searchInput.value; runSearch(0); }
  });

  await loadYear(Number(yearSel.value));
  loadRecent();
  runSearch(0);

  if (typeof ctx.setFreshness === "function") {
    fetchFreshness().then((ts) => { if (ts) ctx.setFreshness(ts); }).catch(() => {});
  }
}
