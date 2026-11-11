'use strict';
// MATRYX addon service — one Node.js process hosting two Stremio-protocol addons:
//   /ext/...     "EXT.to Torrents"  (lib/ext.js)
//   /bridge/...  "OnlyFlix Bridge"  (lib/bridge.js)
// Plain Node http + global fetch. No npm dependencies.
// Run:  node server.js        (PORT env, default 7000)

const http = require('http');
const ext = require('./lib/ext');
const bridge = require('./lib/bridge');

const PORT = parseInt(process.env.PORT || '7000', 10);
const startedAt = new Date().toISOString();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// /ext/stream/series/tt0903747:1:1.json  ->  {type:'series', imdb:'tt0903747', season:1, episode:1}
function parseStreamPath(pathname, prefix) {
  const rest = pathname.slice(prefix.length).replace(/\.json$/, '');
  const [type, rawId] = rest.split('/');
  if (!rawId) return null;
  const parts = decodeURIComponent(rawId).split(':');
  const imdb = parts[0];
  if (!/^tt\d+$/.test(imdb)) return null;
  if (type === 'movie') return { type, imdb };
  if (type === 'series' && parts.length === 3) {
    return { type, imdb, season: parseInt(parts[1], 10), episode: parseInt(parts[2], 10) };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/' || pathname === '/health') {
      return sendJson(res, 200, {
        service: 'matryx-addon-service',
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        env: {
          flaresolverr: !!process.env.FLARESOLVERR_URL,
          tmdbApiKey: !!process.env.TMDB_API_KEY,
        },
        addons: {
          ext: { manifest: '/ext/manifest.json', ...ext.getStatus() },
          bridge: { manifest: '/bridge/manifest.json', providers: bridge.getStatus(), roster: bridge.getRosterInfo() },
        },
      });
    }
    if (pathname === '/ext/manifest.json') return sendJson(res, 200, ext.manifest);
    if (pathname === '/bridge/manifest.json') return sendJson(res, 200, bridge.manifest);

    if (pathname.startsWith('/ext/stream/')) {
      const q = parseStreamPath(pathname, '/ext/stream/');
      if (!q) return sendJson(res, 200, { streams: [] });
      const out = await ext.getExtStreams(q.type, q.imdb, q.season, q.episode);
      return sendJson(res, 200, { streams: out.streams });
    }
    if (pathname.startsWith('/bridge/stream/')) {
      const q = parseStreamPath(pathname, '/bridge/stream/');
      if (!q) return sendJson(res, 200, { streams: [] });
      const streams = await bridge.getBridgeStreams(q.type, q.imdb, q.season, q.episode);
      return sendJson(res, 200, { streams });
    }
    if (pathname === '/diag/mb-probe') {
      const u = new URL(req.url, 'http://localhost');
      const out = await bridge.mbDiagProbe({ key: u.searchParams.get('key'), subject: u.searchParams.get('subject') });
      if (!out) return sendJson(res, 404, { error: 'not found', pathname });
      return sendJson(res, 200, out);
    }
    return sendJson(res, 404, { error: 'not found', pathname });
  } catch (err) {
    // Addon protocol: stream endpoints should answer [] rather than 500 where possible,
    // but unexpected errors are surfaced honestly here + logged.
    console.error('request failed', pathname, err);
    return sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`matryx-addon-service listening on :${PORT}`);
  console.log(`  EXT.to Torrents : http://localhost:${PORT}/ext/manifest.json`);
  console.log(`  OnlyFlix Bridge : http://localhost:${PORT}/bridge/manifest.json`);
  console.log(`  health          : http://localhost:${PORT}/health`);
  console.log(`  FLARESOLVERR_URL ${process.env.FLARESOLVERR_URL ? 'set' : 'NOT set (EXT magnets: direct fetch only)'}`);
  console.log(`  TMDB_API_KEY     ${process.env.TMDB_API_KEY ? 'set' : 'NOT set (Balance skipped)'}`);
});
