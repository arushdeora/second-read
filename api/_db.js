// Second Read's own database (Supabase / Postgres, via its REST API).
// Inactive until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) are set in Vercel.
import { createHash } from "node:crypto";

const env = k => String(process.env[k] || "").trim().replace(/^["']|["']$/g, "").trim();
const base = () => env("SUPABASE_URL").replace(/\/+$/, "");
const key = () => env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SECRET_KEY");
export const dbEnabled = () => !!(base() && key());

export const sha = s => createHash("sha256").update(String(s)).digest("hex");
export const norm = s => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export const userHash = user => user && user.sub ? sha("second-read:" + user.sub).slice(0, 32) : null;
export const wordCount = t => (String(t).match(/[A-Za-z0-9'-]+/g) || []).length;

function headers(extra = {}) {
  const h = { apikey: key(), "content-type": "application/json", ...extra };
  if (key().startsWith("eyJ")) h.authorization = "Bearer " + key();   // older JWT-style keys
  return h;
}

// Insert rows. ignoreDuplicates skips rows that clash with a unique column.
export async function insert(table, rows, { onConflict, ignoreDuplicates = true, returning = false } = {}) {
  if (!dbEnabled()) return null;
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return [];
  const q = onConflict ? "?on_conflict=" + encodeURIComponent(onConflict) : "";
  const prefer = [ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates", returning ? "return=representation" : "return=minimal"];
  try {
    const r = await fetch(`${base()}/rest/v1/${table}${q}`, { method: "POST", headers: headers({ prefer: prefer.join(",") }), body: JSON.stringify(list) });
    if (!r.ok) { console.error("db insert failed", table, r.status, await r.text().catch(() => "")); return null; }
    return returning ? await r.json().catch(() => []) : [];
  } catch (e) { console.error("db insert error", table, e && e.message); return null; }
}

// Select with a PostgREST query string, e.g. "select=url,title&passage_hash=in.(a,b)".
export async function select(table, query) {
  if (!dbEnabled()) return [];
  try {
    const r = await fetch(`${base()}/rest/v1/${table}?${query}`, { headers: headers() });
    if (!r.ok) { console.error("db select failed", table, r.status, await r.text().catch(() => "")); return []; }
    return await r.json().catch(() => []);
  } catch (e) { console.error("db select error", table, e && e.message); return []; }
}

// Save a student's text for training, only when they ticked "help improve Second Read".
export async function collect(req, body, text, { tool, label = null, origin = "student", modelScore = null } = {}) {
  if (!dbEnabled() || !body || body.contribute !== true) return null;
  const t = String(text || "").trim();
  if (wordCount(t) < 25 || t.length > 40000) return null;
  const row = { text: t, label, origin, tool, model_score: modelScore, user_hash: userHash(req.srUser), text_hash: sha(norm(t)), words: wordCount(t) };
  const out = await insert("samples", row, { onConflict: "text_hash", returning: true });
  if (out && out[0]) return out[0].id;
  const found = await select("samples", "select=id&text_hash=eq." + row.text_hash);
  return found[0] ? found[0].id : null;
}

export async function update(table, query, patch) {
  if (!dbEnabled()) return false;
  try {
    const r = await fetch(`${base()}/rest/v1/${table}?${query}`, { method: "PATCH", headers: headers({ prefer: "return=minimal" }), body: JSON.stringify(patch) });
    if (!r.ok) console.error("db update failed", table, r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("db update error", table, e && e.message); return false; }
}

export async function remove(table, query) {
  if (!dbEnabled()) return false;
  try {
    const r = await fetch(`${base()}/rest/v1/${table}?${query}`, { method: "DELETE", headers: headers({ prefer: "return=minimal" }) });
    if (!r.ok) console.error("db delete failed", table, r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("db delete error", table, e && e.message); return false; }
}
