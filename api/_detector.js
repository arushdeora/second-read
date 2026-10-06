// Second Read's own AI detector, running inside our own server (no outside AI).
// Logistic regression over hashed word unigrams + bigrams. The featurizer MUST match
// training/browser_trainer.js exactly, or the scores will be meaningless.
let model = null, w = null;
async function load() {
  if (w) return true;
  try {
    model = (await import("./_detector-model.js")).default;
    const { gunzipSync } = await import("node:zlib");
    const buf = model.gz ? gunzipSync(Buffer.from(model.gz, "base64")) : Buffer.from(model.w, "base64");
    w = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return w.length === model.D;
  } catch (e) { console.error("own detector model missing", e && e.message); w = null; return false; }
}

function feats(text, D) {
  const t = String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, " - ");
  const toks = t.match(/[a-z0-9']+|[.,;:!?"()-]/g) || [];
  const m = new Map();
  const add = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } const k = (h >>> 0) % D; m.set(k, (m.get(k) || 0) + 1); };
  for (let i = 0; i < toks.length; i++) { add("u:" + toks[i]); if (i) add("b:" + toks[i - 1] + " " + toks[i]); }
  let n = 0; for (const v of m.values()) n += v * v; n = Math.sqrt(n) || 1;
  return [m, n];
}

// Returns AI probabilities (0-1) for each text, or null if the model isn't available.
export async function ownScores(texts) {
  if (!(await load())) return null;
  return texts.map(text => {
    const [m, n] = feats(text, model.D);
    let z = model.bias;
    for (const [k, v] of m) z += w[k] * model.scale * (v / n);
    return 1 / (1 + Math.exp(-z));
  });
}
export const ownModelVersion = () => (model ? model.version : null);
