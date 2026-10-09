// Usage, cost and revenue tracking for the owner's /stats page.
// Rows go to Supabase (see supabase/schema.sql). Nothing is stored until the database is
// connected, and never the student's text: only the tool, word count, Claude usage and a
// one-way hash of the Google account.
import { dbEnabled, insert, select, userHash } from "./_db.js";
import { isOwner } from "./_billing.js";

const env = k => String(process.env[k] || "").trim();

// Claude prices in USD per million tokens (input, output), from Anthropic's pricing page.
// Override with AI_PRICE_IN / AI_PRICE_OUT if you use a model that isn't listed here.
const PRICES = [
  [/haiku-5/, 0.10, 0.50],
  [/haiku-4/, 1, 5],
  [/haiku-3-5/, 0.8, 4],
  [/haiku/, 0.25, 1.25],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/opus-5-5/, 4, 20],
  [/opus-(5|4-[5-9])/, 5, 25],
  [/opus/, 15, 75],
  [/fable|mythos/, 10, 50],
];
const SEARCH_PRICE = 10 / 1000;   // web search: $10 per 1,000 searches

export function priceOf(model) {
  if (env("AI_PRICE_IN") && env("AI_PRICE_OUT")) return [Number(env("AI_PRICE_IN")), Number(env("AI_PRICE_OUT"))];
  const hit = PRICES.find(([re]) => re.test(String(model || "")));
  return hit ? [hit[1], hit[2]] : [3, 15];
}
export function costOf(m) {
  const [pin, pout] = priceOf(m.model);
  return (m.inTok * pin + m.outTok * pout) / 1e6 + m.searches * SEARCH_PRICE;
}

const day = (d = new Date()) => d.toISOString().slice(0, 10);

function bodyOf(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

// Called once per request by tracked() in _lib.js, after the response is sent.
export async function logEvent(req, res, m) {
  if (!dbEnabled() || !req.srUser) return;
  const user = req.srUser;
  const uh = userHash(user) || "anonymous";
  const plan = isOwner(user) ? "owner" : res.getHeader("x-sr-pro") === "1" ? "pro" : "free";
  const status = res.statusCode || 0;
  const jobs = [insert("active_days", { user_hash: uh, day: day(), plan }, { onConflict: "user_hash,day" })];
  if (m.tool === "billing") {
    const body = bodyOf(req);
    if (m.mode === "activate" && status === 200 && body.subscriptionID) {
      jobs.push(insert("subscriptions", { id: String(body.subscriptionID).slice(0, 40), user_hash: uh }, { onConflict: "id" }));
      jobs.push(insert("events", { tool: "billing", mode: "pro_signup", status, user_hash: uh, plan }));
    }
    if (m.mode === "pass_capture" && status === 200) jobs.push(insert("events", { tool: "billing", mode: "pro_signup", status, user_hash: uh, plan }));
  } else {
    jobs.push(insert("events", {
      tool: m.tool, mode: m.mode.slice(0, 30) || null, status, user_hash: uh, plan,
      words: m.words, in_tokens: m.inTok, out_tokens: m.outTok, searches: m.searches,
      model: m.model, cost_usd: Number(costOf(m).toFixed(6)),
    }));
  }
  await Promise.all(jobs);
}

// Read every row (PostgREST returns at most 1,000 per request).
export async function selectAll(table, query, max = 50000) {
  const out = [];
  for (let off = 0; off < max; off += 1000) {
    const rows = await select(table, `${query}&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
