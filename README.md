# hiring.cafe job alerts

Emails you new [hiring.cafe](https://hiring.cafe) jobs that match your saved filter — on a schedule, for free, with no server and no database.

**How it works:** a GitHub Actions cron runs `check.mjs` every 10 minutes. hiring.cafe now redirects to **hiringcafe.com** (a Next.js app), so the script scrapes the current build ID and fetches your `searchState.json` filter from the site's own data route (`GET /_next/data/<BUILD_ID>/index.json?searchState=…&page=…`), pages through the results, diffs the job IDs against `seen.json`, and emails you only the new ones **from your own Gmail** (free, via a Google App Password — no paid service). The updated `seen.json` is committed back to the repo so state survives between runs — and the commit doubles as activity that stops GitHub disabling the cron.

> The old `POST /api/search-jobs` endpoint no longer exists — the site was rebuilt on Next.js. `check.mjs` targets the current data route and re-scrapes the build ID each run, so it self-heals across site deploys.

**First run is silent by design:** it seeds `seen.json` with everything currently matching and sends no email, so you don't get a several-hundred-job blast on day one. Alerts start from the *second* run onward.

---

## Before you build: check the free option first

hiring.cafe has built-in **saved-search email alerts**. Create your search on the site, save it, and enable alerts. If those are timely enough and respect your full filter, use them — zero maintenance beats any DIY setup. This repo is worth it only if their alerts are too slow, too noisy, or drop part of your filter.

---

## Setup (~15 minutes)

### 1. Create the repo

Push these files to GitHub:

```
check.mjs
searchState.json
seen.json
package.json
.github/workflows/job-alerts.yml
```

**Public vs private for 10-minute polling:** running every 10 min is ~4,300 runs/month. A **public** repo gets *unlimited* free Actions minutes — recommended, and safe here because no secrets live in the code (they're stored as encrypted GitHub Secrets). A **private** repo only includes 2,000 free minutes/month, which this cadence can exceed. If you keep it private and hit the cap, either lower the frequency or switch the repo to public.

### 2. Create a Gmail App Password (free)

Sending happens through your own Gmail over SMTP — no third-party service, no subscription.

1. Turn on **2-Step Verification** for your Google account (required for app passwords): [myaccount.google.com/security](https://myaccount.google.com/security).
2. Create an **App Password**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → name it e.g. "hiring alerts" → Google gives you a 16-character password like `abcd efgh ijkl mnop`.
3. That app password is what the script logs in with — **not** your normal Gmail password. (Spaces are fine; the script strips them.)

### 3. Add the repository secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret               | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| `GMAIL_USER`         | your Gmail address (e.g. `you@gmail.com`)              |
| `GMAIL_APP_PASSWORD` | the 16-char app password from step 2                   |
| `MAIL_TO`            | where alerts go (defaults to `GMAIL_USER`; comma-separate for several) |
| `MAIL_FROM`          | optional display sender; defaults to `GMAIL_USER`     |

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
| Change how often it checks   | Edit the `cron` in `.github/workflows/job-alerts.yml` (UTC). Currently `*/10 * * * *` = every 10 min. |
| Change the filter            | Re-copy `searchState` from DevTools into `searchState.json`.            |
| Widen the fresh-jobs window  | Bump `dateFetchedPastNDays` in `searchState.json`.                     |
| Reset alerts (re-seed)       | Set `seen.json` back to `{ "ids": [] }` and commit.                    |
| Preview without sending      | `DRY_RUN=1 node check.mjs`                                              |

## Good to know

**Cloudflare / datacenter IPs:** hiringcafe.com is behind Cloudflare, and GitHub runners use datacenter IPs. In testing the data route returned fine from GitHub, but if a run ever starts failing with persistent `403`s, `check.mjs` already retries with backoff — and the ultimate fallback is to run the same script via `cron` on any always-on machine at home (a residential IP sidesteps it). The script doesn't change; only where it runs does.

**Cron punctuality:** GitHub's scheduled runs are best-effort. Most fire close to schedule, but under load they can be delayed several minutes or occasionally skipped — so "every 10 minutes" is a target, not a guarantee. For truly precise 10-minute polling, run it from a home machine's cron instead.

## Files

| File                                  | Purpose                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `check.mjs`                           | The whole thing: fetch → paginate → diff → email via Gmail.   |
| `searchState.json`                    | Your decoded hiring.cafe filter.                              |
| `seen.json`                           | Job IDs already alerted on. Committed back each run.          |
| `.github/workflows/job-alerts.yml`    | The cron + install + run + commit workflow.                   |
| `package.json`                        | Declares the one dependency (nodemailer).                     |
| `.env.example`                        | Template for local testing only.                             |
