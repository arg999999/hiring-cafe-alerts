// hiring.cafe job alerts — zero-dependency Node 20 script.
//
// What it does, in order:
//   1. Reads searchState.json (your decoded filter).
//   2. POSTs it to hiring.cafe's internal API, paginating through all results.
//   3. Diffs the returned job IDs against seen.json.
//   4. First run (empty/missing seen.json): seeds seen.json and sends NO email.
//      Subsequent runs: emails you only the jobs whose IDs are new.
//   5. Writes the updated seen.json back (the workflow commits it).
//
// Env vars (set as GitHub Actions secrets):
//   RESEND_API_KEY  — Resend API key (re_...)
//   MAIL_TO         — recipient(s), comma-separated for multiple
//   MAIL_FROM       — verified Resend sender, e.g. "Jobs <alerts@yourdomain.com>"
//
// Optional env overrides (have sane defaults):
//   PAGE_SIZE=100  MAX_PAGES=25  DRY_RUN=1 (fetch + diff but never email/seed)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const API_URL = "https://hiring.cafe/api/search-jobs";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const MAX_PAGES = Number(process.env.MAX_PAGES || 25);
const DRY_RUN = process.env.DRY_RUN === "1";

const SEARCH_STATE_FILE = new URL("./searchState.json", import.meta.url);
const SEEN_FILE = new URL("./seen.json", import.meta.url);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Pull the first defined, non-empty value from a list of candidate paths.
// Each path is a dotted string, e.g. "v5_processed_job_data.job_title".
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object" || !(key in cur)) {
        ok = false;
        break;
      }
      cur = cur[key];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return undefined;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Fetch with retry/backoff — Cloudflare on datacenter IPs occasionally 403s,
// and the API can 429/5xx transiently. Retry those; fail loudly on the rest.
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, options, { attempts = 5, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // Retry on the codes that are worth retrying.
      if ([403, 408, 425, 429, 500, 502, 503, 504].includes(res.status)) {
        const body = await res.text().catch(() => "");
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      } else {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} (not retryable): ${body.slice(0, 300)}`);
      }
    } catch (err) {
      lastErr = err;
    }
    const delay = baseDelay * 2 ** i + Math.floor(Math.random() * 500);
    log(`  attempt ${i + 1}/${attempts} failed (${lastErr.message}); retrying in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error(`Giving up after ${attempts} attempts. Last error: ${lastErr?.message}`);
}

// Browser-ish headers reduce the odds of a Cloudflare challenge.
function apiHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://hiring.cafe",
    Referer: "https://hiring.cafe/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
}

// ---------------------------------------------------------------------------
// Response parsing. The API is undocumented, so field names may drift.
// We keep every extraction here, with fallbacks, so one place needs fixing
// if hiring.cafe renames something. Verify against DevTools (README step 4).
// ---------------------------------------------------------------------------
function resultsArray(payload) {
  if (Array.isArray(payload)) return payload;
  return (
    pick(payload, ["results", "hits", "jobs", "data.results", "data"]) || []
  );
}

function jobId(item) {
  const id = pick(item, ["id", "_id", "job_id", "objectID", "documentId", "uuid"]);
  return id != null ? String(id) : undefined;
}

function jobFields(item) {
  const title = pick(item, [
    "v5_processed_job_data.job_title",
    "job_information.title",
    "processed_job_data.job_title",
    "title",
    "job_title",
    "name",
  ]);
  const company = pick(item, [
    "v5_processed_job_data.company_name",
    "processed_job_data.company_name",
    "company_name",
    "company.name",
    "company",
    "employer_name",
  ]);
  const location = pick(item, [
    "v5_processed_job_data.formatted_workplace_location",
    "v5_processed_job_data.workplace_location",
    "processed_job_data.formatted_workplace_location",
    "location",
    "job_information.location",
  ]);
  const workplace = pick(item, [
    "v5_processed_job_data.workplace_type",
    "processed_job_data.workplace_type",
    "workplace_type",
  ]);
  const id = jobId(item);
  // Prefer an explicit apply/source URL; fall back to the hiring.cafe job page.
  const url =
    pick(item, [
      "apply_url",
      "apply_link",
      "source_url",
      "job_information.apply_url",
      "url",
    ]) || (id ? `https://hiring.cafe/job/${id}` : "https://hiring.cafe/");
  return {
    id,
    title: title || "(untitled role)",
    company: company || "(unknown company)",
    location: location || "",
    workplace: workplace || "",
    url,
  };
}

// ---------------------------------------------------------------------------
// Fetch all pages of the current search.
// ---------------------------------------------------------------------------
async function fetchAllJobs(searchState) {
  const all = [];
  const seenThisRun = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    log(`Fetching page ${page} (size ${PAGE_SIZE})…`);
    const res = await fetchWithRetry(API_URL, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ size: PAGE_SIZE, page, searchState }),
    });
    const payload = await res.json();
    const rows = resultsArray(payload);
    if (!Array.isArray(rows) || rows.length === 0) {
      log(`  page ${page} returned 0 rows — stopping.`);
      break;
    }
    let added = 0;
    for (const row of rows) {
      const f = jobFields(row);
      if (!f.id) continue; // can't dedupe without an id
      if (seenThisRun.has(f.id)) continue;
      seenThisRun.add(f.id);
      all.push(f);
      added++;
    }
    log(`  page ${page}: ${rows.length} rows, ${added} unique new-to-this-run.`);
    if (rows.length < PAGE_SIZE) break; // last page
  }
  return all;
}

// ---------------------------------------------------------------------------
// Email via Resend (single fetch, no SDK).
// ---------------------------------------------------------------------------
function buildEmailHtml(jobs) {
  const rows = jobs
    .map((j) => {
      const meta = [j.workplace, j.location].filter(Boolean).join(" · ");
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #eee;">
            <a href="${esc(j.url)}" style="font-size:15px;font-weight:600;color:#1a56db;text-decoration:none;">${esc(j.title)}</a>
            <div style="font-size:13px;color:#333;margin-top:2px;">${esc(j.company)}</div>
            ${meta ? `<div style="font-size:12px;color:#777;margin-top:2px;">${esc(meta)}</div>` : ""}
          </td>
        </tr>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px;">
      <h2 style="font-size:18px;color:#111;margin:0 0 4px;">${jobs.length} new job${jobs.length === 1 ? "" : "s"} on hiring.cafe</h2>
      <p style="font-size:13px;color:#777;margin:0 0 16px;">Matching your saved filter · ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="font-size:11px;color:#aaa;margin-top:24px;">Automated by your GitHub Actions job-alerts workflow.</p>
    </div>
  </body></html>`;
}

async function sendEmail(jobs) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.MAIL_FROM;
  if (!key || !to.length || !from) {
    throw new Error("Missing RESEND_API_KEY, MAIL_TO, or MAIL_FROM.");
  }
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
    // First run also covers an existing-but-empty seen.json.
    return { ids, firstRun: ids.length === 0 };
  } catch {
    return { ids: [], firstRun: true };
  }
}

async function saveSeen(ids) {
  // Bound growth: keep the most recent 8000 IDs. Plenty for a 2-day window.
  const capped = ids.slice(-8000);
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
    await saveSeen(allIds); // no-op content-wise, but harmless
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
