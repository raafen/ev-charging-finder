# Current — EV Charging Finder

A calm, map-first charging companion built with Flask, a FastAPI documentation gateway, MapLibre GL JS and an optional Three.js connector studio. Original procedural illustrations; no invented vehicle specifications or live charger occupancy.

**Live application:** https://ev-charging-finder-nine.vercel.app  
**Interactive API documentation:** https://ev-charging-finder-nine.vercel.app/docs  
**ReDoc:** https://ev-charging-finder-nine.vercel.app/redoc  
**GitHub Pages fictional demo:** https://raafen.github.io/ev-charging-finder/

![Current desktop workspace with fictional Manhattan charging stations](docs/media/desktop.png)

[Mobile screenshot](docs/media/mobile.png) · [Short production demo video](docs/media/demo.webm)

Captured from the deployed application. The video demonstrates filtering, station details, the connector lab and theme switching; all shown stations are fictional.

## Run locally

Python 3.12–3.14:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --no-access-log
```

Open `http://127.0.0.1:8000`. The default view contains eight **fictional Manhattan stations**. Offline demo ZIP: **10036**. Other coordinates work but return only fictional records within the requested radius. These are not real navigation destinations.

For real data, set `OCM_API_KEY` in the server environment and uncheck **Fictional demo**. [Obtain an Open Charge Map key](https://openchargemap.org/develop/api). It is sent upstream only in the `X-API-Key` header, never to the browser. Environment files are not automatically loaded by Python.

```bash
python cli.py --zip 10036 --demo
python cli.py 40.758 -73.9855 --radius 10 --json
```

## Product and data-support matrix

| Area / original feature ideas | Implemented | Conditions and boundaries |
|---|---|---|
| Map (1–24) | MapLibre vector map, pitched 3D/buildings, clusters and expansion, status pins, selected power, connector/network filters, pan-to-search, fit/recenter, compass, list mode, radius boundary, explicit fly-to, attribution and fallback | Buildings depend on vector source coverage. Terrain and satellite require configured public sources. Distances are straight-line, not driving miles. Opening details preserves desktop map position. |
| Connectors (25–40) | Reference ID/title normalization; NACS/J3400, J1772/Type 1, CCS1, CHAdeMO, Type 2, CCS2; per-connection current, power, quantity, voltage and amperage; educational guide | Missing values stay unknown. Station count, points and connectors are distinct. Power is advertised, not vehicle delivery. |
| 3D education (41–63) | Original procedural connector models, rotation/zoom/keyboard controls, comparison, labeled explanations, schematic exploded view, generic vehicle/charger illustrations, battery and energy-flow education | Three.js loads only after explicit enable in the lab. Static SVG alternatives always available. Schematics and taper curves are illustrative, not verified vehicle/site geometry. Rendering pauses offscreen and follows reduced-motion settings; DPR capped at 1.5. |
| Garage (64–80) | Multiple local manual profiles, make/model/year/trim, inlet, AC/DC limits, battery, adapters, source/date, native/adapter/incompatible/unknown results and compatible filter | No vehicle catalog configured. All specifications are user-entered. Physical fit does not prove network authorization or adapter safety. No inferred Supercharger access. |
| Networks (81–94) | Reported operator separate from host/connector, filters/chips, comparison, matching counts, preferred networks, access/payment fields and selected official links | Missing access is not public. Neutral labels; no affiliation or logo-rights claims. |
| Estimates (95–110) | Manual SOC, battery, vehicle/charger caps, charging efficiency, energy, minutes, miles, fee breakdown and two-stop comparison | Constant-power approximation. UI totals are before tax; API supports explicit tax. Missing fees remain unknown. No authoritative parsing of pricing text or verified vehicle charging-curve provider. |
| Trips (111–125) | Coordinate origin/destination, configurable OSRM adapter, route geometry, bounded corridor sampling, driving detours, range/reserve assumptions, conditional stop suggestions, manual stops and leg navigation | Disabled until `ROUTING_BASE_URL` is configured. No live traffic. Sampled search can miss stations. Faster candidates rank detour only; API cost ranking needs manual session costs. No claim of a globally optimal charging plan. |
| Trust (126–141) | Provider/source/license, timestamps, operational-vs-occupancy distinction, access/hours/pricing text, source correction links, completeness panel, fictional labels | Completeness is not reliability. Live availability unavailable. Photos, places/amenities and site geometry are omitted without verified, licensed data; no places provider integrated. |
| Personal (142–154) | Local favorites, searches, profiles/preferences, recent stations, three-station comparison, station/filter links, CSV export and PWA shell cache | No accounts/cross-device sync. Stored results are snapshots with retrieval timestamps. API responses and third-party tiles are not service-worker cached. First offline use requires an earlier online visit. |
| Accessibility (155–172) | Native controls, keyboard focus, dialog focus handling, live announcements, text status, reduced motion, outdoor mode, mobile sheet button, list mode, skeleton/empty/retry states, request cancellation and result preservation | Browser suite exercises narrow mobile and failed map resources. Not a formal WCAG certification. Map/3D have accessible list/static alternatives. |
| Engineering (173–197) | Station/vehicle/routing interfaces, bounded TTL caches, rate limiter, controlled retries, normalization, raw/public separation, private logs, request IDs, health/readiness, Python/browser tests, CI audit, Docker, Vercel and Pages packaging | Cache and limiter are process-local, best effort on serverless—not distributed abuse protection. Long routing searches may exceed Vercel time limits. External providers require their own licensing/capacity review. |

## Architecture and data flow

- `main.py`: FastAPI ASGI entrypoint. Hosts `/docs`, `/redoc` and `/openapi.json`; mounts the existing Flask application with `a2wsgi`. Pydantic models document the real mounted endpoints. Flask remains the single route implementation and validates input; this is not a duplicated API.
- `app.py`: HTML form fallback, JSON endpoints, capability configuration, request IDs, bounded rate limiting and privacy-conscious request logs.
- `finder.py`: input validation, normalized public station schema, distance calculation, demo loading and route-corridor/stop calculations.
- `providers.py`: Open Charge Map / OSRM interfaces, timeout/retry policy and thread-safe bounded caches. Raw upstream records remain server-side.
- `domain.py`: connector normalization, manual vehicle interface, physical/network compatibility and constant-power estimates.
- `static/app.js` / `domain.js`: framework-free UI and local-first calculations. Browser preferences stay on-device. Live search is same-origin server API; Pages performs fictional searches locally.
- `static/explorer.js`: lazy connector studio. No Three.js or model dependency on the main search path.
- `scripts/build_vercel.py`: copies only public browser assets to the Vercel CDN directory and versions the service worker.
- `scripts/build_pages.py`: renders a static, explicitly fictional shell with relative paths; exports no server code or credentials.

### API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/search` | ZIP/coordinates, radius 0–100 miles, up to 100 normalized records |
| GET | `/api/station/{id}` | Stable source ID or `demo-1` through `demo-8` |
| GET | `/api/config` | Public capability flags, never provider credentials |
| POST | `/api/compatibility` | Physical fit separate from network authorization |
| POST | `/api/estimate` | Explicit constant-power and tariff assumptions |
| POST | `/api/route` | Configured driving route, bounded corridor and conditional plan |
| GET | `/health`, `/ready` | Process health / capability readiness, not an upstream availability probe |

Errors include a request ID. Upstream errors are deliberately sanitized. Logs omit credentials, payloads, precise coordinates, IP addresses and query strings. Infrastructure access logging has its own privacy policy; local production command disables Uvicorn access logs.

### Technical tradeoffs

MapLibre replaces Leaflet for native vector clustering, pitched views and building extrusions. OpenFreeMap is the default public style source; OpenStreetMap attribution remains visible. A map failure does not block the station list. No elevation or satellite service is silently assumed.

Manual profiles avoid an unlicensed or stale vehicle dataset. Adapter declarations are explicit and directional. They are not electrical safety certifications. A native connector match alone cannot establish network eligibility.

The estimator uses `battery × SOC delta / efficiency / min(vehicle kW, charger kW)`. It does not model verified taper, queueing, weather or shared power. Unknown fees are not zero. The lab's taper visualization is educational only.

The route provider uses bounded sampling and a greedy range-based plan. It exposes uncertainty rather than pretending coverage or optimization. Costs are compared only with explicit numeric assumptions. Vercel is convenient for the app/API, but a container service is preferable for extensive route-corridor workloads.

### Performance budget

Owned JavaScript: **150 KiB uncompressed maximum**, checked in CI. Main map library loads separately from a pinned CDN version. Three.js is opt-in and lazy; no downloaded model assets. Map tile cache is limited to 60 tiles; normalized results are capped at 100; cluster radius is 48 pixels. Connector geometry is procedural and rendering demand-driven, with mobile DPR <=1.5. Fonts, basemap tiles and CDN scripts still require internet on first use.

## Verification

```bash
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m playwright install chromium
python -m unittest discover -s tests/browser -v
python -m pip_audit -r requirements-dev.txt
python scripts/build_pages.py --output site
```

Python tests cover provider errors, cache/rate bounds, malformed data, privacy, ZIP/radius behavior, compatibility rules, charging assumptions and route calculations. Browser tests exercise both Flask and a `/ev-charging-finder/` static export, including third-party resource failure, filtering, demo search, persistent themes and the mobile sheet.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). Vercel is the primary frontend/backend deployment. GitHub Pages runs only the public fictional demo. Docker configuration is included; Docker was unavailable on the development machine, so a local container build/run is not claimed.

## Attribution

Live charging data: [Open Charge Map and its providers](https://openchargemap.org/develop/api), under each source's license. ZIP geocoding: [Zippopotam.us / GeoNames](https://www.zippopotam.us/). Basemap: [OpenFreeMap](https://openfreemap.org/) and [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). MapLibre and Three.js are BSD/MIT-licensed respectively; Google Fonts DM Sans and Manrope are SIL Open Font License fonts. Connector models, SVG illustrations and app icons were created for this project; they are simplified educational depictions, not licensed manufacturer CAD. No manufacturer/network affiliation is implied. No source-code redistribution license has been chosen for this repository.
