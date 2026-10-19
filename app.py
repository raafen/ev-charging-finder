"""Flask API and progressively enhanced HTML shell; all provider secrets stay here."""
from collections import OrderedDict
from datetime import datetime, timezone
import json
import os
import threading
import time
import uuid
from flask import Flask, render_template, request, jsonify, g, send_from_directory
from werkzeug.exceptions import HTTPException
from domain import compatibility, estimate
from finder import FinderError, search, lookup_zip, validate, get_station, route_search

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 65536


class RateLimiter:
    """Bounded fixed windows, per process; not a distributed abuse protection layer."""
    def __init__(self, capacity=2048, clock=time.monotonic):
        self.capacity, self.clock = capacity, clock
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def allow(self, key, limit):
        now = self.clock()
        with self.lock:
            start, count = self.entries.get(key, (now, 0))
            if now - start >= 60:
                start, count = now, 0
            count += 1
            self.entries[key] = (start, count)
            self.entries.move_to_end(key)
            while len(self.entries) > self.capacity:
                self.entries.popitem(last=False)
            return count <= limit, max(1, int(60 - (now - start)))


limiter = RateLimiter()


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def public_config():
    config = {"mode": "server", "live_search": bool(os.environ.get("OCM_API_KEY", "").strip()),
              "routing": bool(os.environ.get("ROUTING_BASE_URL", "").strip()), "vehicle_provider": "manual",
              "availability": False, "payments": False, "reservations": False}
    for key, variable in (("terrain_url", "MAP_TERRAIN_URL"), ("satellite_url", "MAP_SATELLITE_URL")):
        url = os.environ.get(variable, "").strip()
        if url.startswith("https://"):
            config[key] = url
    return config


@app.before_request
def request_context():
    g.request_id = uuid.uuid4().hex
    g.started = time.monotonic()
    if request.path.startswith("/api/") or request.method == "POST":
        try:
            limit = max(1, min(10000, int(os.environ.get("RATE_LIMIT_PER_MINUTE", "60"))))
        except ValueError:
            limit = 60
        # Do not trust spoofable forwarding headers; deployment proxy trust belongs
        # in infrastructure. Serverless workers do not share these counters.
        allowed, retry = limiter.allow(request.remote_addr or "unknown", limit)
        if not allowed:
            response = jsonify(error="Too many requests. Please wait before trying again.", request_id=g.request_id)
            response.status_code = 429
            response.headers["Retry-After"] = str(retry)
            return response


@app.after_request
def response_context(response):
    response.headers["X-Request-ID"] = getattr(g, "request_id", "")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.path.startswith("/api/"):
        response.vary.add("Origin")
        origins = {value.strip() for value in os.environ.get("CORS_ALLOWED_ORIGINS", "https://raafen.github.io").split(",") if value.strip() and value.strip() != "*"}
        origin = request.headers.get("Origin")
        if origin in origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            if request.method == "OPTIONS":
                response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    if request.path.startswith("/api/") or request.path == "/":
        response.headers["Cache-Control"] = "no-store"
    # No IPs, coordinates, query strings, payloads, upstream URLs or credentials.
    app.logger.info(json.dumps({"event": "request", "request_id": getattr(g, "request_id", None),
        "method": request.method, "endpoint": request.endpoint, "status": response.status_code,
        "duration_ms": round((time.monotonic() - getattr(g, "started", time.monotonic())) * 1000, 1)}))
    return response


@app.errorhandler(HTTPException)
def http_error(error):
    if request.path.startswith("/api/"):
        return jsonify(error=error.description, request_id=getattr(g, "request_id", None)), error.code
    return error


def failure(error):
    return jsonify(error=str(error), request_id=g.request_id), error.status if isinstance(error, FinderError) else 400


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")
    return data


def search_input(data):
    if "demo" in data:
        raise ValueError("Demo requests are no longer supported. Search for a real location.")
    if isinstance(data.get("radius"), bool) or isinstance(data.get("limit"), bool):
        raise ValueError("Radius and result limit must be numbers, not booleans.")
    radius = float(data.get("radius", 10))
    raw_limit = data.get("limit", 100)
    limit = int(raw_limit)
    if float(raw_limit) != limit:
        raise ValueError("Result limit must be a whole number.")
    validate(0, 0, radius, limit)
    mode = data.get("location_mode", "zip")
    if mode == "zip":
        lat, lon, location = lookup_zip(str(data.get("zip_code", "")))
    elif mode == "coordinates":
        if isinstance(data.get("latitude"), bool) or isinstance(data.get("longitude"), bool):
            raise ValueError("Coordinates must be numbers, not booleans.")
        if data.get("latitude") is None or data.get("longitude") is None:
            raise ValueError("Latitude and longitude are required for location search.")
        lat, lon = float(data["latitude"]), float(data["longitude"])
        location = "Selected location"
    else:
        raise ValueError("Choose ZIP code or coordinates.")
    stations = search(lat, lon, radius, limit, operational_only=data.get("operational") is True)
    return {"stations": stations, "center": [lat, lon], "location": location, "retrieved_at": timestamp()}


@app.route("/", methods=["GET", "POST"])
def index():
    values = {"zip_code": "", "radius": "10", "limit": "100"}
    stations, error, location, status = [], None, "", 200
    operational = False
    result = None
    if request.method == "POST":
        values = {key: request.form.get(key, values[key]) for key in values}
        operational = request.form.get("operational") == "on"
        try:
            if "demo" in request.form:
                raise ValueError("Demo requests are no longer supported. Search for a real location.")
            if request.form.get("location_mode", "zip") != "zip":
                raise ValueError("Enter a ZIP code to search.")
            result = search_input({**values, "location_mode": "zip", "operational": operational})
            stations, location = result["stations"], result["location"]
        except (ValueError, TypeError, OverflowError, FinderError) as exc:
            stations, error = [], str(exc)
            status = exc.status if isinstance(exc, FinderError) else 400
    config = public_config()
    initial_data = {"stations": stations, "config": config, "error": error,
                    "center": result["center"] if result else None,
                    "location": result["location"] if result else None,
                    "retrieved_at": result["retrieved_at"] if result else None}
    return render_template("index.html", values=values, stations=stations, error=error,
                           operational=operational, location=location, config=config, initial_data=initial_data), status


@app.get("/api/config")
def api_config():
    return jsonify(public_config())


@app.get("/health")
@app.get("/healthz")
def health():
    return jsonify(status="ok")


@app.get("/ready")
@app.get("/readyz")
def ready():
    return jsonify(status="ready", capabilities=public_config(), note="Optional providers are configuration-gated; readiness does not probe external services.")


@app.get("/sw.js")
def service_worker():
    response = send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.post("/api/search")
def api_search():
    try:
        return jsonify(search_input(payload()))
    except (TypeError, ValueError, OverflowError, FinderError) as exc:
        return failure(exc)


@app.get("/api/station/<station_id>")
def api_station(station_id):
    try:
        station = get_station(station_id)
        return jsonify(station=station, retrieved_at=timestamp())
    except (TypeError, ValueError, FinderError) as exc:
        return failure(exc)


@app.post("/api/compatibility")
def api_compatibility():
    try:
        data = payload()
        return jsonify(compatibility(data.get("vehicle", {}), data.get("station", {})))
    except (TypeError, ValueError) as exc:
        return failure(exc)


@app.post("/api/estimate")
def api_estimate():
    try:
        return jsonify(estimate(payload()))
    except (TypeError, ValueError, OverflowError) as exc:
        return failure(exc)


@app.post("/api/route")
def api_route():
    try:
        return jsonify(route_search(payload()))
    except (TypeError, ValueError, OverflowError, FinderError) as exc:
        return failure(exc)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
