import { guard, askClaude, askClaudeText, rewriteKeepLength, fail } from "./_lib.js";
import { collect } from "./_db.js";

// Writing assistant: grammar & clarity review, rewrite modes, and citations.
export const config = { maxDuration: 60 };

const MAX = 20000;
const STYLES = {
  standard: "reworded in fresh, natural language with different sentence structure and vocabulary, keeping the same meaning and roughly the same length",
  creative: "reworded more freely and creatively, with vivid but clear wording and new sentence structures, keeping the same meaning",
  formal: "more formal and professional, suitable for a university assignment",
  simpler: "simpler and easier to read, using plain everyday words and shorter sentences",
  shorter: "noticeably shorter and more concise (about 30-40% fewer words) while keeping every key point",
  longer: "a bit longer and more developed, expanding ideas that are already there without inventing new facts, sources or statistics",
  academic: "more academic: precise vocabulary, objective tone, clear topic sentences, no slang or contractions",
  confident: "more confident and direct, removing unnecessary hedging like 'I think', 'maybe', 'kind of'",
  friendly: "warmer and more friendly, while staying clear and polite",
  fluent: "more fluent and natural, fixing awkward phrasing and grammar while keeping the writer's voice",
};

export default async function handler(req, res) {
  const body = await guard(req, res); if (!body) return;
  const mode = String(body.mode || "");
  try {
    if (mode === "review") return await review(body, res);
    if (mode === "rewrite") return await rewrite(body, res, req);
    if (mode === "cite") return await cite(body, res);
    if (mode === "original") return await original(body, res, req);
    return res.status(400).json({ code: "bad_mode" });
  } catch (e) { fail(res, e); }
}

async function review(body, res) {
  const text = String(body.text || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return res.status(400).json({ code: "empty" });
  if (text.length > MAX) return res.status(413).json({ code: "too_long" });
  const prompt = `You are a careful writing assistant for university students, like a grammar checker. Review the text below.

Find real problems only, in these categories:
- "spelling": misspelled words
- "grammar": agreement, tense, articles, wrong word forms, run-ons, fragments
- "punctuation": commas, apostrophes, capitals, missing periods
- "clarity": confusing or awkward sentences that would be clearer reworded
- "wordiness": phrases that can be said in fewer words
- "word choice": vague, repetitive or informal words in an academic text

Rules:
- "original" MUST be copied EXACTLY from the text (same spelling, spacing and punctuation), short (ideally under 12 words, the smallest span that contains the problem) and must appear in the text.
- "suggestion" is the replacement for exactly that span.
- Do not change meaning, quotations, citations or names. Do not report style preferences that are not clearly better.
- At most 40 issues, in the order they appear.

Also judge the overall writing:
- "tone": 1 to 3 words from: formal, informal, academic, confident, friendly, neutral, persuasive, optimistic, critical, uncertain, casual, respectful
- "clarity": 0-100 how clear and easy to follow it is
- "correctness": 0-100 how free of grammar/spelling errors it is
- "summary": one or two plain sentences of advice for the student

TEXT:
"""
${text}
"""

Reply with ONLY JSON:
{"issues":[{"type":"spelling|grammar|punctuation|clarity|wordiness|word choice","original":"...","suggestion":"...","explanation":"under 14 words"}],"tone":["..."],"clarity":0,"correctness":0,"summary":"..."}`;
  const r = await askClaude(prompt, Math.min(8000, 1200 + Math.ceil(text.length / 4)));
  const issues = (Array.isArray(r.issues) ? r.issues : [])
    .filter(x => x && typeof x.original === "string" && x.original && text.includes(x.original) && typeof x.suggestion === "string" && x.suggestion !== x.original)
    .slice(0, 40)
    .map(x => ({ type: String(x.type || "grammar").toLowerCase(), original: x.original, suggestion: x.suggestion, explanation: String(x.explanation || "").slice(0, 160) }));
  const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  res.status(200).json({
    issues,
    tone: (Array.isArray(r.tone) ? r.tone : [r.tone]).filter(Boolean).map(String).slice(0, 3),
    clarity: clamp(r.clarity), correctness: clamp(r.correctness),
    summary: String(r.summary || "").slice(0, 400),
  });
}

async function rewrite(body, res, req) {
  const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
  const style = String(body.style || "");
  if (!text) return res.status(400).json({ code: "empty" });
  if (text.length > MAX) return res.status(413).json({ code: "too_long" });
  if (!STYLES[style]) return res.status(400).json({ code: "bad_mode" });
  const prompt = `Rewrite the text below so it is ${STYLES[style]}.
Rules:
- Keep the same meaning and paragraph breaks.
- Keep quotations, citations, names, numbers and dates exactly as written.
- Do not invent facts, statistics or sources.
Reply with ONLY the rewritten text, no title or notes.

TEXT:
"""
${text}
"""`;
  // Shorten/Expand change length on purpose; every other mode keeps the original length.
  const range = style === "shorter" ? { min: 0.55, max: 0.8 } : style === "longer" ? { min: 1.2, max: 1.6 } : style === "simpler" ? { min: 0.85, max: 1.1 } : { min: 0.92, max: 1.12 };
  const out = await rewriteKeepLength(prompt, text, { ...range, maxTokens: Math.min(16000, Math.ceil(text.length / (style === "longer" ? 1.4 : 2)) + 1200) });
  if (!out.text) return res.status(502).json({ code: "upstream_error" });
  await collect(req, body, out.text, { tool: "para", label: "ai", origin: "generated" });
  res.status(200).json({ text: out.text, cut: out.cut, words: out.words, originalWords: out.originalWords });
}

// Rewrite the whole text so passages that match published sources are put into the
// student's own words (and grammar is fixed), with a reminder to cite the idea.
async function original(body, res, req) {
  const text = String(body.text || "").replace(/\r\n/g, "\n").trim();
  if (!text) return res.status(400).json({ code: "empty" });
  if (text.length > MAX) return res.status(413).json({ code: "too_long" });
  const flagged = (Array.isArray(body.flagged) ? body.flagged : []).slice(0, 60)
    .map(f => ({ text: String(f.text || "").slice(0, 1000), source: String(f.source || "").slice(0, 200) })).filter(f => f.text);
  const aiFlagged = (Array.isArray(body.aiFlagged) ? body.aiFlagged : []).slice(0, 80).map(t => String(t || "").slice(0, 1000)).filter(Boolean);
  const prompt = `A university student wants their assignment to be written in their own words. Rewrite the WHOLE text below.

${flagged.length ? `These sentences closely match published sources and must be completely re-expressed in fresh wording: change the sentence structure and the vocabulary, not just a few words, while keeping the same meaning. Put a citation reminder in square brackets at the END of each reworded sentence, after its last word and before the full stop, naming the source, like "...wants to get married [cite: ${flagged[0].source || "source"}].", because the idea still came from that source. Never put the reminder before the sentence, and ONLY these flagged sentences get a [cite: ...] reminder; no other sentence in the text may have one.
FLAGGED SENTENCES:
${flagged.map((f, i) => `${i + 1}. "${f.text}"${f.source ? ` (source: ${f.source})` : ""}`).join("\n")}

` : ""}${aiFlagged.length ? `These sentences read as AI-generated. Rewrite them so they sound like a capable university student wrote them: natural, confident university-level English: keep precise academic vocabulary, subject terms and the same level of sophistication as the original (do NOT simplify, dumb down, or make it sound childish or overly casual), varied sentence length (mix short and longer sentences), a direct personal point of view where it fits, no stock transitions (moreover, furthermore, additionally, in conclusion, it is important to note) and no buzzwords (delve, pivotal, crucial, multifaceted, landscape, tapestry, foster, leverage, navigate, realm, showcase, seamless). Keep the meaning. Where a concrete detail from the student would make it stronger, add a short placeholder like [add your own example] instead of inventing one. Do NOT add any [cite: ...] reminder to these sentences.
AI-SOUNDING SENTENCES:
${aiFlagged.map((t, i) => `${i + 1}. "${t}"`).join("\n")}

` : ""}For all the other sentences: keep them close to the original, but fix any spelling, grammar and punctuation mistakes and make clumsy wording read naturally.

Rules:
- Keep the same meaning, argument, order, length and paragraph breaks. Replace and restructure words; never delete sentences or details.
- Keep direct quotations that are in quotation marks, and keep existing citations, names, numbers and dates exactly.
- Do not invent facts, statistics or sources.
- Write like a capable university student: clear, varied sentences in natural academic English. Never simplify the vocabulary or make it sound basic.
Reply with ONLY the rewritten text, no title or notes.

TEXT:
"""
${text}
"""`;
  // Citation reminders add a few words, so allow a little extra.
  const out = await rewriteKeepLength(prompt, text, { min: 0.93, max: 1.15 });
  if (!out.text) return res.status(502).json({ code: "upstream_error" });
  await collect(req, body, out.text, { tool: "para", label: "ai", origin: "generated" });
  res.status(200).json({ text: out.text, cut: out.cut, words: out.words, originalWords: out.originalWords });
}

// ---------- Citations ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json", "user-agent": "SecondRead/1.0 (citation helper)" } });
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, "i");
    const m = html.match(re); if (m) return (m[1] || m[2]).trim();
  }
  return "";
}
async function lookup(q) {
  const s = q.trim();
  const doi = s.match(/10\.\d{4,9}\/[^\s]+/);
  if (doi) {
    const j = await getJson("https://api.crossref.org/works/" + encodeURIComponent(doi[0]));
    const w = j.message || {};
    return { kind: "article", title: (w.title || [])[0], authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ")), year: ((w.issued || {})["date-parts"] || [[]])[0][0], journal: (w["container-title"] || [])[0], volume: w.volume, issue: w.issue, pages: w.page, publisher: w.publisher, doi: w.DOI, url: w.URL };
  }
  const isbn = s.replace(/[-\s]/g, "").match(/^(97[89])?\d{9}[\dXx]$/);
  if (isbn) {
    const j = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn[0]}&format=json&jscmd=data`);
    const b = j["ISBN:" + isbn[0]];
    if (b) return { kind: "book", title: b.title + (b.subtitle ? ": " + b.subtitle : ""), authors: (b.authors || []).map(a => a.name), year: String(b.publish_date || "").match(/\d{4}/)?.[0], publisher: (b.publishers || [])[0]?.name, place: (b.publish_places || [])[0]?.name, isbn: isbn[0] };
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { headers: { "user-agent": "Mozilla/5.0 (compatible; SecondRead citation helper)" }, redirect: "follow" });
    const html = (await r.text()).slice(0, 400000);
    const title = meta(html, ["citation_title", "og:title", "twitter:title"]) || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "";
    const authors = [...html.matchAll(/<meta[^>]+name=["']citation_author["'][^>]*content=["']([^"']+)["']/gi)].map(m => m[1]);
    const author = authors.length ? authors : [meta(html, ["author", "article:author", "parsely-author"])].filter(Boolean);
    const date = meta(html, ["citation_publication_date", "article:published_time", "date", "pubdate", "og:updated_time"]);
    const site = meta(html, ["og:site_name", "application-name"]) || new URL(s).hostname.replace(/^www\./, "");
    return { kind: "webpage", title: title.replace(/\s+/g, " ").trim(), authors: author, date, site, url: s };
  }
  // Treat as a book title (optionally "title by author").
  const j = await getJson("https://openlibrary.org/search.json?limit=1&fields=title,subtitle,author_name,first_publish_year,publisher,isbn&q=" + encodeURIComponent(s));
  const d = (j.docs || [])[0];
  if (d) return { kind: "book", title: d.title + (d.subtitle ? ": " + d.subtitle : ""), authors: (d.author_name || []).slice(0, 6), year: d.first_publish_year, publisher: (d.publisher || [])[0] };
  return null;
}

async function cite(body, res) {
  const q = String(body.query || "").trim().slice(0, 500);
  if (!q) return res.status(400).json({ code: "empty" });
  let source = null;
  try { source = await lookup(q); } catch (e) { console.error("citation lookup failed", e && e.message); }
  if (!source || !source.title) return res.status(404).json({ code: "not_found" });
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Format a reference for this source in APA 7th edition, MLA 9th edition and Chicago 17th (notes-bibliography, bibliography entry).
Use ONLY the details given. If the date is missing use "n.d." (APA) or leave it out (MLA/Chicago). If the author is missing, start with the title as each style requires. For web pages include the URL; MLA and Chicago may add the access date ${today}.
Use *asterisks* around text that should be italic (titles of books, journals, websites).

SOURCE DETAILS (JSON):
${JSON.stringify(source)}

Reply with ONLY JSON: {"apa":"...","mla":"...","chicago":"...","intext":{"apa":"(Author, Year)","mla":"(Author page)"}}`;
  const r = await askClaude(prompt, 900);
  res.status(200).json({ source, apa: String(r.apa || ""), mla: String(r.mla || ""), chicago: String(r.chicago || ""), intext: r.intext || {} });
}
