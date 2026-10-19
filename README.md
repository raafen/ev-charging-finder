# EV Charging Station Finder

A Python application that searches Open Charge Map for charging stations near US ZIP codes or latitude/longitude coordinates. Includes a Flask browser interface and a command-line interface using the same search logic.

## Run it locally

Requires Python 3.10 or newer. From this project folder:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. Select **Offline demo** and click **Find stations**. The default coordinates are Times Square, New York. Demo stations are fictional and only appear near those coordinates.

## Connect real station data

1. Register for a free key at [Open Charge Map](https://www.openchargemap.org/develop/api) using your profile → My Apps → Register An Application.
2. Stop the application with Ctrl+C, then set the key in your terminal:

```bash
export OCM_API_KEY='your-api-key'
python app.py
```

3. Uncheck Offline demo and search again. The key stays on the server; never commit it to GitHub. `.env.example` documents the variable; the app does not automatically load `.env` files.

## Command-line examples

```bash
python cli.py 40.758 -73.9855 --demo
python cli.py 40.758 -73.9855 --radius 15 --operational
python cli.py --zip 10036 --radius 10
python cli.py 40.758 -73.9855 --json > stations.json
python -m unittest discover -s tests -v
```

## Features and limits

- Validates coordinates, radius (up to 100 miles), and result count (up to 100).
- Uses `requests` with connection/read timeouts and friendly errors.
- Computes Haversine straight-line distance, filters by radius, and sorts nearest first.
- Can exclude stations without an explicitly operational reported status.
- Shows names, addresses, distances, status, charging-point count, and source/provider attribution.
- Handles empty results and records without coordinates.

Operational status is **not live plug availability**. It does not establish that a charger is unoccupied, publicly accessible, or working now. Distances are not driving distances. The API fetch is capped at 100 records per search; filtering operates on that subset. Data quality and freshness depend on contributors. Production public hosting should add rate limiting and caching to manage API use.

Data comes from [Open Charge Map](https://openchargemap.org) and its providers under their applicable licenses; source links and provider information are retained. See [API terms and documentation](https://www.openchargemap.org/develop/api). Offline tests use fictional records and mocked HTTP responses.

## How the code works

- `finder.py`: validates input, requests data, normalizes records, computes distances in miles, filters, sorts.
- `app.py`: receives browser form submissions and renders `templates/index.html`.
- `cli.py`: parses terminal arguments and prints text or JSON.
- `tests/test_finder.py`: checks distance calculations, filtering, validation, API failures, and web requests.
- `.github/workflows/tests.yml`: runs tests on GitHub pushes and pull requests.

The API key is sent in the `X-API-Key` header. HTTP error messages do not expose request details or credentials. Flask escapes station text when rendering it. The local server binds to localhost with debug mode disabled.


Before the commit, check `git status` and ensure no credentials are included. Replace YOUR_USERNAME with your account name. Add a screenshot after running the app with real data. No source-code license has been chosen yet; add one if you want to grant reuse rights.

## EC2 deployment

See [DEPLOYMENT.md](DEPLOYMENT.md). Deployment is a separate step and has not been performed simply by downloading this project.

## Describe the project accurately

After running and understanding it, you can describe the implemented Python/API integration, proximity filtering, browser/CLI interfaces, error handling, and testing. Only claim EC2 deployment after actually deploying and verifying it. Only name Claude or Kiro as tools used if you actually use them during your work. This version was built with Codex assistance.

## ZIP code search and miles

Choose **US ZIP code** from **Search using**, enter a five-digit ZIP (including leading zeros), and set a radius in miles. Coordinates remain available through the same dropdown. All search radii and result distances, including CLI JSON (`distance_miles`), use miles. The maximum radius is 100 miles.

ZIP lookup uses [Zippopotam.us](https://zippopotam.us/) (GeoNames data) to get an approximate center, not your exact location. It requires internet but no additional API key. A submitted ZIP is sent to that service; only the resolved coordinates go to Open Charge Map. Offline demo supports ZIP 10036 without internet. Unsupported/not-found ZIPs and lookup failures display an error; coordinates can be used as a fallback.

## Map workspace

The responsive map interface includes a scrolling station sidebar, ZIP/coordinate search without page reloads, power and connector filters, reported operational status, station details, directions, dark mode, and a mobile expandable sheet. Leaflet 1.9.4 loads from unpkg; basemap tiles come from OpenStreetMap and require internet. Station results remain usable if the map library fails to load. Map tiles use the standard OpenStreetMap service; review its tile usage policy before scaling public traffic. Location is requested only after pressing the locate button. Live availability and amenities are not fabricated. API keys remain server-side.
