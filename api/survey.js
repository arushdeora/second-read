// Student survey at /survey/. Anyone can answer; no sign-in needed.
// POST { answers: {...}, hp: "" }      saves one response (a row in the feedback table, tool = "survey").
// POST { action: "results" }           owner only (Google sign-in or STATS_KEY): totals for the /stats page.
import { timingSafeEqual, createHash } from "node:crypto";
import { guard } from "./_lib.js";
import { isOwner, kv } from "./_billing.js";
import { dbEnabled, insert } from "./_db.js";
import { selectAll } from "./_stats.js";

const env = k => String(process.env[k] || "").trim();
function keyOk(req) {
  const want = env("STATS_KEY"), got = String(req.headers["x-stats-key"] || "").trim();
  if (want.length < 24 || !got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
const parse = b => typeof b === "string" ? (() => { try { return JSON.parse(b); } catch { return {}; } })() : (b || {});

// Allowed answers. Anything else is dropped, so the stored data stays clean.
const ONE = {
  country: ["india", "canada", "usa", "other"],
  level: ["ug1", "ug2", "ug_final", "pg", "other"],
  field: ["arts", "commerce", "science", "engineering", "health", "law", "other"],
  freq: ["weekly", "monthly_few", "monthly", "rarely"],
  detector: ["yes", "no", "unsure"],
  flagged: ["me", "friend", "no", "unsure"],
  pays: ["yes", "no"],
  goodPrice: ["p1", "p2", "p3", "p4", "p5", "none"],
  priceFeel: ["cheap", "fair", "high", "too_high"],
  plan: ["monthly", "semester", "yearly", "per_essay"],
  used: ["yes", "no"],
};
const MANY = {
  tools: ["grammarly", "quillbot", "chatgpt", "turnitin", "scribbr", "free_checkers", "friend", "none"],
  worries: ["plagiarism", "ai_flag", "grammar", "citations", "clarity", "word_count"],
  pay: ["upi", "card", "paytm", "netbanking", "paypal", "wallet"],
};
const FEATURES = ["plagiarism", "ai", "grammar", "citations", "proofread", "paraphrase"];
const TEXT = { countryOther: 60, paysWhat: 120, improve: 600, tryIt: 600, more: 1000, email: 120 };

function clean(a) {
  const out = {};
  for (const [k, list] of Object.entries(ONE)) if (list.includes(a[k])) out[k] = a[k];
  for (const [k, list] of Object.entries(MANY)) if (Array.isArray(a[k])) { const v = [...new Set(a[k].filter(x => list.includes(x)))]; if (v.length) out[k] = v; }
  if (a.features && typeof a.features === "object") {
    const f = {}; for (const k of FEATURES) { const v = Math.round(+a.features[k]); if (v >= 1 && v <= 5) f[k] = v; }
    if (Object.keys(f).length) out.features = f;
  }
  const nps = Math.round(+a.nps); if (a.nps !== "" && a.nps != null && nps >= 0 && nps <= 10) out.nps = nps;
  for (const [k, max] of Object.entries(TEXT)) { const v = String(a[k] || "").trim().slice(0, max); if (v) out[k] = v; }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) delete out.email;
  return out;
}

async function tooMany(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const k = "sr:survey:" + createHash("sha256").update("ew-survey:" + ip).digest("hex").slice(0, 24) + ":" + Math.floor(Date.now() / 3600e3);
  const n = Number(await kv(["INCRBY", k, 1])); if (n === 1) await kv(["EXPIRE", k, 7200]);
  return n > 5;   // 5 responses per hour per network (a shared campus Wi-Fi gets a few)
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ code: "method_not_allowed" });
  const body = parse(req.body);

  if (body.action === "results") {
    if (!keyOk(req)) {
      const b = await guard(req, res, { cost: 0 }); if (!b) return;
      if (!isOwner(req.srUser)) return res.status(403).json({ code: "owner_only" });
    }
    if (!dbEnabled()) return res.status(200).json({ code: "no_database" });
    const rows = await selectAll("feedback", "select=created_at,comment&tool=eq.survey&order=created_at.desc", 5000);
    return res.status(200).json(summarize(rows));
  }

  if (body.hp) return res.status(200).json({ saved: true });            // bot filled the hidden field
  if (!dbEnabled()) return res.status(503).json({ code: "no_database" });
  try { if (await tooMany(req)) return res.status(429).json({ code: "rate_limited" }); } catch {}
  const answers = clean(body.answers || {});
  if (Object.keys(answers).length < 4) return res.status(400).json({ code: "too_few_answers" });
  const ok = await insert("feedback", { tool: "survey", kind: "survey", comment: JSON.stringify(answers), score: answers.nps ?? null });
  if (!ok) return res.status(500).json({ code: "upstream_error" });
  res.status(200).json({ saved: true });
}

function summarize(rows) {
  const list = rows.map(r => { try { return { at: r.created_at, ...JSON.parse(r.comment) }; } catch { return null; } }).filter(Boolean);
  const count = (key, opts, subset = list) => {
    const c = Object.fromEntries(opts.map(o => [o, 0])); let n = 0;
    for (const r of subset) { const v = r[key]; if (v == null) continue; n++; (Array.isArray(v) ? v : [v]).forEach(x => { if (x in c) c[x]++; }); }
    return { answered: n, counts: c };
  };
  const byRegion = { india: list.filter(r => r.country === "india"), west: list.filter(r => r.country === "canada" || r.country === "usa") };
  const out = { total: list.length, generatedAt: new Date().toISOString(), single: {}, multi: {}, features: {}, pricing: {}, nps: null, text: {} };
  for (const [k, o] of Object.entries(ONE)) if (k !== "goodPrice") out.single[k] = count(k, o);
  for (const [k, o] of Object.entries(MANY)) out.multi[k] = count(k, o);
  for (const f of FEATURES) { const v = list.map(r => r.features && r.features[f]).filter(Boolean); out.features[f] = { answered: v.length, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 }; }
  for (const [reg, sub] of Object.entries(byRegion)) out.pricing[reg] = { goodPrice: count("goodPrice", ONE.goodPrice, sub), priceFeel: count("priceFeel", ONE.priceFeel, sub) };
  const scores = list.map(r => r.nps).filter(v => Number.isInteger(v));
  if (scores.length) { const pro = scores.filter(s => s >= 9).length, det = scores.filter(s => s <= 6).length; out.nps = { answered: scores.length, score: Math.round((pro - det) / scores.length * 100), promoters: pro, detractors: det }; }
  for (const k of ["improve", "tryIt", "more", "paysWhat", "countryOther"]) out.text[k] = list.filter(r => r[k]).slice(0, 50).map(r => ({ at: r.at, text: r[k], country: r.country || null }));
  out.emails = list.filter(r => r.email).length;
  return out;
}
