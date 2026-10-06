---
title: Second Read Detector
emoji: 🔎
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# Second Read AI detector

Serves Second Read's own trained AI-writing detector (a fine-tuned DistilRoBERTa model).

`POST /score` with `{"texts": ["sentence one", "sentence two"]}` returns `{"scores": [0.12, 0.87]}`,
where each score is the probability (0–1) that the text was written by AI.

Settings (Space → Settings → Variables and secrets):
- `MODEL_ID`: the trained model on Hugging Face, e.g. `your-name/second-read-detector`
- `DETECTOR_KEY` (secret, optional): if set, callers must send `Authorization: Bearer <key>`
- `HF_TOKEN` (secret): only needed if the model repo is private
