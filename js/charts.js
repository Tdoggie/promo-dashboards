// =========================================================================
// Promo Kings — chart kit (ES module)  ·  Apache ECharts 5.5.1
//
// A small themed factory set implementing the GPL PlanView chart grammar,
// adapted to Promo's red + charcoal system. ECharts is loaded as a pinned
// classic script in index.html (window.echarts); this module reads it from
// the global and the theme tokens from CSS custom properties at runtime.
//
// Public factories (each mounts into a DOM element and returns a disposable
// ECharts instance, except the HTML-based hBar/statTile which return nodes):
//   theme()                              -> cached token object
//   statTile(opts)                       -> HTMLElement (KPI tile + optional spark)
//   sparkline(el, data, opts)            -> ECharts instance
//   barChart(el, opts)                   -> ECharts instance (single-series column/bar)
//   stackedBar(el, opts)                 -> ECharts instance (stacked columns)
//   hBar(container, opts)                -> void (renders an HTML money-bar list)
//   lineArea(el, opts)                   -> ECharts instance (multi-line / YoY / OTD)
//   donut(el, opts)                      -> ECharts instance
//   legendChips(container, inst, items)  -> void (toggle-able HTML legend)
//   disposeAll()                         -> tears down every mounted instance
//   compact(n) / splitFig(str) / deltaChip(dir,text) / fmtDelta(cur,base,o)
//
// Dispose/resize are handled: every ECharts instance gets a ResizeObserver
// and is tracked in a module registry; disposeAll() disconnects + disposes.
// =========================================================================

import { el, clear, kesCompact } from "./common.js";

const echarts = window.echarts || null;
export function hasECharts() { return !!echarts; }

// ---- Theme tokens (read once from :root) --------------------------------
let _T = null;
export function theme() {
  if (_T) return _T;
  const cs = getComputedStyle(document.documentElement);
  const g = (n, f) => { const v = cs.getPropertyValue(n).trim(); return v || f; };
  _T = {
    ink: g("--ink", "#23272b"), inkMuted: g("--muted-ink", "#5f666b"),
    slate: g("--slate", "#6d7478"), muted: g("--muted", "#9ea2a5"),
    border: g("--border", "#e4e6e8"), grid: g("--grid", "#edeff0"),
    axis: g("--axis", "#d4d7da"), axisInk: g("--axis-ink", "#9ea2a5"),
    card: g("--card", "#ffffff"), wash: g("--surface-wash", "#f7f8f8"),
    red: g("--red-600", "#c03d3d"), redWash: g("--year-current-wash", "rgba(192,61,61,.10)"),
    success: g("--success", "#2e8b57"), warn: g("--warn", "#c58a2a"), danger: g("--danger", "#b23a34"),
    yearCurrent: g("--year-current", "#c03d3d"),
    yearPrev: g("--year-prev", "#3f484d"),
    yearOlder: g("--year-older", "#9ea2a5"),
    cat: [
      g("--cat-1", "#c03d3d"), g("--cat-2", "#3f484d"), g("--cat-3", "#2c8c8c"),
      g("--cat-4", "#c58a2a"), g("--cat-5", "#6d7478"), g("--cat-6", "#4e6e8e"),
      g("--cat-7", "#8a5a9e")
    ],
    catOther: g("--cat-other", "#b1b4b7"),
    font: g("--font-sans", '"Segoe UI", system-ui, sans-serif')
  };
  return _T;
}
/** Nth categorical colour, cycling, with the last slot as "Other". */
export function catColor(i) { const t = theme(); return t.cat[i % t.cat.length]; }

// ---- Instance registry (dispose/resize) ---------------------------------
const _reg = [];
function register(inst, node) {
  let ro = null;
  try {
    ro = new ResizeObserver(() => { try { inst.resize(); } catch {} });
    ro.observe(node);
  } catch {}
  inst.__ro = ro;
  _reg.push(inst);
  return inst;
}
export function disposeAll() {
  while (_reg.length) {
    const inst = _reg.pop();
    try { inst.__ro && inst.__ro.disconnect(); } catch {}
    try { inst.dispose(); } catch {}
  }
}

/** Core: dispose any existing instance on el, init, set option, observe. */
function makeChart(node, option) {
  if (!node || !echarts) return null;
  try {
    const existing = echarts.getInstanceByDom(node);
    if (existing) {
      const i = _reg.indexOf(existing);
      if (i >= 0) _reg.splice(i, 1);
      try { existing.__ro && existing.__ro.disconnect(); } catch {}
      existing.dispose();
    }
  } catch {}
  const inst = echarts.init(node, null, { renderer: "canvas" });
  inst.setOption(option);
  return register(inst, node);
}

// ---- Formatting helpers --------------------------------------------------
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Compact count format: 320 · 4.8K · 48K · 1.28M. */
export function compact(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return Math.round(v / 1e3) + "K";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** Split a rendered figure into {main, dec} on the first '.' (whole big, decimals small). */
export function splitFig(str) {
  const s = String(str == null ? "" : str);
  const i = s.indexOf(".");
  if (i < 0) return { main: s, dec: "" };
  return { main: s.slice(0, i), dec: s.slice(i) };
}

const GLYPH = { up: "▲", down: "▼", none: "—" }; // ▲ ▼ —

/** Direction + pct from cur vs base. invert=true -> down is good (green). */
export function fmtDelta(cur, base, { invert = false, digits = 1 } = {}) {
  if (base == null || !isFinite(base) || base === 0) return { dir: "none", text: "— vs —", pct: null };
  const pct = ((cur - base) / Math.abs(base)) * 100;
  const mag = Math.abs(pct);
  let dir;
  if (mag < 0.05) dir = "none";
  else if (pct > 0) dir = invert ? "down" : "up";
  else dir = invert ? "up" : "down";
  const glyph = pct > 0.05 ? GLYPH.up : pct < -0.05 ? GLYPH.down : GLYPH.none;
  const text = `${glyph} ${mag.toFixed(digits)}%`;
  return { dir, text, pct };
}

/** A themed delta chip span: dir in up|down|none, text is the full phrase. */
export function deltaChip(dir, text, baseLabel) {
  return el("span", { class: "stat-delta delta--" + (dir || "none") },
    baseLabel ? [text + " ", el("span", { class: "muted", style: { fontWeight: "500" }, text: baseLabel })] : text);
}

// ---- Shared tooltip card -------------------------------------------------
function tipCard(title, rows, totalStr) {
  let h = '<div class="ec-tip">';
  if (title) h += `<div class="ec-tip-title">${esc(title)}</div>`;
  for (const r of rows) {
    const key = r.color ? `background:${r.color}` : "background:transparent";
    h += `<div class="ec-tip-row"><span class="ec-tip-key" style="${key}"></span>` +
         `<span class="ec-tip-lbl">${esc(r.label)}</span>` +
         `<span class="ec-tip-val">${esc(r.value)}</span></div>`;
  }
  if (totalStr != null) {
    h += `<div class="ec-tip-row ec-tip-total"><span class="ec-tip-key" style="background:transparent"></span>` +
         `<span class="ec-tip-lbl">Total</span><span class="ec-tip-val">${esc(totalStr)}</span></div>`;
  }
  return h + "</div>";
}

function base() {
  const t = theme();
  return {
    textStyle: { fontFamily: t.font, color: t.ink },
    animationDuration: 420, animationEasing: "cubicOut",
    grid: { left: 4, right: 14, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      appendToBody: true, backgroundColor: t.card, borderColor: t.border, borderWidth: 1,
      padding: 10, extraCssText: "box-shadow:0 6px 20px rgba(35,39,43,.14);border-radius:6px;",
      textStyle: { color: t.ink }
    }
  };
}
function catAxis(categories, interval) {
  const t = theme();
  return {
    type: "category", data: categories, boundaryGap: true,
    axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
    axisLabel: { color: t.axisInk, fontSize: 11, interval: interval == null ? "auto" : interval }
  };
}
function valAxis(fmt, opts = {}) {
  const t = theme();
  return {
    type: "value", min: 0, max: opts.max, splitNumber: 4,
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: t.grid } },
    axisLabel: { color: t.axisInk, fontSize: 11, formatter: fmt }
  };
}

// ---- Sparkline -----------------------------------------------------------
export function sparkline(node, data, { color } = {}) {
  if (!node || !echarts) return null;
  const t = theme();
  const c = color || t.axisInk;
  const vals = (data || []).map((v) => (v == null ? null : Number(v)));
  const lastIdx = (() => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; })();
  const option = {
    animation: false,
    grid: { left: 1, right: 1, top: 3, bottom: 3 },
    xAxis: { type: "category", show: false, boundaryGap: false, data: vals.map((_, i) => i) },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: { show: false },
    series: [{
      type: "line", data: vals, showSymbol: false, connectNulls: false, smooth: false,
      lineStyle: { color: t.axisInk, width: 1.5, cap: "round" },
      areaStyle: { color: t.axisInk, opacity: 0.10 },
      markPoint: lastIdx >= 0 ? {
        symbol: "circle", symbolSize: 6, silent: true,
        itemStyle: { color: c, borderColor: t.card, borderWidth: 2 },
        data: [{ coord: [lastIdx, vals[lastIdx]] }], label: { show: false }
      } : undefined
    }]
  };
  return makeChart(node, option);
}

// ---- Stat tile (HTML + optional spark) ----------------------------------
/**
 * opts = { label, value (string), sub, caption, color,
 *          delta:{dir,text,base} | null, spark:[nums] | null, onClick }
 * Returns the tile element; a spark is mounted on the next frame (attached).
 */
export function statTile(opts = {}) {
  const t = theme();
  const color = opts.color || t.cat[0];
  const { main, dec } = splitFig(opts.value == null ? "—" : String(opts.value));
  const head = el("div", { class: "stat-head" }, [
    el("span", { class: "stat-dot", style: { background: color } }),
    el("span", { class: "stat-label", text: opts.label || "" })
  ]);
  const valNode = el("div", { class: "stat-value" }, [main, dec ? el("span", { class: "dec", text: dec }) : null]);
  const children = [head, valNode];
  children.push(el("div", { class: "stat-sec", text: opts.sub || "" }));
  if (opts.delta) children.push(deltaChip(opts.delta.dir, opts.delta.text, opts.delta.base));
  else children.push(el("div", { class: "stat-delta delta--none", style: { visibility: "hidden" }, text: "—" }));
  const sparkEl = el("div", { class: "stat-spark" });
  if (opts.spark && opts.spark.length) {
    sparkEl.__spark = { data: opts.spark, color };
    requestAnimationFrame(() => {
      if (sparkEl.isConnected && sparkEl.__spark) sparkline(sparkEl, sparkEl.__spark.data, { color: sparkEl.__spark.color });
    });
  }
  children.push(sparkEl);
  children.push(el("div", { class: "stat-cap", text: opts.caption || "" }));

  const tile = el("div", {
    class: "stat-tile" + (opts.onClick ? " is-click" : ""),
    tabindex: opts.onClick ? "0" : null,
    on: opts.onClick ? {
      click: opts.onClick,
      keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onClick(e); } }
    } : {}
  }, children);
  return tile;
}

// ---- Single-series bar / column -----------------------------------------
/**
 * opts = { categories, data, valueFmt, color, name, horizontal, labelInterval,
 *          colors (per-bar array), rounded }
 */
export function barChart(node, opts = {}) {
  if (!node || !echarts) return null;
  const t = theme();
  const o = base();
  const fmt = opts.valueFmt || ((v) => compact(v));
  const color = opts.color || t.cat[0];
  const per = opts.colors || null;
  const seriesData = (opts.data || []).map((v, i) => ({
    value: v, itemStyle: { color: per ? per[i] : color }
  }));
  const series = [{
    type: "bar", data: seriesData, name: opts.name || "",
    barMaxWidth: 26, barCategoryGap: "38%",
    itemStyle: { borderRadius: opts.horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
    emphasis: { focus: "self" }
  }];
  o.tooltip.trigger = "axis";
  o.tooltip.axisPointer = { type: "shadow" };
  o.tooltip.formatter = (ps) => {
    const p = ps[0];
    return tipCard(p.axisValueLabel, [{ color: per ? per[p.dataIndex] : color, label: opts.name || "Value", value: fmt(p.value) }]);
  };
  if (opts.horizontal) {
    o.xAxis = valAxis(fmt);
    o.yAxis = { ...catAxis(opts.categories), inverse: true };
    o.grid.left = 4;
  } else {
    o.xAxis = catAxis(opts.categories, opts.labelInterval);
    o.yAxis = valAxis(fmt);
  }
  o.series = series;
  return makeChart(node, o);
}

// ---- Stacked columns -----------------------------------------------------
/**
 * opts = { categories, series:[{name,data,color}], valueFmt,
 *          compareLine:{name,data} | null, labelInterval }
 */
export function stackedBar(node, opts = {}) {
  if (!node || !echarts) return null;
  const t = theme();
  const o = base();
  const fmt = opts.valueFmt || ((v) => compact(v));
  const sers = opts.series || [];
  const topIdx = sers.length - 1;
  const series = sers.map((s, i) => ({
    name: s.name, type: "bar", stack: "v", data: s.data,
    itemStyle: {
      color: s.color || catColor(i),
      borderRadius: i === topIdx ? [3, 3, 0, 0] : 0
    },
    barMaxWidth: 28, emphasis: { focus: "series" }
  }));
  if (opts.compareLine) {
    series.push({
      name: opts.compareLine.name, type: "line", data: opts.compareLine.data,
      symbol: "circle", symbolSize: 5, showSymbol: true,
      lineStyle: { color: t.axisInk, width: 1.5, type: "dashed" },
      itemStyle: { color: t.axisInk }, z: 6, tooltip: { show: true }
    });
  }
  o.legend = { show: false, data: [...sers.map((s) => s.name), ...(opts.compareLine ? [opts.compareLine.name] : [])] };
  o.xAxis = catAxis(opts.categories, opts.labelInterval);
  o.yAxis = valAxis(fmt);
  o.tooltip.trigger = "axis";
  o.tooltip.axisPointer = { type: "shadow" };
  o.tooltip.formatter = (ps) => {
    let total = 0; const rows = [];
    for (const p of ps) {
      const isBar = p.seriesType === "bar";
      if (isBar && p.value != null) total += Number(p.value) || 0;
      rows.push({ color: p.color, label: p.seriesName, value: p.value == null ? "—" : fmt(p.value) });
    }
    return tipCard(ps.length ? ps[0].axisValueLabel : "", rows, fmt(total));
  };
  o.series = series;
  return makeChart(node, o);
}

// ---- Multi-line (YoY / OTD) ---------------------------------------------
/**
 * opts = { categories, series:[{name,data,kind:'current'|'prev'|'older',color}],
 *          valueFmt, yMax, target:{value,label} | null, endLabels }
 */
export function lineArea(node, opts = {}) {
  if (!node || !echarts) return null;
  const t = theme();
  const o = base();
  const fmt = opts.valueFmt || ((v) => compact(v));
  const endLabels = opts.endLabels !== false;
  const series = (opts.series || []).map((s) => {
    const kind = s.kind || "current";
    const isCur = kind === "current";
    const color = s.color || (isCur ? t.yearCurrent : kind === "prev" ? t.yearPrev : t.yearOlder);
    const out = {
      name: s.name, type: "line", data: s.data, connectNulls: false, smooth: false,
      showSymbol: false, symbol: "circle", symbolSize: 6,
      lineStyle: { color, width: isCur ? 2.5 : kind === "prev" ? 2 : 1.5, type: isCur ? "solid" : kind === "prev" ? "dashed" : "dotted" },
      itemStyle: { color }, emphasis: { focus: "series" }, z: isCur ? 10 : 5,
      endLabel: endLabels ? { show: true, formatter: () => s.name, color, fontSize: 11, distance: 6 } : { show: false }
    };
    if (isCur && opts.areaOnCurrent !== false) out.areaStyle = { color: t.redWash };
    if (s.target || opts.target) {
      const tg = s.target || opts.target;
      out.markLine = {
        silent: true, symbol: "none",
        lineStyle: { color: t.red, width: 1.25, type: "dashed" },
        label: { formatter: tg.label || "Target", color: t.red, fontSize: 10, position: "insideEndTop" },
        data: [{ yAxis: tg.value }]
      };
    }
    return out;
  });
  o.legend = { show: false, data: (opts.series || []).map((s) => s.name) };
  o.grid.right = 44; // room for end labels
  o.xAxis = { ...catAxis(opts.categories), boundaryGap: false };
  o.yAxis = valAxis(fmt, { max: opts.yMax });
  o.tooltip.trigger = "axis";
  o.tooltip.axisPointer = { type: "line", lineStyle: { color: t.axis } };
  o.tooltip.formatter = (ps) => {
    const rows = ps.slice().reverse().map((p) => ({
      color: p.color, label: p.seriesName, value: p.value == null ? "—" : fmt(p.value)
    }));
    return tipCard(ps.length ? ps[0].axisValueLabel : "", rows);
  };
  o.series = series;
  return makeChart(node, o);
}

// ---- Donut ---------------------------------------------------------------
/**
 * opts = { items:[{name,value,color}], valueFmt, centerLabel, centerValue }
 */
export function donut(node, opts = {}) {
  if (!node || !echarts) return null;
  const t = theme();
  const o = base();
  const fmt = opts.valueFmt || ((v) => compact(v));
  const items = (opts.items || []).filter((d) => (Number(d.value) || 0) > 0);
  const total = items.reduce((a, d) => a + (Number(d.value) || 0), 0);
  o.tooltip.trigger = "item";
  o.tooltip.formatter = (p) => tipCard(opts.centerLabel || "", [
    { color: p.color, label: p.name, value: `${fmt(p.value)} · ${p.percent}%` }
  ]);
  o.grid = undefined;
  o.color = items.map((d, i) => d.color || catColor(i));
  // Center readout via a title component (avoids one centered label per slice).
  o.title = {
    text: opts.centerValue != null ? String(opts.centerValue) : compact(total),
    subtext: opts.centerLabel || "", left: "center", top: "center", textAlign: "center",
    textStyle: { fontSize: 22, fontWeight: 700, color: t.ink, fontFamily: t.font },
    subtextStyle: { fontSize: 10, color: t.inkMuted, fontFamily: t.font },
    itemGap: 2
  };
  o.series = [{
    type: "pie", radius: ["56%", "78%"], center: ["50%", "50%"], avoidLabelOverlap: true,
    itemStyle: { borderColor: t.card, borderWidth: 2 },
    label: { show: false }, labelLine: { show: false },
    emphasis: { scale: true, scaleSize: 4 },
    data: items.map((d, i) => ({ name: d.name, value: d.value, color: d.color || catColor(i) }))
  }];
  return makeChart(node, o);
}

// ---- Toggle-able HTML legend --------------------------------------------
/** items: [{name,color}]; wires clicks to an ECharts instance's legend. */
export function legendChips(container, inst, items) {
  if (!container) return;
  clear(container);
  for (const it of items) {
    const chip = el("button", { class: "legend-chip", type: "button" }, [
      el("span", { class: "dot", style: { background: it.color } }),
      el("span", { text: it.name })
    ]);
    chip.addEventListener("click", () => {
      chip.classList.toggle("is-off");
      try { inst.dispatchAction({ type: "legendToggleSelect", name: it.name }); } catch {}
    });
    container.append(chip);
  }
}

// ---- HTML money-bar list -------------------------------------------------
/**
 * opts = { rows:[{label, sub, value(number), display(string), color,
 *                 tickValue(number)|null, delta:{dir,text}|null, onClick}],
 *          emptyText, max (optional override) }
 */
export function hBar(container, opts = {}) {
  if (!container) return;
  clear(container);
  const rows = opts.rows || [];
  if (!rows.length) {
    container.append(el("div", { class: "hbar-empty", text: opts.emptyText || "Nothing to show" }));
    return;
  }
  const t = theme();
  const candidates = [];
  for (const r of rows) {
    candidates.push(Math.abs(Number(r.value) || 0));
    if (r.tickValue != null) candidates.push(Math.abs(Number(r.tickValue)));
  }
  const max = opts.max || Math.max(1, ...candidates);
  const list = el("div", { class: "hbars" });
  for (const r of rows) {
    const frac = Math.max(0, Math.min(1, (Math.abs(Number(r.value) || 0)) / max));
    const label = el("div", { class: "hbar-label" }, [
      r.label || "—",
      r.sub ? el("span", { class: "sub", text: r.sub }) : null
    ]);
    const valChildren = [r.display != null ? r.display : compact(r.value)];
    if (r.delta) valChildren.push(el("span", { class: "dlt delta--" + (r.delta.dir || "none"), text: r.delta.text }));
    const val = el("div", { class: "hbar-val" }, valChildren);
    const fill = el("div", { class: "hbar-fill", style: { width: (frac * 100).toFixed(1) + "%", background: r.color || t.red } });
    const trackKids = [fill];
    if (r.tickValue != null) {
      const tf = Math.max(0, Math.min(1, Math.abs(Number(r.tickValue)) / max));
      trackKids.push(el("div", { class: "hbar-tick", style: { left: (tf * 100).toFixed(1) + "%" }, title: "comparison" }));
    }
    const track = el("div", { class: "hbar-track" }, trackKids);
    const row = el("div", {
      class: "hbar-row" + (r.onClick ? " is-click" : ""),
      tabindex: r.onClick ? "0" : null,
      on: r.onClick ? {
        click: r.onClick,
        keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.onClick(e); } }
      } : {}
    }, [label, val, track]);
    list.append(row);
  }
  container.append(list);
}
