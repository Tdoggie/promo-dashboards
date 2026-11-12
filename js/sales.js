// =========================================================================
// Promo Kings — Sales (period-driven). All orders. Net sales = invoiced
// (ties to Odoo); order intake = booked. No OTD here (that's Deliveries).
// =========================================================================
import { el, clear, kes, kesCompact, date } from "./common.js";
import { statTile, stackedBar, hBar, lineArea, fmtDelta, theme, hasECharts } from "./charts.js";
import { pull, sectionHead, card, stateBox, loadFail, note, chartBox, monthsIn, dataTable } from "./ui.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export async function renderSales(root, ctx) {
  clear(root);
  const p = ctx.period(), money = ctx.canSeeMoney, t = theme();
  root.append(sectionHead("Sales", `${p.label}${p.compare ? " vs " + p.pyLabel : ""}`));
  const kpis = el("div", { class: "grid cols-4" }); root.append(kpis);
  const rowA = el("div", { class: "grid cols-2" }); root.append(rowA);
  const rowB = el("div", { class: "grid cols-2" }); root.append(rowB);
  kpis.append(stateBox("Loading…"));

  let revM, jc, jcPy;
  try {
    [revM, jc, jcPy] = await Promise.all([
      pull("v_revenue_month", "ym,line,move_type,rev_kes"),
      pull("v_job_card", "value_kes,is_job_card,customer_id,customer_name,rep,so_name,order_date,delivery_state",
           [["gte","order_date",p.start],["lt","order_date",p.end]]),
      pull("v_job_card", "value_kes", [["gte","order_date",p.pyStart],["lt","order_date",p.pyEnd]])
    ]);
  } catch (e) { clear(kpis); kpis.append(loadFail(e)); return; }

  // ---- period aggregates from revenue (invoiced) ----
  const curM = new Set(monthsIn(p.start, p.end)), pyM = new Set(monthsIn(p.pyStart, p.pyEnd));
  let netCur = 0, netPy = 0, credCur = 0, custInv = new Set();
  for (const r of revM) {
    const v = Number(r.rev_kes) || 0;
    if (curM.has(r.ym)) { netCur += v; if (r.move_type === "out_refund") credCur += v; }
    if (pyM.has(r.ym)) netPy += v;
  }
  // ---- period aggregates from orders (booked) ----
  const intakeCur = jc.reduce((a, r) => a + (Number(r.value_kes) || 0), 0);
  const intakePy = jcPy.reduce((a, r) => a + (Number(r.value_kes) || 0), 0);
  const custs = new Set(jc.map(r => r.customer_id || r.customer_name).filter(Boolean));

  clear(kpis);
  kpis.append(
    statTile({ label:"Net sales", color:t.cat[0], value: money ? kesCompact(netCur) : "—", sub:"invoiced",
      delta: p.compare ? d(netCur, netPy) : null, caption:"Ties to Odoo Invoicing Analysis" }),
    statTile({ label:"Order intake", color:t.cat[1], value: money ? kesCompact(intakeCur) : String(jc.length),
      sub: money ? "booked" : "orders", delta: p.compare ? d(intakeCur, intakePy) : null }),
    statTile({ label:"Credit notes", color:t.cat[3], value: money ? kesCompact(Math.abs(credCur)) : "—", sub:"invoiced period",
      caption:"Returns & value credits" }),
    statTile({ label:"Customers", color:t.cat[2], value:String(custs.size), sub:"ordered this period" })
  );

  // ---- Net sales by month, stacked PKL/RW, prior-year line ----
  const yv = p.year;
  const byLine = (ln, y) => MON.map((_, i) => {
    const key = `${y}-${String(i + 1).padStart(2, "0")}`;
    return revM.filter(r => r.ym === key && r.line === ln).reduce((a, r) => a + (Number(r.rev_kes) || 0), 0);
  });
  const totY = (y) => MON.map((_, i) => {
    const key = `${y}-${String(i + 1).padStart(2, "0")}`;
    return revM.filter(r => r.ym === key).reduce((a, r) => a + (Number(r.rev_kes) || 0), 0);
  });
  const nsCard = card(`Net sales by month · ${yv}`, { sub:"stacked by line" });
  const nsChart = chartBox(); nsCard.body.append(nsChart); rowA.append(nsCard.card);
  if (hasECharts() && money) stackedBar(nsChart, {
    categories: MON,
    series: [{ name:"PKL", data:byLine("PKL", yv), color:t.cat[0] }, { name:"RW", data:byLine("RW", yv), color:t.cat[1] }],
    compareLine: p.compare ? { name:String(yv - 1), data:totY(yv - 1) } : null,
    valueFmt: kesCompact
  });
  else nsCard.body.append(stateBox(money ? "No data" : "Hidden for your role"));

  // ---- By rep (drill) ----
  const repAgg = aggBy(jc, r => r.rep || "—");
  const repCard = card("By salesperson", { sub: p.label });
  const repBox = el("div"); repCard.body.append(repBox); rowB.append(repCard.card);
  hBar(repBox, { rows: topN(repAgg, 8).map(x => ({
    label:x.key, value:x.val, display: money ? kesCompact(x.val) : String(x.n) + " orders", color:t.cat[1],
    onClick: () => repDrill(ctx, jc, x.key, money) })), emptyText:"No orders" });

  // ---- Top customers (drill all) ----
  const custAgg = aggBy(jc, r => (r.customer_name || "—"), r => r.customer_id || r.customer_name);
  const custCard = card("Top customers", { onExpand: () => custAll(ctx, custAgg, money) });
  const custBox = el("div"); custCard.body.append(custBox); rowB.append(custCard.card);
  hBar(custBox, { rows: topN(custAgg, 8).map(x => ({
    label:x.label, value:x.val, display: money ? kesCompact(x.val) : String(x.n) + " orders", color:t.cat[0] })),
    emptyText:"No orders" });

  // ---- Job-card search ----
  const sCard = card("Job-card search", { sub:"SO number or customer" });
  rowA.append(sCard.card);
  const input = el("input", { class:"input", type:"search", placeholder:"e.g. S36280 or Crown Paints" });
  const btn = el("button", { class:"btn btn--primary btn--sm", type:"button", text:"Search" });
  const results = el("div", { style:{ marginTop:"10px" } });
  sCard.body.append(el("div", { class:"search-row" }, [input, btn]), results);
  const run = async () => {
    const term = (input.value || "").replace(/[%()]/g, "").trim();
    if (!term) { clear(results); return; }
    clear(results); results.append(stateBox("Searching…"));
    try {
      const { data, error } = await ctx.supabase.from("v_job_card")
        .select("so_id,so_name,customer_name,value_kes,order_date,delivery_state,on_time,promise,deliveries,done_deliveries,rep")
        .eq("is_job_card", true).or(`so_name.ilike.%${term}%,customer_name.ilike.%${term}%`)
        .order("order_date", { ascending:false }).limit(25);
      if (error) throw error;
      clear(results);
      if (!data.length) { results.append(stateBox("No job cards found")); return; }
      results.append(dataTable([
        { key:"so_name", label:"Job card" }, { key:"customer_name", label:"Customer" },
        { key:"value_kes", label:"Value", num:true, fmt:v => money && v != null ? kes(v) : "—" },
        { key:"order_date", label:"Ordered", fmt:v => date(v) },
        { key:"delivery_state", label:"Delivery", fmt:stateLabel }
      ], data.map(r => Object.assign(r, { _click: r }))));
      // row click -> detail
      Array.from(results.querySelectorAll("tbody tr")).forEach((tr, i) => {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => jobDetail(ctx, data[i], money));
      });
    } catch (e) { clear(results); results.append(loadFail(e)); }
  };
  btn.addEventListener("click", run);
  input.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
}

// ---- helpers ----
function d(cur, base) { const f = fmtDelta(cur, base); return { dir:f.dir, text:f.text, base:"vs prior yr" }; }
function aggBy(rows, labelFn, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = (keyFn ? keyFn(r) : labelFn(r)); if (k == null) continue;
    const e = m.get(k) || { key:labelFn(r), label:labelFn(r), val:0, n:0 };
    e.val += Number(r.value_kes) || 0; e.n++; m.set(k, e);
  }
  return [...m.values()];
}
function topN(arr, n) { return arr.sort((a, b) => b.val - a.val).slice(0, n); }
function stateLabel(s) { return s === "done" ? "Delivered" : s === "partial" ? "In progress" : "Not started"; }

function repDrill(ctx, jc, rep, money) {
  const rows = aggBy(jc.filter(r => (r.rep || "—") === rep), r => r.customer_name || "—", r => r.customer_id || r.customer_name)
    .sort((a, b) => b.val - a.val);
  ctx.modal(`${rep} · ${ctx.period().label}`, dataTable([
    { key:"label", label:"Customer" }, { key:"n", label:"Orders", num:true },
    { key:"val", label:"Value", num:true, fmt:v => money ? kes(v) : "—" }
  ], rows));
}
function custAll(ctx, custAgg, money) {
  const rows = custAgg.sort((a, b) => b.val - a.val);
  ctx.modal(`Customers · ${ctx.period().label}`, dataTable([
    { key:"label", label:"Customer" }, { key:"n", label:"Orders", num:true },
    { key:"val", label:"Value", num:true, fmt:v => money ? kes(v) : "—" }
  ], rows));
}
function jobDetail(ctx, r, money) {
  const rows = [
    ["Job card", r.so_name], ["Customer", r.customer_name || "—"], ["Salesperson", r.rep || "—"],
    ["Value", money && r.value_kes != null ? kes(r.value_kes) : "—"],
    ["Ordered", date(r.order_date)], ["Promised", r.promise ? date(r.promise) : "—"],
    ["Delivery", stateLabel(r.delivery_state)], ["Deliveries", `${r.done_deliveries || 0} of ${r.deliveries || 0} done`],
    ["On time", r.on_time == null ? "—" : (r.on_time ? "Yes" : "No")]
  ];
  const dl = el("div", { class:"detail" });
  for (const [k, v] of rows) dl.append(el("div", { class:"detail-row" }, [el("span", { class:"dk", text:k }), el("span", { class:"dv", text:String(v) })]));
  ctx.modal(r.so_name, dl);
}
