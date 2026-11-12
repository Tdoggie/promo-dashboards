// =========================================================================
// Promo Kings — shared section helpers (period-driven dashboards).
// Keeps Sales / Production / Deliveries consistent with the Overview.
// =========================================================================
import { supabase, el, clear } from "./common.js";

/** Paginated read of a view with PostgREST filters [["gte","col",val], ...]. */
export async function pull(view, cols, filters, order) {
  const rows = []; let from = 0; const size = 1000;
  for (let g = 0; g < 60; g++) {
    let q = supabase.from(view).select(cols);
    for (const f of (filters || [])) q = q[f[0]](f[1], f[2]);
    if (order) q = q.order(order[0], { ascending: order[1] !== false, nullsFirst: false });
    const { data, error } = await q.range(from, from + size - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return rows;
}

export function sectionHead(title, sub) {
  return el("div", { class: "sec-head" }, [
    el("h1", { text: title }),
    sub ? el("span", { class: "sec-sub", text: sub }) : null
  ]);
}

/** card(title, {sub, onExpand}) -> {card, body}. onExpand adds a "View all" link. */
export function card(title, opts = {}) {
  const right = opts.onExpand
    ? el("button", { class: "link-btn", type: "button", text: opts.expandLabel || "View all", on: { click: opts.onExpand } })
    : (opts.sub ? el("span", { class: "subtle", text: opts.sub }) : null);
  const head = el("div", { class: "card-head" }, [el("h3", { text: title }), right]);
  const body = el("div");
  return { card: el("div", { class: "card" }, [head, body]), body };
}

export function stateBox(msg) { return el("div", { class: "statebox", text: msg }); }
export function note(text) { return el("p", { class: "note", text }); }
export function chartBox(h) { return el("div", { class: "chart", style: { height: h || "260px" } }); }
export function isAuthErr(e) { return /permission|rls|policy|JWT|401|403/i.test((e && e.message) || ""); }
export function loadFail(e) { return stateBox(isAuthErr(e) ? "Session expired — sign in again." : "Could not load."); }

/** Months 'YYYY-MM' in [start,end). */
export function monthsIn(start, end) {
  const out = []; let [y, m] = start.split("-").map(Number); const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && m < em)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

/**
 * dataTable(columns, rows) -> <table class="tbl"> for modal drills.
 * columns: [{key, label, num?:bool, fmt?:fn}]
 */
export function dataTable(columns, rows) {
  const thead = el("thead", {}, el("tr", {}, columns.map(c => el("th", { class: c.num ? "num" : null, text: c.label }))));
  const tb = el("tbody");
  for (const r of rows) {
    tb.append(el("tr", {}, columns.map(c => {
      const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
      return el("td", { class: c.num ? "num" : null, text: v == null ? "—" : String(v) });
    })));
  }
  return el("table", { class: "tbl" }, [thead, tb]);
}

/** Civil-month index helper for a YYYY-MM string -> {y, m(1-12)}. */
export function ym(ts) {
  if (!ts) return null;
  const s = String(ts);
  return { y: +s.slice(0, 4), m: +s.slice(5, 7) };
}
