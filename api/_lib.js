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

export function guard(req, res) {
  if (req.method !== "POST") { res.status(405).json({ code: "method_not_allowed" }); return null; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ code: "not_configured" }); return null; }
  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const required = process.env.ACCESS_CODE;
  if (required) {
    if (!body.code) { res.status(401).json({ code: "need_code" }); return null; }
    if (body.code !== required) { res.status(403).json({ code: "bad_code" }); return null; }
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) { res.status(429).json({ code: "rate_limited" }); return null; }
  return body;
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

export async function askClaude(prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) throw { status: 429, code: "rate_limited" };
  if (!r.ok) { console.error("Anthropic API error", r.status, data); throw { status: 502, code: "upstream_error" }; }
  if (data.stop_reason === "refusal") throw { status: 422, code: "refused" };
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const json = extractJson(text);
  if (json === null) throw { status: 502, code: "invalid_json" };
  return json;
}

export function fail(res, e) {
  if (e && e.code) return res.status(e.status || 500).json({ code: e.code });
  console.error(e);
  return res.status(500).json({ code: "upstream_error" });
}
