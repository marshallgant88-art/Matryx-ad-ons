# MATRYX Addon Service

One small Node.js service (plain `http` + global `fetch`, **zero npm dependencies**)
hosting two Stremio-protocol addons for MATRYX. Built 2026-11-01.

## Run

```bash
node server.js            # listens on PORT (default 7000)
```

Install URLs (point MATRYX/Stremio at these once hosted):

- `http://<host>:7000/ext/manifest.json` — **EXT.to Torrents**
- `http://<host>:7000/bridge/manifest.json` — **OnlyFlix Bridge**
- `http://<host>:7000/health` — JSON status of both addons + per-provider bridge outcomes

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | Listen port. |
| `FLARESOLVERR_URL` | unset | Base URL of a FlareSolverr sidecar (e.g. `http://localhost:8191`). EXT.to detail pages are Cloudflare-walled from datacenter IPs; when set, magnet lookups go through the solver (`POST /v1`, `cmd: "request.get"`). When unset, detail pages are fetched directly and magnets that can't be fetched are simply omitted. |
| `TMDB_API_KEY` | unset | Optional, bridge only: Balance embeds are addressed by TMDB id. When set, IMDb→TMDB uses TMDB's `/find`; when unset, the bridge reads the TMDB id keylessly from the Nontongo soap page / vidapi embed page, which both embed it. Balance works either way. |

## Addon 1 — EXT.to Torrents (`/ext/...`)

Endpoints:

- `GET /ext/manifest.json`
- `GET /ext/stream/movie/<imdb>.json`
- `GET /ext/stream/series/<imdb>:<season>:<episode>.json`

How it works:

- EXT.to browse pages are server-rendered and searchable natively by IMDb ID:
  `GET https://ext.to/browse/?imdb_id=tt15239678` → 200, "(411 Results)", 50 rows/page,
  pagination via `?page=N`. (Keyword search exists at `/browse/?q=<title>`; the addon
  doesn't need it — MATRYX always queries by IMDb ID.)
- Each result row in `table.search-table` yields: release title
  (`a.torrent-title-link` / `data-tooltip`), detail-page URL (slug ending in the
  numeric torrent id), size, file count, seeders, leechers (the `Size/Seeds/Leechs`
  `add-block` cells), and the magnet button's numeric `data-id`.
- Browse pages contain **no magnets/infoHashes**. Magnets live on detail pages, which
  are Cloudflare-walled from datacenter IPs (verified from the build sandbox: 403 even
  with session cookies and full browser headers — the same reason Sootio's ExtTo
  scraper requires FlareSolverr). The addon therefore resolves magnets through
  FlareSolverr when configured, else by direct fetch, and **degrades gracefully**:
  results whose magnets can't be fetched are dropped, never an error.
- Series: browse returns the show's torrents; episode requests filter release titles
  by `SxxExx` (plus `NxEE` fallback) across up to 3 browse pages.
- Streams are ranked by seeders, magnet resolution is capped (12 via solver, 25
  direct, concurrency 4), browse pages are cached 10 min, magnets 6 h.
- Stream shape: `{name:"EXT.to", title:"<release>\n💾 <size> 👤 <seeders>", infoHash, behaviorHints:{bingeGroup:"ext-<imdb>"}}`.

## Addon 2 — OnlyFlix Bridge (`/bridge/...`)

Endpoints:

- `GET /bridge/manifest.json`
- `GET /bridge/stream/movie/<imdb>.json`
- `GET /bridge/stream/series/<imdb>:<season>:<episode>.json`

OnlyFlix is a WordPress front-end over five public embed providers; the bridge talks
to the five directly (OnlyFlix itself is not involved):

| Provider | Movie URL | Series URL | Stream label |
|---|---|---|---|
| Balance | `balance.medmedia03.wiki/embed/movie/<TMDB>` | `.../embed/tv/<TMDB>/<s>/<e>` | `Balance · HD` |
| Nontongo | `sv2.nontongo.stream/soap/movie/<IMDb>` | `.../soap/tv/<IMDb>/<s>/<e>` | `Nontongo · HD` |
| vidfast | `vidfast.vc/movie/<IMDb>` | `vidfast.vc/tv/<IMDb>/<s>/<e>` | `VidFast · HD` |
| vidapi | `vidapi.xyz/embed/movie/<IMDb>` | `vidapi.xyz/embed/tv/<IMDb>/<s>/<e>` | `vidapi · HD` |
| CDNM | `share.cdnm.ink/embed/imdb/<IMDb>` | — (movie only) | `CDNM · HD` |

**MATRYX constraint honored:** streams with a direct `url` play in MATRYX's own
player; `externalUrl` streams are handed to an external browser. The bridge therefore
returns **only** providers it resolved to a real `.m3u8`/`.mp4` URL. Embed page URLs
are never returned. Unresolved providers are simply omitted (and explained in
`/health`).

### Per-provider resolution status (round 2, verified 2026-11-01)

The unlock was the **referer key**: the providers refuse bare visits but answer
when requests carry `Referer: https://onlyflix.to/` — the way OnlyFlix itself
sends visitors. With that, three of the five chains yield to plain HTTP after
all (full traces in `BRIDGE-ROUND2.md`, raw proof in `proof/round2/`):

- **Balance — RESOLVED (movie + series).** The embed host runs a JSON API:
  `/embed-api/availability/title/<movie|tv>/<tmdb>[/<s>/<e>]` returns rows with
  signed tickets; `/embed-api/availability/play/<ticket>` returns an
  `/embed-media/<token>` proxy URL that itself serves the master playlist.
  Balance is TMDB-addressed; the TMDB id is obtained **keylessly** from the
  Nontongo soap page / vidapi embed page (both embed it), or via TMDB `/find`
  when `TMDB_API_KEY` is set.
- **Nontongo — RESOLVED (movie + series).** The soap page embeds the TMDB id;
  `/01russia/multisourcesoap.php` then serves a page with a literal
  `sources = [{html, file}]` array of direct HLS URLs.
- **vidapi — RESOLVED (movies).** Embed → house `swish` player → `swish.js`
  rewrites to `vscdn.xyz/e/<id>` → the player's packed JW script holds an
  `hls4/hls3/hls2` link table; candidates are verified in failover order.
  *Series unresolved:* the TV embed offers no house player — it delegates to
  third-party wrappers (vsembed.ru, cineby.hair), which are separate services.
- **vidfast — unresolved.** Next.js app; no iframe/media/API string exists in
  the page or its bundles — the player is assembled at runtime from lazy,
  string-array-obfuscated chunks. Needs a headless browser.
- **CDNM — unresolved.** The embed endpoint answers **every** title tested
  (10/10, incl. Big Buck Bunny) with HTTP 404 and a generic "video removed"
  page — blanket-down, not per-title coverage.

Every candidate URL is verified to serve `#EXTM3U` before being returned;
unresolved providers are omitted (and explained in `/health`).

## Files

```
server.js        HTTP server + routing + /health
lib/util.js      fetch helper (UA, timeouts), TTL cache, concurrency pool, media-URL scanner
lib/ext.js       EXT.to browse parser + solver/direct magnet resolution
lib/bridge.js    five provider resolvers + TMDB lookup
proof/           raw outputs of the 2026-11-01 local proof runs
REPORT.md        build report: proof numbers, per-provider status, deployment remains
```

## Deployment (not done — by design)

1. Host this service somewhere always-on and public (e.g. Beamup from a GitHub repo).
2. Optionally run a FlareSolverr sidecar next to it and set `FLARESOLVERR_URL` —
   required for EXT.to magnets from datacenter hosting.
3. Optionally set `TMDB_API_KEY` (Balance works without it — see above).
4. Only vidfast would still need a headless-browser resolver sidecar; the three
   working providers need nothing extra.
5. Add the two manifest URLs to MATRYX's Store / install them as addons.
