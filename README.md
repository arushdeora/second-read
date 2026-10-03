# Second Read

An AI-writing checker for university assignments. Students paste or upload an essay, see which sentences read as AI-written and why, and can rewrite the flagged lines.

- `index.html`: the website (runs the free offline check in the browser)
- `api/analyze.js`: sends the text to Claude for a sentence-by-sentence AI check
- `api/humanize.js`: rewrites flagged sentences
- `api/_lib.js`: shared code (API call, access code, rate limit)

Your API key stays on the server and is never sent to students' browsers.

## Put it online (free, about 10 minutes)

1. **Get an Anthropic API key.** Sign in at https://console.anthropic.com, add a little credit, then create a key under **API Keys**.
2. **Set a spending limit.** In the console, go to **Settings → Limits** and set a monthly limit (for example $10), so a busy week can't surprise you.
3. **Upload the code to GitHub.** Make a free account at https://github.com, create a new repository, then click **uploading an existing file** and drag in everything from this folder (keep the `api` folder).
4. **Deploy on Vercel.** Sign in at https://vercel.com with GitHub, click **Add New → Project**, pick your repository and click **Deploy**.
5. **Add your key.** In the Vercel project, open **Settings → Environment Variables** and add:
   - `ANTHROPIC_API_KEY`: your key from step 1 (required)
   - `ACCESS_CODE`: a password students must enter (optional, but recommended so strangers can't use your credit)
6. **Redeploy.** Go to **Deployments**, open the menu on the latest deployment and choose **Redeploy**. Your site is live at `your-project.vercel.app`.

## Optional settings

| Variable | Default | What it does |
|---|---|---|
| `MODEL` | `claude-haiku-4-5-20251001` | Which Claude model to use. `claude-sonnet-5-5` gives more careful results and costs about 2× as much. |
| `RATE_LIMIT_PER_MINUTE` | `6` | Most AI checks one visitor can run per minute. |

## Cost

With the default model, one essay check costs about 1–2 cents (US), and humanizing the flagged lines costs about the same again. The offline quick check is free.

## Important

AI detectors can be wrong, especially on formal writing and on work by multilingual students. The site says so on the page. Its results should help students revise, never serve as proof of misconduct.
