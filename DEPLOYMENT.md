# Deployment

## Vercel — primary frontend and backend

Production: **https://ev-charging-finder-nine.vercel.app**  
Swagger: **https://ev-charging-finder-nine.vercel.app/docs**  
ReDoc: **https://ev-charging-finder-nine.vercel.app/redoc**

The Vercel Git integration is connected to `raafen/ev-charging-finder`. Pushes to `main` deploy production. `pyproject.toml` selects `main:app`; `vercel.json` selects FastAPI, builds static CDN assets and sets a 60-second function duration. Flask continues serving the web shell and API beneath the FastAPI ASGI documentation gateway. Vercel serves the copied `public/static/` assets directly.

```bash
vercel link --project ev-charging-finder
vercel env add OCM_API_KEY production
vercel deploy --prod
```

Enter the real key at Vercel's secret prompt, not in a shell command, source file, client URL or Git commit. Redeploy after environment changes. The app is useful without a key in explicitly fictional demo mode; real search remains disabled. Use the project environment dashboard for preview/development environments if needed.

Optional server configuration:

| Variable | Meaning |
|---|---|
| `OCM_API_KEY` | Server-only Open Charge Map credential |
| `ROUTING_BASE_URL` | OSRM-compatible routing base URL; absent means route planning disabled |
| `MAP_TERRAIN_URL` | Public HTTPS raster-DEM TileJSON; exposed to browser, so **no secrets** |
| `MAP_SATELLITE_URL` | Public HTTPS raster tile template; exposed to browser, so **no secrets** |
| `RATE_LIMIT_PER_MINUTE` | Best-effort per-process limit; default 60 |

Public map URLs must be licensed for browser distribution. Do not place privileged provider tokens in them. OpenFreeMap, Open Charge Map, ZIP lookup and configured routing providers have independent policies/availability. No free-tier capacity, SLA or unlimited usage is promised.

### Operational limits

Station queries: up to 100 records; cache 128 entries / 180-second TTL. Reference cache: 8 entries / one day. ZIP cache: 256 entries / one day. Caches and rate counters are process-local and reset on cold starts. Vercel workers do not share state; use platform firewall/distributed enforcement before exposing significant production traffic.

Upstream transport uses connection/read timeouts and at most two attempts for transient failures. Routing can perform multiple provider requests; large route searches can exceed a serverless duration budget. Use the container deployment for heavier routing workloads. Readiness reports configured capabilities, not upstream reachability.

`/health` and `/ready` are public. API responses carry `X-Request-ID` and are not cacheable by shared intermediaries. Application logs omit credentials and precise locations. Review Vercel infrastructure logs/retention separately.

## GitHub Pages — fictional static demo

URL: **https://raafen.github.io/ev-charging-finder/**

Pages cannot run Python or safely store API secrets. Its build uses only fictional records and `mode: static`. Demo searches are local; it never sends `/api/search` requests. Real API documentation remains on Vercel.

The GitHub Actions workflow runs Python tests, dependency auditing, Chromium browser tests, a JavaScript-size budget, and then builds/deploys the Pages artifact. Pages must use **GitHub Actions** as its publishing source.

```bash
python scripts/build_pages.py --output site
python -m http.server 8080 --directory site
```

Use a new/empty output directory to avoid publishing stale files. Relative asset and service-worker URLs support the repository subpath. Only allowlisted public asset types are exported. `.env*`, `.vercel/`, Python code and credentials are excluded.

The service worker caches only the owned shell/assets. No external map tiles or API responses are cached. The UI may store explicitly timestamped result snapshots in local storage. Offline data is not live. First offline use requires a prior successful visit; third-party maps and Three.js may be unavailable offline, with list/static alternatives.

## Docker

```bash
docker compose up --build -d
curl http://127.0.0.1:8000/health
```

Optional live-data credential: export `OCM_API_KEY` before starting Compose, or use an uncommitted local `.env` file that Compose reads. Do not bake credentials into the image.

The image runs Uvicorn with two workers as a non-root user. Compose binds localhost, drops capabilities, enables no-new-privileges, uses a read-only root filesystem and supplies a temporary `/tmp`. Put a TLS reverse proxy in front for a public deployment. Cache/rate limits remain per-worker. The health check uses Python's standard library.

Docker was not installed on the development machine; configuration is provided without claiming a successful local image build. The ASGI app itself was run and tested locally and deployed to Vercel.

## Verify after deployment

```bash
curl https://ev-charging-finder-nine.vercel.app/health
curl https://ev-charging-finder-nine.vercel.app/api/config
curl -X POST https://ev-charging-finder-nine.vercel.app/api/search \
  -H 'Content-Type: application/json' \
  -d '{"demo":true,"location_mode":"zip","zip_code":"10036","radius":10}'
```

Check the actual browser surface: search ZIP 10036 in demo mode, filter NACS, toggle theme, open station details, open the connector lab, and visit `/docs`. Never interpret fictional demo records as actual travel guidance.
