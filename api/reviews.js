// Student reviews.
// GET                                  -> public: reviews the owner approved (stars, comment, tool, date; never who wrote them)
// POST { action: "approve" | "hide", id } -> owner only: show or hide one review on the website
import { guard, fail } from "./_lib.js";
import { isOwner } from "./_billing.js";
import { dbEnabled, select, update } from "./_db.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("cache-control", "public, max-age=120, s-maxage=120");
    if (!dbEnabled()) return res.status(200).json({ reviews: [] });
    const [rows, all] = await Promise.all([
      select("feedback", "select=id,created_at,tool,score,comment&kind=eq.review_approved&order=created_at.desc&limit=24"),
      select("feedback", "select=score&kind=in.(review,review_approved)&limit=10000"),   // the average covers every review, not just the ones shown
    ]);
    const average = all.length ? Math.round(all.reduce((n, r) => n + (Number(r.score) || 0), 0) / all.length * 10) / 10 : 0;
    return res.status(200).json({ count: all.length, average, reviews: rows.map(r => ({ id: r.id, at: r.created_at, tool: r.tool, stars: Number(r.score) || 0, comment: r.comment || "" })) });
  }
  const body = await guard(req, res, { cost: 0 }); if (!body) return;
  if (!isOwner(req.srUser)) return res.status(403).json({ code: "owner_only" });
  try {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0 || !["approve", "hide"].includes(body.action)) return res.status(400).json({ code: "bad_request" });
    const ok = await update("feedback", `id=eq.${id}&kind=in.(review,review_approved)`, { kind: body.action === "approve" ? "review_approved" : "review" });
    return res.status(ok ? 200 : 500).json(ok ? { ok: true } : { code: "upstream_error" });
  } catch (e) { return fail(res, e); }
}
