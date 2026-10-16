import { guard, cleanSentences, tooLong, askClaude, fail, tracked, meterExtra } from "./_lib.js";
import { collect } from "./_db.js";
import { ownScores } from "./_detector.js";
import { matchGenerated } from "./_fingerprint.js";
import { externalScores, sentenceScore } from "./_external.js";

// Outside detectors can take a while (Pangram polls for its result).
export const config = { maxDuration: 60 };

// Our own trained detector. It runs inside this server (api/_detector.js + _detector-model.js),
// or on a bigger hosted model if DETECTOR_URL is set (see training/ and detector-space/).
//   DETECTOR_MODE=blend (default): our model + Claude + style statistics
//   DETECTOR_MODE=only:            our model + style statistics, no Claude at all
//   DETECTOR_MODE=off:             don't use our model
const envv = k => String(process.env[k] || "").trim();
async function ownModel(texts) {
  if (envv("DETECTOR_MODE").toLowerCase() === "off") return null;
  const url = envv("DETECTOR_URL");
  if (!url) { const p = await ownScores(texts); return p ? p.map(x => clamp(Math.round(x * 100))) : null; }
  try {
    const headers = { "content-type": "application/json" };
    if (envv("DETECTOR_KEY")) headers.authorization = "Bearer " + envv("DETECTOR_KEY");
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(url.replace(/\/+$/, "") + "/score", { method: "POST", headers, body: JSON.stringify({ texts }), signal: ctl.signal });
    clearTimeout(t);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.scores) || d.scores.length !== texts.length) { console.error("own detector failed", r.status, d); return null; }
    return d.scores.map(x => clamp(Math.round(Number(x) * 100)));
  } catch (e) { console.error("own detector error", e && e.message); return null; }
}

// AI-writing estimate. Two independent signals are blended so one over-eager judgement
// can't push an honest essay to a high score:
//   1. a calibrated per-sentence reading by the model (temperature 0), and
//   2. measurable style statistics (sentence-length variety, stock AI phrases, personal voice).
// Formal or careful human writing is common in university work, so the default leans human.

const PHRASES = ["delve", "moreover", "furthermore", "additionally", "in conclusion", "it is important to note", "it's important to note",
  "plays a crucial role", "play a crucial role", "plays a pivotal role", "pivotal", "tapestry", "in today's", "rapidly evolving", "ever-evolving",
  "landscape", "foster", "notably", "underscore", "multifaceted", "realm", "showcase", "seamless", "robust", "leverage", "harness",
  "vibrant", "intricate", "testament", "comprehensive", "paramount", "embark", "holistic", "nuanced", "in summary", "a myriad of",
  "serves as", "navigate the", "navigating the", "it is worth noting", "in the realm of", "shed light on", "a deeper understanding",
  "ultimately,", "overall,", "in essence", "stands as", "game-changer", "unlock", "elevate"];

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const wordsOf = s => s.match(/[A-Za-z’'-]+/g) || [];

function stats(sentences) {
  const text = sentences.map(s => s.text).join(" ");
  const words = wordsOf(text); const n = Math.max(1, words.length);
  const lens = sentences.map(s => wordsOf(s.text).length).filter(x => x > 0);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length));
  const cv = mean ? sd / mean : 0;
  const lower = text.toLowerCase();
  const phraseHits = PHRASES.reduce((c, p) => c + (lower.split(p).length - 1), 0);
  const phraseRate = phraseHits / n * 100;                      // stock phrases per 100 words
  const personal = (lower.match(/\b(i|i'm|i've|i'd|my|me|we|our)\b/g) || []).length + (lower.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/g) || []).length;
  const personalRate = personal / n * 100;
  // Each sub-score: 0 = looks human, 100 = looks AI.
  // Sentence-length variety only means something over enough sentences; on a short passage it is noise,
  // so it stays neutral-low there instead of counting against the writer.
  const burst = lens.length < 8 ? 25 : clamp((0.55 - cv) / 0.30 * 100);   // even sentence lengths look AI
  const phr = clamp(phraseRate / 1.2 * 100);                               // ~1.2 stock phrases / 100 words = max
  const pers = clamp((2 - personalRate) / 2 * 50);                         // no personal voice is only a weak signal
  // No personal voice is normal in summaries and literary analysis, so it only counts a little.
  const score = 0.50 * burst + 0.45 * phr + 0.05 * pers;
  return { score, cv, phraseHits, phraseRate, personalRate, words: n };
}

async function handler(req, res) {
  const body = await guard(req, res); if (!body) return;
  const sentences = cleanSentences(body.sentences);
  if (!sentences.length) return res.status(400).json({ code: "empty" });
  if (tooLong(sentences)) return res.status(413).json({ code: "too_long" });

  const numbered = sentences.map(s => `[${s.i}] ${s.text}`).join("\n");
  const prompt = `You estimate whether each sentence of a university student's text was generated by an AI model (like ChatGPT) or written by the student. False accusations hurt students, so be strict about evidence and lean HUMAN when unsure.

Do NOT treat these as AI evidence on their own: formal or academic tone, correct grammar, good vocabulary, clear structure, topic sentences, citations, non-native English patterns, or simply being well written. Many careful human writers produce this.

Count as AI evidence only concrete markers: stock AI phrases ("delve", "it is important to note", "plays a crucial/pivotal role", "in today's rapidly evolving", "tapestry", "multifaceted", "navigate the landscape"), empty generic claims with no specifics, perfectly balanced lists of three repeated across sentences, hedging boilerplate, and the same sentence rhythm over and over.
Many AI texts avoid those buzzwords (students ask for "plain" or "student-like" writing, or run it through a humanizer). Judge the text as a whole too. These also count as AI evidence when several appear together: every paragraph built the same way (claim, explanation, neat one-line takeaway), a tidy aphorism closing each paragraph (like "and that makes all the difference"), examples that are textbook-standard rather than drawn from a specific source the student read, perfectly smooth prose with zero slips or quirks over many sentences, a staged casual voice (like "here's the thing" or "honestly, it's simple") that never says anything specific to the writer, and a conclusion that neatly restates the opening.
Count as human evidence: specific details from a named source the student is working with (an article, a case, a film scene, page numbers), in-text citations like (Author, 2019), uneven rhythm, idiosyncratic wording, awkward or non-native phrasing, small mistakes (typos, a missing space after a comma, agreement errors).
Summaries and literary analysis are normally written in the third person without "I": that is NOT AI evidence. Quoting or naming an author and their arguments is normal student work. Formal tone alone is never enough.

Calibration for each sentence's "likelihood":
- 0-20: ordinary human writing, including formal academic writing
- 20-40: polished and generic but a human could easily write it
- 40-70: two or more clear AI markers, or a sentence in a text that reads machine-written as a whole
- 70-100: obviously machine-like (several stock phrases, or the whole-text AI pattern above is clear and there is no human evidence)
A typical honest student essay should land mostly between 5 and 35. An AI essay without buzzwords should still score 60+ when the whole-text pattern is clear.

Text, split into numbered sentences:
${numbered}

Reply with ONLY JSON:
{"score": <0-100 overall, following the same calibration>,
 "summary": "<2-3 plain sentences for the student: what (if anything) reads as AI, what reads as human, one revision tip>",
 "sentences": [{"i": <number>, "likelihood": <0-100>, "reason": "<under 16 words, name the concrete marker or say why it reads human>"}]}
Include every sentence number exactly once.`;

  try {
    // Outside detectors (Pangram, Sapling, Originality.ai) run in parallel with our own checks.
    const extP = externalScores(sentences.map(s => s.text).join(" "), meterExtra);
    const [own, ours] = await Promise.all([ownModel(sentences.map(s => s.text)), matchGenerated(sentences.map(s => s.text))]);
    const onlyOwn = own && envv("DETECTOR_MODE").toLowerCase() === "only";
    const r = onlyOwn
      ? { score: null, summary: "", sentences: sentences.map((s, k) => ({ i: s.i, likelihood: own[k], reason: own[k] >= 50 ? "Our detector found AI-like patterns here." : "Reads like human writing to our detector." })) }
      : await askClaude(prompt, Math.min(8000, 600 + sentences.length * 60), { temperature: 0, model: process.env.AI_MODEL || undefined });
    if (own && !onlyOwn) {
      // Blend our model into Claude's per-sentence view. DETECTOR_WEIGHT (0-1) sets our model's share:
      // 0.15 by default: on a test of pre-ChatGPT university essays it flagged about half the human ones,
      // so it only nudges Claude's view for now. Raise it once a retrained model does better.
      const ww = Math.max(0, Math.min(1, Number(envv("DETECTOR_WEIGHT") || 0.15)));
      const ownBy = new Map(sentences.map((s, k) => [s.i, own[k]]));
      r.sentences = (Array.isArray(r.sentences) ? r.sentences : []).map(x => ownBy.has(Number(x.i)) ? { ...x, likelihood: ww * ownBy.get(Number(x.i)) + (1 - ww) * (Number(x.likelihood) || 0) } : x);
      r.score = null;
    }
    const st = stats(sentences);
    const list = (Array.isArray(r.sentences) ? r.sentences : []).map(x => ({ i: Number(x.i), likelihood: clamp(Math.round(Number(x.likelihood) || 0)), reason: String(x.reason || "").slice(0, 160) }));
    // Model's view: length-weighted mean of sentence likelihoods, blended with its overall number.
    const byI = new Map(list.map(x => [x.i, x]));
    let wsum = 0, lsum = 0;
    sentences.forEach(s => { const w = Math.max(1, wordsOf(s.text).length); const l = (byI.get(s.i) || { likelihood: 20 }).likelihood; wsum += w; lsum += w * l; });
    const modelMean = wsum ? lsum / wsum : 20;
    const modelScore = r.score == null ? modelMean : 0.5 * modelMean + 0.5 * clamp(Number(r.score) || modelMean);
    let score = 0.6 * modelScore + 0.4 * st.score;
    // False accusations are the worst error for students, so without measurable AI fingerprints the score
    // stays low: no stock phrases caps it at 25 (45 if the model leans AI), few phrases at 40.
    // But AI text with the buzzwords removed (plain prompts, humanizers) has none of those fingerprints,
    // so when the model is confident on its own (75+), its view carries the score and can reach "AI".
    // Only when Claude is part of the reading: our own small model alone isn't reliable enough to accuse.
    const strongModel = !onlyOwn && modelMean >= 75;
    if (strongModel) score = Math.max(score, 0.85 * modelMean);
    else if (st.phraseHits === 0) score = Math.min(score, modelMean >= 60 ? 45 : 25);
    else if (st.phraseRate < 0.4) score = Math.min(score, 40);
    else if (st.phraseRate < 0.6) score = Math.min(score, 55);
    // Short texts can't be judged reliably: pull toward a low, neutral value and say so.
    const shortText = st.words < 150;
    if (st.words < 80) score = 0.5 * score + 0.5 * 20;
    else if (shortText) score = 0.75 * score + 0.25 * 20;
    score = Math.round(clamp(score));
    // Rescale sentence likelihoods so they agree with the overall result.
    const k = modelMean > 0 ? Math.min(1.2, score / modelMean) : 1;
    let sentencesOut = list.map(x => ({ ...x, likelihood: Math.round(clamp(x.likelihood * k)) }));
    // Consensus with outside detectors: only call it AI (or human) when at least two independent votes agree;
    // when they disagree, say it's unclear instead of showing a confident number.
    const ext = await extP;
    let verdict = score >= 60 ? "ai" : score < 30 ? "human" : "unclear";
    if (ext.length) {
      const extAvg = ext.reduce((a, d) => a + d.score, 0) / ext.length * 100;
      const aiVotes = ext.filter(d => d.score >= 0.7).length + (modelMean >= 70 ? 1 : 0);
      const humanVotes = ext.filter(d => d.score <= 0.3).length + (score <= 30 ? 1 : 0);
      let combined = 0.7 * extAvg + 0.3 * score;
      if (aiVotes >= 2 && aiVotes > humanVotes) { verdict = "ai"; combined = Math.max(combined, 60); }
      else if (humanVotes >= 2 && aiVotes === 0) { verdict = "human"; combined = Math.min(combined, 29); }
      else { verdict = "unclear"; combined = Math.max(30, Math.min(59, combined)); }
      score = Math.round(clamp(combined));
      const textOf = new Map(sentences.map(s => [s.i, s.text]));
      sentencesOut = sentencesOut.map(x => {
        const vals = ext.map(d => sentenceScore(textOf.get(x.i), d.segments)).filter(v => v != null);
        if (!vals.length) return x;
        const e = vals.reduce((a, v) => a + v, 0) / vals.length * 100;
        return { ...x, likelihood: Math.round(clamp(0.6 * e + 0.4 * x.likelihood)) };
      });
    }
    // Text that EssayWiz's own Humanizer or Paraphraser produced is known machine-rewritten text:
    // mark those sentences and make sure the overall score reflects their share of the text.
    const ourBy = new Map(sentences.map((s, j) => [s.i, ours[j]]));
    let rewritten = null;
    if (ours.some(Boolean)) {
      let ww = 0, wm = 0, tool = null;
      sentences.forEach((s, j) => { const w = Math.max(1, wordsOf(s.text).length); ww += w; if (ours[j]) { wm += w; tool = tool || ours[j]; } });
      const share = ww ? wm / ww : 0;
      sentencesOut = sentencesOut.map(x => ourBy.get(x.i) ? { ...x, likelihood: 97, reason: `Rewritten by EssayWiz's ${ourBy.get(x.i) === "humanizer" ? "Humanizer" : "Paraphraser"}`, ours: true } : x);
      score = Math.round(clamp(Math.max(score, share >= 0.5 ? 70 + 30 * share : 100 * share)));
      rewritten = { share: Math.round(share * 100), tool };
      if (share >= 0.5) verdict = "ai";
    }
    // When the calibrated score is low, don't show a model summary that may still talk about AI signs.
    const voted = ext.length ? `${ext.length + 1} detectors checked this (${ext.map(d => d.name).join(", ")} and EssayWiz). ` : "";
    const extSummary = !ext.length ? "" : voted + (verdict === "ai" ? "They agree it reads as AI-written. Rewrite the highlighted sentences in your own words." : verdict === "human" ? "They agree it reads as human-written." : "They don't agree, so we can't say for sure. Treat this as a guide and revise any highlighted sentence that doesn't sound like you.");
    const summary = rewritten && rewritten.share >= 30 ? `About ${rewritten.share}% of this text matches output from EssayWiz's ${rewritten.tool === "humanizer" ? "Humanizer" : "Paraphraser"}, so it reads as machine-rewritten. Rewrite those sentences in your own words.` : extSummary || (score < 30 ? "" : String(r.summary || "")) || (score >= 60 ? "Our detector found many AI-like sentences. Rewrite the highlighted ones in your own voice with specific details." : score >= 30 ? "Some sentences read as AI-like to our detector, but much of it reads human. Revise the highlighted sentences with your own examples." : "Most of this reads like human writing to our detector.");
    await collect(req, body, sentences.map(s => s.text).join(" "), { tool: "ai", modelScore: score });
    res.status(200).json({
      score, verdict, summary, sentences: sentencesOut, shortText, words: st.words, rewritten,
      detectors: ext.map(d => ({ name: d.name, score: Math.round(d.score * 100) })), engine: own ? (onlyOwn ? "own" : "own+claude") : "claude",
      signals: [
        { label: `Sentence variety ${st.cv >= 0.45 ? "high" : st.cv >= 0.3 ? "medium" : "low"}`, level: st.cv >= 0.45 ? "good" : st.cv >= 0.3 ? "warn" : "bad" },
        { label: `${st.phraseHits} stock AI phrase${st.phraseHits === 1 ? "" : "s"}`, level: st.phraseRate < 0.4 ? "good" : st.phraseRate < 1 ? "warn" : "bad" },
      ],
    });
  } catch (e) { fail(res, e); }
}

export default tracked("analyze", handler);
