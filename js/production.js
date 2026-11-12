// =========================================================================
// Promo Kings — Production. "Where work sits" from Odoo order/delivery state
// (paperwork, not floor timing) + real floor output from the workbooks.
// =========================================================================
import { el, clear, kesCompact, date } from "./common.js";
import { statTile, stackedBar, donut, hBar, theme, hasECharts } from "./charts.js";
import { pull, sectionHead, card, stateBox, loadFail, note, chartBox, dataTable } from "./ui.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TODAY = new Date().toISOString().slice(0, 10);

export async function renderProduction(root, ctx) {
  clear(root);
  const p = ctx.period(), money = ctx.canSeeMoney, t = theme();
  root.append(sectionHead("Production", p.label));
  root.append(note("Odoo order & delivery state — paperwork, not shop-floor timing. Floor output from the production workbooks."));
  const kpis = el("div", { class: "grid cols-4" }); root.append(kpis);
  const rowA = el("div", { class: "grid cols-2" }); root.append(rowA);
  const rowB = el("div", { class: "grid cols-2" }); root.append(rowB);
  kpis.append(stateBox("Loading…"));

  let jcYear, dept;
  try {
    [jcYear, dept] = await Promise.all([
      pull("v_job_card", "so_name,customer_name,value_kes,is_job_card,order_date,promise,genuine_promise,on_time,delivery_state,deliveries,done_deliveries",
           [["gte","order_date",`${p.year}-01-01`],["lt","order_date",`${p.year+1}-01-01`],["eq","is_job_card",true]]),
      pull("v_dept_output", "department,unit,uom,grain,period_start,output_qty,backfilled")
    ]);
  } catch (e) { clear(kpis); kpis.append(loadFail(e)); return; }

  const inP = jcYear.filter(r => r.order_date >= p.start && r.order_date < p.end);
  const open = inP.filter(r => r.delivery_state !== "done");
  const overdue = open.filter(r => r.genuine_promise && r.promise && r.promise.slice(0,10) < TODAY);
  const partial = inP.filter(r => r.delivery_state === "partial");
  const delivered = inP.filter(r => r.delivery_state === "done");
  const openVal = open.reduce((a, r) => a + (Number(r.value_kes) || 0), 0);

  clear(kpis);
  kpis.append(
    statTile({ label:"Open job cards", color:t.cat[3], value:String(open.length), sub: money ? kesCompact(openVal)+" open" : "not delivered" }),
    statTile({ label:"Overdue", color:t.danger, value:String(overdue.length), sub:"past a firm promise" }),
    statTile({ label:"In progress", color:t.warn, value:String(partial.length), sub:"part-delivered" }),
    statTile({ label:"Delivered", color:t.success, value:String(delivered.length), sub:"this period" })
  );

  // ---- Where work sits: delivery-state by month (one chart) ----
  const wsCard = card(`Where work sits · ${p.year}`, { sub:"job cards by state, by order month" });
  const wsChart = chartBox(); wsCard.body.append(wsChart); rowA.append(wsCard.card);
  const stateByMonth = (st) => MON.map((_, i) => jcYear.filter(r =>
    r.order_date.slice(5,7) === String(i+1).padStart(2,"0") && r.delivery_state === st).length);
  if (hasECharts()) stackedBar(wsChart, {
    categories: MON,
    series: [
      { name:"Not started", data:stateByMonth("none"), color:t.muted },
      { name:"In progress", data:stateByMonth("partial"), color:t.warn },
      { name:"Delivered", data:stateByMonth("done"), color:t.success }
    ], valueFmt:(v)=>String(v)
  });

  // ---- Late-risk (drill) ----
  const lrCard = card("Late-risk", { onExpand: () => lateDrill(ctx, overdue, money) });
  const lrBox = el("div"); lrCard.body.append(lrBox); rowA.append(lrCard.card);
  const lr = overdue.map(r => ({ ...r, days: daysBetween(r.promise, TODAY) })).sort((a,b)=>b.days-a.days).slice(0, 8);
  hBar(lrBox, { rows: lr.map(r => ({ label:r.so_name, sub:r.customer_name, value:r.days,
    display:r.days + "d late", color:t.danger })), emptyText:"Nothing overdue" });

  // ---- Department output: branding MoM by section ----
  const brand = dept.filter(r => r.department === "Branding");
  const bmCard = card("Branding output · by month", { sub:"pieces" });
  const bmChart = chartBox(); bmCard.body.append(bmChart); rowB.append(bmCard.card);
  const sections = ["Screen Printing", "Embroidery", "Sublimation"];
  const secMonth = (sec) => MON.map((_, i) => {
    const ym = `${p.year}-${String(i+1).padStart(2,"0")}-01`;
    const row = brand.find(r => r.unit === sec && r.period_start === ym);
    return row ? Number(row.output_qty) : 0;
  });
  if (hasECharts()) stackedBar(bmChart, {
    categories: MON, series: sections.map((s, i) => ({ name:s, data:secMonth(s), color:t.cat[i+1] })), valueFmt:(v)=>String(v)
  });
  bmCard.body.append(note("Jan–Jun back-filled by the workbook script; Jul–Oct typed."));

  // ---- Floor output snapshot (native units, current period) ----
  const foCard = card("Floor output · this period", { sub:"current coverage only" });
  const foBox = el("div"); foCard.body.append(foBox); rowB.append(foCard.card);
  const inPer = (d) => d >= p.start && d < p.end;
  const list = el("div", { class:"mini-list" });
  const stitch = dept.filter(r => r.department === "Stitching" && inPer(r.period_start)).reduce((a,r)=>a+(Number(r.output_qty)||0),0);
  const brandP = dept.filter(r => r.department === "Branding" && inPer(r.period_start)).reduce((a,r)=>a+(Number(r.output_qty)||0),0);
  if (brandP) list.append(miniRow("Branding", Math.round(brandP).toLocaleString()+" pcs"));
  if (stitch) list.append(miniRow("Stitching", Math.round(stitch).toLocaleString()+" pcs"));
  const rw = new Map();
  for (const r of dept.filter(x => x.department === "Royal Weaver" && inPer(x.period_start))) {
    const e = rw.get(r.unit) || { q:0, uom:r.uom }; e.q += Number(r.output_qty) || 0; rw.set(r.unit, e);
  }
  for (const [k, e] of [...rw.entries()].sort((a,b)=>b[1].q-a[1].q)) list.append(miniRow("RW · " + k, Math.round(e.q).toLocaleString()+" "+e.uom));
  if (!list.children.length) foBox.append(stateBox("No floor data for this period"));
  else { foBox.append(list); foCard.body.append(note("Stitching & RW: current period only (no history in the workbooks).")); }
}

function miniRow(lbl, val) { return el("div", { class:"mini-row" }, [el("span", { class:"mini-lbl", text:lbl }), el("span", { class:"mini-val", text:val })]); }
function daysBetween(a, b) { return Math.max(0, Math.round((new Date(b) - new Date((a||"").slice(0,10))) / 86400000)); }
function lateDrill(ctx, overdue, money) {
  const rows = overdue.map(r => ({ ...r, days: daysBetween(r.promise, TODAY) })).sort((a,b)=>b.days-a.days);
  ctx.modal(`Overdue · ${ctx.period().label}`, dataTable([
    { key:"so_name", label:"Job card" }, { key:"customer_name", label:"Customer" },
    { key:"promise", label:"Promised", fmt:v=>date(v) }, { key:"days", label:"Days late", num:true },
    { key:"value_kes", label:"Value", num:true, fmt:v => money && v!=null ? kesCompact(v) : "—" }
  ], rows));
}
