// Shared helpers for the API routes. Files starting with "_" are not exposed as routes on Vercel.
import { charge } from "./_billing.js";
const MODEL = process.env.MODEL || "claude-haiku-4-5-20251001";
const MAX_CHARS = 20000;

// Best-effort per-IP limit (resets when the server instance restarts).
const hits = new Map();
function rateLimited(ip, perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 6)) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > perMinute;
}

// Google sign-in: when GOOGLE_CLIENT_ID is set, every API call must carry a valid Google ID token.
const tokenCache = new Map();
async function googleUser(req) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) return { anonymous: true };
  const auth = String(req.headers["authorization"] || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.exp * 1000 > Date.now()) return hit;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token));
    if (!r.ok) return null;
    const t = await r.json();
    const okIss = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
    if (t.aud !== clientId || !okIss || Number(t.exp) * 1000 < Date.now()) return null;
    const user = { sub: t.sub, email: t.email, exp: Number(t.exp) };
    if (tokenCache.size > 2000) tokenCache.clear();
    tokenCache.set(token, user);
    return user;
  } catch (e) { console.error("tokeninfo failed", e); return null; }
}

// opts.cost: credits this request uses from the student's daily allowance (see _billing.js).
export async function guard(req, res, opts = {}) {
  if (req.method !== "POST") { res.status(405).json({ code: "method_not_allowed" }); return null; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ code: "not_configured" }); return null; }
  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const required = process.env.ACCESS_CODE;
  if (required) {
    if (!body.code) { res.status(401).json({ code: "need_code" }); return null; }
    if (body.code !== required) { res.status(403).json({ code: "bad_code" }); return null; }
  }
  const user = await googleUser(req);
  if (!user) { res.status(401).json({ code: "need_login" }); return null; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(user.sub || ip)) { res.status(429).json({ code: "rate_limited" }); return null; }
  req.srUser = user;
  try {
    const cost = opts.cost == null ? 1 : opts.cost;
    const denied = await charge(user, cost, String(req.headers["x-sr-subscription"] || ""), res);
    if (denied) { res.status(denied.status).json({ code: denied.code }); return null; }
  } catch (e) { console.error("billing check failed", e && (e.message || e.code)); }
  return body || {};
}

export function cleanSentences(list, max = 400) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map(s => ({ i: Number(s.i) | 0, text: String(s.text || "").replace(/\s+/g, " ").trim() })).filter(s => s.text);
}

export function tooLong(sentences, extra = "") {
  return sentences.reduce((n, s) => n + s.text.length, 0) + extra.length > MAX_CHARS;
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

export function extractJson(text) {
  const direct = safeParse(text.trim());
  if (direct !== null) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { const v = safeParse(fence[1]); if (v !== null) return v; }
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) return safeParse(text.slice(a, b + 1));
  return null;
}

function apiKey() {
  // Tolerate stray spaces, line breaks or quotes pasted into the Vercel setting.
  return String(process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
}

export async function askClaude(prompt, maxTokens, opts = {}) {
  const key = apiKey();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: opts.model || MODEL, max_tokens: maxTokens, ...(opts.temperature != null ? { temperature: opts.temperature } : {}), messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) throw { status: 429, code: "rate_limited" };
  if (!r.ok) {
    console.error("Anthropic API error", r.status, data);
    if (r.status === 401) console.error(`Key check: starts with "${key.slice(0, 7)}", ${key.length} characters (a valid key starts with "sk-ant-" and is about 108 characters)`); throw { status: 502, code: "upstream_error" }; }
  if (data.stop_reason === "refusal") throw { status: 422, code: "refused" };
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const json = extractJson(text);
  if (json === null) throw { status: 502, code: "invalid_json" };
  return json;
}

// Plain-text reply (for long rewrites, where asking for JSON would be fragile).
export async function askClaudeText(prompt, maxTokens) {
  const key = apiKey();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) throw { status: 429, code: "rate_limited" };
  if (!r.ok) { console.error("Anthropic API error", r.status, data); throw { status: 502, code: "upstream_error" }; }
  if (data.stop_reason === "refusal") throw { status: 422, code: "refused" };
  return { text: (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim(), cut: data.stop_reason === "max_tokens" };
}

// Rewrite while keeping roughly the original length. Rewriters tend to quietly drop
// sentences; if the result is too short (or too long), ask once more with the exact
// numbers and keep whichever attempt is closest to the target.
export const countWords = t => (String(t).match(/[A-Za-z0-9\u00C0-\u024F\u2019'-]+/g) || []).length;
export async function rewriteKeepLength(prompt, original, { min = 0.92, max = 1.12, maxTokens } = {}) {
  const n = countWords(original);
  const lo = Math.round(n * min), hi = Math.round(n * max);
  const rule = `\n\nLENGTH RULE: The original is ${n} words. Your rewrite MUST be between ${lo} and ${hi} words. Rewrite every sentence; do not drop sentences, ideas, examples, details or qualifiers. Change words and sentence structure instead of deleting them. Keep the same number of paragraphs and roughly the same number of sentences in each.\n\nPUNCTUATION RULE: When you continue or join a sentence, use connecting WORDS (and, but, because, so, while, which, although, as, since) or start a new sentence. Do NOT use dashes (— or – or a hyphen used as a dash), semicolons, or colons to join clauses. Use only full stops, commas, question marks, quotation marks and normal hyphens inside words.`;
  const tokens = maxTokens || Math.min(16000, Math.ceil(String(original).length / 2) + 1200);
  // Safety net: turn any leftover dash or semicolon joins into a comma or a full stop.
  const unjoin = t => t
    .replace(/\s*[\u2014\u2013]\s*/g, ", ")                 // em/en dashes -> comma
    .replace(/(\w) - (\w)/g, "$1, $2")                        // spaced hyphen used as a dash
    .replace(/;\s+([a-z])/g, ", and $1")                       // semicolon before lowercase -> ", and"
    .replace(/;\s+([A-Z])/g, ". $1")                           // semicolon before capital -> new sentence
    .replace(/,\s*,/g, ",").replace(/, ([.!?])/g, "$1");
  const clean = t => unjoin(t.replace(/^"""\s*|\s*"""$/g, "")).trim();
  let best = await askClaudeText(prompt + rule, tokens); best.text = clean(best.text);
  let w = countWords(best.text);
  if (n >= 40 && (w < lo || w > hi) && !best.cut) {
    const fix = w < lo
      ? `\n\nIMPORTANT: A previous attempt was only ${w} words, which removed too much. The result must be ${lo}-${hi} words. Go through the original sentence by sentence and rewrite EVERY one; keep all details.`
      : `\n\nIMPORTANT: A previous attempt was ${w} words, which is too long. The result must be ${lo}-${hi} words. Do not add new content.`;
    try {
      const again = await askClaudeText(prompt + rule + fix, tokens); again.text = clean(again.text);
      const w2 = countWords(again.text);
      if (again.text && Math.abs(w2 - n) < Math.abs(w - n)) { best = again; w = w2; }
    } catch (e) { /* keep the first attempt */ }
  }
  return { text: best.text, cut: best.cut, words: w, originalWords: n };
}

export function fail(res, e) {
  if (e && e.code) return res.status(e.status || 500).json({ code: e.code });
  console.error(e);
  return res.status(500).json({ code: "upstream_error" });
}
