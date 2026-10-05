// Shared helpers for the API routes. Files starting with "_" are not exposed as routes on Vercel.
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

export async function guard(req, res) {
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

export function fail(res, e) {
  if (e && e.code) return res.status(e.status || 500).json({ code: e.code });
  console.error(e);
  return res.status(500).json({ code: "upstream_error" });
}
