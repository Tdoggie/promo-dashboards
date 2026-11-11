// Promo Kings web app — public runtime config.
// This file is a CLASSIC script (not a module): it runs before js/app.js and
// defines window.PROMO_CONFIG, which common.js reads to build the Supabase client.
//
// SECURITY: the publishable key below is a PUBLIC browser key. It is safe to ship.
// Row-Level Security on the server is what actually protects the data.
// NEVER put a Supabase secret key (sb_secret_...) or access token (sbp_...) in web/.
window.PROMO_CONFIG = {
  url: "https://paqdgnugbkzbdkbizbsj.supabase.co",
  publishableKey: "sb_publishable_QGhiGGQtJqxrxfQtSwnWKg_61c_Hyse"
};
