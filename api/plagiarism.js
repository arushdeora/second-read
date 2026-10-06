import { guard, cleanSentences, tooLong, extractJson, fail } from "./_lib.js";
import { dbEnabled, select, insert, update, sha, norm, wordCount } from "./_db.js";

// Our own plagiarism index: every source found is saved (as a one-way hash of the sentence,
// plus the sentence itself only if the student agreed), so repeat passages are found instantly.
const keyOf = t => sha(norm(t));
async function lookupIndex(sentences) {
  if (!dbEnabled()) return [];
  const cands = sentences.filter(s => wordCount(s.text) >= 8);
  if (!cands.length) return [];
  const byHash = new Map(cands.map(s => [keyOf(s.text), s.i]));
  const rows = await select("sources", "select=id,passage_hash,url,title,type,hits&passage_hash=in.(" + [...byHash.keys()].join(",") + ")&limit=50");
  return rows.map(r => ({ i: byHash.get(r.passage_hash), match: "exact", type: r.type === "book" ? "book" : "web", url: r.url, title: r.title || r.url, note: "Found in Second Read's source index", _id: r.id, _hits: r.hits }));
}
async function saveIndex(sentences, matches, contribute) {
  if (!dbEnabled() || !matches.length) return;
  const textOf = new Map(sentences.map(s => [s.i, s.text]));
  const rows = matches.filter(m => m.match === "exact" && textOf.has(m.i)).map(m => ({
    passage_hash: keyOf(textOf.get(m.i)), passage: contribute ? textOf.get(m.i) : null, url: m.url, title: m.title, type: m.type,
  }));
  await insert("sources", rows, { onConflict: "passage_hash,url" });
}

// Searching the web takes a while; give the function time to finish.
export const config = { maxDuration: 60 };

const MODEL = process.env.PLAGIARISM_MODEL || process.env.MODEL || "claude-haiku-4-5-20251001";
const MAX_SEARCHES = Number(process.env.PLAGIARISM_MAX_SEARCHES || 10);

function apiKey() {
  return String(process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
}

export default async function handler(req, res) {
  const body = await guard(req, res, { cost: 2 }); if (!body) return;
  const sentences = cleanSentences(body.sentences);
  if (!sentences.length) return res.status(400).json({ code: "empty" });
  if (tooLong(sentences)) return res.status(413).json({ code: "too_long" });

  const indexed = await lookupIndex(sentences);
  for (const m of indexed) if (m._id) update("sources", "id=eq." + m._id, { hits: (m._hits || 1) + 1 });
  const numbered = sentences.map(s => `[${s.i}] ${s.text}`).join("\n");
  const prompt = `You are a plagiarism checker for a university student's assignment. Your job is to find sentences that were copied (word for word, or nearly) from published books or from websites.

Steps:
1. Pick the 5 most distinctive sentences or long phrases (specific wording, at least 8 words). Skip direct quotations that are already in quote marks with a citation, and skip very generic sentences.
2. Search for each one using the exact phrase in double quotes. This checks websites.
3. For phrases that sound like they could come from a book (literary, academic or textbook style), also search book sources, for example by adding: site:books.google.com OR site:gutenberg.org OR site:archive.org OR site:goodreads.com. You have ${MAX_SEARCHES} searches in total.
4. Only report a match when a result clearly contains the same or nearly the same wording. Do not report sources that are only about the same topic.
5. Mark each match as "book" if the source is a book (a Google Books page, Project Gutenberg, Internet Archive, a quotes page naming a book, or a publisher page), otherwise "web".

Text, split into numbered sentences:
${numbered}

When you are done searching, reply with ONLY a JSON object of this shape:
{"checked": <number of sentences you searched>,
 "matches": [{"i": <sentence number>, "match": "exact" | "close", "type": "book" | "web", "url": "<source url>", "title": "<book title and author, or page title>", "note": "<under 15 words: what matched>"}],
 "originality": <0-100, your estimate of how much of the text is original>,
 "summary": "<1-2 plain sentences for the student>"}
If nothing matched, return an empty matches array.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) return res.status(429).json({ code: "rate_limited" });
    if (!r.ok) {
      console.error("Anthropic API error (plagiarism)", r.status, data);
      const msg = JSON.stringify(data);
      if (r.status === 400 && /web.?search/i.test(msg)) return res.status(503).json({ code: "search_disabled" });
      return res.status(502).json({ code: "upstream_error" });
    }
    const blocks = Array.isArray(data.content) ? data.content : [];
    const searched = blocks.filter(b => b.type === "server_tool_use").map(b => b.input && b.input.query).filter(Boolean);
    const lastTool = blocks.map(b => b.type).lastIndexOf("web_search_tool_result");
    const finalText = blocks.slice(lastTool + 1).filter(b => b.type === "text").map(b => b.text).join("");
    const json = extractJson(finalText) || extractJson(blocks.filter(b => b.type === "text").map(b => b.text).join(""));
    if (!json || typeof json !== "object") return res.status(502).json({ code: "invalid_json" });
    const known = new Set(sentences.map(s => s.i));
    const matches = (Array.isArray(json.matches) ? json.matches : [])
      .filter(m => m && known.has(Number(m.i)) && /^https?:\/\//.test(String(m.url || "")))
      .slice(0, 20)
      .map(m => ({ i: Number(m.i), match: m.match === "exact" ? "exact" : "close", type: m.type === "book" || /books\.google|gutenberg\.org|archive\.org\/details|goodreads\.com/.test(String(m.url)) ? "book" : "web", url: String(m.url), title: String(m.title || m.url).slice(0, 160), note: String(m.note || "").slice(0, 160) }));
    await saveIndex(sentences, matches, body.contribute === true);
    // Add matches from our own index that the web search didn't repeat.
    const seen = new Set(matches.map(m => m.i + " " + m.url));
    for (const m of indexed) if (m.i != null && !seen.has(m.i + " " + m.url)) { const { _id, _hits, ...clean } = m; matches.push(clean); }
    res.status(200).json({
      checked: Number(json.checked) || searched.length,
      searches: searched.length,
      matches,
      originality: Math.max(0, Math.min(100, Number(json.originality) || (matches.length ? 70 : 100))),
      summary: String(json.summary || ""),
    });
  } catch (e) { fail(res, e); }
}
