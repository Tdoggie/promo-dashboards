// =========================================================================
// Promo Kings — app controller (ES module)
// Login, sidebar shell (user pinned bottom), a global period engine that
// drives every section, a modal helper, and the hash router.
// Section signature:  async render(root, ctx)
//   ctx = { supabase, profile, role, canSeeMoney, period(), onPeriod(fn),
//           modal(title, node), closeModal, setFreshness }
// =========================================================================
import {
  supabase, getSession, getProfile, signIn, signOut, onAuthChange,
  canSeeMoney, hasFullAccess, createRouter, el, clear, $
} from "./common.js";
import { disposeAll } from "./charts.js";
import { renderOverview } from "./overview.js";
import { renderSales } from "./sales.js";
import { renderProduction } from "./production.js";
import { renderDeliveries } from "./deliveries.js";

const loginView = $("#login-view"), appView = $("#app-view");
const loginForm = $("#login-form"), emailInput = $("#login-email"), pwInput = $("#login-password");
const loginError = $("#login-error"), loginSubmit = $("#login-submit");
const whoEl = $("#who"), roleEl = $("#su-role"), avatarEl = $("#su-avatar"), signoutBtn = $("#signout");
const content = $("#content"), freshnessTxt = document.querySelector(".freshness-txt");
const periodBar = $("#period-bar"), modalRoot = $("#modal-root");

const DATA_YEARS = [2023, 2024, 2025, 2026];
const LAST_YEAR = DATA_YEARS[DATA_YEARS.length - 1];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

let router = null, routesMap = null, listeners = [];

// ---------- Period engine ----------
const P = { grain: "year", y: LAST_YEAR, m: 10, q: 4, compare: true };  // default: year 2026

function pad(n){ return String(n).padStart(2,"0"); }
function addMonth(y, m, d){ const t = (m-1)+d; return { y: y + Math.floor(t/12), m: (t%12+12)%12 + 1 }; }

/** Current period window: {grain,start,end,label, pyStart,pyEnd,pyLabel, year}. ISO date bounds [start,end). */
function period(){
  let start, end, label, py;
  if (P.grain === "year"){
    start = `${P.y}-01-01`; end = `${P.y+1}-01-01`; label = `${P.y}`;
    py = { start:`${P.y-1}-01-01`, end:`${P.y}-01-01`, label:`${P.y-1}` };
  } else if (P.grain === "quarter"){
    const sm = (P.q-1)*3 + 1; const e = addMonth(P.y, sm, 3);
    start = `${P.y}-${pad(sm)}-01`; end = `${e.y}-${pad(e.m)}-01`; label = `Q${P.q} ${P.y}`;
    py = { start:`${P.y-1}-${pad(sm)}-01`, end:`${P.y-1}-${pad(sm+2>12?12:sm+2)}-01`, label:`Q${P.q} ${P.y-1}` };
    const pe = addMonth(P.y-1, sm, 3); py.end = `${pe.y}-${pad(pe.m)}-01`;
  } else { // month
    const e = addMonth(P.y, P.m, 1);
    start = `${P.y}-${pad(P.m)}-01`; end = `${e.y}-${pad(e.m)}-01`; label = `${MON[P.m-1]} ${P.y}`;
    const pe = addMonth(P.y-1, P.m, 1);
    py = { start:`${P.y-1}-${pad(P.m)}-01`, end:`${pe.y}-${pad(pe.m)}-01`, label:`${MON[P.m-1]} ${P.y-1}` };
  }
  return { grain:P.grain, year:P.y, month:P.m, quarter:P.q, compare:P.compare,
           start, end, label, pyStart:py.start, pyEnd:py.end, pyLabel:py.label };
}

function step(dir){
  if (P.grain === "year") P.y = Math.min(LAST_YEAR, Math.max(DATA_YEARS[0], P.y + dir));
  else if (P.grain === "quarter"){ let t=(P.q-1)+dir; P.y += Math.floor(t/4); P.q=(t%4+4)%4+1; }
  else { const n = addMonth(P.y, P.m, dir); P.y = n.y; P.m = n.m; }
  clampAnchor(); renderPeriodBar(); fireChange();
}
function clampAnchor(){ if (P.y < DATA_YEARS[0]){P.y=DATA_YEARS[0];} if (P.y > LAST_YEAR){P.y=LAST_YEAR;} }

function renderPeriodBar(){
  if (!periodBar) return;
  clear(periodBar);
  const seg = el("div", { class:"seg", role:"group", "aria-label":"Grain" });
  for (const g of [["month","Month"],["quarter","Quarter"],["year","Year"]]){
    seg.append(el("button", { type:"button", "aria-pressed": String(P.grain===g[0]), text:g[1],
      on:{ click:()=>{ P.grain=g[0]; renderPeriodBar(); fireChange(); } } }));
  }
  const prev = el("button", { type:"button", "aria-label":"Previous", text:"‹", on:{ click:()=>step(-1) } });
  const next = el("button", { type:"button", "aria-label":"Next", text:"›", on:{ click:()=>step(1) } });
  const atEnd = (P.grain==="year" && P.y>=LAST_YEAR);
  next.disabled = atEnd;
  const nav = el("div", { class:"per-nav" }, [prev, el("span",{class:"per-label",text:period().label}), next]);
  const cmp = el("label", { class:"per-cmp" }, [
    el("input", { type:"checkbox", checked:P.compare, on:{ change:(e)=>{ P.compare=e.target.checked; fireChange(); } } }),
    "vs prior year"
  ]);
  periodBar.append(seg, nav, cmp);
}

function onPeriod(fn){ listeners.push(fn); return () => { listeners = listeners.filter(f=>f!==fn); }; }
function fireChange(){ rerender(); }   // sections read period() fresh on re-render

// ---------- Modal ----------
function closeModal(){ clear(modalRoot); document.removeEventListener("keydown", escClose); }
function escClose(e){ if (e.key === "Escape") closeModal(); }
function modal(title, node){
  clear(modalRoot);
  const x = el("button", { class:"modal-x", type:"button", "aria-label":"Close", text:"×", on:{ click:closeModal } });
  const back = el("div", { class:"modal-back", on:{ click:(e)=>{ if (e.target===back) closeModal(); } } }, [
    el("div", { class:"modal", role:"dialog", "aria-modal":"true" }, [
      el("div", { class:"modal-head" }, [el("h3", { text:title||"" }), x]),
      el("div", { class:"modal-body" }, [node])
    ])
  ]);
  modalRoot.append(back);
  document.addEventListener("keydown", escClose);
}

// ---------- Views ----------
function initials(name){ return (name||"?").split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join("") || "?"; }

function showLogin(){
  if (router){ router.stop(); router = null; }
  disposeAll(); appView.hidden = true; loginView.hidden = false; setLoginLoading(false);
}

function showApp(session, profile){
  const role = (profile && profile.role) || "staff";
  const name = (profile && (profile.full_name || profile.username)) || session.user.email || "Signed in";
  whoEl.textContent = name; roleEl.textContent = role; avatarEl.textContent = initials(name);

  loginView.hidden = true; appView.hidden = false;
  loadFreshness();
  renderPeriodBar();

  const ctx = { supabase, profile, role, canSeeMoney: canSeeMoney(role),
                period, onPeriod, modal, closeModal, setFreshness };

  if (!hasFullAccess(role)){
    if (router){ router.stop(); router = null; }
    periodBar.hidden = true; appView.querySelector(".nav").hidden = true;
    renderLimited(content, name, role); return;
  }
  periodBar.hidden = false; appView.querySelector(".nav").hidden = false;

  routesMap = {
    overview:   () => renderOverview(content, ctx),
    sales:      () => renderSales(content, ctx),
    production: () => renderProduction(content, ctx),
    deliveries: () => renderDeliveries(content, ctx)
  };
  if (router) router.stop();
  router = createRouter({
    routes: routesMap, fallback: "overview",
    onBefore: (key) => { setActiveNav(key); content.scrollTop = 0; disposeAll(); }
  });
  router.start();
}

function rerender(){
  if (router && routesMap){ const k = router.current(); if (routesMap[k]){ disposeAll(); routesMap[k](); } }
}
function setActiveNav(key){
  appView.querySelectorAll(".nav-item").forEach(a =>
    a.dataset.route === key ? a.setAttribute("aria-current","page") : a.removeAttribute("aria-current"));
}
function renderLimited(root, name, role){
  clear(root);
  root.append(el("div", { class:"card" }, [
    el("h2", { text:`Hi ${name}` }),
    el("p", { class:"note", text:`Your ${role} view is being prepared.` })
  ]));
}

// ---------- Freshness ----------
function setFreshness(ts){ if (freshnessTxt) freshnessTxt.textContent = ts ? ("Updated " + new Date(ts).toLocaleDateString("en-KE",{day:"2-digit",month:"short"})) : "—"; }
async function loadFreshness(){
  setFreshness(null);
  try{
    const { data } = await supabase.from("v_job_card").select("synced_at").order("synced_at",{ascending:false}).limit(1);
    if (data && data.length) setFreshness(data[0].synced_at);
  }catch{}
}

// ---------- Login ----------
function setLoginLoading(on){
  loginSubmit.disabled = on;
  const spin = loginSubmit.querySelector(".spinner"), label = loginSubmit.querySelector(".btn-label");
  if (spin) spin.hidden = !on; if (label) label.textContent = on ? "Signing in…" : "Sign in";
}
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault(); loginError.hidden = true;
  if (!emailInput.value || !pwInput.value){ loginError.textContent="Enter email and password."; loginError.hidden=false; return; }
  setLoginLoading(true);
  try { await signIn(emailInput.value, pwInput.value); }
  catch (err){ loginError.textContent = err.message || "Sign-in failed."; loginError.hidden = false; setLoginLoading(false); }
});
signoutBtn.addEventListener("click", async () => { signoutBtn.disabled=true; try{ await signOut(); } finally{ signoutBtn.disabled=false; } });

onAuthChange((event, session) => {
  if (event === "SIGNED_IN") applyAuth(session);
  else if (event === "SIGNED_OUT") showLogin();
});
async function applyAuth(session){
  if (!session){ showLogin(); return; }
  let profile = null; try { profile = await getProfile(); } catch {}
  showApp(session, profile);
}
(async function boot(){
  try { await applyAuth(await getSession()); } catch(err){ console.error("boot failed:", err); showLogin(); }
})();
