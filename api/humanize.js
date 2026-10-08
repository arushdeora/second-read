import { guard, cleanSentences, tooLong, askClaude, rewriteKeepLength, fail, tracked } from "./_lib.js";
import { collect } from "./_db.js";

// A full rewrite of a long essay can take a while.
export const config = { maxDuration: 60 };

const STYLE = `natural, confident university-level English: keep precise academic vocabulary, subject terms and the same level of sophistication as the original (do NOT simplify, dumb down, or make it sound childish or overly casual), varied sentence length (mix shorter and longer, more complex sentences), no stock transitions (moreover, furthermore, in conclusion, it is important to note), no buzzwords (pivotal, multifaceted, leverage, foster, landscape, tapestry, delve), and a direct point of view`;

async function handler(req, res) {
  const body = await guard(req, res); if (!body) return;

  // Mode 1: rewrite the whole text and return it as one piece.
  if (body.mode === "full") {
    const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) return res.status(400).json({ code: "empty" });
    if (text.length > 20000) return res.status(413).json({ code: "too_long" });
    const prompt = `A university student is revising their own assignment so it reads like their own natural writing. Rewrite the WHOLE text below so it sounds like a real student wrote it: ${STYLE}.
Rules:
- Keep the same meaning, argument, structure and paragraph breaks (one blank line between paragraphs).
- Keep every quotation, citation, reference, name, number and date exactly as written.
- Do NOT invent facts, statistics, sources or personal experiences. Where a concrete detail from the student would help, insert a short bracketed placeholder like [add your own example].
- Keep the same length: rewrite and replace words, never delete sentences or details.
Reply with ONLY the rewritten text: no title, no notes, no quotation marks around it.

TEXT:
"""
${text}
"""`;
    try {
      const out = await rewriteKeepLength(prompt, text, { min: 0.93, max: 1.1 });
      if (!out.text) return res.status(502).json({ code: "upstream_error" });
      // With the student's permission, keep the machine-written result as an "ai" example for training.
      await collect(req, body, out.text, { tool: "human", label: "ai", origin: "generated" });
      return res.status(200).json({ text: out.text, cut: out.cut, words: out.words, originalWords: out.originalWords });
    } catch (e) { return fail(res, e); }
  }

  // Mode 2 (default): rewrite only the flagged sentences.
  const targets = cleanSentences(body.targets, 200);
  const context = String(body.context || "").slice(0, 4000);
  if (!targets.length) return res.status(400).json({ code: "empty" });
  if (tooLong(targets, context)) return res.status(413).json({ code: "too_long" });

  const prompt = `A university student is revising their own assignment. Some sentences read as generic or AI-like. Rewrite ONLY the numbered sentences below so they sound like a real student wrote them: ${STYLE}. Keep the original meaning, quotations, and citations. Do NOT invent facts, statistics, sources, or personal experiences. Where a concrete detail from the student would make the sentence stronger, insert a short bracketed placeholder like [add your own example] or [name a source] for them to fill in. Match the tone of the student's own sentences:
"""${context || "(no other sentences)"}"""

Sentences to rewrite:
${targets.map(s => `[${s.i}] ${s.text}`).join("\n")}

Reply with ONLY a JSON array: [{"i": <number>, "rewrite": "<new sentence or two>", "why": "<what you changed, under 15 words>"}], one entry per numbered sentence.`;

  try {
    const r = await askClaude(prompt, Math.min(8000, 400 + targets.length * 120));
    res.status(200).json({ rewrites: Array.isArray(r) ? r : [] });
  } catch (e) { fail(res, e); }
}

export default tracked("humanize", handler);
