// =========================================================================
// Promo Kings — shared helpers (ES module)
//
// Imports the Supabase client, exposes auth + profile helpers, formatting
// helpers, a tiny DOM helper, and a minimal hash router.
//
// Pinned CDN (cdn.jsdelivr.net only, exact version):
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
// =========================================================================

// ---- Supabase client (singleton) ---------------------------------------
const cfg = window.PROMO_CONFIG || {};
if (!cfg.url || !cfg.publishableKey) {
  // Surface a clear message rather than a cryptic createClient failure.
  console.error("PROMO_CONFIG missing url/publishableKey — did config.js load before the module?");
}

export const supabase = createClient(cfg.url, cfg.publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: "promo-kings-auth"
  }
});

// ---- Auth / profile ------------------------------------------------------

/** Current Supabase session, or null. */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) { console.warn("getSession:", error.message); return null; }
  return data.session || null;
}

/** Returns the session when logged in, otherwise null (no throw). */
export async function requireAuth() {
  return await getSession();
}

/** Sign in with email + password. Returns { session } or throws Error(message). */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (email || "").trim(),
    password: password || ""
  });
  if (error) throw new Error(friendlyAuthError(error));
  return data;
}

/** Sign out the current user. */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.warn("signOut:", error.message);
}

/**
 * Read the signed-in user's profile row from public.profiles.
 * Columns: id, username, full_name, role, active.
 * Returns the row object, or null if none / not logged in.
 */
export async function getProfile() {
  const { data: u } = await supabase.auth.getUser();
  const uid = u?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, full_name, role, active")
    .eq("id", uid)
    .maybeSingle();
  if (error) { console.warn("getProfile:", error.message); return null; }
  return data || null;
}

/** Subscribe to auth changes. cb(event, session). Returns an unsubscribe fn. */
export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}

function friendlyAuthError(error) {
  const m = (error && error.message) || "Sign-in failed.";
  if (/invalid login credentials/i.test(m)) return "Email or password is incorrect.";
  if (/email not confirmed/i.test(m)) return "This account's email has not been confirmed yet.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Please wait a moment and try again.";
  if (/network|fetch/i.test(m)) return "Network problem reaching the server. Check your connection.";
  return m;
}

// ---- Roles / visibility --------------------------------------------------

// Roles that are NOT allowed to see money/value figures.
const MONEY_BLIND_ROLES = new Set(["rider", "designer"]);

/** True when the given role may see KES / value figures. Unknown roles default to staff (true). */
export function canSeeMoney(role) {
  return !MONEY_BLIND_ROLES.has(role);
}

/** Roles that get the full dashboards for now (others see a limited page). */
export function hasFullAccess(role) {
  return !MONEY_BLIND_ROLES.has(role);
}

// ---- Formatting ----------------------------------------------------------

const _kesFmt = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 });

/** Format a number as 'KES 1,234,567'. Null/NaN -> 'KES 0'. */
export function kes(n) {
  const v = Number(n);
  return "KES " + _kesFmt.format(Number.isFinite(v) ? Math.round(v) : 0);
}

/** Compact KES for tight spaces, e.g. 'KES 1.05M', 'KES 820K'. */
export function kesCompact(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return "KES " + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "KES " + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "KES " + Math.round(v / 1e3) + "K";
  return kes(v);
}

const _MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Format a date/timestamp as 'DD Mmm YYYY'. Null/invalid -> '—'. */
export function date(d) {
  if (!d) return "—";
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const day = String(dt.getDate()).padStart(2, "0");
  return `${day} ${_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** 'DD Mmm YYYY, HH:MM' for detail views. */
export function dateTime(d) {
  if (!d) return "—";
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${date(dt)}, ${hh}:${mm}`;
}

/** Percent with one decimal, e.g. 94.2 -> '94.2%'. */
export function pct(n, digits = 1) {
  const v = Number(n);
  return (Number.isFinite(v) ? v.toFixed(digits) : "0") + "%";
}

// ---- Tiny DOM helper -----------------------------------------------------

/**
 * el(tag, props?, children?) -> HTMLElement
 *  - props: attributes/props. { class, html, text, dataset:{}, on:{click:fn}, ...attrs }
 *  - children: node | string | array (strings become text nodes)
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") { for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv; }
    else if (k === "on") { for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn); }
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k in node && k !== "list") { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Query one element. */
export const $ = (sel, root = document) => root.querySelector(sel);
/** Query all elements (as an array). */
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Remove all children of a node. */
export function clear(node) { if (node) node.replaceChildren(); }

// ---- Hash router ---------------------------------------------------------
//
// Routes are hash fragments like '#/sales'. Register handlers per route key
// ('sales', 'production', 'deliveries'); the router calls the matching handler
// on load and on every hashchange.
//
//   const router = createRouter({
//     routes: { sales: renderSales, production: renderProduction },
//     fallback: "sales",
//     onBefore: (key) => { ... }   // optional, runs before each handler
//   });
//   router.start();
//
// Handlers are invoked as handler(key). They render into their own container.

export function createRouter({ routes = {}, fallback = Object.keys(routes)[0], onBefore } = {}) {
  let current = null;
  let scheduled = false;

  function rawKey() {
    return (location.hash || "").replace(/^#\/?/, "").split(/[/?]/)[0];
  }
  function parse() {
    const h = rawKey();
    return (h && routes[h]) ? h : fallback;
  }

  async function run() {
    const key = parse();
    current = key;
    if (typeof onBefore === "function") onBefore(key);
    const handler = routes[key];
    if (typeof handler === "function") {
      try { await handler(key); }
      catch (err) { console.error(`route "${key}" failed:`, err); }
    }
  }

  // Collapse multiple same-tick triggers (e.g. the initial normalise + its
  // hashchange) into a single render.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => { scheduled = false; run(); });
  }

  function start() {
    window.addEventListener("hashchange", schedule);
    // Normalise a bare/invalid hash to the fallback (good for bookmarking).
    if (!routes[rawKey()]) location.replace("#/" + fallback);
    schedule();
  }

  function go(key) { location.hash = "#/" + key; }
  function stop() { window.removeEventListener("hashchange", schedule); }

  return { start, stop, go, current: () => current };
}
