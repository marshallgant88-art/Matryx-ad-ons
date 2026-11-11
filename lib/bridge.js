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

// ROUND-5 OUTCOME (2026-11-10, bridge v1.3.0 -> v1.3.1): VixSrc and VidSrc
// resolvers were built for the "Cinema HD crawler" expansion, deployed in
// v1.3.0, live-tested from Render's egress on four titles (Dune: Part Two,
// Breaking Bad S1E1, The Invite, Street Fighter) and REMOVED in v1.3.1 under
// the standing rule that a provider is kept only on live proof -- both
// returned zero verified streams:
//   VixSrc  vixsrc.to answers HTTP 403 from Render's egress (as it did from
//           the sandbox); the page loads only from a real browser, so no
//           server-side resolver can reach the window.masterPlaylist chain.
//   VidSrc  vidsrc.xyz embed fetch fails; vidsrc.to is a shell delegating to
//           vidsrc.sh and exposes no data-hash server list -- the classic
//           rcp/prorcp chain no longer exists on the live mirrors, and the
//           embed is reCAPTCHA-gated besides.
// The keyless TMDB mapping added in round 5 (Cinemeta moviedb_id fallback in
// tmdbForImdb) is retained: it only fires where the older routes returned
// null and is shared by the surviving resolvers.

// ROUND-6 (2026-11-10, bridge v1.4.0) — two upgrades adopted from the
// Cinema HD / ShowBox teardown (~/workspace/apk-teardown/TEARDOWN-REPORT.md):
//   1. REMOTE-CONFIG ROSTER. The provider roster (enabled flag, priority
//      order, per-provider timeout) lives in roster.json at the repo root
//      and is fetched from the repo's raw GitHub URL at runtime (10-min
//      TTL, background refresh, last-good kept on any failure, baked-in
//      roster = today's exact behavior as the fallback). HARD RULE: the
//      config is DATA ONLY — it can enable/disable/reorder/timeout
//      providers that exist in the code registry (RESOLVERS); it can never
//      add a provider, a URL, or code. (Cinema HD executed downloaded JS
//      providers; this bridge deliberately does not — and when Cinema HD's
//      remote config was deleted, the app died; hence the baked-in
//      fallback here.)
//   2. GENERIC HOSTER-RESOLVER STAGE (resolveEmbed). When a built-in
//      provider surfaces a page/embed URL instead of a direct media URL,
//      the URL is routed through a shared stage that extracts direct media
//      via the common player patterns (JW Player / video.js sources,
//      file:"..." vars, <source> tags, bare .m3u8/.mp4 URLs, one iframe
//      hop) and returns only media that validates (playlist magic, ftyp
//      signature, or media content-type), labeled "<Provider> · <Hoster>".
//      Providers' existing direct paths are untouched.

const vm = require('vm');
const { fetchText, TtlCache, scanMediaUrls, deescape, UA } = require('./util');

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

// Cinemeta (Stremio's own public metadata addon, no key) carries the TMDB id
// as `moviedb_id` in its meta response — a free IMDb->TMDB mapping that works
// server-side. Verified 2026-11-10: agreed with the Nontongo scrape on all
// four test titles (693134 / 1396 / 950028 / 1153576).
async function tmdbFromCinemeta(imdb, type) {
  const kind = type === 'series' ? 'series' : 'movie';
  const r = await fetchText(`https://v3-cinemeta.strem.io/meta/${kind}/${encodeURIComponent(imdb)}.json`, { timeoutMs: 15000 });
  if (!r.ok) return null;
  const j = JSON.parse(r.text);
  const id = j && j.meta && j.meta.moviedb_id;
  return id ? String(id) : null;
}

async function tmdbForImdb(imdb, type, season, episode) {
  return (await tmdbFromKey(imdb, type).catch(() => null))
    || (await tmdbFromProviders(imdb, type, season, episode).catch(() => null))
    || (await tmdbFromCinemeta(imdb, type).catch(() => null));
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
  // v1.4 fallback: if the API handed back a page/embed URL instead of a
  // playlist, route it through the generic hoster stage.
  if (looksLikePageUrl(url)) {
    const hosted = await resolveEmbed(url, pageUrl).catch(() => null);
    if (hosted) {
      record('vidora', label, 'resolved', `VidSpark API -> embed page -> generic hoster stage (${hosted.hoster}) -> validated media`);
      return { url: hosted.url, name: `${label} · ${hosted.hoster}` };
    }
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
    // v1.4 fallback: a sources[] entry that is a page/embed URL rather than
    // a playlist goes through the generic hoster stage.
    if (looksLikePageUrl(f)) {
      const hosted = await resolveEmbed(f, multiUrl).catch(() => null);
      if (hosted) {
        record('nontongo', label, 'resolved', `multisourcesoap source was an embed page -> generic hoster stage (${hosted.hoster}) -> validated media`);
        return { url: hosted.url, name: `${label} · ${hosted.hoster}` };
      }
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
      // v1.4 fallback: a page-shaped play URL (an embed page instead of the
      // playlist proxy) goes through the generic hoster stage.
      if (looksLikePageUrl(abs)) {
        const hosted = await resolveEmbed(abs, r1.url).catch(() => null);
        if (hosted) {
          record('balance', label, 'resolved', `availability API -> ticket -> embed page -> generic hoster stage (${hosted.hoster}) -> validated media`);
          return { url: hosted.url, name: `${label} · ${hosted.hoster}` };
        }
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
  // v1.4 fallback: the generic hoster stage reads player setups the plain
  // scan cannot (relative URLs, file:/src: vars) and validates the media.
  const hosted = await resolveEmbed(startUrl, ONLYFLIX).catch(() => null);
  if (hosted) {
    record(key, label, 'resolved', `generic hoster stage -> ${hosted.hoster} embed -> validated media`);
    return { url: hosted.url, name: `${label} · ${hosted.hoster}` };
  }
  record(key, label, 'unresolved', failDetail);
  return null;
}

// ---------- generic hoster-resolver stage (v1.4) ----------

// A URL that ends in .m3u8/.mp4 is direct media: if it fails verification it
// is dead media, and re-fetching it as a "page" cannot help. Anything else a
// provider hands us may be an embed page — that is what this stage is for.
function looksLikePageUrl(url) { return !/\.(m3u8|mp4)($|\?)/i.test(url); }

function hosterName(pageUrl) {
  try {
    const h = new URL(pageUrl).hostname.replace(/^www\./, '');
    const first = h.split('.')[0] || h;
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch { return 'Hoster'; }
}

// Extract direct-media candidates from an embed page: JW Player / file-var
// setups, video.js-style sources, <source> tags, then bare media URLs.
// Relative URLs are resolved against the page; order is preserved.
function extractEmbedMedia(html, pageUrl) {
  const t = deescape(html);
  const found = [];
  const push = (u) => {
    if (!u) return;
    try {
      const abs = new URL(u, pageUrl).href;
      if (/\.(m3u8|mp4)($|\?)/i.test(abs) && !found.includes(abs)) found.push(abs);
    } catch { /* ignore */ }
  };
  for (const m of t.matchAll(/["']?file["']?\s*:\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of t.matchAll(/\bfile\s*=\s*["']([^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi)) push(m[1]);
  for (const m of t.matchAll(/["']?src["']?\s*:\s*["']([^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi)) push(m[1]);
  for (const m of t.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) push(m[1]);
  for (const u of scanMediaUrls(t)) push(u);
  return found;
}

// Media validation in the bridge's spirit (cf. verifyPlaylist, which is
// HLS-only): a candidate counts only if its first bytes are an HLS playlist
// or an MP4 ftyp box, or it arrives with a playlist/video content-type.
// The body read is bounded to the first chunk and then cancelled.
async function verifyMediaUrl(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...(referer ? { Referer: referer } : {}),
        Range: 'bytes=0-4095',
      },
    });
    if (res.status >= 300) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let head = Buffer.alloc(0);
    if (res.body) {
      const reader = res.body.getReader();
      const first = await reader.read();
      if (first.value) head = Buffer.from(first.value);
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    if (head.toString('utf8').trimStart().startsWith('#EXTM3U')) return true;
    if (/mpegurl/.test(ct)) return true;
    if (head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp') return true;
    if (/^video\//.test(ct) && /\.(m3u8|mp4)($|\?)/i.test(url)) return true;
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Resolve an embed/page URL to validated direct media, or null. Follows the
// fetch layer's redirects and ONE iframe hop to a nested player page.
async function resolveEmbed(embedUrl, referer) {
  const first = await getPage(embedUrl, referer || ONLYFLIX, 20000).catch(() => null);
  if (!first || first.status !== 200) return null;
  const pages = [{ html: first.text, url: first.url }];
  const nested = nestedPlayerUrls(first.text, first.url).filter((u) => u !== first.url);
  if (nested.length) {
    const second = await getPage(nested[0], first.url, 20000).catch(() => null);
    if (second && second.status === 200) pages.push({ html: second.text, url: second.url });
  }
  for (const p of pages) {
    for (const cand of extractEmbedMedia(p.html, p.url)) {
      if (await verifyMediaUrl(cand, p.url)) return { url: cand, hoster: hosterName(embedUrl) };
    }
  }
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

// ---------- remote-config roster (v1.4) ----------

// Baked-in roster = pre-v1.4 behavior exactly: same providers, same dispatch
// order. The timeoutMs values are per-provider dispatch budgets sized above
// each chain's observed worst case, so the baked-in config never cuts off a
// resolution that would have completed before v1.4 (there was no dispatch
// cap at all); they exist so a remote config can tighten them deliberately.
const BAKED_IN_ROSTER = [
  { id: 'vidora', enabled: true, timeoutMs: 180000 },
  { id: 'balance', enabled: true, timeoutMs: 300000 },
  { id: 'nontongo', enabled: true, timeoutMs: 240000 },
  { id: 'vidfast', enabled: true, timeoutMs: 180000 },
  { id: 'vidapi', enabled: true, timeoutMs: 300000 },
  { id: 'cdnm', enabled: true, timeoutMs: 180000 },
];

const ROSTER_URL = process.env.BRIDGE_ROSTER_URL
  || 'https://raw.githubusercontent.com/marshallgant88-art/Matryx-ad-ons/main/roster.json';
const ROSTER_TTL_MS = 10 * 60 * 1000;

function rosterSignature(entries) {
  return entries.map((e) => `${e.id}:${e.enabled ? 1 : 0}:${e.timeoutMs}`).join('|');
}

// DATA-ONLY validation: an entry is honored only if its id already exists in
// the code registry (RESOLVERS). Unknown ids are ignored — the config can
// never add a provider, a URL, or code. Providers the config omits keep
// their baked-in entry (config can disable a provider only by naming it).
function sanitizeRoster(parsed) {
  if (!parsed || !Array.isArray(parsed.providers)) return null;
  const baked = new Map(BAKED_IN_ROSTER.map((e) => [e.id, e]));
  const seen = new Set();
  const out = [];
  for (const p of parsed.providers) {
    if (!p || typeof p.id !== 'string' || !baked.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    const base = baked.get(p.id);
    out.push({
      id: p.id,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
      timeoutMs: Number.isFinite(p.timeoutMs)
        ? Math.min(600000, Math.max(1000, Math.round(p.timeoutMs)))
        : base.timeoutMs,
    });
  }
  if (!out.length) return null;
  for (const e of BAKED_IN_ROSTER) if (!seen.has(e.id)) out.push({ ...e });
  return out;
}

let rosterState = {
  entries: BAKED_IN_ROSTER,
  source: 'fallback',
  fetchedAt: 0,
  signature: rosterSignature(BAKED_IN_ROSTER),
};

async function refreshRoster() {
  try {
    const r = await fetchText(ROSTER_URL, { timeoutMs: 15000 });
    if (!r.ok) return; // keep last good (or baked-in fallback)
    const clean = sanitizeRoster(JSON.parse(r.text));
    if (!clean) return; // unparseable/invalid config: keep last good
    const sig = rosterSignature(clean);
    if (sig !== rosterState.signature) cache.map.clear(); // roster change invalidates cached stream lists
    rosterState = { entries: clean, source: 'remote', fetchedAt: Date.now(), signature: sig };
  } catch { /* keep last good (or baked-in fallback) */ }
}
refreshRoster();
setInterval(refreshRoster, ROSTER_TTL_MS).unref();

function getRosterInfo() {
  return {
    source: rosterState.source,
    url: ROSTER_URL,
    ageSec: rosterState.fetchedAt ? Math.round((Date.now() - rosterState.fetchedAt) / 1000) : null,
    ttlSec: Math.round(ROSTER_TTL_MS / 1000),
    enabledProviders: rosterState.entries.filter((e) => e.enabled).map((e) => e.id),
    providers: rosterState.entries,
  };
}

// Per-provider dispatch budget from the roster. A resolver that exceeds its
// budget counts as unresolved for this request; it keeps running in the
// background (promises cannot be cancelled) and its late record() still
// lands in /health, but its late result is discarded.
function withRosterTimeout(key, promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      record(key, LABELS[key], 'unresolved', `exceeded roster timeout (${timeoutMs} ms)`);
      resolve(null);
    }, timeoutMs);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    );
  });
}

async function getBridgeStreams(type, imdb, season, episode) {
  const cacheKey = `${type}:${imdb}:${season || ''}:${episode || ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const entries = rosterState.entries.filter((e) => e.enabled && RESOLVERS[e.id]);
  const keys = entries.map((e) => e.id);
  const results = await Promise.all(
    entries.map((e) => withRosterTimeout(
      e.id,
      RESOLVERS[e.id](type, imdb, season, episode).catch((err) => {
        record(e.id, LABELS[e.id], 'unresolved', `resolver error: ${err.message}`);
        return null;
      }),
      e.timeoutMs
    ))
  );
  const streams = [];
  keys.forEach((k, i) => {
    const r = results[i];
    if (!r) return;
    const url = typeof r === 'string' ? r : r.url;
    if (!url) return;
    streams.push({
      name: (typeof r === 'object' && r.name) ? r.name : LABELS[k],
      title: `Direct stream · ${new URL(url).host}${/\.mp4($|\?)/.test(url) ? ' · MP4' : ' · HLS'}`,
      url,
    });
  });
  cache.set(cacheKey, streams, CACHE_TTL);
  return streams;
}

const manifest = {
  id: 'app.matryx.onlyflixbridge',
  version: '1.4.0',
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

// ── TEMPORARY DIAGNOSTIC — MovieBox §8 region-wall probe (added 2026-11-10, key-gated,
// REMOVED in the same session). Performs the MovieBox guest flow server-side exactly as
// TEARDOWN-REPORT §6 documented it: country-code -> detail (issues the anonymous guest JWT
// in the x-user response header) -> subject/play with that JWT. Guest-level only: no
// accounts, no Pro defeat, no spoofed geo headers — the point is this service's real
// US (Oregon) connection IP. ──
const MB_DIAG_KEY = 'c34c8f62b1bee1181e883319';
const MB_API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const MB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MB_SAMPLES = {
  '3214756591438286576': { label: 'abyss', detailPath: 'abyss-sUdojzoCtP3', se: 1, ep: 1 },
  '7164730789711039880': { label: 'dream', detailPath: 'dream-q1yB3pFxgx8', se: 1, ep: 1 },
  '3991952166557736960': { label: 'bfkiller', detailPath: 'a-bona-fide-killer-yzvVpvmbTK4', se: 1, ep: 1 },
  '5242889364639836664': { label: 'movie418', detailPath: '418-hindi-cam-2D94Gnjuif6', se: 0, ep: 0 },
};

async function mbFetch(url, headers, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text };
  } finally {
    clearTimeout(t);
  }
}

function mbFirstStreamUrl(data) {
  const keyPref = ['url', 'address', 'playUrl', 'src', 'file', 'link', 'm3u8', 'hls'];
  function hunt(v, depth) {
    if (!v || depth > 4) return null;
    if (typeof v === 'string') return /^https?:\/\//i.test(v) ? v : null;
    if (Array.isArray(v)) {
      for (const e of v) { const u = hunt(e, depth + 1); if (u) return u; }
      return null;
    }
    if (typeof v === 'object') {
      for (const k of keyPref) { const u = hunt(v[k], depth + 1); if (u) return u; }
      for (const k of Object.keys(v)) { const u = hunt(v[k], depth + 1); if (u) return u; }
    }
    return null;
  }
  for (const l of [data && data.streams, data && data.dash, data && data.hls]) {
    const u = hunt(l, 0);
    if (u) return u;
  }
  return null;
}

// Fetchability check on ONE issued stream URL: HEAD, falling back to a 1-byte range GET.
// Never downloads content (range body is cancelled unread).
async function mbStreamTest(url) {
  const out = { url };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': MB_UA } });
      out.head = { status: res.status, contentType: res.headers.get('content-type'), contentLength: res.headers.get('content-length'), finalUrl: res.url };
    } finally { clearTimeout(t); }
  } catch (e) { out.headError = String((e && e.message) || e); }
  if (!out.head || out.head.status >= 400) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': MB_UA, Range: 'bytes=0-0' } });
        out.rangeGet = { status: res.status, contentType: res.headers.get('content-type'), contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length'), finalUrl: res.url };
        if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
      } finally { clearTimeout(t); }
    } catch (e) { out.rangeGetError = String((e && e.message) || e); }
  }
  return out;
}

async function mbDiagProbe({ key, subject }) {
  if (key !== MB_DIAG_KEY) return null;
  const s = MB_SAMPLES[subject];
  if (!s) return null;
  const baseHeaders = { 'User-Agent': MB_UA, 'X-Client-Info': '{"timezone":"UTC"}', 'X-Request-Lang': 'en', Accept: '*/*' };
  const out = { probe: 'mb-diag-s8', at: new Date().toISOString(), subject: { subjectId: subject, label: s.label, detailPath: s.detailPath, se: s.se, ep: s.ep } };
  // 1) The upstream's own geo answer for THIS (Oregon) connection.
  try {
    const cc = await mbFetch(`${MB_API}/country-code`, baseHeaders);
    out.countryCodeStatus = cc.status;
    try { out.countryCode = JSON.parse(cc.text); } catch { out.countryCode = cc.text; }
  } catch (e) { out.countryCodeError = String((e && e.message) || e); }
  // 2) Guest session issuance: anonymous detail call -> guest JWT in the x-user header.
  let token = null;
  try {
    const d = await mbFetch(`${MB_API}/detail?detailPath=${encodeURIComponent(s.detailPath)}`, baseHeaders);
    out.detailStatus = d.status;
    const xu = d.headers['x-user'];
    if (xu) { try { token = JSON.parse(xu).token || null; } catch { token = null; } }
    out.guestTokenIssued = !!token;
  } catch (e) { out.detailError = String((e && e.message) || e); }
  // 3) The play call, shaped exactly as the web client shapes it (supportCodecs as integers).
  const playUrl = `${MB_API}/subject/play?subjectId=${subject}&se=${s.se}&ep=${s.ep}` +
    `&detailPath=${encodeURIComponent(s.detailPath)}&streamSignType=1` +
    '&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1';
  const playHeaders = { ...baseHeaders };
  if (token) playHeaders.Authorization = `Bearer ${token}`;
  try {
    const p = await mbFetch(playUrl, playHeaders);
    let body;
    try { body = JSON.parse(p.text); } catch { body = p.text; }
    out.play = { status: p.status, headers: p.headers, body };
    const data = body && body.data;
    if (data) {
      out.counts = {
        streams: (data.streams || []).length,
        dash: (data.dash || []).length,
        hls: (data.hls || []).length,
        hasResource: data.hasResource,
      };
      const su = mbFirstStreamUrl(data);
      if (su) out.streamTest = await mbStreamTest(su);
    }
  } catch (e) { out.playError = String((e && e.message) || e); }
  return out;
}

module.exports = { manifest, getBridgeStreams, getStatus, getRosterInfo, resolveEmbed, LABELS, mbDiagProbe };
