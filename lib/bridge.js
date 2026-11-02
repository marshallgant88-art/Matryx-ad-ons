'use strict';
// ADDON 2 — "OnlyFlix Bridge"
//
// Resolves the five public embed providers that OnlyFlix (onlyflix.to) fronts to DIRECT
// stream URLs, and returns only the ones that actually resolve. MATRYX plays streams
// with a direct `url` in its own player; streams with only `externalUrl` are handed to
// an external browser — so embed page URLs are NEVER returned as streams.
//
//   Balance   https://balance.medmedia03.wiki/embed/movie/<TMDB>   (TMDB ids!)
//             https://balance.medmedia03.wiki/embed/tv/<TMDB>/<s>/<e>
//   Nontongo  https://sv2.nontongo.stream/soap/movie/<IMDb>  /soap/tv/<IMDb>/<s>/<e>
//   vidfast   https://vidfast.vc/movie/<IMDb>                /tv/<IMDb>/<s>/<e>
//   vidapi    https://vidapi.xyz/embed/movie/<IMDb>          /embed/tv/<IMDb>/<s>/<e>
//   CDNM      https://share.cdnm.ink/embed/imdb/<IMDb>       (movies only)
//
// REFERER KEY (found 2026-11-01): the providers refuse BARE visits (vidapi served a
// 404 overlay from both a datacenter browser and a home phone) but answer when the
// request carries OnlyFlix as its referer (https://onlyflix.to/) — the way OnlyFlix
// itself sends visitors. Every chain below starts with that referer; nested fetches
// keep the embedding page as referer, which preserves the chain.
//
// ROUND-2 CHAINS (traced + proven live 2026-11-01, see BRIDGE-ROUND2.md):
//   vidapi    embed page -> house player link stream.vidapi.xyz/swish?id=<id>
//             -> swish.js rewrites the iframe to https://vscdn.xyz/e/<id>
//             -> vscdn page's Dean-Edwards-packed JW script holds
//                var links={hls4:"/stream/.../master.m3u8", hls3:..., hls2:...}
//             -> first candidate that serves #EXTM3U wins. MOVIES ONLY: the series
//             embed offers no swish player; it delegates to third-party wrappers
//             (vsembed.ru, cineby.hair) that are not vidapi's own chain.
//   Nontongo  soap page embeds "tmdbId":<n> -> GET /01russia/multisourcesoap.php
//             ?id=<tmdb>&type=movie (tv: &season=&episode=&type=tv), referer = soap
//             page -> the sources page contains a literal `sources = [{html,file}]`
//             array of direct HLS URLs (Cloudflare-Worker CDN, "#file.m3u8" suffix
//             is a fragment and is stripped) -> first that serves #EXTM3U wins.
//   Balance   JSON API on the embed host (numbered medmedia03.wiki mirrors):
//             GET /embed-api/availability/title/<movie|tv>/<tmdb>[/<s>/<e>]
//             -> per-provider rows with signed `ticket`s ->
//             GET /embed-api/availability/play/<ticket> -> {stream:{url:
//             "/embed-media/<token>"}} -> that proxy URL serves the master playlist
//             itself (variants are proxied too) -> verified #EXTM3U.
//             Balance is TMDB-addressed; the IMDb->TMDB id is obtained WITHOUT any
//             API key from the Nontongo soap page / vidapi embed page, which both
//             embed the title's TMDB id (TMDB_API_KEY /find is used when set).
//   vidfast   UNRESOLVED. Next.js app: no iframe, media URL, or API string exists
//             in the page or its first-party bundles; the player lives in lazy
//             webpack chunks behind string-array obfuscation. The generic scan
//             chain still runs (in case the page shape changes), then gives up.
//   CDNM      UNRESOLVED. The embed endpoint answers every title tested (10/10,
//             incl. Big Buck Bunny) with HTTP 404 and a generic page: "The video
//             has been removed at the request of the copyright holder." The fetch
//             still runs so a per-title exception would be caught if one appears.
//
// ROUND-4 ADDITION (2026-11-02, see BRIDGE-ROUND4.md):
//   Vidora    https://www.vidspark.to/api/vidora/v1/movie/<TMDB>
//             (tv: /v1/tv/<TMDB>/<s>/<e>) — a JSON API on the VidSpark
//             front, gated by the site's PUBLIC client key (sent as the
//             x-player-key header; the key ships in VidSpark's own JS
//             bundle to every visitor — free endpoint, no account, no
//             payment) and requiring the VidSpark title page as Referer
//             (the OnlyFlix referer is answered 403). Returns
//             {result, sources:[{url}]} with signed paretocdn HLS URLs
//             (~12 h window) -> verified #EXTM3U before returning. Vidora
//             encodes its OWN catalog, skewed to the newest releases:
//             theatres-only titles resolve, back-catalog staples answer
//             "Movie not yet encoded". The series endpoint exists but no
//             episode was verified in round 4.

const vm = require('vm');
const { fetchText, TtlCache, scanMediaUrls, deescape } = require('./util');

const cache = new TtlCache(); // resolved stream lists, 30 min
const CACHE_TTL = 30 * 60 * 1000;

const ONLYFLIX = 'https://onlyflix.to/';

const providerStatus = {}; // key -> {label, lastCheck, outcome, detail}
function record(key, label, outcome, detail) {
  providerStatus[key] = { label, lastCheck: new Date().toISOString(), outcome, detail };
}
function getStatus() { return providerStatus; }

const LABELS = {
  balance: 'Balance · HD',
  nontongo: 'Nontongo · HD',
  vidfast: 'VidFast · HD',
  vidapi: 'vidapi · HD',
  vidora: 'Vidora · HD',
  cdnm: 'CDNM · HD',
};

function getPage(url, referer, timeoutMs = 25000) {
  return fetchText(url, { timeoutMs, headers: referer ? { Referer: referer } : {} });
}

// A candidate counts as resolved only if it actually serves an HLS playlist.
async function verifyPlaylist(url, referer) {
  try {
    const r = await fetchText(url, {
      timeoutMs: 15000,
      headers: { ...(referer ? { Referer: referer } : {}), Range: 'bytes=0-2047' },
    });
    return r.status < 300 && r.text.trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

// ---------- IMDb -> TMDB (keyless first) ----------

async function tmdbFromKey(imdb, type) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const r = await fetchText(
    `https://api.themoviedb.org/3/find/${encodeURIComponent(imdb)}?api_key=${key}&external_source=imdb_id`,
    { timeoutMs: 15000 }
  );
  if (!r.ok) return null;
  const j = JSON.parse(r.text);
  const list = type === 'series' ? j.tv_results : j.movie_results;
  return list && list.length ? String(list[0].id) : null;
}

// Both the Nontongo soap page and the vidapi embed page embed the title's TMDB id.
async function tmdbFromProviders(imdb, type, season, episode) {
  const soapUrl = type === 'series'
    ? `https://sv2.nontongo.stream/soap/tv/${imdb}/${season}/${episode}`
    : `https://sv2.nontongo.stream/soap/movie/${imdb}`;
  try {
    const r = await getPage(soapUrl, ONLYFLIX, 20000);
    const m = r.text.match(/"tmdbId"\s*:\s*(\d+)/);
    if (m) return m[1];
  } catch { /* fall through */ }
  const vidUrl = type === 'series'
    ? `https://vidapi.xyz/embed/tv/${imdb}/${season}/${episode}`
    : `https://vidapi.xyz/embed/movie/${imdb}`;
  try {
    const r = await getPage(vidUrl, ONLYFLIX, 20000);
    const m = deescape(r.text).match(/[?&]tmdb=(\d+)/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return null;
}

async function tmdbForImdb(imdb, type, season, episode) {
  return (await tmdbFromKey(imdb, type).catch(() => null))
    || (await tmdbFromProviders(imdb, type, season, episode).catch(() => null));
}

// ---------- vidapi ----------

// Dean-Edwards packer: capture what the page's eval() would receive (the unpacked
// source string) WITHOUT executing the payload — the packer function itself is pure
// string manipulation; our capture callback just records its return value.
function unpackPackedScript(html) {
  const start = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (start < 0) return null;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  const expr = html.slice(start, end).trim();
  let captured = null;
  const sandbox = { __capture: (s) => { captured = s; } };
  try {
    vm.createContext(sandbox);
    vm.runInContext(expr.replace(/^eval/, '__capture'), sandbox, { timeout: 5000 });
  } catch {
    return null;
  }
  return typeof captured === 'string' && captured.length > 100 ? captured : null;
}

async function resolveVidapi(type, imdb, season, episode) {
  const label = LABELS.vidapi;
  const embedUrl = type === 'series'
    ? `https://vidapi.xyz/embed/tv/${imdb}/${season}/${episode}`
    : `https://vidapi.xyz/embed/movie/${imdb}`;
  const r1 = await getPage(embedUrl, ONLYFLIX);
  if (r1.status === 404) {
    record('vidapi', label, 'unresolved', 'embed page 404 — provider has no entry for this title');
    return null;
  }
  const embed = deescape(r1.text);
  const swish = embed.match(/https:\/\/stream\.vidapi\.xyz\/swish\?id=([A-Za-z0-9]+)/);
  if (!swish) {
    record('vidapi', label, 'unresolved', type === 'series'
      ? 'series embed offers no house (swish) player — it delegates to third-party wrappers (vsembed.ru / cineby.hair), which are separate services'
      : 'no swish player link on the embed page for this title');
    return null;
  }
  const id = swish[1];
  const swishUrl = `https://stream.vidapi.xyz/swish?id=${id}&ref=${encodeURIComponent(ONLYFLIX)}`;
  const r2 = await getPage(swishUrl, r1.url);
  // swish.js rewrites the wrapper iframe to the real player host ("<base>" + id).
  let playerBase = 'https://vscdn.xyz/e/';
  const jsMatch = r2.text.match(/<script[^>]+src=["']([^"']+\.js)["']/i);
  if (jsMatch) {
    try {
      const jsUrl = new URL(jsMatch[1], swishUrl).href;
      if (/swish\.js/.test(jsUrl)) {
        const rj = await getPage(jsUrl, swishUrl);
        const base = rj.text.match(/["'](https:\/\/[^"']+\/)["']\s*\+\s*myUrl/);
        if (base) playerBase = base[1];
      }
    } catch { /* keep default base */ }
  }
  const playerUrl = playerBase + id;
  const r3 = await getPage(playerUrl, swishUrl);
  if (r3.status !== 200) {
    record('vidapi', label, 'unresolved', `player page (${new URL(playerUrl).host}) HTTP ${r3.status}`);
    return null;
  }
  // Media may be plain in the page (other titles/shapes); otherwise unpack the
  // packed JW setup and read its `links` table (hls4 -> hls3 -> hls2 failover).
  let candidates = scanMediaUrls(r3.text);
  if (!candidates.length) {
    const unpacked = unpackPackedScript(r3.text);
    const linksJson = unpacked && unpacked.match(/var links=(\{[^}]*\})/);
    if (linksJson) {
      try {
        const links = JSON.parse(linksJson[1]);
        for (const k of ['hls4', 'hls3', 'hls2']) {
          if (links[k]) candidates.push(new URL(links[k], playerUrl).href);
        }
      } catch { /* fall through */ }
    }
  }
  for (const c of candidates) {
    if (await verifyPlaylist(c, playerUrl)) {
      record('vidapi', label, 'resolved', `swish -> ${new URL(playerUrl).host} player -> verified HLS playlist`);
      return c;
    }
  }
  record('vidapi', label, 'unresolved', 'player page reached but no candidate served an HLS playlist');
  return null;
}

// ---------- Vidora (round 4: new-release specialist, own encode catalog) ----------

// VidSpark's public client key — a static constant in the site's own JS
// bundle, served to every visitor's browser. Free endpoint: there is no
// account, signup, or payment anywhere in this flow. If VidSpark rotates
// the key, the API answers 403 and the resolver records exactly that.
const VIDORA_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';

async function resolveVidora(type, imdb, season, episode) {
  const label = LABELS.vidora;
  const tmdb = await tmdbForImdb(imdb, type, season, episode).catch(() => null);
  if (!tmdb) {
    record('vidora', label, 'unresolved', 'no TMDB id found for this title');
    return null;
  }
  const pageUrl = type === 'series'
    ? `https://www.vidspark.to/tv/${tmdb}`
    : `https://www.vidspark.to/movie/${tmdb}`;
  const apiUrl = type === 'series'
    ? `https://www.vidspark.to/api/vidora/v1/tv/${tmdb}/${season}/${episode}`
    : `https://www.vidspark.to/api/vidora/v1/movie/${tmdb}`;
  let r;
  try {
    r = await fetchText(apiUrl, {
      timeoutMs: 20000,
      headers: { Referer: pageUrl, 'x-player-key': VIDORA_KEY },
    });
  } catch (err) {
    record('vidora', label, 'unresolved', `API request failed: ${err.message}`);
    return null;
  }
  if (r.status === 403) {
    record('vidora', label, 'unresolved', 'API 403 — the public client key may have rotated (it lives in VidSpark\'s JS bundle)');
    return null;
  }
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* fall through */ }
  if (!j || !j.result || !Array.isArray(j.sources) || !j.sources.length || !j.sources[0].url) {
    record('vidora', label, 'unresolved', j && j.message
      ? `provider reports: ${j.message}`
      : `API HTTP ${r.status} with no sources`);
    return null;
  }
  const url = j.sources[0].url;
  if (await verifyPlaylist(url, pageUrl)) {
    record('vidora', label, 'resolved', 'VidSpark API -> paretocdn HLS -> verified playlist');
    return url;
  }
  record('vidora', label, 'unresolved', 'API returned a source that did not serve an HLS playlist');
  return null;
}

// ---------- Nontongo ----------

async function resolveNontongo(type, imdb, season, episode) {
  const label = LABELS.nontongo;
  const soapUrl = type === 'series'
    ? `https://sv2.nontongo.stream/soap/tv/${imdb}/${season}/${episode}`
    : `https://sv2.nontongo.stream/soap/movie/${imdb}`;
  const r1 = await getPage(soapUrl, ONLYFLIX);
  if (r1.status !== 200) {
    record('nontongo', label, 'unresolved', `soap page HTTP ${r1.status} (upstream is intermittently 504)`);
    return null;
  }
  const tmdb = (r1.text.match(/"tmdbId"\s*:\s*(\d+)/) || [])[1];
  if (!tmdb) {
    record('nontongo', label, 'unresolved', 'soap page carried no tmdbId — no entry for this title');
    return null;
  }
  const multiUrl = type === 'series'
    ? `https://sv2.nontongo.stream/01russia/multisourcesoap.php?id=${tmdb}&season=${season}&episode=${episode}&type=tv`
    : `https://sv2.nontongo.stream/01russia/multisourcesoap.php?id=${tmdb}&type=movie`;
  const r2 = await getPage(multiUrl, r1.url, 30000);
  if (r2.status !== 200) {
    record('nontongo', label, 'unresolved', `multisourcesoap page HTTP ${r2.status}`);
    return null;
  }
  const arrMatch = r2.text.match(/sources\s*=\s*(\[[\s\S]*?\])\s*;/);
  let files = [];
  if (arrMatch) {
    try {
      files = JSON.parse(arrMatch[1])
        .map((s) => s && s.file)
        .filter((f) => typeof f === 'string')
        .map((f) => f.split('#')[0]); // "#file.m3u8" is a fragment, never sent
    } catch { /* fall through to scanner */ }
  }
  if (!files.length) files = scanMediaUrls(r2.text);
  for (const f of files) {
    if (await verifyPlaylist(f, multiUrl)) {
      record('nontongo', label, 'resolved', 'soap page -> multisourcesoap sources[] -> verified HLS playlist');
      return f;
    }
  }
  record('nontongo', label, 'unresolved', 'multisourcesoap page carried no working source URL');
  return null;
}

// ---------- Balance ----------

async function resolveBalance(type, imdb, season, episode) {
  const label = LABELS.balance;
  const tmdb = await tmdbForImdb(imdb, type, season, episode);
  if (!tmdb) {
    record('balance', label, 'unresolved', 'could not obtain a TMDB id for this title (no TMDB_API_KEY, and neither Nontongo nor vidapi exposed one)');
    return null;
  }
  const entry = type === 'series' ? `tv/${tmdb}/${season}/${episode}` : `movie/${tmdb}`;
  const r1 = await getPage(`https://balance.medmedia03.wiki/embed/${entry}`, ONLYFLIX);
  if (r1.status !== 200) {
    record('balance', label, 'unresolved', `embed page HTTP ${r1.status}`);
    return null;
  }
  const host = new URL(r1.url).origin; // numbered mirror that actually served us
  const titleUrl = `${host}/embed-api/availability/title/${entry}`;

  const readyRows = async () => {
    const r = await getPage(titleUrl, r1.url, 20000);
    if (r.status !== 200) return { rows: [], checking: false, status: r.status };
    let j;
    try { j = JSON.parse(r.text); } catch { return { rows: [], checking: false, status: r.status }; }
    const rows = [];
    let checking = false;
    for (const prov of Object.values(j.providers || {})) {
      if (prov.state === 'checking') checking = true;
      for (const row of prov.rows || []) {
        if (row.status === 'ready' && row.ticket && !row.hidden) {
          rows.push({ ticket: row.ticket, quality: parseInt(row.quality, 10) || 0 });
        }
      }
    }
    rows.sort((a, b) => b.quality - a.quality);
    return { rows, checking, status: r.status };
  };

  let { rows, checking } = await readyRows();
  if (!rows.length && checking) {
    // Providers were still assembling sources; one bounded retry.
    await new Promise((res) => setTimeout(res, 3500));
    ({ rows } = await readyRows());
  }
  if (!rows.length) {
    record('balance', label, 'unresolved', 'availability API returned no ready sources for this title');
    return null;
  }
  for (const row of rows.slice(0, 3)) {
    try {
      const rp = await getPage(`${host}/embed-api/availability/play/${row.ticket}`, r1.url, 20000);
      if (rp.status !== 200) continue;
      const streamUrl = JSON.parse(rp.text)?.stream?.url;
      if (!streamUrl) continue;
      const abs = new URL(streamUrl, host).href;
      if (await verifyPlaylist(abs, r1.url)) {
        record('balance', label, 'resolved', `availability API -> ticket -> /embed-media proxy -> verified HLS playlist (${row.quality ? row.quality + 'p row' : 'auto'})`);
        return abs;
      }
    } catch { /* try next row */ }
  }
  record('balance', label, 'unresolved', 'play API returned no stream that served an HLS playlist');
  return null;
}

// ---------- vidfast / CDNM (generic scan chain, round-2 findings recorded) ----------

function nestedPlayerUrls(html, baseUrl) {
  const t = deescape(html);
  const urls = new Set();
  for (const m of t.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], baseUrl).href;
      if (!/youtube|google|recaptcha|ads|doubleclick/i.test(u)) urls.add(u);
    } catch { /* ignore */ }
  }
  for (const m of t.matchAll(/https?:\/\/[^\s"'<>]*swish\?id=[^\s"'<>]+/gi)) urls.add(m[0]);
  return [...urls].slice(0, 2);
}

function firstPartyScripts(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.origin === new URL(baseUrl).origin && /\.js($|\?)/.test(u.pathname + u.search)) out.push(u.href);
    } catch { /* ignore */ }
  }
  return out.slice(0, 3);
}

async function genericScan(key, startUrl, failDetail) {
  const label = LABELS[key];
  const r1 = await getPage(startUrl, ONLYFLIX);
  if (key === 'cdnm' && /removed at the request of the copyright holder/i.test(r1.text)) {
    record(key, label, 'unresolved', 'embed endpoint serves its generic "video removed" page (HTTP 404) — verified for 10/10 titles incl. Big Buck Bunny; the endpoint is blanket-down, not per-title');
    return null;
  }
  if (r1.status === 404) {
    record(key, label, 'unresolved', 'embed page 404 — provider has no entry for this title');
    return null;
  }
  let media = scanMediaUrls(r1.text);
  if (media.length) {
    record(key, label, 'resolved', 'direct file on embed page');
    return media[0];
  }
  for (const nu of nestedPlayerUrls(r1.text, r1.url)) {
    if (nu === startUrl) continue;
    const r2 = await getPage(nu, r1.url).catch(() => null);
    if (!r2) continue;
    media = scanMediaUrls(r2.text);
    if (media.length) {
      record(key, label, 'resolved', 'direct file on nested player page');
      return media[0];
    }
  }
  for (const su of firstPartyScripts(r1.text, r1.url)) {
    const rs = await getPage(su, r1.url).catch(() => null);
    if (!rs) continue;
    media = scanMediaUrls(rs.text);
    if (media.length) {
      record(key, label, 'resolved', 'direct file in script bundle');
      return media[0];
    }
  }
  record(key, label, 'unresolved', failDetail);
  return null;
}

// ---------- dispatch ----------

const RESOLVERS = {
  vidora: resolveVidora,
  balance: resolveBalance,
  nontongo: resolveNontongo,
  vidfast: (type, imdb, season, episode) => genericScan(
    'vidfast',
    type === 'series' ? `https://vidfast.vc/tv/${imdb}/${season}/${episode}` : `https://vidfast.vc/movie/${imdb}`,
    'Next.js app — round-2 trace: no iframe/media/API URL exists in the page or first-party bundles; the player is assembled at runtime from lazy, string-array-obfuscated webpack chunks (packed/encoded payloads). Needs a headless browser.'
  ),
  vidapi: resolveVidapi,
  cdnm: (type, imdb) => (type === 'series'
    ? (record('cdnm', LABELS.cdnm, 'skipped', 'CDNM embed is movie-only'), Promise.resolve(null))
    : genericScan('cdnm', `https://share.cdnm.ink/embed/imdb/${imdb}`, 'no media found on embed page or nested players')),
};

async function getBridgeStreams(type, imdb, season, episode) {
  const cacheKey = `${type}:${imdb}:${season || ''}:${episode || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const keys = ['vidora', 'balance', 'nontongo', 'vidfast', 'vidapi', 'cdnm'];
  const results = await Promise.all(
    keys.map((k) => RESOLVERS[k](type, imdb, season, episode).catch((err) => {
      record(k, LABELS[k], 'unresolved', `resolver error: ${err.message}`);
      return null;
    }))
  );
  const streams = [];
  keys.forEach((k, i) => {
    const url = results[i];
    if (!url) return;
    streams.push({
      name: LABELS[k],
      title: `Direct stream · ${new URL(url).host}${/\.mp4($|\?)/.test(url) ? ' · MP4' : ' · HLS'}`,
      url,
    });
  });
  cache.set(cacheKey, streams, CACHE_TTL);
  return streams;
}

const manifest = {
  id: 'app.matryx.onlyflixbridge',
  version: '1.2.0',
  name: 'OnlyFlix Bridge',
  description:
    'Direct streams resolved from public embed providers — the five OnlyFlix fronts ' +
    '(Balance, Nontongo, VidFast, vidapi, CDNM) plus Vidora via VidSpark — labeled ' +
    'per provider. Only providers that resolve to a real video file/playlist are ' +
    'returned — never embed pages.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: false },
};

module.exports = { manifest, getBridgeStreams, getStatus, LABELS };
