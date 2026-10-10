// Owner-only numbers for the /stats page: users, usage, Claude cost, PayPal revenue and profit.
// POST { days: 30 } with the owner's Google sign-in. Everyone else gets 403.
import { guard, fail } from "./_lib.js";
import { isOwner, subscriptionReport, billingEnabled } from "./_billing.js";
import { dbEnabled } from "./_db.js";
import { selectAll } from "./_stats.js";

export const config = { maxDuration: 60 };
const env = k => String(process.env[k] || "").trim();
const round = (x, n = 2) => Number((x || 0).toFixed(n));

export default async function handler(req, res) {
  const body = await guard(req, res, { cost: 0 }); if (!body) return;
  if (!isOwner(req.srUser)) return res.status(403).json({ code: "owner_only" });
  if (!dbEnabled()) return res.status(200).json({ code: "no_database" });
  try {
    const days = Math.max(1, Math.min(365, Number(body.days) || 30));
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - (days - 1));
    const sinceISO = start.toISOString();
    const dayList = Array.from({ length: days }, (_, i) => new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10));

    const [events, active, subs, reviews] = await Promise.all([
      selectAll("events", `select=created_at,tool,mode,status,user_hash,plan,words,cost_usd,searches&created_at=gte.${encodeURIComponent(sinceISO)}&order=created_at.asc`),
      selectAll("active_days", "select=user_hash,day,plan&order=day.asc"),
      selectAll("subscriptions", "select=id,user_hash,created_at&order=created_at.desc", 500),
      selectAll("feedback", "select=id,created_at,tool,score,comment,kind&kind=in.(review,review_approved)&order=created_at.desc", 2000),
    ]);

    // Users: everyone except the owner. "New" = first day we ever saw them.
    const firstSeen = new Map();
    for (const a of active) if (a.plan !== "owner" && !firstSeen.has(a.user_hash)) firstSeen.set(a.user_hash, a.day);
    const daily = Object.fromEntries(dayList.map(d => [d, { day: d, users: new Set(), newUsers: 0, checks: 0, cost: 0, revenue: 0 }]));
    for (const a of active) if (a.plan !== "owner" && daily[a.day]) daily[a.day].users.add(a.user_hash);
    for (const [, d] of firstSeen) if (daily[d]) daily[d].newUsers++;

    // Usage and Claude cost (the owner's own checks cost real money too, so they count toward cost).
    const tools = {};
    let checks = 0, failed = 0, words = 0, aiCost = 0, ownerCost = 0, limitHits = 0, proSignups = 0, searches = 0;
    for (const e of events) {
      const d = daily[String(e.created_at).slice(0, 10)];
      const cost = Number(e.cost_usd) || 0;
      aiCost += cost; if (e.plan === "owner") ownerCost += cost;
      if (d) d.cost += cost;
      if (e.tool === "billing") { if (e.mode === "pro_signup") proSignups++; continue; }
      if (e.status === 402) { limitHits++; continue; }
      if (e.status >= 400) { failed++; continue; }
      checks++; words += Number(e.words) || 0; searches += Number(e.searches) || 0;
      if (d) d.checks++;
      const label = e.tool === "write" ? (e.mode || "write") : e.tool === "humanize" ? "humanize" : e.tool;
      const t = tools[label] = tools[label] || { tool: label, checks: 0, words: 0, cost: 0 };
      t.checks++; t.words += Number(e.words) || 0; t.cost += cost;
    }

    // Revenue: actual PayPal payments for every subscription we've seen.
    let gross = 0, fees = 0, net = 0, proActive = 0; const currencies = new Set();
    if (billingEnabled()) {
      const reports = await Promise.all(subs.slice(0, 100).map(s => subscriptionReport(s.id, sinceISO).catch(() => null)));
      for (const r of reports.filter(Boolean)) {
        if (r.status === "ACTIVE") proActive++;
        for (const p of r.payments) {
          gross += p.gross; fees += p.fee; net += p.net; currencies.add(p.currency);
          const d = daily[String(p.time).slice(0, 10)]; if (d) d.revenue += p.net;
        }
      }
    }

    const fixedMonthly = Number(env("FIXED_MONTHLY_COSTS_USD")) || 0;
    const fixed = fixedMonthly * days / 30;
    const allUsers = new Set(); for (const d of Object.values(daily)) for (const u of d.users) allUsers.add(u);
    const today = daily[dayList[dayList.length - 1]];

    return res.status(200).json({
      days, since: sinceISO, generatedAt: now.toISOString(),
      summary: {
        users: allUsers.size, newUsers: Object.values(daily).reduce((n, d) => n + d.newUsers, 0),
        activeToday: today ? today.users.size : 0, totalUsers: firstSeen.size,
        checks, failed, limitHits, words, searches,
        proActive, proSignups, subscriptionsKnown: subs.length,
        gross: round(gross), fees: round(fees), net: round(net), currency: [...currencies].join("/") || "USD",
        aiCost: round(aiCost, 4), ownerAiCost: round(ownerCost, 4), costPerCheck: checks ? round(aiCost / checks, 4) : 0,
        fixedMonthly, fixed: round(fixed), profit: round(net - aiCost - fixed),
      },
      daily: dayList.map(d => ({ day: d, users: daily[d].users.size, newUsers: daily[d].newUsers, checks: daily[d].checks, cost: round(daily[d].cost, 4), revenue: round(daily[d].revenue) })),
      tools: Object.values(tools).map(t => ({ ...t, cost: round(t.cost, 4), avgCost: round(t.cost / t.checks, 4) })).sort((a, b) => b.checks - a.checks),
      billing: billingEnabled(),
      reviews: {
        count: reviews.length,
        average: reviews.length ? round(reviews.reduce((n, r) => n + (Number(r.score) || 0), 0) / reviews.length, 1) : 0,
        stars: [5, 4, 3, 2, 1].map(k => ({ stars: k, count: reviews.filter(r => Number(r.score) === k).length })),
        approved: reviews.filter(r => r.kind === "review_approved").length,
        latest: reviews.slice(0, 50).map(r => ({ id: r.id, at: r.created_at, tool: r.tool, stars: Number(r.score) || 0, comment: r.comment || "", approved: r.kind === "review_approved" })),
      },
    });
  } catch (e) { return fail(res, e); }
}
