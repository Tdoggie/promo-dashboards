// =========================================================================
// Promo Kings — Deliveries. Strictly delivery timeliness, from Odoo's own
// delivery state (it logs ~92% of deliveries). OTD = genuine promises only.
// =========================================================================
import { el, clear, kesCompact, date, pct } from "./common.js";
import { statTile, lineArea, barChart, hBar, theme, hasECharts } from "./charts.js";
import { pull, sectionHead, card, stateBox, loadFail, note, chartBox, dataTable } from "./ui.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS3 = [2024, 2025, 2026];
const TODAY = new Date().toISOString().slice(0, 10);
const LEAD = [["≤3d",0,3],["4–7d",4,7],["8–14d",8,14],["15–30d",15,30],["31d+",31,1e9]];
let _otd3 = null;   // cached 3-year genuine/measurable set

export async function renderDeliveries(root, ctx) {
  clear(root);
  const p = ctx.period(), money = ctx.canSeeMoney, t = theme();
  root.append(sectionHead("Deliveries", p.label));
  root.append(note("Odoo logs ~92% of deliveries (date + who validated). Proof-of-delivery, site contact, vehicle and rider are not in Odoo."));
  const kpis = el("div", { class:"grid cols-4" }); root.append(kpis);
  const rowA = el("div", { class:"grid cols-2" }); root.append(rowA);
  const rowB = el("div", { class:"grid cols-2" }); root.append(rowB);
  kpis.append(stateBox("Loading…"));

  let jc;
  try {
    jc = await pull("v_job_card", "so_name,customer_name,value_kes,is_job_card,order_date,promise,genuine_promise,on_time,delivery_state,deliveries,done_deliveries,last_delivery_done",
      [["gte","order_date",p.start],["lt","order_date",p.end],["eq","is_job_card",true]]);
    if (!_otd3) _otd3 = await pull("v_job_card", "order_date,on_time,genuine_promise",
      [["gte","order_date",`${YEARS3[0]}-01-01`],["eq","is_job_card",true],["eq","genuine_promise",true]]);
  } catch (e) { clear(kpis); kpis.append(loadFail(e)); return; }

  // ---- period OTD ----
  const meas = jc.filter(r => r.genuine_promise && r.on_time != null);
  const onTime = meas.filter(r => r.on_time);
  const excluded = jc.length - meas.length;
  const otdPct = meas.length ? onTime.length / meas.length * 100 : null;
  const open = jc.filter(r => r.delivery_state !== "done");
  const overdue = open.filter(r => r.genuine_promise && r.promise && r.promise.slice(0,10) < TODAY);
  // lead time (ordered & delivered in period)
  const leadDays = jc.filter(r => r.delivery_state === "done" && r.last_delivery_done)
    .map(r => Math.max(0, Math.round((new Date(r.last_delivery_done) - new Date(r.order_date)) / 86400000)));
  const avgLead = leadDays.length ? Math.round(leadDays.reduce((a,b)=>a+b,0) / leadDays.length) : null;

  clear(kpis);
  kpis.append(
    statTile({ label:"On-time delivery", color:t.cat[2], value: otdPct==null?"—":pct(otdPct), sub:"genuine promises",
      caption: `${excluded.toLocaleString()} non-committed excluded` }),
    statTile({ label:"On time", color:t.success, value: `${onTime.length}/${meas.length}`, sub:"measurable job cards" }),
    statTile({ label:"Overdue", color:t.danger, value:String(overdue.length), sub:"open, past a firm promise" }),
    statTile({ label:"Avg lead time", color:t.cat[1], value: avgLead==null?"—":avgLead+"d", sub:"order → delivered" })
  );

  // ---- OTD by month, 3-year YoY ----
  const otdCard = card("On-time delivery", { sub:"3-year, by order month" });
  const otdChart = chartBox(); otdCard.body.append(otdChart); rowA.append(otdCard.card);
  const otdSeries = YEARS3.map(y => ({
    name:String(y), kind: y===2026?"current":y===2025?"prev":"older",
    data: MON.map((_, i) => {
      const mm = String(i+1).padStart(2,"0");
      const set = _otd3.filter(r => r.order_date.slice(0,7) === `${y}-${mm}` && r.on_time != null);
      return set.length ? Math.round(set.filter(r=>r.on_time).length / set.length * 1000)/10 : null;
    })
  }));
  if (hasECharts()) lineArea(otdChart, { categories:MON, series:otdSeries, valueFmt:(v)=>v+"%", yMax:100, areaOnCurrent:false, target:{ value:90, label:"90%" } });

  // ---- Lead-time distribution ----
  const ltCard = card("Lead time", { sub:"order → delivered, this period" });
  const ltChart = chartBox("220px"); ltCard.body.append(ltChart); rowA.append(ltCard.card);
  const buckets = LEAD.map(([lbl,lo,hi]) => leadDays.filter(d => d>=lo && d<=hi).length);
  if (hasECharts() && leadDays.length) barChart(ltChart, { categories:LEAD.map(x=>x[0]), data:buckets, valueFmt:(v)=>String(v), color:t.cat[2] });
  else ltCard.body.append(stateBox("No completed deliveries this period"));

  // ---- Overdue (drill) ----
  const odCard = card("Overdue deliveries", { onExpand: () => overdueDrill(ctx, overdue, money) });
  const odBox = el("div"); odCard.body.append(odBox); rowB.append(odCard.card);
  const od = overdue.map(r => ({ ...r, days: dleft(r.promise) })).sort((a,b)=>b.days-a.days).slice(0,8);
  hBar(odBox, { rows: od.map(r => ({ label:r.so_name, sub:r.customer_name, value:r.days, display:r.days+"d late", color:t.danger })), emptyText:"Nothing overdue" });

  // ---- Partial deliveries ----
  const paCard = card("Partly delivered", { sub:p.label });
  const paBox = el("div"); paCard.body.append(paBox); rowB.append(paCard.card);
  const part = jc.filter(r => r.delivery_state === "partial").sort((a,b)=>(b.deliveries-b.done_deliveries)-(a.deliveries-a.done_deliveries)).slice(0,8);
  if (!part.length) paBox.append(stateBox("None partly delivered"));
  else {
    const l = el("div", { class:"mini-list" });
    for (const r of part) l.append(el("div", { class:"mini-row" }, [
      el("span", { class:"mini-lbl", text:`${r.so_name} · ${r.customer_name||"—"}` }),
      el("span", { class:"mini-val", text:`${r.done_deliveries||0}/${r.deliveries||0}` })
    ]));
    paBox.append(l);
  }
}

function dleft(promise) { return Math.max(0, Math.round((new Date(TODAY) - new Date(promise.slice(0,10))) / 86400000)); }
function overdueDrill(ctx, overdue, money) {
  const rows = overdue.map(r => ({ ...r, days: dleft(r.promise) })).sort((a,b)=>b.days-a.days);
  ctx.modal(`Overdue · ${ctx.period().label}`, dataTable([
    { key:"so_name", label:"Job card" }, { key:"customer_name", label:"Customer" },
    { key:"promise", label:"Promised", fmt:v=>date(v) }, { key:"days", label:"Days late", num:true },
    { key:"done_deliveries", label:"Done", num:true, fmt:(v,r)=>`${v||0}/${r.deliveries||0}` },
    { key:"value_kes", label:"Value", num:true, fmt:v => money && v!=null ? kesCompact(v) : "—" }
  ], rows));
}
