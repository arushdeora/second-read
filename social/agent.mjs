// EssayWiz Instagram agent. Runs once a day from GitHub Actions (.github/workflows/instagram.yml).
//   Every day:        one AI-generated Reel (video made by an AI video model on Replicate, caption by Claude).
//   Mon, Wed, Fri:    one carousel post (study or writing tips, slides rendered from social/slide.html).
//   Site changed:     a "New on EssayWiz" carousel instead, written from the commits on main since the last run.
// Fully automatic, with guardrails: captions are checked against social/facts.md rules before anything is posted,
// and setting the repository variable SOCIAL_PAUSED=true stops all posting.
// State (what was posted, last commit seen) lives on the "social-log" branch, which Vercel never deploys.
//
// Settings (GitHub Actions secrets / variables):
//   ANTHROPIC_API_KEY  Claude, writes captions, video prompts and slides          (secret, required)
//   REPLICATE_API_TOKEN  AI video generation                                     (secret, required for Reels)
//   IG_ACCESS_TOKEN    Instagram API with Instagram Login, long-lived token       (secret, required)
//   IG_USER_ID         Instagram account ID (default "me")                        (variable)
//   VIDEO_MODEL        Replicate model, default google/veo-3-fast                 (variable)
//   VIDEO_INPUT        extra JSON input for the model, e.g. {"duration":8}        (variable)
//   CLAUDE_MODEL       default claude-haiku-5-5                                   (variable)
//   DRY_RUN=true       plan and render everything, post nothing
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const env = k => String(process.env[k] || "").trim();
const DRY = env("DRY_RUN") === "true";
const STATE = path.resolve(env("STATE_DIR") || path.join(repoRoot, "state"));
const IG = `https://graph.instagram.com${env("IG_API_VERSION") ? "/" + env("IG_API_VERSION") : ""}`;
const IG_USER = env("IG_USER_ID") || "me";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The day in India (the audience's day), so "Monday" means Monday in IST.
const ist = new Date(Date.now() + 5.5 * 3600e3);
const DAY = ist.toISOString().slice(0, 10), DOW = ist.getUTCDay();
const POST_DAY = [1, 3, 5].includes(DOW);

/* ---------------- state (social-log branch) ---------------- */
const statePath = path.join(STATE, "log.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { posts: [], lastCommit: null };
const saveState = () => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state, null, 1)); };
const git = (args, cwd = STATE) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function pushState(message) {
  if (DRY || !fs.existsSync(path.join(STATE, ".git"))) return;
  git(["add", "-A"]);
  if (!git(["status", "--porcelain"])) return;
  git(["commit", "-m", message]);
  git(["push", "origin", "HEAD:social-log"]);
}
const already = type => state.posts.some(p => p.date === DAY && p.type === type && p.status === "published");

/* ---------------- Claude ---------------- */
const FACTS = fs.readFileSync(path.join(here, "facts.md"), "utf8");
async function claude(prompt, maxTokens = 2000) {
  if (!env("ANTHROPIC_API_KEY")) throw new Error("ANTHROPIC_API_KEY is not set");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env("CLAUDE_MODEL") || "claude-haiku-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${JSON.stringify(d.error || d).slice(0, 300)}`);
  const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("Claude did not return JSON");
  return JSON.parse(text.slice(a, b + 1));
}

/* ---------------- guardrails ---------------- */
const BANNED = /\b(undetectable|bypass\w*|beat(s|ing)? (turnitin|gptzero|ai detectors?|detectors?)|fool(s|ing)? |trick(s|ing)? (turnitin|detectors?)|100\s?%|guarantee\w*|never get caught|pass (turnitin|any (ai )?detector))\b/i;
const MONEY = /(?:[$₹€£]\s?\d|\d\s?(?:usd|inr|rs\.?|rupees|dollars)\b)/i;
export function checkText(label, text, { max = 2200 } = {}) {
  const t = String(text || "");
  const problems = [];
  if (!t.trim()) problems.push("empty");
  if (t.length > max) problems.push(`too long (${t.length} > ${max})`);
  const banned = t.match(BANNED); if (banned) problems.push(`banned claim "${banned[0]}"`);
  const money = t.match(MONEY); if (money) problems.push(`mentions a price "${money[0]}" (prices differ by country)`);
  if ((t.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) problems.push("more than 30 hashtags");
  return problems.map(p => `${label}: ${p}`);
}
const recentCaptions = n => state.posts.slice(-n).map(p => `- [${p.date} ${p.type}] ${String(p.caption || "").split("\n")[0].slice(0, 120)}`).join("\n") || "(none yet)";

// DRY_RUN without a Claude key (local testing): fixed sample plans, still passed through the same checks.
const SAMPLE = {
  reel: { topic: "sample", video_prompt: "Cinematic vertical shot of a university student at a desk late at night, warm lamp light, laptop and highlighted notes, she reads her finished essay, exhales and smiles with relief; shallow depth of field, slow push-in, no on-screen text.",
    caption: "Deadline tonight? Check the whole essay before you hit submit.\nPlagiarism, AI-writing and grammar in one check.\nFix what's flagged, keep your own voice.\nTry it free at essaywiz.app (link in bio).\n\nVideo made with AI.\n#essaywriting #studytips #university #plagiarismchecker #grammar" },
  carousel: { kind: "tips", caption: "Run through this before every submission.\nSave it for your next essay.\n#essaytips #studytips #academicwriting #university #studentlife",
    slides: [{ kicker: "Checklist", title: "10 minutes before you submit", body: "A quick routine that catches the mistakes markers notice first." },
      { kicker: "Step 1", title: "Check every source is cited", body: "Every quote and every borrowed idea needs a citation.\nNo exceptions." },
      { kicker: "Step 2", title: "Read it out loud", body: "Stiff or repeated sentences are easy to hear and easy to fix." },
      { kicker: "Try it free", title: "Check it all in one go", body: "Plagiarism, AI-writing and grammar in one check.\nessaywiz.app" }] },
};
async function planWithChecks(prompt, check) {
  if (DRY && !env("ANTHROPIC_API_KEY")) {
    const plan = prompt.includes("today's Reel") ? SAMPLE.reel : SAMPLE.carousel, problems = check(plan);
    if (problems.length) throw new Error("sample plan broke the rules: " + problems.join("; "));
    log("(no Claude key: using the built-in sample plan)");
    return plan;
  }
  let last = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const plan = await claude(attempt === 1 ? prompt : `${prompt}\n\nYour previous answer broke these rules, fix them: ${last.join("; ")}`);
    last = check(plan);
    if (!last.length) return plan;
    log("plan rejected:", last.join("; "));
  }
  throw new Error("Claude's plan kept breaking the rules: " + last.join("; "));
}

/* ---------------- Reel ---------------- */
const REEL_TOPICS = ["checking an essay for plagiarism before submitting", "reading AI-detector results sentence by sentence",
  "fixing grammar and learning from each correction", "paraphrasing a paragraph in an academic tone", "making stiff writing sound natural",
  "formatting citations in APA, MLA or Chicago", "deadline night: checking a whole essay at once", "proving an essay is your own work with a writing history",
  "turning feedback into a better final draft", "studying smarter during exam season"];
async function planReel() {
  const topic = REEL_TOPICS[Math.floor(Date.parse(DAY) / 864e5) % REEL_TOPICS.length];
  return planWithChecks(`You run the Instagram account of EssayWiz, a writing-tools website for students. Plan today's Reel.
Today's theme: ${topic}.

FACTS AND RULES (follow exactly):
${FACTS}

Recent posts (do not repeat their hooks or ideas):
${recentCaptions(14)}

The video is made by an AI text-to-video model, 9:16 vertical, about 8 seconds, no sound needed.
AI video cannot show real app screens, readable text or logos correctly, so the video prompt must describe a cinematic,
realistic scene (students, desks, laptops, notebooks, libraries, late-night study, a relieved smile) with NO on-screen text,
NO user interfaces, NO brand names or logos, and no real people's likeness. The caption carries the message.

Reply with ONLY JSON:
{"video_prompt": "<one detailed paragraph for the video model>",
 "caption": "<hook line, 2-4 short lines of value, then: Try it free at essaywiz.app (link in bio). Then a blank line and 'Video made with AI.' Then 5-10 relevant hashtags>",
 "topic": "${topic}"}`, p => [...checkText("caption", p.caption), ...checkText("video prompt", p.video_prompt, { max: 1800 }),
    ...(/essay\s?wiz/i.test(p.video_prompt || "") ? ["video prompt: names EssayWiz, but AI video can't draw the brand correctly"] : []),
    ...(!/video made with ai/i.test(p.caption || "") ? ["caption: must say 'Video made with AI.'"] : [])]);
}

async function makeVideo(prompt) {
  if (!env("REPLICATE_API_TOKEN")) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = env("VIDEO_MODEL") || "google/veo-3-fast";
  const extra = env("VIDEO_INPUT") ? JSON.parse(env("VIDEO_INPUT")) : {};
  const headers = { authorization: `Bearer ${env("REPLICATE_API_TOKEN")}`, "content-type": "application/json" };
  const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, { method: "POST", headers,
    body: JSON.stringify({ input: { prompt, aspect_ratio: "9:16", ...extra } }) });
  let p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Replicate error ${r.status} for ${model}: ${JSON.stringify(p).slice(0, 300)}`);
  const until = Date.now() + 20 * 60e3;
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    if (Date.now() > until) throw new Error("video generation took longer than 20 minutes");
    await sleep(8000);
    p = await (await fetch(p.urls.get, { headers })).json();
  }
  if (p.status !== "succeeded") throw new Error(`video generation ${p.status}: ${String(p.error || "").slice(0, 300)}`);
  const url = Array.isArray(p.output) ? p.output[0] : typeof p.output === "string" ? p.output : p.output && p.output.url;
  if (!/^https:\/\//.test(url || "")) throw new Error("video model returned no video URL");
  return url;
}

/* ---------------- carousel ---------------- */
const TIP_TOPICS = ["5 signs your essay reads as AI-written (and how to fix them)", "How to cite a website in APA 7", "Paraphrasing vs plagiarism: where the line is",
  "A 10-minute checklist before you submit", "How to read a plagiarism report", "Writing a strong thesis statement", "MLA vs APA vs Chicago in one slide each",
  "Common grammar mistakes in essays", "How to make formal writing sound natural", "How to show your essay is your own work"];
function siteNews() {
  // Commits on main since the last run (the bot's own commits live on social-log, so they never appear here).
  try {
    const since = state.lastCommit;
    const range = since ? [`${since}..HEAD`] : ["-n", "5"];
    const lines = git(["log", "--no-merges", "--format=%H%x09%s", ...range], repoRoot).split("\n").filter(Boolean);
    return { head: git(["rev-parse", "HEAD"], repoRoot), changes: lines.map(l => l.split("\t")[1]) };
  } catch (e) { log("could not read site changes:", e.message); return { head: null, changes: [] }; }
}
async function planCarousel(news) {
  const topic = TIP_TOPICS[Math.floor(Date.parse(DAY) / 864e5 / 2) % TIP_TOPICS.length];
  const newsPart = news.length ? `\nThe website changed since the last post. Commit messages:\n${news.map(n => "- " + n).join("\n")}
If any change is something students would notice or care about, make this a "New on EssayWiz" announcement about it
(set "kind":"news"). Ignore internal or technical changes. If nothing is worth announcing, do the tips topic.` : "";
  return planWithChecks(`You run the Instagram account of EssayWiz, a writing-tools website for students. Plan today's carousel post.
Tips topic: ${topic}.${newsPart}

FACTS AND RULES (follow exactly):
${FACTS}

Recent posts (do not repeat):
${recentCaptions(14)}

Slides are 4:5 images with a short kicker label, a big title (max 7 words) and body text (max 32 words, can use line breaks).
Make 4 to 6 slides: slide 1 is the hook, the last slide is a call to action to try EssayWiz free at essaywiz.app.

Reply with ONLY JSON:
{"kind": "tips" or "news",
 "slides": [{"kicker": "<1-3 words>", "title": "<max 7 words>", "body": "<max 32 words>"}],
 "caption": "<hook line, 2-4 short lines, 'Save this for your next essay' style call to action, then 5-10 hashtags>"}`,
    p => [...checkText("caption", p.caption),
      ...(!Array.isArray(p.slides) || p.slides.length < 2 || p.slides.length > 10 ? ["slides: need 2 to 10 slides"] : []),
      ...(p.slides || []).flatMap((s, i) => [...checkText(`slide ${i + 1} title`, s.title, { max: 70 }), ...checkText(`slide ${i + 1} body`, s.body, { max: 260 }),
        ...(String(s.kicker || "").length > 24 ? [`slide ${i + 1} kicker: too long`] : [])])]);
}

const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function chromePath() {
  const tries = [env("CHROME_PATH"), "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
  const found = tries.find(p => p && fs.existsSync(p));
  if (!found) throw new Error("no Chrome found to render slides (set CHROME_PATH)");
  return found;
}
function renderSlides(slides, outDir) {
  const tpl = fs.readFileSync(path.join(here, "slide.html"), "utf8");
  const logo = pathToFileURL(path.join(repoRoot, "icon-192.png")).href;
  const chrome = chromePath(), files = [];
  // Work files (HTML, Chrome profile) go to a temp folder; only the finished images land in outDir, which is committed.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ew-slides-"));
  fs.mkdirSync(outDir, { recursive: true });
  try {
    slides.forEach((s, i) => {
      const fill = { KICKER: esc(s.kicker), TITLE: esc(s.title), BODY: esc(s.body), PAGE: `${i + 1} / ${slides.length}`, LOGO: logo };
      const html = tpl.replace(/\{\{(KICKER|TITLE|BODY|PAGE|LOGO)\}\}/g, (_, k) => fill[k]);
      const htmlFile = path.join(work, `slide-${i + 1}.html`), png = path.join(work, `slide-${i + 1}.png`);
      fs.writeFileSync(htmlFile, html);
      execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files",
        `--user-data-dir=${path.join(work, "chrome")}`, "--window-size=1080,1350", "--virtual-time-budget=4000",
        `--screenshot=${png}`, pathToFileURL(htmlFile).href], { stdio: "ignore" });
      if (!fs.existsSync(png)) throw new Error(`Chrome did not render slide ${i + 1}`);
      // Instagram's API only takes JPEG images.
      const jpg = path.join(outDir, `slide-${i + 1}.jpg`);
      try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-q:v", "2", jpg]); files.push(jpg); }
      catch {
        if (!DRY) throw new Error("ffmpeg is needed to convert slides to JPEG");
        const keep = path.join(outDir, `slide-${i + 1}.png`); fs.copyFileSync(png, keep); files.push(keep);   // preview only
      }
    });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  return files;
}

/* ---------------- Instagram (API with Instagram Login) ---------------- */
async function ig(method, pathPart, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: env("IG_ACCESS_TOKEN") });
  const url = method === "GET" ? `${IG}/${pathPart}?${body}` : `${IG}/${pathPart}`;
  const r = await fetch(url, method === "GET" ? {} : { method, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`Instagram ${pathPart.split("?")[0]}: ${JSON.stringify(d.error || d).slice(0, 300)}`);
  return d;
}
async function waitReady(id, minutes) {
  const until = Date.now() + minutes * 60e3;
  for (;;) {
    const s = await ig("GET", id, { fields: "status_code,status" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram could not process the media: ${s.status || s.status_code}`);
    if (Date.now() > until) throw new Error("Instagram took too long to process the media");
    await sleep(10000);
  }
}
async function publish(containerId) {
  const { id } = await ig("POST", `${IG_USER}/media_publish`, { creation_id: containerId });
  let permalink = null; try { permalink = (await ig("GET", id, { fields: "permalink" })).permalink; } catch {}
  return { id, permalink };
}
async function postReel(videoUrl, caption) {
  const { id } = await ig("POST", `${IG_USER}/media`, { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" });
  await waitReady(id, 15);
  return publish(id);
}
async function postCarousel(imageUrls, caption) {
  const children = [];
  for (const image_url of imageUrls) children.push((await ig("POST", `${IG_USER}/media`, { image_url, is_carousel_item: "true" })).id);
  for (const c of children) await waitReady(c, 5);
  const { id } = await ig("POST", `${IG_USER}/media`, { media_type: "CAROUSEL", children: children.join(","), caption });
  await waitReady(id, 5);
  return publish(id);
}
async function refreshToken() {
  // Long-lived Instagram tokens last 60 days; refreshing extends them. The workflow saves a new token if one comes back.
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(env("IG_ACCESS_TOKEN"))}`);
    const d = await r.json();
    if (d.access_token && d.access_token !== env("IG_ACCESS_TOKEN") && env("NEW_TOKEN_FILE")) fs.writeFileSync(env("NEW_TOKEN_FILE"), d.access_token);
    if (d.expires_in) log(`Instagram token valid for ${Math.round(d.expires_in / 86400)} more days`);
  } catch (e) { log("token refresh skipped:", e.message); }
}

/* ---------------- main ---------------- */
async function main() {
  if (env("SOCIAL_PAUSED") === "true") { log("Paused (SOCIAL_PAUSED=true). Nothing posted."); return 0; }
  log(`EssayWiz Instagram agent, ${DAY} (IST, ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][DOW]})${DRY ? ", DRY RUN: nothing will be posted" : ""}`);
  if (!DRY) {
    const missing = ["ANTHROPIC_API_KEY", "REPLICATE_API_TOKEN", "IG_ACCESS_TOKEN"].filter(k => !env(k));
    if (missing.length) { log(`Not set up yet: add ${missing.join(", ")} in GitHub > Settings > Secrets and variables > Actions. Nothing posted.`); return 0; }
  }
  if (!DRY) await refreshToken();
  let failures = 0;
  const media = path.join(STATE, "media", DAY);

  // 1. Daily Reel
  if (already("reel")) log("Today's Reel is already posted.");
  else try {
    const plan = await planReel();
    log("Reel plan:", plan.topic, "|", plan.caption.split("\n")[0]);
    const entry = { date: DAY, type: "reel", topic: plan.topic, caption: plan.caption, videoPrompt: plan.video_prompt };
    if (DRY) { log("DRY RUN video prompt:", plan.video_prompt); log("DRY RUN caption:\n" + plan.caption); entry.status = "dry-run"; }
    else {
      const video = await makeVideo(plan.video_prompt); log("video ready");
      const res = await postReel(video, plan.caption);
      Object.assign(entry, { status: "published", mediaId: res.id, permalink: res.permalink }); log("Reel published:", res.permalink || res.id);
    }
    state.posts.push(entry); saveState(); pushState(`Reel ${DAY}`);
  } catch (e) { failures++; log("REEL FAILED:", e.message); state.posts.push({ date: DAY, type: "reel", status: "failed", error: e.message }); saveState(); pushState(`Reel ${DAY} failed`); }

  // 2. Carousel on Mon/Wed/Fri, or any day the site changed
  const news = siteNews();
  if (already("carousel")) log("Today's carousel is already posted.");
  else if (POST_DAY || news.changes.length) try {
    const plan = await planCarousel(news.changes);
    if (!POST_DAY && plan.kind !== "news") log("Site changes weren't worth announcing; no extra post today.");
    else {
      log(`Carousel (${plan.kind}):`, plan.slides.map(s => s.title).join(" | "));
      const files = renderSlides(plan.slides, media);
      const entry = { date: DAY, type: "carousel", kind: plan.kind, caption: plan.caption, slides: plan.slides };
      if (DRY) { log("DRY RUN slides rendered to", media); log("DRY RUN caption:\n" + plan.caption); entry.status = "dry-run"; entry.files = files; }
      else {
        pushState(`Carousel images ${DAY}`);   // images must be public before Instagram can fetch them
        const base = `https://raw.githubusercontent.com/${env("GITHUB_REPOSITORY")}/social-log/media/${DAY}/`;
        await sleep(5000);
        const res = await postCarousel(files.map(f => base + path.basename(f)), plan.caption);
        Object.assign(entry, { status: "published", mediaId: res.id, permalink: res.permalink }); log("Carousel published:", res.permalink || res.id);
      }
      state.posts.push(entry);
    }
    if (news.head) state.lastCommit = news.head;
    saveState(); pushState(`Carousel ${DAY}`);
  } catch (e) { failures++; log("CAROUSEL FAILED:", e.message); state.posts.push({ date: DAY, type: "carousel", status: "failed", error: e.message }); saveState(); pushState(`Carousel ${DAY} failed`); }
  else { if (news.head) state.lastCommit = news.head; saveState(); pushState(`Checked ${DAY}`); log("No carousel today."); }

  state.posts = state.posts.slice(-200);
  saveState();
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(f => { if (f) { log(`${f} part(s) failed; see above.`); process.exit(1); } })
    .catch(e => { log("FAILED:", e.message); process.exit(1); });
}
