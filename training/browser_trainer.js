// Second Read detector v1: trained in the browser on public human/AI text.
// Features: hashed word unigrams + bigrams (FNV-1a, 2^15 buckets), L2-normalised.
// How to retrain: open any page of the live site, paste this file into the browser console, then run
//   await SRT.fetchAll(); SRT.build(); SRT.fit(6, 0.2, 1e-6); SRT.evaluate();  copy(await SRT.exportModule({...}))
// and save the result as api/_detector-model.js.
// Model: logistic regression (AdaGrad + L2). The SAME featurizer is used by api/_detector.js.
window.SRT = window.SRT || {};
(() => {
  const D = 1 << 15;   // 32,768 buckets: small enough to ship inside the site
  function feats(text) {
    const t = String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, " - ");
    const toks = t.match(/[a-z0-9']+|[.,;:!?"()-]/g) || [];
    const m = new Map();
    const add = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } const k = (h >>> 0) % D; m.set(k, (m.get(k) || 0) + 1); };
    for (let i = 0; i < toks.length; i++) { add("u:" + toks[i]); if (i) add("b:" + toks[i - 1] + " " + toks[i]); }
    let n = 0; for (const v of m.values()) n += v * v; n = Math.sqrt(n) || 1;
    const ks = Int32Array.from(m.keys()); const vs = Float32Array.from(ks, k => m.get(k) / n);
    return [ks, vs];
  }
  const words = s => (s.match(/[A-Za-z0-9'-]+/g) || []).length;
  function chunks(text, rnd) {
    let sents = String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sents.length && !/^[A-Z"(]/.test(sents[0])) sents.shift();                  // starts mid-sentence
    if (sents.length && !/[.!?]["')]?$/.test(sents[sents.length - 1])) sents.pop();  // cut off at the end
    const out = []; let i = 0;
    while (i < sents.length && out.length < 8) {
      const n = [1, 1, 2, 3][Math.floor(rnd() * 4)]; const c = sents.slice(i, i + n).join(" "); i += n;
      if (words(c) >= 6 && words(c) <= 120) out.push(c);
    }
    return out;
  }
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const PILE = "https://datasets-server.huggingface.co/rows?dataset=artem9k/ai-text-detection-pile&config=default&split=train";
  const HC3 = "https://datasets-server.huggingface.co/rows?dataset=Hello-SimpleAI/HC3&config=all&split=train";
  async function getJson(u, tries = 4) {
    for (let k = 0; k < tries; k++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) {} await new Promise(r => setTimeout(r, 1500 * (k + 1))); }
    return { rows: [] };
  }
  SRT.fetchAll = async ({ pileReq = 40, hc3Req = 30 } = {}) => {
    const S = SRT; S.docs = []; S.status = "fetching"; S.done = 0;
    const jobs = [];
    for (let k = 0; k < pileReq; k++) jobs.push([PILE + "&offset=" + Math.floor(rnd() * 1027000) + "&length=100", "pile"]);
    for (let k = 0; k < pileReq; k++) jobs.push([PILE + "&offset=" + (1030000 + Math.floor(rnd() * 362000)) + "&length=100", "pile"]);
    for (let k = 0; k < hc3Req; k++) jobs.push([HC3 + "&offset=" + Math.floor(rnd() * 24200) + "&length=100", "hc3"]);
    S.total = jobs.length; let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [u, kind] = jobs[next++]; const j = await getJson(u);
        for (const r of j.rows || []) {
          const row = r.row;
          if (kind === "pile") S.docs.push({ id: "p" + r.row_idx, y: row.source === "human" ? 0 : 1, text: row.text });
          else {
            (row.human_answers || []).forEach((t, q) => S.docs.push({ id: "h" + r.row_idx + "h" + q, g: "h" + r.row_idx, y: 0, text: t }));
            (row.chatgpt_answers || []).forEach((t, q) => S.docs.push({ id: "h" + r.row_idx + "c" + q, g: "h" + r.row_idx, y: 1, text: t }));
          }
        }
        S.done++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    S.status = "fetched";
  };
  SRT.build = () => {
    const S = SRT; const seen = new Set(); const train = [], test = [];
    for (const d of S.docs) {
      if (seen.has(d.id)) continue; seen.add(d.id);
      const grp = d.g || d.id; let h = 0; for (let i = 0; i < grp.length; i++) h = (h * 31 + grp.charCodeAt(i)) | 0;
      const isTest = Math.abs(h) % 10 === 0;
      for (const c of chunks(d.text, rnd)) (isTest ? test : train).push({ y: d.y, c, src: d.id[0] });
    }
    const bal = xs => { const a = xs.filter(x => x.y === 0), b = xs.filter(x => x.y === 1); const n = Math.min(a.length, b.length); const sh = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }; return sh(sh(a).slice(0, n).concat(sh(b).slice(0, n))); };
    S.train = bal(train).map(x => ({ ...x, f: feats(x.c) })); S.test = bal(test).map(x => ({ ...x, f: feats(x.c) }));
    return { docs: seen.size, train: S.train.length, test: S.test.length };
  };
  SRT.fit = (epochs = 4, lr = 0.4, l2 = 1e-6) => {
    const S = SRT; const w = new Float32Array(D), g = new Float32Array(D).fill(1e-8); let b = 0, gb = 1e-8;
    for (let e = 0; e < epochs; e++) {
      for (const x of S.train) {
        const [ks, vs] = x.f; let z = b; for (let i = 0; i < ks.length; i++) z += w[ks[i]] * vs[i];
        const p = 1 / (1 + Math.exp(-z)); const err = p - x.y;
        for (let i = 0; i < ks.length; i++) { const k = ks[i]; const gr = err * vs[i] + l2 * w[k]; g[k] += gr * gr; w[k] -= lr * gr / Math.sqrt(g[k]); }
        gb += err * err; b -= lr * err / Math.sqrt(gb);
      }
    }
    S.w = w; S.b = b;
  };
  SRT.predict = text => { const [ks, vs] = feats(text); let z = SRT.b; for (let i = 0; i < ks.length; i++) z += SRT.w[ks[i]] * vs[i]; return 1 / (1 + Math.exp(-z)); };
  SRT.evaluate = () => {
    const S = SRT; const ps = S.test.map(x => { const [ks, vs] = x.f; let z = S.b; for (let i = 0; i < ks.length; i++) z += S.w[ks[i]] * vs[i]; return 1 / (1 + Math.exp(-z)); });
    const ys = S.test.map(x => x.y); const acc = ps.filter((p, i) => (p >= 0.5) === (ys[i] === 1)).length / ps.length;
    const pos = ps.filter((p, i) => ys[i] === 1).sort((a, b) => a - b), neg = ps.filter((p, i) => ys[i] === 0);
    let auc = 0; for (const p of neg) { let lo = 0, hi = pos.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[m] <= p) lo = m + 1; else hi = m; } auc += pos.length - lo; } auc /= (pos.length * neg.length);
    const at = t => ({ t, caught: +(pos.filter(p => p >= t).length / pos.length).toFixed(3), falseAlarm: +(neg.filter(p => p >= t).length / neg.length).toFixed(3) });
    const bySrc = {}; S.test.forEach((x, i) => { const k = x.src === "p" ? "essays" : "q&a"; (bySrc[k] = bySrc[k] || [0, 0])[0]++; if ((ps[i] >= 0.5) === (x.y === 1)) bySrc[k][1]++; });
    return { acc: +acc.toFixed(3), auc: +auc.toFixed(3), thresholds: [0.5, 0.7, 0.9].map(at), bySource: Object.fromEntries(Object.entries(bySrc).map(([k, [n, ok]]) => [k, +(ok / n).toFixed(3) + " of " + n])) };
  };
  SRT.exportModule = async (meta) => {
    const S = SRT; let mx = 0; for (const v of S.w) mx = Math.max(mx, Math.abs(v)); const scale = mx / 127;
    const q = new Int8Array(D); for (let i = 0; i < D; i++) q[i] = Math.round(S.w[i] / scale);
    const gz = new Uint8Array(await new Response(new Blob([q.buffer]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    let bin = ""; for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
    return "// Second Read's own AI detector (see training/browser_trainer.js).\n" +
      "export const meta = " + JSON.stringify(meta) + ";\nexport default " + JSON.stringify({ version: (meta && meta.version) || 1, D, bias: S.b, scale, gz: btoa(bin) }) + ";\n";
  };
})();
