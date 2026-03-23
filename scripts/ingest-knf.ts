/**
 * Ingestion crawler for the KNF (Komisja Nadzoru Finansowego) MCP server.
 *
 * Scrapes regulatory content from knf.gov.pl and populates the SQLite
 * database with provisions from three sourcebook categories:
 *
 *   KNF_REKOMENDACJE  — KNF recommendations for banks (A–Z), insurance,
 *                        capital markets
 *   KNF_WYTYCZNE      — KNF guidelines (IT, outsourcing, cloud, AML, etc.)
 *   KNF_STANOWISKA    — KNF supervisory positions and communications
 *
 * Additionally crawls enforcement actions from the KNF penalty register
 * (kary nałożone) available as yearly PDF tables and HTML decision pages.
 *
 * Data sources (all under https://www.knf.gov.pl):
 *   - /dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/
 *     rekomendacje_dla_bankow          — bank recommendations (A–Z)
 *   - /dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/
 *     sektor_ubezpieczeniowy/Rekomendacje — insurance recommendations
 *   - /dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/
 *     inne_dokumenty                    — other guidelines and documents
 *   - /dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/
 *     wytyczne_dotyczace_zarzadzania_obszarami_IT — IT guidelines
 *   - /komunikacja/stanowiska_urzedu    — supervisory positions
 *   - /dla_rynku/stanowiska/stanowiska_uknf_sektor_bankowy — banking positions
 *   - /dla_rynku/stanowiska/stanowiska_uknf_rynek_kapitalowy — capital market positions
 *   - /o_nas/Kary_nalozone_przez_KNF    — enforcement penalties
 *   - /komunikacja/komunikaty           — regulatory communications
 *
 * Usage:
 *   npx tsx scripts/ingest-knf.ts
 *   npx tsx scripts/ingest-knf.ts --dry-run        # log what would be inserted
 *   npx tsx scripts/ingest-knf.ts --resume          # resume from last checkpoint
 *   npx tsx scripts/ingest-knf.ts --force           # drop and recreate DB
 *   npx tsx scripts/ingest-knf.ts --max-pages 3     # limit listing pagination
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["KNF_DB_PATH"] ?? "data/knf.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://www.knf.gov.pl";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const USER_AGENT =
  "AnsvarKNFCrawler/1.0 (+https://github.com/Ansvar-Systems/polish-financial-regulation-mcp; compliance research)";

// CLI flags
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const force = args.includes("--force");
const maxPagesArg = args.find((_, i) => args[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// Sourcebook definitions — the three document categories in the DB schema
// ---------------------------------------------------------------------------

const SOURCEBOOKS = [
  {
    id: "KNF_REKOMENDACJE",
    name: "KNF Rekomendacje",
    description:
      "Rekomendacje KNF dotyczące dobrych praktyk w zakresie zarządzania ryzykiem, " +
      "bezpieczeństwa IT, i ładu korporacyjnego dla banków, zakładów ubezpieczeń " +
      "i rynku kapitałowego.",
  },
  {
    id: "KNF_WYTYCZNE",
    name: "KNF Wytyczne",
    description:
      "Wytyczne KNF precyzujące oczekiwania nadzorcze w obszarach takich jak " +
      "outsourcing, zarządzanie ciągłością działania, IT, AML i chmura obliczeniowa.",
  },
  {
    id: "KNF_STANOWISKA",
    name: "KNF Stanowiska",
    description:
      "Stanowiska i komunikaty UKNF wyrażające poglądy regulatora w kwestiach " +
      "interpretacyjnych i nadzorczych dla sektora bankowego, kapitałowego " +
      "i ubezpieczeniowego.",
  },
] as const;

// ---------------------------------------------------------------------------
// Crawl targets — listing pages for each sourcebook
// ---------------------------------------------------------------------------

interface CrawlTarget {
  sourcebookId: string;
  /** Absolute path on knf.gov.pl */
  path: string;
  /** Human-readable label for console output */
  label: string;
  /** Default provision type for items discovered from this listing */
  defaultType: string;
  /** Default chapter prefix */
  chapterPrefix: string;
  /** Maximum listing pages to crawl */
  maxPages: number;
}

const CRAWL_TARGETS: CrawlTarget[] = [
  // ── Rekomendacje ──────────────────────────────────────────────────────────
  {
    sourcebookId: "KNF_REKOMENDACJE",
    path: "/dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/rekomendacje_dla_bankow",
    label: "Rekomendacje dla banków (A–Z)",
    defaultType: "recommendation",
    chapterPrefix: "RB",
    maxPages: 5,
  },
  {
    sourcebookId: "KNF_REKOMENDACJE",
    path: "/dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/sektor_ubezpieczeniowy/Rekomendacje",
    label: "Rekomendacje dla sektora ubezpieczeniowego",
    defaultType: "recommendation",
    chapterPrefix: "RU",
    maxPages: 3,
  },

  // ── Wytyczne ──────────────────────────────────────────────────────────────
  {
    sourcebookId: "KNF_WYTYCZNE",
    path: "/dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/wytyczne_dotyczace_zarzadzania_obszarami_IT",
    label: "Wytyczne IT i bezpieczeństwo teleinformatyczne",
    defaultType: "guideline",
    chapterPrefix: "WIT",
    maxPages: 3,
  },
  {
    sourcebookId: "KNF_WYTYCZNE",
    path: "/dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne/inne_dokumenty",
    label: "Wytyczne — inne dokumenty (outsourcing, AML, chmura)",
    defaultType: "guideline",
    chapterPrefix: "WINE",
    maxPages: 5,
  },
  {
    sourcebookId: "KNF_WYTYCZNE",
    path: "/dla_rynku/regulacje_i_praktyka/rekomendacje_i_wytyczne",
    label: "Rekomendacje i wytyczne — strona główna",
    defaultType: "guideline",
    chapterPrefix: "WG",
    maxPages: 3,
  },

  // ── Stanowiska ────────────────────────────────────────────────────────────
  {
    sourcebookId: "KNF_STANOWISKA",
    path: "/komunikacja/stanowiska_urzedu",
    label: "Stanowiska Urzędu KNF",
    defaultType: "position",
    chapterPrefix: "SU",
    maxPages: 10,
  },
  {
    sourcebookId: "KNF_STANOWISKA",
    path: "/dla_rynku/stanowiska/stanowiska_uknf_sektor_bankowy",
    label: "Stanowiska UKNF — sektor bankowy",
    defaultType: "position",
    chapterPrefix: "SB",
    maxPages: 5,
  },
  {
    sourcebookId: "KNF_STANOWISKA",
    path: "/dla_rynku/stanowiska/stanowiska_uknf_rynek_kapitalowy",
    label: "Stanowiska UKNF — rynek kapitałowy",
    defaultType: "position",
    chapterPrefix: "SK",
    maxPages: 5,
  },
];

/** Enforcement listing page */
const ENFORCEMENT_URL = "/o_nas/Kary_nalozone_przez_KNF";

/** Komunikaty (regulatory communications) — used for stanowiska discovery */
const KOMUNIKATY_URL = "/komunikacja/komunikaty";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  provisionsIngested: number;
  enforcementsIngested: number;
  errors: string[];
}

interface ParsedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string;
  section: string | null;
}

interface ParsedEnforcement {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (--resume support)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as IngestState;
      console.log(
        `[RESUME] Loaded state from ${STATE_FILE} — ${parsed.processedUrls.length} URLs already processed`,
      );
      return parsed;
    } catch {
      console.warn("[WARN] Could not parse state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    provisionsIngested: 0,
    enforcementsIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function isProcessed(state: IngestState, url: string): boolean {
  return state.processedUrls.includes(url);
}

function markProcessed(state: IngestState, url: string): void {
  if (!state.processedUrls.includes(url)) {
    state.processedUrls.push(url);
  }
}

// ---------------------------------------------------------------------------
// HTML text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Strip tags, decode Polish HTML entities, collapse whitespace.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&oacute;/g, "ó")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&eacute;/g, "é")
    .replace(/&aacute;/g, "á")
    .replace(/&#x[0-9a-fA-F]+;/g, (match) => {
      const code = parseInt(match.slice(3, -1), 16);
      return String.fromCharCode(code);
    })
    .replace(/&#\d+;/g, (match) => {
      const code = parseInt(match.slice(2, -1), 10);
      return String.fromCharCode(code);
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract a date from Polish text. Common formats:
 *   - "23 stycznia 2020 r."
 *   - "2020-01-23"
 *   - "23.01.2020"
 *   - "styczeń 2020"
 */
const PL_MONTHS: Record<string, string> = {
  // Genitive forms (used in dates like "23 stycznia 2020")
  stycznia: "01",
  lutego: "02",
  marca: "03",
  kwietnia: "04",
  maja: "05",
  czerwca: "06",
  lipca: "07",
  sierpnia: "08",
  września: "09",
  października: "10",
  listopada: "11",
  grudnia: "12",
  // Nominative forms (used in headings like "styczeń 2020")
  styczeń: "01",
  luty: "02",
  marzec: "03",
  kwiecień: "04",
  maj: "05",
  czerwiec: "06",
  lipiec: "07",
  sierpień: "08",
  wrzesień: "09",
  październik: "10",
  listopad: "11",
  grudzień: "12",
};

function extractDate(text: string): string | null {
  // ISO format: 2020-01-23
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // Polish long format: "23 stycznia 2020 r."
  const plPattern = /(\d{1,2})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze[sś]nia|pa[zź]dziernika|listopada|grudnia)\s+(\d{4})/i;
  const plMatch = text.match(plPattern);
  if (plMatch) {
    const day = plMatch[1]!.padStart(2, "0");
    const monthKey = plMatch[2]!.toLowerCase();
    const month = PL_MONTHS[monthKey] ?? "01";
    const year = plMatch[3]!;
    return `${year}-${month}-${day}`;
  }

  // Dot format: 23.01.2020
  const dotMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotMatch) {
    return `${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1]}`;
  }

  // Month + year only: "styczeń 2020" — use 1st of month
  const monthYearPattern = /\b(styczeń|luty|marzec|kwiecień|maj|czerwiec|lipiec|sierpień|wrzesień|pa[zź]dziernik|listopad|grudzień)\s+(\d{4})/i;
  const myMatch = text.match(monthYearPattern);
  if (myMatch) {
    const monthKey = myMatch[1]!.toLowerCase();
    const month = PL_MONTHS[monthKey] ?? "01";
    const year = myMatch[2]!;
    return `${year}-${month}-01`;
  }

  // Year only
  const yearOnly = text.match(/\b(20\d{2})\b/);
  if (yearOnly) {
    return `${yearOnly[1]}-01-01`;
  }

  return null;
}

/**
 * Build a stable reference string for a provision.
 * Format: {SOURCEBOOK_ID} {CHAPTER}.{SEQ}
 */
let referenceCounters: Record<string, number> = {};

function makeReference(
  sourcebookId: string,
  chapterPrefix: string,
  title: string,
): string {
  // Try to extract a letter from recommendation titles like "Rekomendacja D"
  const rekomMatch = title.match(/Rekomendacja\s+([A-Z])/i);
  if (rekomMatch) {
    const letter = rekomMatch[1]!.toUpperCase();
    const key = `${sourcebookId}_${letter}`;
    const seq = (referenceCounters[key] ?? 0) + 1;
    referenceCounters[key] = seq;
    return `${sourcebookId} ${letter}.${seq}`;
  }

  // For numbered wytyczne/stanowiska, try to extract a number
  const numMatch = title.match(/(?:nr|numer|poz\.?)\s*(\d+)/i);
  if (numMatch) {
    return `${sourcebookId} ${chapterPrefix}.${numMatch[1]}`;
  }

  // Fallback: chapter prefix + sequential counter
  const key = `${sourcebookId}_${chapterPrefix}`;
  const seq = (referenceCounters[key] ?? 0) + 1;
  referenceCounters[key] = seq;
  return `${sourcebookId} ${chapterPrefix}.${seq}`;
}

/**
 * Extract a chapter letter or identifier from a recommendation/guideline title.
 * "Rekomendacja D" → "D"
 * "Wytyczne IT" → "IT"
 */
function extractChapter(title: string, fallback: string): string {
  const rekomMatch = title.match(/Rekomendacja\s+([A-Z])/i);
  if (rekomMatch) return rekomMatch[1]!.toUpperCase();

  const wytMatch = title.match(/Wytyczne\s+(\S+)/i);
  if (wytMatch) return wytMatch[1]!;

  return fallback;
}

// ---------------------------------------------------------------------------
// Listing page parser — discover detail page URLs from a category
// ---------------------------------------------------------------------------

/**
 * Crawl a KNF listing page and extract links to individual detail pages.
 *
 * KNF listing pages typically render items as list entries or card blocks
 * with <a> tags pointing to detail pages. We extract all internal links
 * that look like sub-pages of the listing path.
 *
 * Pagination: KNF uses `?articleId=...&p_id=18` patterns and sometimes
 * `?p=N` or separate listing pages. We follow "next" / "następna" links
 * when present.
 */
async function discoverDetailUrls(
  target: CrawlTarget,
  state: IngestState,
): Promise<string[]> {
  const urls: string[] = [];
  const effectiveMax = maxPagesOverride
    ? Math.min(maxPagesOverride, target.maxPages)
    : target.maxPages;

  console.log(
    `\n  Discovering URLs from: ${target.label} (up to ${effectiveMax} pages)...`,
  );

  const visited = new Set<string>();
  let currentUrl: string | null = `${BASE_URL}${target.path}`;

  for (let page = 1; page <= effectiveMax && currentUrl; page++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    if (page % 5 === 1 || page === 1) {
      console.log(
        `    Fetching listing page ${page}/${effectiveMax}... (${urls.length} URLs so far)`,
      );
    }

    const html = await rateLimitedFetch(currentUrl);
    if (!html) {
      console.warn(`    [WARN] Could not fetch listing page ${page}`);
      break;
    }

    const $ = cheerio.load(html);
    let pageUrls = 0;

    // Extract all links that point to detail pages.
    // KNF uses several link patterns:
    //   1. Sub-pages under the same path: /dla_rynku/.../detail_page
    //   2. articleId query parameters: ?articleId=XXXXX&p_id=18
    //   3. PDF documents: /knf/pl/komponenty/img/document.pdf
    //   4. Absolute paths to other sections
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Skip pagination, anchors, mailto, and external links
      if (
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("javascript:") ||
        href.includes("?sivu=") ||
        href.includes("/rss")
      ) {
        return;
      }

      let fullUrl: string;

      if (href.startsWith("http")) {
        // Only follow links to knf.gov.pl
        if (!href.includes("knf.gov.pl")) return;
        fullUrl = href;
      } else {
        fullUrl = `${BASE_URL}${href.startsWith("/") ? href : `/${href}`}`;
      }

      // Accept detail pages: sub-paths of the listing, articleId pages, and PDFs
      const isSubPage =
        href.startsWith(target.path) &&
        href !== target.path &&
        href.length > target.path.length + 2;

      const isArticlePage =
        href.includes("articleId=") && href.includes("p_id=");

      const isPdfDocument =
        href.includes("/komponenty/img/") && href.endsWith(".pdf");

      // Also accept links within /dla_rynku/ that point to specific guidelines
      const isGuidelinePage =
        href.startsWith("/dla_rynku/") &&
        !href.endsWith("/") &&
        href.split("/").length >= 4;

      if (
        (isSubPage || isArticlePage || isPdfDocument || isGuidelinePage) &&
        !urls.includes(fullUrl)
      ) {
        urls.push(fullUrl);
        pageUrls++;
      }
    });

    // Look for "next page" pagination link
    currentUrl = null;
    $("a[href]").each((_i, el) => {
      const text = $(el).text().trim().toLowerCase();
      const href = $(el).attr("href");
      if (
        href &&
        (text.includes("następna") ||
          text.includes("nastepna") ||
          text.includes("next") ||
          text === ">" ||
          text === "»")
      ) {
        currentUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? href : `/${href}`}`;
      }
    });

    // Stop early if no new links found on this page
    if (pageUrls === 0 && page > 1) {
      console.log(
        `    No new URLs on page ${page} — stopping pagination for ${target.label}`,
      );
      break;
    }
  }

  console.log(`    Discovered ${urls.length} URLs from ${target.label}`);
  return urls;
}

// ---------------------------------------------------------------------------
// Detail page parser — extract provisions from individual KNF pages
// ---------------------------------------------------------------------------

/**
 * Parse a KNF detail page (HTML) and extract one or more provisions.
 *
 * KNF detail pages have varying layouts. Common patterns:
 *   - Recommendation pages: title in h1/h2, content in div.article-content
 *   - Position pages: structured as numbered points
 *   - Guideline pages: often have sub-sections with numbered paragraphs
 *
 * For pages with substantial content, we split by numbered sections.
 * For shorter pages, we treat the entire body as one provision.
 */
function parseDetailPage(
  html: string,
  url: string,
  target: CrawlTarget,
): ParsedProvision[] {
  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];

  // Extract the page title
  const titleEl =
    $("h1.article-title").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("title").first().text().trim().replace(/\s*-\s*Komisja.*$/, "") ||
    "";

  if (!titleEl) {
    return provisions;
  }

  // Extract the main content area
  // KNF pages use various content containers
  let contentHtml =
    $("div.article-content").html() ||
    $("div.content-main").html() ||
    $("div#content").html() ||
    $("article").html() ||
    $("div.main-content").html() ||
    $("main").html() ||
    "";

  if (!contentHtml) {
    // Fallback: grab the largest div with substantial text
    let maxLen = 0;
    $("div").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > maxLen && text.length > 200) {
        maxLen = text.length;
        contentHtml = $(el).html() ?? "";
      }
    });
  }

  if (!contentHtml || htmlToText(contentHtml).length < 50) {
    return provisions;
  }

  const fullText = htmlToText(contentHtml);
  const dateFromPage = extractDate(fullText) ?? extractDate(titleEl);
  const chapter = extractChapter(titleEl, target.chapterPrefix);

  // Try to split into numbered sections (common in recommendations)
  // Patterns: "1." "1)" "I." "§ 1" etc.
  const sections = splitIntoSections(fullText);

  if (sections.length > 1 && sections.length <= 100) {
    // Multiple sections found — create one provision per section
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      if (section.text.length < 30) continue;

      const sectionTitle = section.heading || `${titleEl} — pkt ${i + 1}`;
      const reference = makeReference(
        target.sourcebookId,
        chapter,
        titleEl,
      );

      provisions.push({
        sourcebook_id: target.sourcebookId,
        reference,
        title: sectionTitle.slice(0, 500),
        text: section.text,
        type: target.defaultType,
        status: "in_force",
        effective_date: dateFromPage,
        chapter,
        section: section.heading ? `${chapter}.${i + 1}` : null,
      });
    }
  } else {
    // Single provision from the whole page
    const reference = makeReference(
      target.sourcebookId,
      chapter,
      titleEl,
    );

    provisions.push({
      sourcebook_id: target.sourcebookId,
      reference,
      title: titleEl.slice(0, 500),
      text: fullText.slice(0, 50_000),
      type: target.defaultType,
      status: "in_force",
      effective_date: dateFromPage,
      chapter,
      section: null,
    });
  }

  return provisions;
}

interface TextSection {
  heading: string | null;
  text: string;
}

/**
 * Split text into numbered sections. Recognises:
 *   "1. Tekst..."  "1) Tekst..."  "§ 1. Tekst..."
 *   "I. Tekst..."  "Rozdział 1."
 */
function splitIntoSections(text: string): TextSection[] {
  const sections: TextSection[] = [];

  // Split on patterns like "1. " or "§ 1." at the start of a line
  const pattern = /\n\s*(?:(?:§\s*)?\d{1,3}[\.\)]\s|(?:Rozdział|Punkt|Art\.?)\s+\d+)/g;
  const matches: Array<{ index: number; match: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ index: m.index, match: m[0] });
  }

  if (matches.length < 2) {
    // Not enough section markers — return as single block
    return [{ heading: null, text }];
  }

  // Text before the first marker
  const preamble = text.slice(0, matches[0]!.index).trim();
  if (preamble.length > 30) {
    sections.push({ heading: "Wstęp", text: preamble });
  }

  // Each section runs from its marker to the next
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    const sectionText = text.slice(start, end).trim();

    // Try to extract a heading from the first line
    const firstNewline = sectionText.indexOf("\n");
    const heading =
      firstNewline > 0 && firstNewline < 200
        ? sectionText.slice(0, firstNewline).trim()
        : sectionText.slice(0, 100).trim();

    sections.push({ heading, text: sectionText });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Enforcement page parser — extract penalty decisions
// ---------------------------------------------------------------------------

/**
 * Parse the KNF enforcement/penalties page and extract structured enforcement
 * actions. The page at /o_nas/Kary_nalozone_przez_KNF contains links to
 * yearly PDF tables and individual decision communications.
 *
 * We extract enforcement actions from the HTML content and linked decision
 * pages (komunikaty). PDF parsing is out of scope — we log PDF URLs for
 * manual review.
 */
async function crawlEnforcementActions(
  state: IngestState,
): Promise<ParsedEnforcement[]> {
  console.log("\n--- Enforcement actions (kary nałożone) ---");

  const enforcements: ParsedEnforcement[] = [];
  const mainUrl = `${BASE_URL}${ENFORCEMENT_URL}`;

  if (isProcessed(state, mainUrl) && resume) {
    console.log("  [SKIP] Enforcement main page already processed");
    return enforcements;
  }

  const html = await rateLimitedFetch(mainUrl);
  if (!html) {
    console.warn("  [WARN] Could not fetch enforcement page");
    state.errors.push(`Failed to fetch ${mainUrl}`);
    return enforcements;
  }

  const $ = cheerio.load(html);

  // Collect links to individual decision pages and yearly PDF tables
  const decisionUrls: string[] = [];
  const pdfUrls: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    if (href.endsWith(".pdf") && href.includes("kary")) {
      const fullUrl = href.startsWith("http")
        ? href
        : `${BASE_URL}${href}`;
      pdfUrls.push(fullUrl);
    } else if (
      (href.includes("komunikaty") || href.includes("Kary")) &&
      href.includes("articleId=")
    ) {
      const fullUrl = href.startsWith("http")
        ? href
        : `${BASE_URL}${href}`;
      if (!decisionUrls.includes(fullUrl)) {
        decisionUrls.push(fullUrl);
      }
    }
  });

  if (pdfUrls.length > 0) {
    console.log(
      `  Found ${pdfUrls.length} penalty PDF tables (logged, not parsed):`,
    );
    for (const pdfUrl of pdfUrls.slice(0, 5)) {
      console.log(`    - ${pdfUrl}`);
    }
  }

  // Also try to extract enforcement info directly from the main page
  // The page sometimes contains a table or list of recent penalties
  const mainContent = $("div.article-content, div.content-main, main")
    .text()
    .trim();
  const inlineEnforcements = parseEnforcementText(mainContent);
  enforcements.push(...inlineEnforcements);

  // Crawl individual decision pages
  console.log(
    `  Found ${decisionUrls.length} decision page links to crawl...`,
  );

  for (const decUrl of decisionUrls) {
    if (isProcessed(state, decUrl) && resume) continue;

    const decHtml = await rateLimitedFetch(decUrl);
    if (!decHtml) {
      state.errors.push(`Failed to fetch decision page: ${decUrl}`);
      continue;
    }

    const $dec = cheerio.load(decHtml);
    const decTitle =
      $dec("h1").first().text().trim() || $dec("title").text().trim();
    const decContent =
      $dec("div.article-content").text().trim() ||
      $dec("main").text().trim();

    if (decContent.length < 50) {
      markProcessed(state, decUrl);
      continue;
    }

    const parsed = parseEnforcementFromDecision(decTitle, decContent);
    if (parsed) {
      enforcements.push(parsed);
    }

    markProcessed(state, decUrl);
  }

  // Also crawl the "komunikaty" (communications) page for penalty-related
  // announcements
  const komUrl = `${BASE_URL}${KOMUNIKATY_URL}`;
  if (!isProcessed(state, komUrl) || !resume) {
    const komHtml = await rateLimitedFetch(komUrl);
    if (komHtml) {
      const $kom = cheerio.load(komHtml);
      $kom("a[href]").each((_i, el) => {
        const href = $kom(el).attr("href");
        const text = $kom(el).text().trim().toLowerCase();
        if (
          href &&
          (text.includes("kar") ||
            text.includes("sankcj") ||
            text.includes("grzywn")) &&
          href.includes("articleId=")
        ) {
          const fullUrl = href.startsWith("http")
            ? href
            : `${BASE_URL}${href}`;
          if (!decisionUrls.includes(fullUrl)) {
            decisionUrls.push(fullUrl);
          }
        }
      });
      markProcessed(state, komUrl);
    }
  }

  markProcessed(state, mainUrl);
  console.log(
    `  Extracted ${enforcements.length} enforcement actions from HTML pages`,
  );

  return enforcements;
}

/**
 * Parse enforcement text for structured penalty data.
 * Looks for patterns like:
 *   "kara pieniężna w wysokości 500 000 zł"
 *   "nałożyła karę na [Firma] w kwocie..."
 */
function parseEnforcementText(text: string): ParsedEnforcement[] {
  const results: ParsedEnforcement[] = [];

  // Pattern: "KNF nałożyła ... karę ... na [firma] ... w wysokości [kwota]"
  const penaltyPattern =
    /(?:nało[żz]y[łl]a?\s+)?(?:na\s+)?([A-ZŻŹĆĄŚĘŁÓŃ][^\n,]{5,60}?)\s+(?:kar[ęe]\s+pieni[ęe][żz]n[ąa]?\s+)?w\s+wysokości\s+([\d\s,.]+)\s*(?:zł|PLN)/gi;
  let match: RegExpExecArray | null;

  while ((match = penaltyPattern.exec(text)) !== null) {
    const firmName = match[1]!.trim();
    const amountStr = match[2]!.replace(/\s/g, "").replace(",", ".");
    const amount = parseFloat(amountStr) || null;

    // Extract surrounding context as summary (200 chars before and after)
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(
      text.length,
      match.index + match[0].length + 200,
    );
    const summary = text.slice(contextStart, contextEnd).trim();

    results.push({
      firm_name: firmName,
      reference_number: null,
      action_type: "fine",
      amount,
      date: extractDate(summary),
      summary,
      sourcebook_references: null,
    });
  }

  return results;
}

/**
 * Parse a single KNF decision communication page into an enforcement action.
 */
function parseEnforcementFromDecision(
  title: string,
  content: string,
): ParsedEnforcement | null {
  // The title or content should mention a penalty/sanction
  const isPenaltyRelated =
    /kar[aęy]|sankcj|grzywn|cofni[ęe]cie|zakaz|ograniczen/i.test(
      title + " " + content,
    );
  if (!isPenaltyRelated) return null;

  // Try to extract firm name from the title
  // Common pattern: "Komunikat KNF w sprawie [Firma]"
  const firmMatch = title.match(
    /(?:w\s+sprawie|dotycz[aą]c[ey]?|wobec)\s+(.{5,80}?)(?:\s*-\s*Komisja|\s*$)/i,
  );
  const firmName = firmMatch
    ? firmMatch[1]!.trim()
    : title.replace(/Komunikat\s+KNF\s*/i, "").trim().slice(0, 80);

  if (!firmName || firmName.length < 3) return null;

  // Determine action type
  let actionType = "other";
  if (/kar[aęy]\s+pieni[ęe][żz]n/i.test(content)) actionType = "fine";
  else if (/cofni[ęe]cie\s+zezwolenia/i.test(content))
    actionType = "license_revocation";
  else if (/zakaz/i.test(content)) actionType = "prohibition";
  else if (/ograniczen/i.test(content)) actionType = "restriction";
  else if (/nakaz/i.test(content)) actionType = "order";
  else if (/ostrze[żz]enie/i.test(content)) actionType = "warning";

  // Try to extract amount
  let amount: number | null = null;
  const amtMatch = content.match(
    /(?:w\s+wysokości|w\s+kwocie|w\s+łącznej\s+kwocie)\s+([\d\s,.]+)\s*(?:zł|PLN|złotych)/i,
  );
  if (amtMatch) {
    const amtStr = amtMatch[1]!.replace(/\s/g, "").replace(",", ".");
    amount = parseFloat(amtStr) || null;
    // Handle "mln" multiplier
    if (content.slice(amtMatch.index!, amtMatch.index! + amtMatch[0].length + 10).includes("mln")) {
      amount = amount ? amount * 1_000_000 : null;
    }
  }

  // Reference number — look for "decyzja nr" or "sygn." patterns
  const refMatch = content.match(
    /(?:decyzja\s+(?:nr|numer)|sygn\.?|sygnatura)\s*[:\s]*([\w\-\/\.]+)/i,
  );
  const referenceNumber = refMatch ? refMatch[1]!.trim() : null;

  // Summary — first 500 chars of content
  const summary = content.slice(0, 500).trim();

  return {
    firm_name: firmName.slice(0, 200),
    reference_number: referenceNumber,
    action_type: actionType,
    amount,
    date: extractDate(content),
    summary,
    sourcebook_references: null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function upsertSourcebooks(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );

  for (const sb of SOURCEBOOKS) {
    insert.run(sb.id, sb.name, sb.description);
  }
  console.log(`Upserted ${SOURCEBOOKS.length} sourcebooks`);
}

function insertProvisions(
  db: Database.Database,
  provisions: ParsedProvision[],
): number {
  if (provisions.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkExists = db.prepare(
    "SELECT 1 FROM provisions WHERE sourcebook_id = ? AND reference = ? LIMIT 1",
  );

  let inserted = 0;

  const tx = db.transaction(() => {
    for (const p of provisions) {
      // Skip duplicates
      const exists = checkExists.get(p.sourcebook_id, p.reference);
      if (exists) continue;

      insert.run(
        p.sourcebook_id,
        p.reference,
        p.title,
        p.text,
        p.type,
        p.status,
        p.effective_date,
        p.chapter,
        p.section,
      );
      inserted++;
    }
  });

  tx();
  return inserted;
}

function insertEnforcements(
  db: Database.Database,
  enforcements: ParsedEnforcement[],
): number {
  if (enforcements.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const checkExists = db.prepare(
    "SELECT 1 FROM enforcement_actions WHERE firm_name = ? AND date = ? LIMIT 1",
  );

  let inserted = 0;

  const tx = db.transaction(() => {
    for (const e of enforcements) {
      // Skip duplicates (same firm + same date)
      const exists = checkExists.get(e.firm_name, e.date);
      if (exists) continue;

      insert.run(
        e.firm_name,
        e.reference_number,
        e.action_type,
        e.amount,
        e.date,
        e.summary,
        e.sourcebook_references,
      );
      inserted++;
    }
  });

  tx();
  return inserted;
}

// ---------------------------------------------------------------------------
// Main crawl orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== KNF Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(
    `Flags: ${[
      dryRun && "--dry-run",
      resume && "--resume",
      force && "--force",
      maxPagesOverride && `--max-pages ${maxPagesOverride}`,
    ]
      .filter(Boolean)
      .join(" ") || "(none)"}`,
  );
  console.log(`Rate limit: ${RATE_LIMIT_MS}ms between requests`);
  console.log();

  const state = loadState();

  let db: Database.Database | null = null;
  if (!dryRun) {
    db = initDatabase();
    upsertSourcebooks(db);
  } else {
    console.log("[DRY-RUN] No database changes will be made.\n");
  }

  // Reset reference counters for fresh run (not resume)
  if (!resume) {
    referenceCounters = {};
  }

  // -----------------------------------------------------------------------
  // Phase 1: Crawl provisions from rekomendacje, wytyczne, and stanowiska
  // -----------------------------------------------------------------------

  let totalProvisions = 0;

  for (const target of CRAWL_TARGETS) {
    console.log(`\n--- ${target.label} ---`);

    // Discover detail page URLs
    const detailUrls = await discoverDetailUrls(target, state);

    // Filter out already-processed URLs
    const toProcess = resume
      ? detailUrls.filter((url) => !isProcessed(state, url))
      : detailUrls;

    console.log(
      `  ${toProcess.length} pages to process (${detailUrls.length - toProcess.length} skipped by resume)`,
    );

    for (let i = 0; i < toProcess.length; i++) {
      const url = toProcess[i]!;

      // Skip PDF files — we only parse HTML detail pages
      if (url.endsWith(".pdf")) {
        console.log(`  [SKIP] PDF: ${url}`);
        markProcessed(state, url);
        continue;
      }

      if ((i + 1) % 10 === 0 || i === 0) {
        console.log(
          `  Processing ${i + 1}/${toProcess.length}: ${url.slice(0, 100)}...`,
        );
      }

      const html = await rateLimitedFetch(url);
      if (!html) {
        state.errors.push(`Failed to fetch: ${url}`);
        markProcessed(state, url);
        continue;
      }

      const provisions = parseDetailPage(html, url, target);

      if (dryRun) {
        for (const p of provisions) {
          console.log(
            `  [DRY-RUN] Would insert: ${p.reference} — ${p.title?.slice(0, 60)}`,
          );
        }
      } else if (db) {
        const inserted = insertProvisions(db, provisions);
        totalProvisions += inserted;
        state.provisionsIngested += inserted;
      }

      markProcessed(state, url);

      // Save state periodically (every 20 pages)
      if ((i + 1) % 20 === 0) {
        saveState(state);
      }
    }

    // Save state after each target
    saveState(state);
  }

  // -----------------------------------------------------------------------
  // Phase 2: Crawl enforcement actions
  // -----------------------------------------------------------------------

  const enforcements = await crawlEnforcementActions(state);
  let totalEnforcements = 0;

  if (dryRun) {
    for (const e of enforcements) {
      console.log(
        `  [DRY-RUN] Would insert enforcement: ${e.firm_name} — ${e.action_type} — ${e.amount ?? "N/A"} zł`,
      );
    }
  } else if (db) {
    totalEnforcements = insertEnforcements(db, enforcements);
    state.enforcementsIngested += totalEnforcements;
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  saveState(state);

  console.log("\n=== Ingestion Complete ===");

  if (!dryRun && db) {
    const provisionCount = (
      db
        .prepare("SELECT count(*) as cnt FROM provisions")
        .get() as { cnt: number }
    ).cnt;
    const sourcebookCount = (
      db
        .prepare("SELECT count(*) as cnt FROM sourcebooks")
        .get() as { cnt: number }
    ).cnt;
    const enforcementCount = (
      db
        .prepare("SELECT count(*) as cnt FROM enforcement_actions")
        .get() as { cnt: number }
    ).cnt;
    const ftsCount = (
      db
        .prepare("SELECT count(*) as cnt FROM provisions_fts")
        .get() as { cnt: number }
    ).cnt;

    console.log(`\nDatabase summary (${DB_PATH}):`);
    console.log(`  Sourcebooks:          ${sourcebookCount}`);
    console.log(`  Provisions:           ${provisionCount} (${totalProvisions} new this run)`);
    console.log(`  Enforcement actions:  ${enforcementCount} (${totalEnforcements} new this run)`);
    console.log(`  FTS entries:          ${ftsCount}`);
    db.close();
  } else {
    console.log(`\n[DRY-RUN] Would have inserted ~${totalProvisions} provisions`);
    console.log(
      `[DRY-RUN] Would have inserted ~${enforcements.length} enforcement actions`,
    );
  }

  if (state.errors.length > 0) {
    console.log(`\nErrors encountered (${state.errors.length}):`);
    for (const err of state.errors.slice(-20)) {
      console.log(`  - ${err}`);
    }
  }

  console.log(`\nState saved to ${STATE_FILE}`);
  console.log(`URLs processed: ${state.processedUrls.length}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
