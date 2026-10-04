import { guard, cleanSentences, tooLong, askClaude, fail } from "./_lib.js";

export default async function handler(req, res) {
  const body = await guard(req, res); if (!body) return;
  const sentences = cleanSentences(body.sentences);
  if (!sentences.length) return res.status(400).json({ code: "empty" });
  if (tooLong(sentences)) return res.status(413).json({ code: "too_long" });

  const numbered = sentences.map(s => `[${s.i}] ${s.text}`).join("\n");
  const prompt = `You are an expert at judging whether university student writing was produced by an AI model (like ChatGPT) or written by a person. Be calibrated and fair: formal academic style alone is NOT evidence of AI, and non-native English writing is often wrongly flagged, so weigh concrete signals (generic filler, stock transitions, perfectly balanced lists of three, vague claims with no specifics, hedging boilerplate, uniform rhythm) against human signals (specific personal detail, idiosyncratic phrasing, uneven rhythm, real opinions, small errors).

Here is the text split into numbered sentences:
${numbered}

Reply with ONLY a JSON object of this shape:
{"score": <0-100 overall likelihood the text is AI-generated>,
 "summary": "<2-3 plain sentences for the student: what reads as AI, what reads as human, and one concrete revision tip>",
 "signals": [{"label": "<short observation, under 10 words>", "level": "bad"|"warn"|"good"}],
 "sentences": [{"i": <sentence number>, "likelihood": <0-100>, "reason": "<under 18 words>"}]}
Include every sentence number exactly once. Give 3-5 signals.`;

  try {
    const r = await askClaude(prompt, Math.min(8000, 600 + sentences.length * 60));
    res.status(200).json({
      score: r.score, summary: r.summary,
      signals: Array.isArray(r.signals) ? r.signals : [],
      sentences: Array.isArray(r.sentences) ? r.sentences : [],
    });
  } catch (e) { fail(res, e); }
}
