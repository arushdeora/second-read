# Second Read's own AI detector, served from a free Hugging Face Space (CPU).
import os
import torch
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL_ID = os.environ.get("MODEL_ID", "")
KEY = os.environ.get("DETECTOR_KEY", "")
TOKEN = os.environ.get("HF_TOKEN") or None

tok = AutoTokenizer.from_pretrained(MODEL_ID, token=TOKEN)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, token=TOKEN).eval()
torch.set_num_threads(max(1, os.cpu_count() or 1))
# Which output is "ai"? Training saves id2label = {0: "human", 1: "ai"}.
AI = next((int(i) for i, l in model.config.id2label.items() if str(l).lower() == "ai"), 1)

app = FastAPI()

class Req(BaseModel):
    texts: list[str]

@app.get("/")
def health():
    return {"ok": True, "model": MODEL_ID}

@app.post("/score")
def score(req: Req, authorization: str | None = Header(default=None)):
    if KEY and authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="bad key")
    texts = [t[:2000] for t in req.texts[:400]]
    if not texts:
        return {"scores": []}
    out = []
    with torch.inference_mode():
        for i in range(0, len(texts), 32):
            batch = tok(texts[i:i + 32], truncation=True, max_length=256, padding=True, return_tensors="pt")
            probs = torch.softmax(model(**batch).logits, dim=-1)[:, AI]
            out.extend(round(float(p), 4) for p in probs)
    return {"scores": out}
