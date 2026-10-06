// 15-minute free trial, then Pro subscription ($5/month through PayPal).
// Nothing here is active until PAYPAL_CLIENT_ID and PAYPAL_SECRET are set in Vercel:
// until then every signed-in student can use the tools for free with no time limit.
//
// Optional settings:
//   PAYPAL_ENV          "sandbox" to test with PayPal sandbox accounts (default: live)
//   PAYPAL_PLAN_ID      use an existing PayPal plan; otherwise a $5/month "Second Read Pro" plan is created automatically
//   PRO_PRICE           monthly price in USD for the auto-created plan (default 5.00)
//   OWNER_EMAILS        comma-separated Google emails that always have free, unlimited access (default: the owner)
//   FREE_TRIAL_MINUTES  length of the free trial, counted from a student's first check (default 15)
//   PRO_DAILY_CREDITS   fair-use cap for Pro members per day (default 400)
//   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//                       a free Upstash Redis store; keeps usage counts and Pro status accurate across servers and devices
// Trial start times are also saved in the Supabase "trials" table when the database is connected,
// so a trial can't restart when the server restarts.

import { dbEnabled, select as dbSelect, insert as dbInsert, userHash } from "./_db.js";

const env = k => String(process.env[k] || "").trim().replace(/^["']|["']$/g, "").trim();
export const billingEnabled = () => !!(env("PAYPAL_CLIENT_ID") && env("PAYPAL_SECRET"));
const OWNERS = () => (env("OWNER_EMAILS") || "arushdeora24@gmail.com").toLowerCase().split(/[\s,;]+/).filter(Boolean);
export const isOwner = user => !!(user && user.email && OWNERS().includes(user.email));
const TRIAL_MS = () => (Number(env("FREE_TRIAL_MINUTES") || 15) || 15) * 60e3;
const PRO = () => Number(env("PRO_DAILY_CREDITS") || 400);
const PRICE = () => (Number(env("PRO_PRICE") || 5) || 5).toFixed(2);
const PP = () => env("PAYPAL_ENV").toLowerCase() === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
const PLAN_NAME = "Second Read Pro";

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
  if (!r.ok || !d.access_token) { console.error("PayPal auth failed", r.status, d.error || d.name, "(check PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_ENV)"); throw { status: 502, code: "billing_error" }; }
  tok = { v: d.access_token, exp: Date.now() + Number(d.expires_in || 3000) * 1000 };
  return tok.v;
}
async function pp(path, opts = {}) {
  const r = await fetch(PP() + path, { ...opts, headers: { authorization: "Bearer " + await ppToken(), "content-type": "application/json", ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// The $5/month plan: PAYPAL_PLAN_ID, an existing active "Second Read Pro" plan, or a new one.
let planId = null;
export async function getPlanId() {
  if (env("PAYPAL_PLAN_ID")) return env("PAYPAL_PLAN_ID");
  if (planId) return planId;
  const stored = await kv(["GET", "sr:plan"]); if (stored) return (planId = stored);
  const list = await pp("/v1/billing/plans?page_size=20&total_required=true");
  const found = (list.d.plans || []).find(p => p.name === PLAN_NAME && p.status === "ACTIVE");
  if (found) { planId = found.id; await kv(["SET", "sr:plan", planId]); return planId; }
  const prod = await pp("/v1/catalogs/products", { method: "POST", headers: { "PayPal-Request-Id": "second-read-pro-product-v1" },
    body: JSON.stringify({ name: PLAN_NAME, description: "Unlimited access to the Second Read writing tools", type: "SERVICE" }) });
  if (!prod.ok) { console.error("PayPal product create failed", prod.status, prod.d); throw { status: 502, code: "billing_error" }; }
  const plan = await pp("/v1/billing/plans", { method: "POST", headers: { "PayPal-Request-Id": "second-read-pro-plan-v1-" + PRICE() },
    body: JSON.stringify({
      product_id: prod.d.id, name: PLAN_NAME, description: `Second Read Pro, $${PRICE()} USD per month`, status: "ACTIVE",
      billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: PRICE(), currency_code: "USD" } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    }) });
  if (!plan.ok) { console.error("PayPal plan create failed", plan.status, plan.d); throw { status: 502, code: "billing_error" }; }
  planId = plan.d.id; await kv(["SET", "sr:plan", planId]);
  return planId;
}

// Check a subscription with PayPal. It counts as Pro while ACTIVE, or after cancelling
// until the end of the month already paid for.
async function checkSubscription(id, user) {
  if (!/^I-[A-Z0-9]{6,30}$/.test(String(id || ""))) return null;
  const r = await pp("/v1/billing/subscriptions/" + id);
  if (!r.ok) return null;
  const s = r.d;
  if (String(s.custom_id || "") !== String(user.sub)) return null;          // must belong to this Google account
  const plan = await getPlanId().catch(() => null);
  if (plan && s.plan_id !== plan) return null;
  const next = s.billing_info && s.billing_info.next_billing_time ? Date.parse(s.billing_info.next_billing_time) : 0;
  const paidUntil = next || 0;
  const pro = s.status === "ACTIVE" || ((s.status === "CANCELLED" || s.status === "SUSPENDED") && paidUntil > Date.now());
  return { id, pro, status: s.status, paidUntil };
}

const proCache = new Map();
export async function proStatus(user, hintId) {
  const c = proCache.get(user.sub);
  if (c && c.until > Date.now() && (c.info.pro || !hintId || hintId === c.info.id)) return c.info;
  const ids = [hintId, await kv(["GET", "sr:sub:" + user.sub])].filter(Boolean);
  let info = { pro: false };
  for (const id of [...new Set(ids)]) {
    try { const s = await checkSubscription(id, user); if (s) { info = s; if (s.pro) break; } } catch (e) { console.error("subscription check failed", e && (e.message || e.code)); }
  }
  if (info.pro) await kv(["SET", "sr:sub:" + user.sub, info.id]);
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
export async function usage(user) {
  return Number(await kv(["GET", `sr:use:${user.sub}:${day()}`]) || 0);
}

// When did this student's free trial start? (null = not started yet)
async function trialStart(user) {
  const v = Number(await kv(["GET", "sr:trial:" + user.sub]) || 0);
  if (v) return v;
  if (dbEnabled()) {
    const rows = await dbSelect("trials", "select=started_at&user_hash=eq." + userHash(user));
    if (rows[0]) { const t = Date.parse(rows[0].started_at); if (t) { await kv(["SET", "sr:trial:" + user.sub, String(t)]); return t; } }
  }
  return null;
}
async function startTrial(user) {
  const now = Date.now();
  await kv(["SET", "sr:trial:" + user.sub, String(now)]);
  if (dbEnabled()) await dbInsert("trials", { user_hash: userHash(user), started_at: new Date(now).toISOString() }, { onConflict: "user_hash" });
  return (await trialStart(user)) || now;   // keep the earliest start if one already existed
}
async function trialEnds(user, start = false) {
  let t = await trialStart(user);
  if (!t && start) t = await startTrial(user);
  return t ? t + TRIAL_MS() : null;
}

// Check one request. Returns null if allowed, or an error {status, code}.
export async function charge(user, cost, hintId, res) {
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
  const ends = await trialEnds(user, true);
  res.setHeader("x-sr-trial-ends", String(ends));
  if (Date.now() > ends) return { status: 402, code: "need_pro" };
  return null;
}

export async function status(user, hintId) {
  if (!billingEnabled() || !user || !user.sub) return { enabled: false };
  const owner = isOwner(user);
  const info = owner ? { pro: true, status: "OWNER" } : await proStatus(user, hintId);
  return {
    owner,
    enabled: true, pro: !!info.pro, subscriptionStatus: info.status || null, paidUntil: info.paidUntil || null,
    trialMinutes: TRIAL_MS() / 60e3, trialEndsAt: info.pro ? null : await trialEnds(user, false), now: Date.now(), price: PRICE(),
    paypalClientId: env("PAYPAL_CLIENT_ID"), planId: await getPlanId(),
    manageUrl: env("PAYPAL_ENV").toLowerCase() === "sandbox" ? "https://www.sandbox.paypal.com/myaccount/autopay/" : "https://www.paypal.com/myaccount/autopay/",
  };
}
