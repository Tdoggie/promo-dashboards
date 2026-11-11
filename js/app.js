// =========================================================================
// Promo Kings — app entry / controller (ES module)
//
// Boots auth, renders the login screen when logged out, and the app chrome
// (header + nav + routed sections) when logged in. Wires the hash router to
// section renderers.
//
// To add a section:
//   1. Create web/js/<name>.js exporting  render<Name>(root, ctx).
//   2. import it here and add it to `makeRouter`'s routes map.
//   3. Add a matching <a class="nav-item" href="#/<name>" data-route="<name>">
//      in index.html.
// Section render signature:  async render(root, ctx)
//   root = the #content element (cleared before the call)
//   ctx  = { supabase, profile, role, canSeeMoney, setFreshness }
// =========================================================================

import {
  supabase, getSession, getProfile, signIn, signOut, onAuthChange,
  canSeeMoney, hasFullAccess, createRouter, el, clear, $, dateTime
} from "./common.js";
import { renderSales } from "./sales.js";
import { renderProduction } from "./production.js";
import { renderDeliveries } from "./deliveries.js";

// ---- DOM handles ---------------------------------------------------------
const loginView   = $("#login-view");
const appView     = $("#app-view");
const loginForm   = $("#login-form");
const emailInput  = $("#login-email");
const pwInput     = $("#login-password");
const loginError  = $("#login-error");
const loginSubmit = $("#login-submit");
const whoEl       = $("#who");
const signoutBtn  = $("#signout");
const content     = $("#content");
const freshnessEl = $("#freshness");
const sectionLbl  = $("#section-label");

const LABELS = { sales: "Sales", production: "Production", deliveries: "Deliveries" };

let router = null;      // current router instance
let bootedOnce = false; // guards the initial getSession/applyAuth

// ---- View toggles --------------------------------------------------------
function showLogin() {
  if (router) { router.stop(); router = null; }
  appView.hidden = true;
  loginView.hidden = false;
  setLoginLoading(false);
}

function showApp(session, profile) {
  const role = (profile && profile.role) || "staff";
  const ctx = {
    supabase,
    profile,
    role,
    canSeeMoney: canSeeMoney(role),
    setFreshness
  };

  // Header identity
  const name = (profile && (profile.full_name || profile.username)) || session.user.email || "Signed in";
  whoEl.textContent = name + (role !== "staff" ? ` · ${role}` : "");
  whoEl.title = `${name} (${role})`;

  loginView.hidden = true;
  appView.hidden = false;

  // Data freshness (best-effort)
  loadFreshness();

  const nav = appView.querySelector(".nav");

  if (!hasFullAccess(role)) {
    // rider / designer — dedicated views come later.
    if (router) { router.stop(); router = null; }
    if (nav) nav.hidden = true;
    sectionLbl.textContent = "Home";
    renderLimited(content, profile, role);
    return;
  }

  if (nav) nav.hidden = false;

  // (Re)build the router for this session.
  if (router) router.stop();
  router = makeRouter(ctx);
  router.start();
}

// ---- Router --------------------------------------------------------------
function makeRouter(ctx) {
  return createRouter({
    routes: {
      sales:      () => renderSales(content, ctx),
      production: () => renderProduction(content, ctx),
      deliveries: () => renderDeliveries(content, ctx)
    },
    fallback: "sales",
    onBefore: (key) => {
      sectionLbl.textContent = LABELS[key] || "";
      setActiveNav(key);
      content.scrollTop = 0;
      window.scrollTo({ top: 0 });
    }
  });
}

function setActiveNav(key) {
  appView.querySelectorAll(".nav-item").forEach((a) => {
    if (a.dataset.route === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// ---- Limited section (rider / designer) ---------------------------------
function renderLimited(root, profile, role) {
  clear(root);
  const name = (profile && (profile.full_name || profile.username)) || "there";
  root.append(
    el("div", { class: "card limited" }, [
      el("span", { class: "badge badge--none", text: role }),
      el("h2", { text: `Hi ${name}` }),
      el("p", { class: "subtle", text: "Your dedicated view is being prepared. There's nothing for your role here yet — check back soon." }),
      el("p", { class: "muted", style: { fontSize: ".82rem" }, text: "You can sign out from the top bar." })
    ])
  );
}

// ---- Freshness -----------------------------------------------------------
function setFreshness(ts) {
  freshnessEl.textContent = "Data freshness: " + (ts ? dateTime(ts) : "—");
  if (ts) freshnessEl.title = "Most recent sync time in the data (" + dateTime(ts) + ")";
}
async function loadFreshness() {
  setFreshness(null);
  try {
    const { data, error } = await supabase
      .from("job_card").select("synced_at")
      .order("synced_at", { ascending: false }).limit(1);
    if (!error && data && data.length) setFreshness(data[0].synced_at);
  } catch { /* leave as — */ }
}

// ---- Login form ----------------------------------------------------------
function setLoginLoading(on) {
  loginSubmit.disabled = on;
  const spin = loginSubmit.querySelector(".spinner");
  const label = loginSubmit.querySelector(".btn-label");
  if (spin) spin.hidden = !on;
  if (label) label.textContent = on ? "Signing in…" : "Sign in";
}
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}
function clearLoginError() { loginError.hidden = true; loginError.textContent = ""; }

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearLoginError();
  const email = emailInput.value;
  const pw = pwInput.value;
  if (!email || !pw) { showLoginError("Enter your email and password."); return; }
  setLoginLoading(true);
  try {
    await signIn(email, pw);
    // onAuthChange('SIGNED_IN') takes over and renders the app.
  } catch (err) {
    showLoginError(err.message || "Sign-in failed.");
    setLoginLoading(false);
  }
});

signoutBtn.addEventListener("click", async () => {
  signoutBtn.disabled = true;
  try { await signOut(); } finally { signoutBtn.disabled = false; }
  // onAuthChange('SIGNED_OUT') shows the login screen.
});

// ---- Auth boot + subscription -------------------------------------------
async function applyAuth(session) {
  if (!session) { showLogin(); return; }
  let profile = null;
  try { profile = await getProfile(); } catch { /* treat as staff */ }
  showApp(session, profile);
}

onAuthChange((event, session) => {
  if (event === "SIGNED_IN") applyAuth(session);
  else if (event === "SIGNED_OUT") showLogin();
  // INITIAL_SESSION handled by boot(); TOKEN_REFRESHED/USER_UPDATED need no view change.
});

async function boot() {
  if (bootedOnce) return;
  bootedOnce = true;
  try {
    const session = await getSession();
    await applyAuth(session);
  } catch (err) {
    console.error("boot failed:", err);
    showLogin();
  }
}

boot();
