// hiring.cafe (hiringcafe.com) job alerts — zero-dependency Node 20 script.
//
// NOTE ON THE API (verified live, July 2026):
// hiring.cafe redirects to hiringcafe.com, which is a Next.js app. There is no
// longer a `POST /api/search-jobs` endpoint. The job feed is served by the
// Next.js data route:
//
//   GET https://hiringcafe.com/_next/data/<BUILD_ID>/index.json
//         ?searchState=<url-encoded JSON>&page=<n>
//   header: x-nextjs-data: 1
//
// Response: { pageProps: { ssrHits: [...], ssrPage, ssrPageSize,
//                          ssrTotalCount, ssrIsLastPage, ssrError } }
//
// <BUILD_ID> changes on every site deploy, so we scrape it from the homepage
// HTML (window.__NEXT_DATA__.buildId) on each run — this makes the script
// self-healing across deploys.
//
// What it does:
//   1. Reads searchState.json (your decoded filter).
//   2. Scrapes the current BUILD_ID, then pages through index.json.
//   3. Diffs the returned job IDs against seen.json.
//   4. First run (empty/missing seen.json): seeds seen.json, sends NO email.
//      Later runs: emails only jobs whose IDs are new.
//   5. Writes the updated seen.json back (the workflow commits it).
//
// Env vars (GitHub Actions secrets):
//   RESEND_API_KEY, MAIL_TO, MAIL_FROM
// Optional: PAGE_SIZE unused now; MAX_PAGES=25, DRY_RUN=1

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SITE = "https://hiringcafe.com";
const MAX_PAGES = Number(process.env.MAX_PAGES || 25);
const DRY_RUN = process.env.DRY_RUN === "1";

const SEARCH_STATE_FILE = new URL("./searchState.json", import.meta.url);
const SEEN_FILE = new URL("./seen.json", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const firstOf = (a) => (Array.isArray(a) && a.length ? a[0] : undefined);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function browserHeaders(extra = {}) {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${SITE}/`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ...extra,
  };
}

// Retry only on network errors and transient/blocking statuses. Anything else
// throws immediately (so a real 404/400 doesn't waste five attempts).
async function fetchWithRetry(url, options, { attempts = 5, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      lastErr = e; // network-level error → retry
    }
    if (res) {
      if (res.ok) return res;
      if (![403, 408, 425, 429, 500, 502, 503, 504].includes(res.status)) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} (not retryable): ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`HTTP ${res.status}`);
    }
    const delay = baseDelay * 2 ** i + Math.floor(Math.random() * 500);
    log(`  attempt ${i + 1}/${attempts} failed (${lastErr?.message}); retrying in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error(`Giving up after ${attempts} attempts. Last error: ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// hiringcafe.com data access
// ---------------------------------------------------------------------------
async function getBuildId() {
  const res = await fetchWithRetry(`${SITE}/`, { headers: browserHeaders() });
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error("Could not find buildId in homepage HTML (site markup may have changed).");
  return m[1];
}

async function fetchPage(buildId, searchState, page) {
  const url = `${SITE}/_next/data/${buildId}/index.json?searchState=${encodeURIComponent(
    JSON.stringify(searchState)
  )}&page=${page}`;
  const res = await fetchWithRetry(url, { headers: browserHeaders({ "x-nextjs-data": "1" }) });
  const json = await res.json();
  return json.pageProps || {};
}

// Field extraction — verified against the live response. Fallbacks kept so a
// minor rename doesn't break everything; see README "Verify the live payload".
function jobFields(h) {
  const v5 = h.v5_processed_job_data || {};
  const ji = h.job_information || {};
  const ec = h.enriched_company_data || {};
  const id = h.id != null ? String(h.id) : h.objectID != null ? String(h.objectID) : undefined;
  const title = v5.core_job_title || ji.title || ji.job_title_raw || "(untitled role)";
  const company = ec.name || v5.company_name || "(unknown company)";
  const workplace = v5.workplace_type || "";
  const location =
    firstOf(v5.workplace_cities) ||
    firstOf(v5.workplace_states) ||
    firstOf(v5.workplace_countries) ||
    "";
  const url = h.apply_url || `${SITE}/`;
  return { id, title, company, location, workplace, url };
}

async function fetchAllJobs(searchState) {
  let buildId = await getBuildId();
  log(`buildId=${buildId}`);
  const all = [];
  const seenThisRun = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    let pp;
    try {
      pp = await fetchPage(buildId, searchState, page);
    } catch (e) {
      // A stale buildId (deploy mid-run) shows up as a 404 — re-scrape once.
      if (page === 0 && /HTTP 404/.test(String(e.message))) {
        log("  buildId looked stale; re-scraping…");
        buildId = await getBuildId();
        pp = await fetchPage(buildId, searchState, page);
      } else throw e;
    }
    if (pp.ssrError) throw new Error("API returned ssrError: " + JSON.stringify(pp.ssrError));
    const hits = pp.ssrHits || [];
    if (hits.length === 0) {
      log(`  page ${page}: 0 hits — stopping.`);
      break;
    }
    let added = 0;
    for (const hit of hits) {
      const f = jobFields(hit);
      if (!f.id || seenThisRun.has(f.id)) continue;
      seenThisRun.add(f.id);
      all.push(f);
      added++;
    }
    log(
      `  page ${page}: ${hits.length} hits, ${added} unique (total=${pp.ssrTotalCount}, last=${pp.ssrIsLastPage}).`
    );
    if (pp.ssrIsLastPage) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Email via Resend (single fetch, no SDK)
// ---------------------------------------------------------------------------
function buildEmailHtml(jobs) {
  const rows = jobs
    .map((j) => {
      const meta = [j.workplace, j.location].filter(Boolean).join(" · ");
      return `
        <tr><td style="padding:12px 0;border-bottom:1px solid #eee;">
          <a href="${esc(j.url)}" style="font-size:15px;font-weight:600;color:#1a56db;text-decoration:none;">${esc(j.title)}</a>
          <div style="font-size:13px;color:#333;margin-top:2px;">${esc(j.company)}</div>
          ${meta ? `<div style="font-size:12px;color:#777;margin-top:2px;">${esc(meta)}</div>` : ""}
        </td></tr>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px;">
      <h2 style="font-size:18px;color:#111;margin:0 0 4px;">${jobs.length} new job${jobs.length === 1 ? "" : "s"} on hiring.cafe</h2>
      <p style="font-size:13px;color:#777;margin:0 0 16px;">Matching your saved filter · ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="font-size:11px;color:#aaa;margin-top:24px;">Automated by your GitHub Actions job-alerts workflow.</p>
    </div></body></html>`;
}

async function sendEmail(jobs) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.MAIL_FROM;
  if (!key || !to.length || !from) throw new Error("Missing RESEND_API_KEY, MAIL_TO, or MAIL_FROM.");
  const subject = `${jobs.length} new hiring.cafe job${jobs.length === 1 ? "" : "s"}`;
  const res = await fetchWithRetry("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html: buildEmailHtml(jobs) }),
  });
  const out = await res.json().catch(() => ({}));
  log(`Email sent (Resend id: ${out.id || "unknown"}).`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
async function loadSeen() {
  if (!existsSync(SEEN_FILE)) return { ids: [], firstRun: true };
  try {
    const raw = JSON.parse(await readFile(SEEN_FILE, "utf8"));
    const ids = Array.isArray(raw) ? raw : raw.ids || [];
    return { ids, firstRun: ids.length === 0 };
  } catch {
    return { ids: [], firstRun: true };
  }
}

async function saveSeen(ids) {
  const capped = ids.slice(-8000); // bound growth; plenty for a 2-day window
  await writeFile(SEEN_FILE, JSON.stringify({ ids: capped }, null, 0) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const searchState = JSON.parse(await readFile(SEARCH_STATE_FILE, "utf8"));
  const { ids: seenIds, firstRun } = await loadSeen();
  const seenSet = new Set(seenIds);

  const jobs = await fetchAllJobs(searchState);
  log(`Fetched ${jobs.length} unique jobs total.`);

  const fresh = jobs.filter((j) => !seenSet.has(j.id));
  log(`${fresh.length} are new vs. seen.json (firstRun=${firstRun}).`);

  const allIds = [...seenSet];
  for (const j of jobs) if (!seenSet.has(j.id)) allIds.push(j.id);

  if (DRY_RUN) {
    log("DRY_RUN=1 — not emailing, not writing seen.json.");
    for (const j of fresh.slice(0, 20)) log(`  NEW: ${j.title} — ${j.company} — ${j.url}`);
    return;
  }
  if (firstRun) {
    await saveSeen(allIds);
    log(`First run: seeded seen.json with ${allIds.length} IDs. No email sent.`);
    return;
  }
  if (fresh.length === 0) {
    await saveSeen(allIds);
    log("No new jobs. Nothing to send.");
    return;
  }
  await sendEmail(fresh);
  await saveSeen(allIds);
  log(`Done. Emailed ${fresh.length} new job(s) and updated seen.json.`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
