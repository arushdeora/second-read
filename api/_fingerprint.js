// Recognise text that EssayWiz itself rewrote (Humanizer, Paraphraser, "rewrite in my own words").
// When a tool returns text, a one-way hash of each sentence is kept for FINGERPRINT_DAYS (default 90).
// The AI Detector looks the hashes up, so our own machine rewrites are reported as AI-rewritten
// instead of slipping past the detector. Only hashes are stored, never the text.
import { createHash } from "node:crypto";
import { kv } from "./_billing.js";

const DAYS = () => Number(process.env.FINGERPRINT_DAYS || 90) || 90;
const norm = s => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = s => (s.match(/[a-z0-9']+/g) || []).length;
const key = s => "sr:gen:" + createHash("sha256").update("ew-gen:" + s).digest("hex").slice(0, 32);

// Split like the page does: on . ! ? and line breaks.
export function splitSentences(text) {
  return (String(text).match(/[^.!?\n]+(?:[.!?]+["')\]]*)?/g) || []).map(t => t.trim()).filter(t => t.length > 1);
}

// Sentences of 6+ words only: short ones ("That is true.") are too common to mean anything.
const usable = list => list.map(norm).filter(s => words(s) >= 6);

export async function markGenerated(text, tool = "rewrite") {
  try {
    const list = [...new Set(usable(splitSentences(text)))].slice(0, 400);
    const ttl = DAYS() * 86400;
    await Promise.all(list.map(s => kv(["SET", key(s), tool, "EX", ttl])));
  } catch (e) { console.error("fingerprint save failed", e && e.message); }
}

// Returns, for each input sentence, the tool that produced it (or null).
export async function matchGenerated(sentences) {
  const normed = sentences.map(s => norm(s));
  const idx = normed.map((s, i) => words(s) >= 6 ? i : -1).filter(i => i >= 0);
  const hits = sentences.map(() => null);
  if (!idx.length) return hits;
  try {
    const res = await Promise.all(idx.map(i => kv(["GET", key(normed[i])])));
    idx.forEach((i, k) => { if (res[k]) hits[i] = String(res[k]); });
  } catch (e) { console.error("fingerprint lookup failed", e && e.message); }
  return hits;
}
