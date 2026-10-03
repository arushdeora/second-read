import { guard, cleanSentences, tooLong, askClaude, fail } from "./_lib.js";

export default async function handler(req, res) {
  const body = guard(req, res); if (!body) return;
  const targets = cleanSentences(body.targets, 200);
  const context = String(body.context || "").slice(0, 4000);
  if (!targets.length) return res.status(400).json({ code: "empty" });
  if (tooLong(targets, context)) return res.status(413).json({ code: "too_long" });

  const prompt = `A university student is revising their own assignment. Some sentences read as generic or AI-like. Rewrite ONLY the numbered sentences below so they sound like a real student wrote them: plain everyday words, varied sentence length, no stock transitions (moreover, furthermore, in conclusion, it is important to note), no buzzwords (pivotal, multifaceted, leverage, foster, landscape, tapestry), and a direct point of view. Keep the original meaning, quotations, and citations. Do NOT invent facts, statistics, sources, or personal experiences. Where a concrete detail from the student would make the sentence stronger, insert a short bracketed placeholder like [add your own example] or [name a source] for them to fill in. Match the tone of the student's own sentences:
"""${context || "(no other sentences)"}"""

Sentences to rewrite:
${targets.map(s => `[${s.i}] ${s.text}`).join("\n")}

Reply with ONLY a JSON array: [{"i": <number>, "rewrite": "<new sentence or two>", "why": "<what you changed, under 15 words>"}], one entry per numbered sentence.`;

  try {
    const r = await askClaude(prompt, Math.min(8000, 400 + targets.length * 120));
    res.status(200).json({ rewrites: Array.isArray(r) ? r : [] });
  } catch (e) { fail(res, e); }
}
