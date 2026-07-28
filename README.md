# hiring.cafe job alerts

Emails you new [hiring.cafe](https://hiring.cafe) jobs that match your saved filter — on a schedule, for free, with no server and no database.

**How it works:** a GitHub Actions cron runs `check.mjs` every 4 hours. hiring.cafe now redirects to **hiringcafe.com** (a Next.js app), so the script scrapes the current build ID and fetches your `searchState.json` filter from the site's own data route (`GET /_next/data/<BUILD_ID>/index.json?searchState=…&page=…`), pages through the results, diffs the job IDs against `seen.json`, and emails you only the new ones via [Resend](https://resend.com). The updated `seen.json` is committed back to the repo so state survives between runs — and the commit doubles as activity that stops GitHub disabling the cron.

> The old `POST /api/search-jobs` endpoint no longer exists — the site was rebuilt on Next.js. `check.mjs` targets the current data route and re-scrapes the build ID each run, so it self-heals across site deploys.

**First run is silent by design:** it seeds `seen.json` with everything currently matching and sends no email, so you don't get a several-hundred-job blast on day one. Alerts start from the *second* run onward.

---

## Before you build: check the free option first

hiring.cafe has built-in **saved-search email alerts**. Create your search on the site, save it, and enable alerts. If those are timely enough and respect your full filter, use them — zero maintenance beats any DIY setup. This repo is worth it only if their alerts are too slow, too noisy, or drop part of your filter.

---

## Setup (~15 minutes)

### 1. Create the repo

Push these files to a **private** GitHub repo (private = unlimited free Actions minutes for this workload):

```
check.mjs
searchState.json
seen.json
package.json
.github/workflows/job-alerts.yml
```

### 2. Get a Resend account + sender

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month).
2. Create an **API key** → copy it (`re_...`).
3. Set a **from address**. Fastest path: use Resend's test sender `onboarding@resend.dev`, which can only email *your own* account address — perfect for this. For a custom domain, verify it under Domains first, then use e.g. `alerts@yourdomain.com`.

### 3. Add three repository secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret           | Value                                             |
| ---------------- | ------------------------------------------------- |
| `RESEND_API_KEY` | your `re_...` key                                 |
| `MAIL_TO`        | where alerts go (comma-separate for several)      |
| `MAIL_FROM`      | e.g. `Jobs <onboarding@resend.dev>` or your domain sender |

### 4. Verify the live payload (important — the API is undocumented)

This internal data route can shift without notice, so confirm it if a run ever comes back empty:

1. Open [hiringcafe.com](https://hiringcafe.com), apply your filter, open **DevTools → Network**.
2. Find the `index.json?searchState=…` request under `_next/data/<BUILD_ID>/`. Confirm `searchState` in the URL matches the one in this repo; if the site changed field names, copy the live `searchState` over the file here.
3. **Response** tab → jobs live in `pageProps.ssrHits`, with pagination via `&page=N` until `pageProps.ssrIsLastPage` is true. Each hit exposes `id`, `apply_url`, `v5_processed_job_data.core_job_title`, `enriched_company_data.name`, and `v5_processed_job_data.workplace_type` / `workplace_cities`. If any of these are renamed, edit the fallbacks in the `jobFields()` function — they're grouped together for exactly this reason.

### 5. Test it

- **Locally (recommended first):** `cp .env.example .env`, fill it in, then dry-run without emailing:
  ```bash
  DRY_RUN=1 node check.mjs      # prints new jobs, writes nothing, sends nothing
  ```
  Then a real run: `node check.mjs` (first run just seeds `seen.json`; run it twice to see an email).
- **On GitHub:** repo → **Actions** tab → *hiring.cafe job alerts* → **Run workflow**. First manual run seeds state; subsequent runs alert.

Once the manual run is green, the cron takes over automatically.

---

## Tuning

| Want to…                     | Do this                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Change how often it checks   | Edit the `cron` in `.github/workflows/job-alerts.yml` (UTC).            |
| Change the filter            | Re-copy `searchState` from DevTools into `searchState.json`.            |
| Widen the fresh-jobs window  | Bump `dateFetchedPastNDays` in `searchState.json`.                     |
| Reset alerts (re-seed)       | Set `seen.json` back to `{ "ids": [] }` and commit.                    |
| Preview without sending      | `DRY_RUN=1 node check.mjs`                                              |

## The one real risk: Cloudflare

hiring.cafe sits behind Cloudflare, and GitHub Actions runners use **datacenter IPs** that Cloudflare sometimes 403s. `check.mjs` retries with exponential backoff, which handles transient blocks. If it becomes *persistent* (every run 403s), the cheapest fix is to run the exact same script via `cron` on any always-on machine at home — a residential IP sidesteps the block entirely. The script and files don't change; only where it runs does.

## Files

| File                                  | Purpose                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `check.mjs`                           | The whole thing: fetch → paginate → diff → email. Zero deps.  |
| `searchState.json`                    | Your decoded hiring.cafe filter.                              |
| `seen.json`                           | Job IDs already alerted on. Committed back each run.          |
| `.github/workflows/job-alerts.yml`    | The cron + run + commit workflow.                             |
| `.env.example`                        | Template for local testing only.                             |
