// =========================================================================
// Promo Kings — Overview: the shared "what's going on" dashboard.
// Net sales (invoiced, ties to Odoo), order intake (booked), OTD, where work
// sits, top customers, production output — all driven by the global period.
// =========================================================================
import { supabase, el, clear, kes, kesCompact, pct } from "./common.js";
import { statTile, lineArea, donut, hBar, barChart, fmtDelta, theme, hasECharts } from "./charts.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS3 = [2024, 2025, 2026];           // 3-year YoY window
const STATE = { done:"Delivered", partial:"In progress", none:"Not started" };

async function pull(view, cols, filters){
  const rows = []; let from = 0; const size = 1000;
  for (let g=0; g<40; g++){
    let q = supabase.from(view).select(cols).range(from, from+size-1);
    for (const f of (filters||[])) q = q[f[0]](f[1], f[2]);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return rows;
}

function monthsIn(start, end){
  const out = []; let [y,m] = start.split("-").map(Number); const [ey,em] = end.split("-").map(Number);
  while (y < ey || (y===ey && m < em)){ out.push(`${y}-${String(m).padStart(2,"0")}`); m++; if (m>12){m=1;y++;} }
  return out;
}

export async function renderOverview(root, ctx){
  clear(root);
  const p = ctx.period();
  const head = el("div", { class:"sec-head" }, [ el("h1", { text:"Overview" }),
    el("span", { class:"sec-sub", text:`${p.label}${p.compare ? " vs "+p.pyLabel : ""}` }) ]);
  const kpis = el("div", { class:"grid cols-4" });
  const rowA = el("div", { class:"grid cols-2" });
  const rowB = el("div", { class:"grid cols-2" });
  root.append(head, kpis, rowA, rowB);
  kpis.append(stateBox("Loading…"));

  let revM, jc, jcPy, dept;
  try {
    [revM, jc, jcPy, dept] = await Promise.all([
      pull("v_revenue_month", "ym,line,move_type,rev_kes"),
      pull("v_job_card", "value_kes,is_job_card,genuine_promise,on_time,delivery_state,customer_id,customer_name",
           [["gte","order_date",p.start],["lt","order_date",p.end]]),
      pull("v_job_card", "value_kes",
           [["gte","order_date",p.pyStart],["lt","order_date",p.pyEnd]]),
      pull("v_dept_output", "department,unit,uom,grain,period_start,output_qty")
    ]);
  } catch (err){ clear(kpis); kpis.append(stateBox(/permission|JWT|401|403/i.test(err.message||"") ? "Session expired — sign in again." : "Could not load.")); return; }

  // ---- Net sales (invoiced) for the period + prior year, from v_revenue_month ----
  const curM = new Set(monthsIn(p.start, p.end)), pyM = new Set(monthsIn(p.pyStart, p.pyEnd));
  let netCur = 0, netPy = 0; const byYm = {};
  for (const r of revM){ const v = Number(r.rev_kes)||0; byYm[r.ym]=(byYm[r.ym]||0)+v;
    if (curM.has(r.ym)) netCur += v; if (pyM.has(r.ym)) netPy += v; }

  // ---- Order intake (booked) ----
  const intakeCur = jc.reduce((a,r)=>a+(Number(r.value_kes)||0),0);
  const intakePy  = jcPy.reduce((a,r)=>a+(Number(r.value_kes)||0),0);

  // ---- OTD (genuine, measurable) ----
  const otd = (rows)=>{ let g=0,ot=0; for (const r of rows){ if (r.is_job_card && r.genuine_promise && r.on_time!=null){ g++; if (r.on_time) ot++; } } return g? ot/g*100 : null; };
  const otdCur = otd(jc);

  // ---- Open / backlog (this period's job cards not fully delivered) ----
  const openRows = jc.filter(r=>r.is_job_card && r.delivery_state!=="done");
  const openVal = openRows.reduce((a,r)=>a+(Number(r.value_kes)||0),0);

  const money = ctx.canSeeMoney;
  clear(kpis);
  kpis.append(
    statTile({ label:"Net sales", color:theme().cat[0], value: money?kesCompact(netCur):"—",
      sub:"invoiced", delta: p.compare? deltaOf(netCur,netPy):null, caption:"Ties to Odoo Invoicing Analysis" }),
    statTile({ label:"Order intake", color:theme().cat[1], value: money?kesCompact(intakeCur):String(jc.length),
      sub: money?"booked":"job cards", delta: p.compare? deltaOf(intakeCur,intakePy):null }),
    statTile({ label:"On-time delivery", color:theme().cat[2], value: otdCur==null?"—":pct(otdCur),
      sub:"genuine promises", caption:"Non-committed dates excluded" }),
    statTile({ label:"Open", color:theme().cat[3], value:String(openRows.length),
      sub: money?kesCompact(openVal)+" open":"job cards", caption:"Not fully delivered" })
  );

  // ---- Net sales 3-year YoY (monthly lines) ----
  const yoyCard = card("Net sales", "3-year, monthly");
  const yoyChart = el("div", { class:"chart", style:{height:"260px"} });
  yoyCard.body.append(yoyChart);
  rowA.append(yoyCard.card);
  if (hasECharts()){
    const series = YEARS3.map((y,i)=>({
      name:String(y), kind: y===2026?"current":y===2025?"prev":"older",
      data: MON.map((_,mi)=> byYm[`${y}-${String(mi+1).padStart(2,"0")}`] ?? null)
    }));
    lineArea(yoyChart, { categories:MON, series, valueFmt:(v)=>kesCompact(v) });
  }

  // ---- Where work sits (period job cards by delivery state) ----
  const stCard = card("Where work sits", p.label);
  const stChart = el("div", { class:"chart", style:{height:"260px"} });
  stCard.body.append(stChart);
  rowA.append(stCard.card);
  const stAgg = { done:0, partial:0, none:0 };
  for (const r of jc){ if (r.is_job_card && stAgg[r.delivery_state]!=null) stAgg[r.delivery_state]++; }
  const t = theme();
  if (hasECharts()) donut(stChart, { centerLabel:"job cards", centerValue:String(stAgg.done+stAgg.partial+stAgg.none),
    items:[{name:STATE.done,value:stAgg.done,color:t.success},{name:STATE.partial,value:stAgg.partial,color:t.warn},{name:STATE.none,value:stAgg.none,color:t.muted}] });

  // ---- Top customers (period) -> drill modal ----
  const custAgg = new Map();
  for (const r of jc){ const k=r.customer_id||r.customer_name; if(!k) continue;
    const e=custAgg.get(k)||{name:r.customer_name||"—",val:0,n:0}; e.val+=Number(r.value_kes)||0; e.n++; custAgg.set(k,e); }
  const custAll = [...custAgg.values()].sort((a,b)=>b.val-a.val);
  const custCard = card("Top customers", p.label, custAll.length>8 ? ()=>openCust(ctx, custAll, money) : null);
  const custBars = el("div"); custCard.body.append(custBars);
  rowB.append(custCard.card);
  hBar(custBars, { rows: custAll.slice(0,8).map(c=>({ label:c.name, value:c.val,
    display: money?kesCompact(c.val):String(c.n)+" jobs", color:t.cat[0] })), emptyText:"No orders this period" });

  // ---- Production output (period) ----
  const prodCard = card("Production output", p.label);
  const prodBody = el("div"); prodCard.body.append(prodBody);
  rowB.append(prodCard.card);
  renderProd(prodBody, dept, p);
}

// Branding (pcs, monthly) + stitching (pcs) + RW (native units) for the period — terse.
function renderProd(body, dept, p){
  const inPeriod = (d)=> d >= p.start && d < p.end;
  const brand = dept.filter(r=>r.department==="Branding" && inPeriod(r.period_start));
  const stitch = dept.filter(r=>r.department==="Stitching" && inPeriod(r.period_start));
  const rw = dept.filter(r=>r.department==="Royal Weaver" && inPeriod(r.period_start));
  const sum = (rows)=>rows.reduce((a,r)=>a+(Number(r.output_qty)||0),0);
  const rows = [];
  const bSec = groupSum(brand, "unit");
  for (const [k,v] of bSec) rows.push({ label:"Branding · "+k, value:v, display: Math.round(v).toLocaleString()+" pcs", color:theme().cat[2] });
  if (stitch.length) rows.push({ label:"Stitching", value:sum(stitch), display: Math.round(sum(stitch)).toLocaleString()+" pcs", color:theme().cat[1] });
  const rwSec = new Map();
  for (const r of rw){ const e=rwSec.get(r.unit)||{q:0,uom:r.uom}; e.q+=Number(r.output_qty)||0; rwSec.set(r.unit,e); }
  for (const [k,e] of rwSec) rows.push({ label:"RW · "+k, value:e.q, display: Math.round(e.q).toLocaleString()+" "+e.uom, color:theme().cat[4] });
  if (!rows.length){ body.append(stateBox("No floor data for this period")); return; }
  // RW units differ (pcs/Mtr/Pairs) -> bar lengths scale within each is misleading; show as a plain list, no shared bar.
  const list = el("div", { class:"mini-list" });
  for (const r of rows.sort((a,b)=>b.value-a.value)){
    list.append(el("div", { class:"mini-row" }, [ el("span",{class:"mini-lbl",text:r.label}), el("span",{class:"mini-val",text:r.display}) ]));
  }
  body.append(list, el("p",{class:"note",text:"Floor output; branding monthly, stitching/RW current period."}));
}

function groupSum(rows, key){ const m=new Map(); for (const r of rows){ m.set(r[key],(m.get(r[key])||0)+(Number(r.output_qty)||0)); } return [...m.entries()].sort((a,b)=>b[1]-a[1]); }

function openCust(ctx, custAll, money){
  const tbl = el("table", { class:"tbl" });
  tbl.append(el("thead",{},el("tr",{},[el("th",{text:"Customer"}),el("th",{class:"num",text:"Jobs"}),el("th",{class:"num",text: money?"Value":""})])));
  const tb = el("tbody");
  for (const c of custAll) tb.append(el("tr",{},[el("td",{text:c.name}),el("td",{class:"num",text:String(c.n)}),el("td",{class:"num",text: money?kes(c.val):"—"})]));
  tbl.append(tb);
  ctx.modal("Customers · "+ctx.period().label, tbl);
}

function deltaOf(cur, base){ const d=fmtDelta(cur,base); return { dir:d.dir, text:d.text, base:"vs prior yr" }; }
function card(title, sub, onExpand){
  const head = el("div",{class:"card-head"},[ el("h3",{text:title}),
    onExpand ? el("button",{class:"link-btn",type:"button",text:"View all",on:{click:onExpand}}) : (sub?el("span",{class:"subtle",text:sub}):null) ]);
  const body = el("div"); const c = el("div",{class:"card"},[head,body]);
  return { card:c, body };
}
function stateBox(msg){ return el("div",{class:"statebox",text:msg}); }
