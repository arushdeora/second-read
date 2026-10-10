import { guard } from "./_lib.js";
import { dbEnabled, insert, update, remove, collect, userHash } from "./_db.js";

// POST { action: "delete_mine" } removes everything this account contributed.
// POST { tool, rating: "up"|"down", kind?, comment?, score?, text?, contribute? }
// Saves feedback. When the student agreed to share their text, it is saved as a training
// sample too. "wrong_ai" (= "I wrote this myself") labels the text as human.
const KINDS = new Set(["wrong_ai", "correct_ai", "good", "bad", "review"]);   // "review": site review, score = 1-5 stars
const TOOLS = new Set(["check", "para", "grammar", "plag", "ai", "human", "cite"]);

export default async function handler(req, res) {
  const body = await guard(req, res, { cost: 0 }); if (!body) return;
  if (!dbEnabled()) return res.status(200).json({ saved: false });
  if (body.action === "delete_mine") {
    // Remove every text and piece of feedback this Google account contributed.
    const uh = userHash(req.srUser);
    const ok = uh && await remove("feedback", "user_hash=eq." + uh) && await remove("samples", "user_hash=eq." + uh);
    return res.status(ok ? 200 : 500).json(ok ? { deleted: true } : { code: "upstream_error" });
  }
  const tool = TOOLS.has(body.tool) ? body.tool : "other";
  const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
  const kind = KINDS.has(body.kind) ? body.kind : null;
  let sampleId = null;
  if (body.contribute === true && body.text) {
    const label = kind === "wrong_ai" ? "human" : null;
    sampleId = await collect(req, body, body.text, { tool, label, modelScore: Number.isFinite(+body.score) ? Math.round(+body.score) : null });
    if (sampleId && label) await update("samples", "id=eq." + sampleId, { label });
  }
  await insert("feedback", {
    tool, rating, kind, comment: body.comment ? String(body.comment).slice(0, 1000) : null,
    score: Number.isFinite(+body.score) ? (kind === "review" ? Math.min(5, Math.max(1, Math.round(+body.score))) : Math.round(+body.score)) : null, user_hash: userHash(req.srUser), sample_id: sampleId,
  });
  res.status(200).json({ saved: true });
}
