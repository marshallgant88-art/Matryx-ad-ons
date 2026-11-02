'use strict';
// Shared helpers: HTTP fetch with browser UA + timeout, TTL cache, media-URL scanning.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

async function fetchText(url, { timeoutMs = 20000, headers = {}, method = 'GET', body = null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text };
  } finally {
    clearTimeout(t);
  }
}

// Tiny in-memory TTL cache.
class TtlCache {
  constructor() { this.map = new Map(); }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.map.delete(key); return null; }
    return e.val;
  }
  set(key, val, ttlMs) { this.map.set(key, { val, exp: Date.now() + ttlMs }); }
}

// Run async fn over items with bounded concurrency; returns results in order (nulls on error).
async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function deescape(s) {
  return s
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u003[aA]/g, ':')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

// Find direct media URLs (.m3u8 / .mp4) in a blob of HTML/JS text.
function scanMediaUrls(text) {
  const t = deescape(text);
  const found = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const u = m[0].replace(/[),;]+$/, '');
    // Skip obvious non-content placeholders.
    if (/sample|trailer|placeholder|example\.|w3\.org/i.test(u)) continue;
    found.add(u);
  }
  return [...found];
}

module.exports = { fetchText, TtlCache, pool, scanMediaUrls, deescape, UA };
