// Outside AI-text detectors used as extra, independent votes in the AI Detector.
// Each one switches on when its key is set in Vercel (Settings → Environment Variables):
//   PANGRAM_API_KEY      Pangram    (~$0.05 per 100 words since Pangram 4)  https://pangram.readthedocs.io/en/stable/api/rest.html
//   SAPLING_API_KEY      Sapling    (~$0.005 per 1,000 characters, English only)  https://sapling.ai/docs/api/detector/
//   ORIGINALITY_API_KEY  Originality.ai (~1 credit per 100 words)  https://docs.originality.ai
// Optional:
//   ORIGINALITY_URL      the scan endpoint (default below; confirm it in your Originality dashboard)
//   EXTERNAL_MIN_WORDS   skip outside detectors on texts shorter than this (default 50; they are unreliable on tiny texts)
//   EXTERNAL_DETECTORS   comma list to limit which run, e.g. "pangram,sapling" (default: every one with a key)
// A detector that fails, times out or isn't configured is simply left out; the check still works.
const env = k => String(process.env[k] || "").trim().replace(/^["']|["']$/g, "").trim();
const words = t => (String(t).match(/[A-Za-z0-9À-ɏ'’-]+/g) || []).length;

async function timed(url, opts, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); const d = await r.json().catch(() => ({})); return { r, d }; }
  finally { clearTimeout(t); }
}

// Each returns { name, score (0-1, 1 = AI), segments: [{ text, score }], cost (USD) } or throws.
const PROVIDERS = {
  async pangram(text) {
    const key = env("PANGRAM_API_KEY");
    const base = "https://text.external-api.pangram.com";
    const headers = { "content-type": "application/json", "x-api-key": key };
    const { r, d } = await timed(base + "/task", { method: "POST", headers, body: JSON.stringify({ text }) }, 10000);
    if (!r.ok || !d.task_id) throw new Error("pangram create " + r.status + " " + JSON.stringify(d).slice(0, 200));
    const until = Date.now() + 30000;
    let res = null;
    while (Date.now() < until) {
      await new Promise(ok => setTimeout(ok, 700));
      const p = await timed(base + "/task/" + encodeURIComponent(d.task_id), { headers: { "x-api-key": key } }, 8000);
      if (!p.r.ok) throw new Error("pangram poll " + p.r.status);
      if (p.d.stage === "STAGE_SUCCESS") { res = p.d; break; }
      if (p.d.stage === "STAGE_FAILED") throw new Error("pangram failed: " + (p.d.headline || ""));
    }
    if (!res) throw new Error("pangram timeout");
    // fraction_ai = share judged AI; AI-assisted text counts half.
    const score = Math.min(1, Number(res.fraction_ai || 0) + 0.5 * Number(res.fraction_ai_assisted || 0));
    const segments = (Array.isArray(res.windows) ? res.windows : []).map(w => ({ text: String(w.text || ""), score: Number(w.ai_assistance_score) || 0 }));
    // Pangram 4 bills $0.05 per 100 words (was per 1,000); our Oct 2026 test matched this rate.
    return { name: "Pangram", score, segments, label: res.prediction_short || null, cost: Math.max(1, Math.ceil(words(text) / 100)) * 0.05 };
  },

  async sapling(text) {
    const { r, d } = await timed("https://api.sapling.ai/api/v1/aidetect", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: env("SAPLING_API_KEY"), text: text.slice(0, 200000), sent_scores: true }),
    }, 20000);
    if (!r.ok || typeof d.score !== "number") throw new Error("sapling " + r.status + " " + String(d.msg || "").slice(0, 200));
    const segments = (Array.isArray(d.sentence_scores) ? d.sentence_scores : []).map(s => ({ text: String(s.sentence || ""), score: Number(s.score) || 0 }));
    return { name: "Sapling", score: d.score, segments, cost: text.length / 1000 * 0.005 };
  },

  async originality(text) {
    const url = env("ORIGINALITY_URL") || "https://api.originality.ai/api/v1/scan/ai";
    const { r, d } = await timed(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-OAI-API-KEY": env("ORIGINALITY_API_KEY") },
      body: JSON.stringify({ title: "EssayWiz check", content: text, aiModelVersion: "multilang", storeScan: false,
        check_ai: true, check_plagiarism: false, check_facts: false, check_readability: false, check_grammar: false }),
    }, 25000);
    if (!r.ok) throw new Error("originality " + r.status + " " + JSON.stringify(d).slice(0, 200));
    // Two documented shapes: v3 { results: { ai: { confidence: { AI }, blocks } } } and the older v1 { score: { ai }, blocks }.
    const ai = (d.results && d.results.ai) || d;
    const score = Number((ai.confidence && ai.confidence.AI) ?? (ai.score && ai.score.ai));
    if (!Number.isFinite(score)) throw new Error("originality: no score in response");
    const segments = (Array.isArray(ai.blocks) ? ai.blocks : []).map(b => ({ text: String(b.text || ""), score: Number(b.result && b.result.fake) || 0 }));
    return { name: "Originality.ai", score, segments, cost: Math.max(1, Math.ceil(words(text) / 100)) * 0.01 };
  },
};
const KEYS = { pangram: "PANGRAM_API_KEY", sapling: "SAPLING_API_KEY", originality: "ORIGINALITY_API_KEY" };

export function externalEnabled() {
  const only = env("EXTERNAL_DETECTORS").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return Object.keys(PROVIDERS).filter(n => env(KEYS[n]) && (!only.length || only.includes(n)));
}

// Runs every configured detector in parallel. onCost(usd) is called for each successful paid call.
export async function externalScores(text, onCost) {
  const names = externalEnabled();
  if (!names.length || words(text) < (Number(env("EXTERNAL_MIN_WORDS")) || 50)) return [];
  const out = await Promise.all(names.map(async n => {
    try { const res = await PROVIDERS[n](text); if (onCost) onCost(res.cost || 0); return res; }
    catch (e) { console.error("external detector failed:", n, e && e.message); return null; }
  }));
  return out.filter(Boolean);
}

// Score for one sentence from a detector's segments: segments that contain the sentence, or that the sentence contains.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function sentenceScore(sentence, segments) {
  const s = norm(sentence); if (!s) return null;
  const hits = segments.filter(g => { const t = norm(g.text); return t && (t.includes(s) || (t.length > 20 && s.includes(t))); });
  return hits.length ? hits.reduce((a, g) => a + g.score, 0) / hits.length : null;
}
