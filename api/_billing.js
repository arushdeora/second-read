// Free plan: up to 200 words per check, 2 humanizes a day, no citations. Pro ($5/month or $39.99/year through PayPal): no word limit.
// Nothing here is active until PAYPAL_CLIENT_ID and PAYPAL_SECRET are set in Vercel:
// until then every signed-in student can use the tools for free with no limits.
//
// Optional settings:
//   PAYPAL_ENV          "sandbox" to test with PayPal sandbox accounts (default: live)
//   PAYPAL_PLAN_ID      use an existing PayPal plan; otherwise a $5/month "EssayWiz Pro" plan is created automatically
//   PRO_PRICE           monthly price in USD for the auto-created plan (default 5.00)
//   PRO_YEARLY_PRICE    yearly price in USD for the auto-created "EssayWiz Pro Yearly" plan (default 39.99)
//   OWNER_EMAILS        comma-separated Google emails that always have free, unlimited access (default: the owner)
//   FREE_WORD_LIMIT     most words a free student can check at once (default 200)
//   FREE_HUMANIZE_DAILY free humanizes per student per day (default 2)
//   FREE_DAILY_CHECKS   fair-use cap on free checks per student per day, to protect the AI bill (default 40)
//   PRO_DAILY_CREDITS   fair-use cap for Pro members per day (default 400)
//   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//                       a free Upstash Redis store; keeps usage counts and Pro status accurate across servers and devices

import { dbEnabled, select, insert, userHash } from "./_db.js";

const env = k => String(process.env[k] || "").trim().replace(/^["']|["']$/g, "").trim();
export const billingEnabled = () => !!(env("PAYPAL_CLIENT_ID") && env("PAYPAL_SECRET"));
const OWNERS = () => (env("OWNER_EMAILS") || "arushdeora24@gmail.com").toLowerCase().split(/[\s,;]+/).filter(Boolean);
export const isOwner = user => !!(user && user.email && OWNERS().includes(user.email));
const FREE_WORDS = () => Number(env("FREE_WORD_LIMIT") || 200) || 200;
const FREE_HUMANIZE = () => Number(env("FREE_HUMANIZE_DAILY") || 2);
const FREE_DAILY = () => Number(env("FREE_DAILY_CHECKS") || 40) || 40;
const PRO = () => Number(env("PRO_DAILY_CREDITS") || 400);
const PRICE = () => (Number(env("PRO_PRICE") || 5) || 5).toFixed(2);
const YEAR_PRICE = () => (Number(env("PRO_YEARLY_PRICE") || 39.99) || 39.99).toFixed(2);
const PP = () => env("PAYPAL_ENV").toLowerCase() === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
const PLAN_NAME = "EssayWiz Pro";
const YEAR_PLAN_NAME = "EssayWiz Pro Yearly";

/* ---------- small key-value store: Upstash Redis REST if configured, else memory ---------- */
const mem = new Map();
const kvUrl = () => env("KV_REST_API_URL") || env("UPSTASH_REDIS_REST_URL");
const kvTok = () => env("KV_REST_API_TOKEN") || env("UPSTASH_REDIS_REST_TOKEN");
async function kv(cmd) {
  if (kvUrl() && kvTok()) {
    try {
      const r = await fetch(kvUrl(), { method: "POST", headers: { authorization: "Bearer " + kvTok(), "content-type": "application/json" }, body: JSON.stringify(cmd) });
      const d = await r.json();
      if (r.ok && !d.error) return d.result;
      console.error("kv error", d.error || r.status);
    } catch (e) { console.error("kv failed", e && e.message); }
  }
  // Memory fallback (per server instance; resets on cold start).
  const [op, key, val, , ttl] = cmd; const now = Date.now();
  const hit = mem.get(key); const live = hit && (!hit.exp || hit.exp > now) ? hit : null;
  if (op === "GET") return live ? live.v : null;
  if (op === "SET") { mem.set(key, { v: String(val), exp: ttl ? now + Number(ttl) * 1000 : 0 }); return "OK"; }
  if (op === "INCRBY") { const v = (live ? Number(live.v) : 0) + Number(val); mem.set(key, { v: String(v), exp: live ? live.exp : now + 2 * 86400e3 }); return v; }
  if (op === "EXPIRE") { if (live) live.exp = now + Number(val) * 1000; return 1; }
  return null;
}

/* ---------- PayPal REST ---------- */
let tok = null;
async function ppToken() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.v;
  const r = await fetch(PP() + "/v1/oauth2/token", {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(env("PAYPAL_CLIENT_ID") + ":" + env("PAYPAL_SECRET")).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    // Explain the usual causes without ever printing the keys themselves.
    const id = env("PAYPAL_CLIENT_ID"), sec = env("PAYPAL_SECRET");
    const hints = [];
    if (/[^\x21-\x7e]/.test(id + sec)) hints.push("a key contains hidden dots or spaces (it was copied while masked); copy it again with the copy icon");
    if (id.length < 70 || id.length > 90) hints.push(`client ID is ${id.length} characters (PayPal client IDs are about 80)`);
    if (sec.length < 70 || sec.length > 90) hints.push(`secret is ${sec.length} characters (PayPal secrets are about 80)`);
    if (r.status === 401 && !env("PAYPAL_ENV")) {
      try {
        const s = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { authorization: "Basic " + Buffer.from(id + ":" + sec).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
        if (s.ok) hints.push("these are SANDBOX (test) keys; use the LIVE keys from developer.paypal.com with the Live toggle on");
      } catch (e) { /* ignore */ }
    }
    console.error("PayPal auth failed", r.status, d.error || d.name, "env:", env("PAYPAL_ENV") || "live", "|", hints.join("; ") || "keys look well-formed: the client ID and secret are probably from different apps, or the app was deleted");
    throw { status: 502, code: "billing_error" };
  }
  tok = { v: d.access_token, exp: Date.now() + Number(d.expires_in || 3000) * 1000 };
  return tok.v;
}
async function pp(path, opts = {}) {
  const r = await fetch(PP() + path, { ...opts, headers: { authorization: "Bearer " + await ppToken(), "content-type": "application/json", ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// The $5/month plan: PAYPAL_PLAN_ID, an existing active "EssayWiz Pro" plan, or a new one.
let planId = null;
export async function getPlanId() {
  if (env("PAYPAL_PLAN_ID")) return env("PAYPAL_PLAN_ID");
  if (planId) return planId;
  const stored = await kv(["GET", "sr:plan"]); if (stored) return (planId = stored);
  const list = await pp("/v1/billing/plans?page_size=20&total_required=true");
  const found = (list.d.plans || []).find(p => p.name === PLAN_NAME && p.status === "ACTIVE");
  if (found) { planId = found.id; await kv(["SET", "sr:plan", planId]); return planId; }
  const prod = await pp("/v1/catalogs/products", { method: "POST", headers: { "PayPal-Request-Id": "essaywiz-pro-product-v1" },
    body: JSON.stringify({ name: PLAN_NAME, description: "Unlimited access to the EssayWiz writing tools", type: "SERVICE" }) });
  if (!prod.ok) { console.error("PayPal product create failed", prod.status, prod.d); throw { status: 502, code: "billing_error" }; }
  const plan = await pp("/v1/billing/plans", { method: "POST", headers: { "PayPal-Request-Id": "essaywiz-pro-plan-v1-" + PRICE() },
    body: JSON.stringify({
      product_id: prod.d.id, name: PLAN_NAME, description: `EssayWiz Pro, $${PRICE()} USD per month`, status: "ACTIVE",
      billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: PRICE(), currency_code: "USD" } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    }) });
  if (!plan.ok) { console.error("PayPal plan create failed", plan.status, plan.d); throw { status: 502, code: "billing_error" }; }
  planId = plan.d.id; await kv(["SET", "sr:plan", planId]);
  return planId;
}

// The $39.99/year plan: PAYPAL_YEARLY_PLAN_ID, an existing active "EssayWiz Pro Yearly" plan, or a new one.
let yearPlanId = null;
export async function getYearPlanId() {
  if (env("PAYPAL_YEARLY_PLAN_ID")) return env("PAYPAL_YEARLY_PLAN_ID");
  if (yearPlanId) return yearPlanId;
  const stored = await kv(["GET", "sr:plan:year"]); if (stored) return (yearPlanId = stored);
  const list = await pp("/v1/billing/plans?page_size=20&total_required=true");
  const found = (list.d.plans || []).find(p => p.name === YEAR_PLAN_NAME && p.status === "ACTIVE");
  if (found) { yearPlanId = found.id; await kv(["SET", "sr:plan:year", yearPlanId]); return yearPlanId; }
  const prod = await pp("/v1/catalogs/products", { method: "POST", headers: { "PayPal-Request-Id": "essaywiz-pro-product-v1" },
    body: JSON.stringify({ name: PLAN_NAME, description: "Unlimited access to the EssayWiz writing tools", type: "SERVICE" }) });
  if (!prod.ok) { console.error("PayPal product create failed", prod.status, prod.d); throw { status: 502, code: "billing_error" }; }
  const plan = await pp("/v1/billing/plans", { method: "POST", headers: { "PayPal-Request-Id": "essaywiz-pro-yearly-plan-v1-" + YEAR_PRICE() },
    body: JSON.stringify({
      product_id: prod.d.id, name: YEAR_PLAN_NAME, description: `EssayWiz Pro, $${YEAR_PRICE()} USD per year`, status: "ACTIVE",
      billing_cycles: [{ frequency: { interval_unit: "YEAR", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: YEAR_PRICE(), currency_code: "USD" } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    }) });
  if (!plan.ok) { console.error("PayPal yearly plan create failed", plan.status, plan.d); throw { status: 502, code: "billing_error" }; }
  yearPlanId = plan.d.id; await kv(["SET", "sr:plan:year", yearPlanId]);
  return yearPlanId;
}

// Check a subscription with PayPal. It counts as Pro while ACTIVE, or after cancelling
// until the end of the month already paid for.
async function checkSubscription(id, user) {
  if (!/^I-[A-Z0-9]{6,30}$/.test(String(id || ""))) return null;
  const r = await pp("/v1/billing/subscriptions/" + id);
  if (!r.ok) return null;
  const s = r.d;
  if (String(s.custom_id || "") !== String(user.sub)) return null;          // must belong to this Google account
  const plans = (await Promise.all([getPlanId().catch(() => null), getYearPlanId().catch(() => null)])).filter(Boolean);
  if (plans.length && !plans.includes(s.plan_id)) return null;
  const next = s.billing_info && s.billing_info.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : 0;
  // PayPal drops next_billing_time once a subscription is cancelled, so work out the end of the
  // period already paid for from the last payment: one month later (or one year on the yearly plan).
  const last = s.billing_info && s.billing_info.last_payment && s.billing_info.last_payment.time ? new Date(s.billing_info.last_payment.time) : null;
  let paidEnd = 0;
  if (last && !isNaN(last)) { const e = new Date(last); if (s.plan_id === yearPlanId) e.setUTCFullYear(e.getUTCFullYear() + 1); else e.setUTCMonth(e.getUTCMonth() + 1); paidEnd = e.getTime(); }
  const paidUntil = next || paidEnd;
  const pro = s.status === "ACTIVE" || ((s.status === "CANCELLED" || s.status === "SUSPENDED") && paidUntil > Date.now());
  return { id, pro, status: s.status, paidUntil, period: s.plan_id === yearPlanId ? "year" : "month" };
}

// For the owner's /stats page: a subscription's status and the payments PayPal actually
// received (gross, PayPal fee, net) since a date.
export async function subscriptionReport(id, sinceISO) {
  if (billingEnabled() && /^PASS-[MY]-/.test(String(id || ""))) return passReport(id, sinceISO);
  if (!billingEnabled() || !/^I-[A-Z0-9]{6,30}$/.test(String(id || ""))) return null;
  const s = await pp("/v1/billing/subscriptions/" + id);
  if (!s.ok) return null;
  const end = new Date().toISOString();
  const t = await pp(`/v1/billing/subscriptions/${id}/transactions?start_time=${encodeURIComponent(sinceISO)}&end_time=${encodeURIComponent(end)}`);
  const num = x => Number((x && x.value) || 0);
  const payments = ((t.ok && t.d.transactions) || []).filter(x => x.status === "COMPLETED").map(x => {
    const b = x.amount_with_breakdown || {};
    return { time: x.time, gross: num(b.gross_amount), fee: num(b.fee_amount), net: num(b.net_amount) || num(b.gross_amount) - num(b.fee_amount), currency: (b.gross_amount || {}).currency_code || "USD" };
  });
  return { id, status: s.d.status, startTime: s.d.start_time || s.d.create_time || null, payments };
}

const proCache = new Map();
export async function proStatus(user, hintId) {
  const c = proCache.get(user.sub);
  if (c && c.until > Date.now() && (c.info.pro || !hintId || hintId === c.info.id)) return c.info;
  // Look in three places: this browser's saved ID, the server cache, and the database. The database is
  // what lets Pro follow the student to a new device, a new sign-in, or after the server restarts.
  let saved = [];
  try { saved = (await select("subscriptions", `select=id&user_hash=eq.${userHash(user)}&id=like.I-*&order=created_at.desc&limit=5`)).map(r => r.id); } catch (e) { console.error("subscription lookup failed", e && e.message); }
  const ids = [hintId, await kv(["GET", "sr:sub:" + user.sub]), ...saved].filter(Boolean);
  let info = { pro: false };
  for (const id of [...new Set(ids)]) {
    try { const s = await checkSubscription(id, user); if (s) { info = s; if (s.pro) break; } } catch (e) { console.error("subscription check failed", e && (e.message || e.code)); }
  }
  if (info.pro) await kv(["SET", "sr:sub:" + user.sub, info.id]);
  else { try { const p = await passStatus(user); if (p) info = p; } catch (e) { console.error("pass check failed", e && e.message); } }
  proCache.set(user.sub, { info, until: Date.now() + (info.pro ? 30 * 60e3 : 5 * 60e3) });
  if (proCache.size > 5000) proCache.clear();
  return info;
}

export async function activate(user, id, tries = 0) {
  proCache.delete(user.sub);
  const s = await checkSubscription(id, user);
  if (!s) return { pro: false };
  if ((s.status === "APPROVAL_PENDING" || s.status === "APPROVED") && tries < 4) {
    // PayPal can take a few seconds to switch a new subscription to ACTIVE.
    await new Promise(ok => setTimeout(ok, 2500));
    return activate(user, id, tries + 1);
  }
  if (s.pro) await kv(["SET", "sr:sub:" + user.sub, s.id]);
  proCache.set(user.sub, { info: s, until: Date.now() + 30 * 60e3 });
  return s;
}

const day = () => new Date().toISOString().slice(0, 10);
// Successful humanizes today, counted from the usage log in Supabase, so the free limit
// holds across servers even without Redis. Returns 0 if the database isn't connected.
async function humanizedToday(user) {
  try {
    if (!dbEnabled()) return 0;
    const since = day() + "T00:00:00Z";
    const rows = await select("events", `select=id&tool=eq.humanize&status=eq.200&user_hash=eq.${userHash(user)}&created_at=gte.${encodeURIComponent(since)}&limit=10`);
    return rows.length;
  } catch (e) { console.error("humanize count failed", e && e.message); return 0; }
}
export async function usage(user) {
  return Number(await kv(["GET", `sr:use:${user.sub}:${day()}`]) || 0);
}

// Check one request. Returns null if allowed, or an error {status, code}.
export async function charge(user, cost, hintId, res, words = 0, feature = "") {
  if (!billingEnabled() || !user || !user.sub || !cost) return null;
  if (isOwner(user)) { res.setHeader("x-sr-pro", "1"); return null; }   // the owner always has free access
  const info = await proStatus(user, hintId);
  res.setHeader("x-sr-pro", info.pro ? "1" : "0");
  if (info.pro) {
    // Pro: unlimited, with a generous daily fair-use cap to protect the AI bill.
    const key = `sr:use:${user.sub}:${day()}`;
    const used = Number(await kv(["GET", key]) || 0);
    if (used + cost > PRO()) return { status: 429, code: "daily_cap" };
    await kv(["INCRBY", key, cost]); await kv(["EXPIRE", key, 2 * 86400]);
    return null;
  }
  // Free plan: no citations, up to FREE_WORDS words per check, FREE_HUMANIZE humanizes a day, plus a daily fair-use cap.
  res.setHeader("x-sr-word-limit", String(FREE_WORDS()));
  if (feature === "cite") return { status: 402, code: "pro_only_cite" };
  if (words > FREE_WORDS()) return { status: 402, code: "word_limit" };
  if (feature === "humanize") {
    const hkey = `sr:hum:${user.sub}:${day()}`;
    const used = Math.max(Number(await kv(["GET", hkey]) || 0), await humanizedToday(user));
    if (used >= FREE_HUMANIZE()) return { status: 402, code: "humanize_limit" };
    await kv(["INCRBY", hkey, 1]); await kv(["EXPIRE", hkey, 2 * 86400]);
  }
  const key = `sr:free:${user.sub}:${day()}`;
  const used = Number(await kv(["GET", key]) || 0);
  if (used + 1 > FREE_DAILY()) return { status: 429, code: "free_daily_cap" };
  await kv(["INCRBY", key, 1]); await kv(["EXPIRE", key, 2 * 86400]);
  return null;
}

export async function status(user, hintId) {
  if (!billingEnabled() || !user || !user.sub) return { enabled: false };
  const owner = isOwner(user);
  const info = owner ? { pro: true, status: "OWNER" } : await proStatus(user, hintId);
  return {
    owner,
    enabled: true, pro: !!info.pro, subscriptionStatus: info.status || null, paidUntil: info.paidUntil || null,
    wordLimit: info.pro ? null : FREE_WORDS(), freeWordLimit: FREE_WORDS(), freeHumanizeDaily: FREE_HUMANIZE(),
    price: PRICE(), yearlyPrice: YEAR_PRICE(), period: info.period || null,
    paypalClientId: env("PAYPAL_CLIENT_ID"), planId: await getPlanId(), yearlyPlanId: await getYearPlanId().catch(e => { console.error("yearly plan unavailable", e && e.code); return null; }),
    manageUrl: env("PAYPAL_ENV").toLowerCase() === "sandbox" ? "https://www.sandbox.paypal.com/myaccount/autopay/" : "https://www.paypal.com/myaccount/autopay/",
  };
}

/* ---------- Apple Pay: one-time Pro passes (PayPal doesn't support Apple Pay for subscriptions) ---------- */
// A pass is a PayPal order. Once captured it's stored in the subscriptions table as "PASS-M-<order>" (31 days)
// or "PASS-Y-<order>" (366 days); passes bought back to back add up.
const PASS_DAYS = { month: 31, year: 366 };
const passPrice = period => period === "year" ? YEAR_PRICE() : PRICE();

export async function createPass(user, period) {
  if (!PASS_DAYS[period]) throw { status: 400, code: "bad_period" };
  const r = await pp("/v2/checkout/orders", { method: "POST", body: JSON.stringify({
    intent: "CAPTURE",
    application_context: { brand_name: "EssayWiz", shipping_preference: "NO_SHIPPING" },
    purchase_units: [{ reference_id: "pass-" + period, custom_id: user.sub, soft_descriptor: "ESSAYWIZ",
      description: period === "year" ? "EssayWiz Pro, 1 year (one-time payment)" : "EssayWiz Pro, 1 month (one-time payment)",
      amount: { currency_code: "USD", value: passPrice(period) } }],
  }) });
  if (!r.ok) { console.error("PayPal order create failed", r.status, r.d); throw { status: 502, code: "billing_error" }; }
  return r.d.id;
}

export async function capturePass(user, orderId) {
  if (!/^[A-Z0-9]{10,30}$/.test(String(orderId || ""))) throw { status: 400, code: "bad_order" };
  let o = await pp("/v2/checkout/orders/" + orderId);
  if (!o.ok) throw { status: 400, code: "bad_order" };
  if (o.d.status !== "COMPLETED") {
    const c = await pp(`/v2/checkout/orders/${orderId}/capture`, { method: "POST", body: "{}" });
    if (!c.ok) console.error("PayPal capture failed", c.status, c.d && (c.d.name || c.d.message), c.d && c.d.details);
    o = await pp("/v2/checkout/orders/" + orderId);
  }
  const u = ((o.d && o.d.purchase_units) || [])[0] || {};
  const period = String(u.reference_id || "").replace(/^pass-/, "");
  const cap = ((u.payments || {}).captures || [])[0];
  const paid = cap && cap.status === "COMPLETED" && Number(cap.amount && cap.amount.value) >= Number(passPrice(period)) - 0.001;
  if (o.d.status !== "COMPLETED" || !paid || !PASS_DAYS[period] || String(u.custom_id || "") !== String(user.sub)) throw { status: 402, code: "payment_failed" };
  const id = `PASS-${period === "year" ? "Y" : "M"}-${orderId}`;
  const saved = await insert("subscriptions", { id, user_hash: userHash(user) }, { onConflict: "id" });
  if (saved === null) console.error("PASS NOT SAVED: paid order", orderId, "for", userHash(user), "- add it to the subscriptions table by hand");
  await kv(["SET", "sr:pass:" + user.sub, String(Date.now() + PASS_DAYS[period] * 864e5)]);
  proCache.delete(user.sub);
  return period;
}

async function passStatus(user) {
  let until = 0;
  const rows = await select("subscriptions", `select=id,created_at&user_hash=eq.${userHash(user)}&id=like.PASS-*&order=created_at.asc&limit=100`);
  for (const r of rows) until = Math.max(until, Date.parse(r.created_at)) + (r.id.startsWith("PASS-Y-") ? PASS_DAYS.year : PASS_DAYS.month) * 864e5;
  until = Math.max(until, Number(await kv(["GET", "sr:pass:" + user.sub]) || 0));   // backup if the database write failed
  return until > Date.now() ? { pro: true, status: "PASS", paidUntil: until, id: null, period: null } : null;
}

async function passReport(id, sinceISO) {
  const o = await pp("/v2/checkout/orders/" + id.slice(7));
  if (!o.ok) return null;
  const cap = ((((o.d.purchase_units || [])[0] || {}).payments || {}).captures || [])[0];
  if (!cap || cap.status !== "COMPLETED" || cap.create_time < sinceISO) return { id, status: "PASS", payments: [] };
  const b = cap.seller_receivable_breakdown || {}, num = x => Number((x && x.value) || 0);
  const gross = num(b.gross_amount) || num(cap.amount), fee = num(b.paypal_fee);
  return { id, status: "PASS", payments: [{ time: cap.create_time, gross, fee, net: num(b.net_amount) || gross - fee, currency: (cap.amount || {}).currency_code || "USD" }] };
}
