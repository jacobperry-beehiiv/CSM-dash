import { XMLParser } from "fast-xml-parser";

/**
 * Google News RSS fetcher.
 *
 * No official API; this hits the public `news.google.com/rss/search`
 * endpoint which has worked reliably for years (it's what tools like
 * Feedly use under the hood) but carries no SLA. Every fetch is
 * soft-failed — a flaky response, an empty result, a timeout — all
 * resolve to an empty headline list rather than throwing, so a single
 * bad customer can't kill the dashboard panel or the nightly sweep.
 *
 * Per customer we fire THREE category-tagged queries: business-
 * structure (M&A / IPO / bankruptcy), staffing (layoffs / exec
 * changes), and sales-and-funding (acquires / Series A-C / funding).
 * Each query is the company name in quotes ANDed with a category-
 * specific OR-clause + `when:30d` so RSS returns only the last 30
 * days. The three result sets get merged + deduped by article URL;
 * a headline matching multiple categories keeps the most-load-bearing
 * label (business > staffing > sales) so the UI's category chip
 * reads as the strongest signal.
 *
 * Disable globally via `NEWS_FETCH_DISABLED=1` env var — useful if
 * Google starts blocking us and we want to cut the dashboard off
 * without a code change.
 */

export type NewsCategory =
  | "business_structure"
  | "staffing"
  | "sales_funding";

export interface NewsHeadline {
  url: string;
  title: string;
  source: string;
  published_at: string; // ISO
  category: NewsCategory;
}

/** Category OR-clauses. Each goes into the `q=` param after the
 *  quoted company name. Tuned for high-signal CSM concerns; not
 *  exhaustive (there's deliberate overlap — "acquires" lives under
 *  sales-funding but "acquisition" under business-structure so we
 *  catch press releases that use either framing). */
const CATEGORY_QUERIES: Record<NewsCategory, string> = {
  business_structure:
    '(acquisition OR merger OR IPO OR restructuring OR "spin-off" ' +
    'OR subsidiary OR bankruptcy OR "going public")',
  staffing:
    '(layoffs OR "laid off" OR "executive departure" OR "CEO change" ' +
    'OR "CFO change" OR resigned OR appointed OR hired OR "stepped down")',
  sales_funding:
    '(acquires OR "acquired by" OR "sold to" OR "Series A" ' +
    'OR "Series B" OR "Series C" OR funding OR "raised" OR investment)',
};

/** Priority for dedup tie-break — business-structure wins, then
 *  staffing, then sales-funding. The first column captures the
 *  highest-stakes events (an acquisition matters more than a routine
 *  funding announcement). */
const CATEGORY_PRIORITY: Record<NewsCategory, number> = {
  business_structure: 0,
  staffing: 1,
  sales_funding: 2,
};

const RSS_ENDPOINT = "https://news.google.com/rss/search";
const FETCH_TIMEOUT_MS = 8_000;

function isDisabled(): boolean {
  const v = (process.env.NEWS_FETCH_DISABLED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Fetch all three categories for one company. Soft-fails any
 *  individual query — partial results are better than nothing. */
export async function fetchNewsForCompany(
  companyName: string
): Promise<NewsHeadline[]> {
  if (isDisabled()) return [];
  const name = (companyName ?? "").trim();
  if (!name) return [];

  const categories: NewsCategory[] = [
    "business_structure",
    "staffing",
    "sales_funding",
  ];
  const results = await Promise.all(
    categories.map((cat) =>
      fetchCategory(name, cat).catch((e) => {
        console.warn(
          `[google-news] ${cat} fetch failed for "${name}":`,
          e instanceof Error ? e.message : e
        );
        return [] as NewsHeadline[];
      })
    )
  );

  return dedupeByUrl(results.flat());
}

/** Single-category RSS fetch + parse. Throws on network/parse errors
 *  so the caller can log them; returns [] on an empty-but-valid
 *  feed (no news in the last 30d). */
async function fetchCategory(
  companyName: string,
  category: NewsCategory
): Promise<NewsHeadline[]> {
  const q = `"${companyName}" ${CATEGORY_QUERIES[category]} when:30d`;
  const url = new URL(RSS_ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: controller.signal,
      // No auth header — RSS is fully public. Google sometimes 429s
      // when it dislikes the UA; the default Node fetch UA tends to
      // work, but if we ever hit throttling we can rotate via this
      // header.
      headers: { "User-Agent": "CSM-Mission-Control/1.0 (+headlines)" },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Google News RSS`);
  }
  const xml = await res.text();
  return parseRss(xml, category);
}

interface RssItem {
  title?: string | { "#text"?: string };
  link?: string;
  pubDate?: string;
  source?: { "#text"?: string; "@_url"?: string } | string;
}

interface RssShape {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[];
    };
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Some RSS items wrap their title in a CDATA section with embedded
  // HTML entities; this normalizes to a flat string when possible
  // and preserves the wrapped shape otherwise (we narrow in
  // pickText() below).
  textNodeName: "#text",
});

/** Parse a Google News RSS payload into headline records. Defensive
 *  about missing fields — a malformed entry is skipped rather than
 *  fatal. */
function parseRss(xml: string, category: NewsCategory): NewsHeadline[] {
  const parsed = parser.parse(xml) as RssShape;
  const itemNode = parsed.rss?.channel?.item;
  if (!itemNode) return [];
  const items = Array.isArray(itemNode) ? itemNode : [itemNode];
  const out: NewsHeadline[] = [];
  for (const item of items) {
    const title = pickText(item.title);
    const link = typeof item.link === "string" ? item.link : "";
    const source = pickSource(item.source);
    const published = parsePubDate(item.pubDate);
    if (!title || !link || !published) continue;
    out.push({
      url: link,
      title,
      source,
      published_at: published,
      category,
    });
  }
  return out;
}

function pickText(v: RssItem["title"]): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof v["#text"] === "string") {
    return v["#text"].trim();
  }
  return "";
}

function pickSource(v: RssItem["source"]): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof v["#text"] === "string") {
    return v["#text"].trim();
  }
  return "Unknown";
}

/** RSS dates are RFC 822 (e.g. "Mon, 23 Jun 2025 14:00:00 GMT").
 *  `new Date()` parses those reliably across runtimes. Returns the
 *  ISO string on success, null on unparseable input. */
function parsePubDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Dedup by URL. When the same article matches multiple categories,
 *  the higher-priority category wins (see CATEGORY_PRIORITY). Sorted
 *  by published_at desc so newest is first. */
function dedupeByUrl(headlines: NewsHeadline[]): NewsHeadline[] {
  const byUrl = new Map<string, NewsHeadline>();
  for (const h of headlines) {
    const existing = byUrl.get(h.url);
    if (!existing) {
      byUrl.set(h.url, h);
      continue;
    }
    if (
      CATEGORY_PRIORITY[h.category] < CATEGORY_PRIORITY[existing.category]
    ) {
      byUrl.set(h.url, h);
    }
  }
  return [...byUrl.values()].sort((a, b) =>
    a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0
  );
}
