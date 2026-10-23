# EssayWiz Instagram agent

Posts to Instagram automatically, every day at 19:00 India time (GitHub Actions, `.github/workflows/instagram.yml`):

- **Every day:** one Reel. Claude writes the idea and caption; an AI video model on Replicate makes an ~8 second vertical video.
- **Mon, Wed, Fri:** one carousel of 4-6 branded slides (study and writing tips), rendered from `slide.html`.
- **When the website changes:** a "New on EssayWiz" carousel about it (only if students would care).

Everything is checked before posting: no prices (they differ by country), no "undetectable / bypass / guaranteed" claims,
no more than 30 hashtags, and every Reel caption says "Video made with AI." Facts come only from `facts.md`; keep it up to date.
Every post is logged in `log.json` on the `social-log` branch (Vercel never deploys that branch).

## One-time setup

1. **Instagram:** switch @essaywiz.app to a **Business** or **Creator** account (Instagram app > Settings > Account type).
2. **Meta app:** at developers.facebook.com create an app, add the **Instagram** product ("API setup with Instagram login"),
   add your Instagram account, and generate a **long-lived access token** with `instagram_business_basic` and
   `instagram_business_content_publish`. Note the Instagram account ID shown there.
3. **Replicate:** sign up at replicate.com, add billing, and copy an API token (replicate.com/account/api-tokens).
4. **Claude:** an Anthropic API key (console.anthropic.com > API Keys). Use a separate key from the website's.
5. **GitHub:** repo **Settings > Secrets and variables > Actions**:
   - Secrets: `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`, `IG_ACCESS_TOKEN`
   - Variables: `IG_USER_ID` (the Instagram account ID)
   - Optional secret `SECRETS_ADMIN_TOKEN`: a fine-grained GitHub token with "Secrets: read and write" on this repo, so the
     agent can save the refreshed Instagram token itself. Without it, create a new Instagram token every 60 days.
6. **Test:** Actions tab > "Instagram agent" > Run workflow with **dry run** ticked. Check the log and the slides in the
   "instagram-media" download. Then run it once without dry run.

## Control

- **Pause:** add the variable `SOCIAL_PAUSED` = `true` (delete it to resume).
- **Change the video model:** variable `VIDEO_MODEL` (default `google/veo-3-fast`), extra model settings as JSON in `VIDEO_INPUT`.
- **Change the caption model:** variable `CLAUDE_MODEL` (default `claude-haiku-5-5`).
- **Failures:** a failed run shows red in the Actions tab and GitHub emails you. Nothing half-finished is posted.
