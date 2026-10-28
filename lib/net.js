// Network access for recon: one page at a time, paced per host, through the
// Harness web service when present and global fetch otherwise.

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lastHit = new Map();

/**
 * Wait out the per-host interval. Politeness is also a correctness measure:
 * it keeps the fetch order equal to the reading order.
 */
export async function pace(url, minIntervalMs) {
  let host = 'unknown';
  try { host = new URL(url).host; } catch { /* keep default */ }
  const previous = lastHit.get(host) || 0;
  const wait = previous + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function withTimeout(signal, ms) {
  if (signal) return signal;
  return AbortSignal.timeout(ms);
}

/**
 * Fetch one URL. `web` is the optional Harness web service; when it is absent
 * or fails, plain fetch is used so the tools still work in a bare process.
 */
export async function politeFetch(web, url, options = {}) {
  const { minIntervalMs = 1200, timeoutMs = 45000, signal } = options;
  await pace(url, minIntervalMs);

  if (web && options.preferService !== false) {
    try {
      const result = await web.fetch({ url }, withTimeout(signal, timeoutMs));
      return {
        status: result.statusCode,
        body: result.body,
        finalUrl: result.url || url,
        truncated: Boolean(result.truncated),
        via: 'web-service',
      };
    } catch (error) {
      if (options.serviceOnly) throw error;
      // fall through to plain fetch
    }
  }

  const response = await fetch(url, {
    redirect: 'follow',
    signal: withTimeout(signal, timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const isHtml = /html|xml/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(text.slice(0, 200));
  return {
    status: response.status,
    body: { kind: isHtml ? 'html' : 'text', content: text },
    finalUrl: response.url || url,
    truncated: false,
    via: 'fetch',
  };
}

/** Run several searches, merging duplicate URLs and keeping the first sighting. */
export async function searchMany(web, queries, options = {}) {
  const { maxResults = 8, signal } = options;
  const seen = new Map();
  const answers = [];
  const failures = [];

  for (const query of queries) {
    if (!web) { failures.push({ query, error: 'no search provider is configured' }); continue; }
    try {
      const result = await web.search({ query, maxResults }, signal);
      if (result.content) answers.push({ query, text: result.content });
      for (const source of result.sources || []) {
        const key = normalizeUrl(source.url);
        if (!key) continue;
        if (!seen.has(key)) {
          seen.set(key, {
            url: source.url,
            title: source.title || '',
            snippet: source.snippet || '',
            publishedAt: source.publishedAt,
            foundBy: [query],
          });
        } else {
          seen.get(key).foundBy.push(query);
        }
      }
    } catch (error) {
      failures.push({ query, error: error.message });
    }
  }
  return { sources: [...seen.values()], answers, failures };
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid'].forEach((p) => u.searchParams.delete(p));
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.href;
  } catch {
    return String(url || '').trim();
  }
}

export function sameSite(a, b) {
  try { return new URL(a).host === new URL(b).host; } catch { return false; }
}
