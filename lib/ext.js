'use strict';
// ADDON 1 — "EXT.to Torrents"
//
// EXT.to (https://ext.to) browse pages are server-rendered and searchable natively by
// IMDb ID:  GET /browse/?imdb_id=tt15239678  -> 200, "(411 Results)", 50 rows/page,
// pagination via ?page=N. Each result row (a <tr> in table.search-table) carries:
//   release title (a.torrent-title-link, data-tooltip), detail-page URL (slug ending
//   in the numeric torrent id), a magnet button (a.search-magnet-btn, data-id), and
//   Size / Files / Age / Seeds / Leechs / Source cells (div.add-block-wrapper).
//
// The browse HTML contains NO magnets or infoHashes. Magnets live on the per-torrent
// detail pages, which are Cloudflare-walled from datacenter IPs (verified: HTTP 403
// from the sandbox even with session cookies + full browser headers). Design: fetch
// detail pages through a FlareSolverr sidecar when FLARESOLVERR_URL is set
// (POST {cmd:"request.get", url, maxTimeout} -> solution.response HTML), else try a
// direct fetch and degrade gracefully (streams without a magnet are dropped, never
// a crash; the parse counts are still exposed via /health and x-ext-* debug fields).

const { fetchText, TtlCache, pool } = require('./util');

const BASE = 'https://ext.to';
const browseCache = new TtlCache(); // 10 min, per spec
const magnetCache = new TtlCache(); // 6 h
const BROWSE_TTL = 10 * 60 * 1000;
const MAGNET_TTL = 6 * 60 * 60 * 1000;
const MAX_PAGES_MOVIE = 1;
const MAX_PAGES_SERIES = 3;
const MAX_MAGNETS_SOLVER = 12; // solver round-trips are slow (up to ~60 s each)
const MAX_MAGNETS_DIRECT = 25;

const status = {
  lastBrowse: null, // {imdb, at, httpStatus, total, parsed}
  lastError: null,
  solverConfigured: !!process.env.FLARESOLVERR_URL,
};

function getStatus() { return status; }

function cellValue(row, label) {
  const re = new RegExp(`add-block">${label}</span>\\s*<span[^>]*>([\\s\\S]*?)</span>`);
  const m = row.match(re);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function parseBrowse(html) {
  // EXT formats thousands with a space on some pages ("2 378 Results").
  const totalM = html.match(/\(([\d][\d\s,]*) Results\)/);
  const total = totalM ? parseInt(totalM[1].replace(/[\s,]/g, ''), 10) : null;
  const results = [];
  const rows = html.split('<tr>');
  for (const row of rows) {
    if (!row.includes('torrent-title-link')) continue;
    const linkM = row.match(/<a href="([^"]+)" class="torrent-title-link" data-tooltip="([^"]*)"/);
    if (!linkM) continue;
    const idM = row.match(/search-magnet-btn[^>]*data-id="(\d+)"/);
    const seeds = cellValue(row, 'Seeds');
    const leechs = cellValue(row, 'Leechs');
    results.push({
      title: linkM[2].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"'),
      detailPath: linkM[1],
      torrentId: idM ? idM[1] : null,
      size: cellValue(row, 'Size'),
      files: cellValue(row, 'Files'),
      seeders: seeds != null ? parseInt(seeds.replace(/,/g, ''), 10) || 0 : null,
      leechers: leechs != null ? parseInt(leechs.replace(/,/g, ''), 10) || 0 : null,
    });
  }
  return { total, results };
}

async function fetchBrowsePage(imdb, page) {
  const url = `${BASE}/browse/?imdb_id=${encodeURIComponent(imdb)}${page > 1 ? `&page=${page}` : ''}`;
  const cached = browseCache.get(url);
  if (cached) return cached;
  const r = await fetchText(url, { timeoutMs: 30000 });
  if (!r.ok) {
    status.lastError = `browse ${imdb} p${page}: HTTP ${r.status}`;
    throw new Error(`EXT browse HTTP ${r.status}`);
  }
  const parsed = parseBrowse(r.text);
  status.lastBrowse = { imdb, page, at: new Date().toISOString(), httpStatus: r.status, total: parsed.total, parsed: parsed.results.length };
  browseCache.set(url, parsed, BROWSE_TTL);
  return parsed;
}

async function fetchViaSolver(url) {
  const solver = process.env.FLARESOLVERR_URL.replace(/\/+$/, '');
  const r = await fetchText(`${solver}/v1`, {
    method: 'POST',
    timeoutMs: 90000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
  });
  if (!r.ok) throw new Error(`solver HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  if (j.status !== 'ok' || !j.solution || !j.solution.response) {
    throw new Error(`solver: ${j.message || 'no solution'}`);
  }
  return j.solution.response;
}

// Resolve one detail page to an infoHash (hex, lowercase) or null.
async function resolveMagnet(detailPath) {
  const url = BASE + detailPath;
  const cached = magnetCache.get(url);
  if (cached !== null) return cached;
  let html = null;
  try {
    html = process.env.FLARESOLVERR_URL
      ? await fetchViaSolver(url)
      : (await fetchText(url, { timeoutMs: 15000 })).text;
  } catch { html = null; }
  let infoHash = null;
  if (html) {
    const m = html.replace(/&amp;/g, '&').match(/magnet:\?xt=urn:btih:([A-Za-z0-9]+)/);
    if (m) {
      let h = m[1];
      if (/^[A-Za-z2-7]{32}$/.test(h)) h = base32ToHex(h); // base32 btih -> hex
      if (/^[0-9a-fA-F]{40}$/.test(h)) infoHash = h.toLowerCase();
    }
  }
  magnetCache.set(url, infoHash, MAGNET_TTL);
  return infoHash;
}

function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function episodeFilter(results, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const reSE = new RegExp(`S${s}E${e}(?!\\d)`, 'i');
  const reX = new RegExp(`(?<!\\d)${Number(season)}x${e}(?!\\d)`, 'i');
  return results.filter((r) => reSE.test(r.title) || reX.test(r.title));
}

async function getExtStreams(type, imdb, season, episode) {
  const maxPages = type === 'series' ? MAX_PAGES_SERIES : MAX_PAGES_MOVIE;
  let all = [];
  let total = null;
  for (let p = 1; p <= maxPages; p++) {
    try {
      const page = await fetchBrowsePage(imdb, p);
      if (total === null) total = page.total;
      if (!page.results.length) break;
      all = all.concat(page.results);
      if (all.length >= (total || Infinity)) break;
    } catch {
      if (p === 1) return { streams: [], parsed: 0, total: null, magnets: 0 };
      break;
    }
  }
  let candidates = all;
  if (type === 'series') candidates = episodeFilter(all, season, episode);
  candidates.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  const cap = process.env.FLARESOLVERR_URL ? MAX_MAGNETS_SOLVER : MAX_MAGNETS_DIRECT;
  const chosen = candidates.slice(0, cap);
  const hashes = await pool(chosen, 4, (c) => resolveMagnet(c.detailPath));
  const streams = [];
  chosen.forEach((c, i) => {
    const infoHash = hashes[i];
    if (!infoHash) return;
    streams.push({
      name: 'EXT.to',
      title: `${c.title}\n💾 ${c.size || '?'} 👤 ${c.seeders != null ? c.seeders : '?'}`,
      infoHash,
      behaviorHints: { bingeGroup: `ext-${imdb}` },
    });
  });
  return { streams, parsed: all.length, total, magnets: streams.length };
}

const manifest = {
  id: 'app.matryx.ext',
  version: '1.0.0',
  name: 'EXT.to Torrents',
  description:
    'Torrent streams scraped from EXT.to (the index that absorbed TorrentGalaxy\'s community). ' +
    'Searches EXT.to natively by IMDb ID; magnets are resolved from torrent detail pages ' +
    '(via FlareSolverr sidecar when configured). Free P2P, no account, no debrid.',
  logo: 'https://ext.to/favicon.ico',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: false },
};

module.exports = { manifest, getExtStreams, getStatus };
