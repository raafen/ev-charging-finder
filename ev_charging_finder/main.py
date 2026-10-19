"""FastAPI documentation gateway; Flask remains the single implementation of the API.

The ASGI mount forwards real requests to Flask. OpenAPI describes that mounted API,
using shared Pydantic documentation models rather than duplicating route handlers.
"""
from typing import Literal
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, Field
from a2wsgi import WSGIMiddleware
from .app import app as flask_app


class SearchRequest(BaseModel):
    location_mode: Literal["zip", "coordinates"] = "zip"
    zip_code: str = Field(default="", description="Five-digit US ZIP; required for ZIP searches.")
    latitude: float | None = Field(default=None, ge=-90, le=90, description="Required with longitude for internal coordinate searches.")
    longitude: float | None = Field(default=None, ge=-180, le=180)
    radius: float = Field(default=10, gt=0, le=100, description="Straight-line search radius in miles.")
    limit: int = Field(default=100, ge=1, le=100)
    operational: bool = False


class Adapter(BaseModel):
    from_connector: str = Field(alias="from", description="Charger connector, e.g. CCS1.")
    to: str = Field(description="Vehicle inlet, e.g. NACS.")
    current_type: Literal["AC", "DC"]


class Vehicle(BaseModel):
    connectors: list[str] = Field(default_factory=list)
    adapters: list[Adapter] = Field(default_factory=list)
    networks: list[str] = Field(default_factory=list, description="User-confirmed network authorizations, separate from plug fit.")
    battery_kwh: float | None = Field(default=None, gt=0)
    max_ac_kw: float | None = Field(default=None, ge=0)
    max_dc_kw: float | None = Field(default=None, ge=0)
    consumption_kwh_per_100_miles: float | None = Field(default=None, gt=0)


class Connection(BaseModel):
    connector: str = "Unknown"
    current_type: Literal["AC", "DC", "Unknown"] = "Unknown"
    power_kw: float | None = None
    quantity: int | None = None
    voltage: float | None = None
    amps: float | None = None


class Station(BaseModel):
    id: int | None = None
    name: str = "Unnamed station"
    latitude: float | None = None
    longitude: float | None = None
    connectors: list[str] = Field(default_factory=list)
    connections: list[Connection] = Field(default_factory=list)
    network: str | None = None
    network_access: Literal["open", "restricted", "unknown"] = "unknown"
    operational: bool | None = None
    max_power_kw: float | None = None
    distance_miles: float | None = None


class CompatibilityRequest(BaseModel):
    vehicle: Vehicle
    station: Station


class EstimateRequest(BaseModel):
    vehicle: Vehicle
    start_percent: float = Field(ge=0, le=100)
    target_percent: float = Field(ge=0, le=100, description="Must exceed start_percent.")
    station_power_kw: float = Field(gt=0)
    current_type: Literal["AC", "DC"]
    efficiency_percent: float = Field(default=90, ge=1, le=100)
    price_per_kwh: float | None = Field(default=None, ge=0)
    price_per_minute: float | None = Field(default=None, ge=0)
    session_fee: float | None = Field(default=None, ge=0)
    parking_fee: float | None = Field(default=None, ge=0)
    tax_percent: float | None = Field(default=None, ge=0, le=100)
    currency: str = "USD"


class RouteRequest(BaseModel):
    origin_zip: str | None = Field(default=None, description="Five-digit US departure ZIP; supply with destination_zip.")
    destination_zip: str | None = Field(default=None, description="Five-digit US destination ZIP.")
    origin: list[float] | None = Field(default=None, min_length=2, max_length=2, description="Internal [latitude, longitude]; use instead of ZIP fields.")
    destination: list[float] | None = Field(default=None, min_length=2, max_length=2, description="Internal [latitude, longitude].")
    corridor_miles: float = Field(default=3, ge=0.1, le=25)
    range_miles: float | None = Field(default=None, ge=1, le=1000, description="Assumed departure range, also restored at each stop.")
    reserve_miles: float = Field(default=20, ge=0, le=1000)
    include_stations: bool = True
    vehicle: Vehicle | None = None
    manual_station_costs: dict[str, float] | None = Field(default=None, description="Comparable session costs in one currency, keyed by station ID.")


app = FastAPI(title="Current Charging API", version="2.0.0", description="Server-side station search and transparent charging tools. The Flask API is mounted beneath this FastAPI documentation gateway. No API keys belong in client requests. Interactive requests execute the real mounted endpoints.", docs_url="/docs", redoc_url="/redoc")


def mounted_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
    schemas = schema.setdefault("components", {}).setdefault("schemas", {})
    definitions = [SearchRequest, CompatibilityRequest, EstimateRequest, RouteRequest]
    for model in definitions:
        model_schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        schemas.update(model_schema.pop("$defs", {}))
        schemas[model.__name__] = model_schema
    error = {"description": "Validation, provider or rate-limit error. JSON contains error and request_id.", "content": {"application/json": {"schema": {"type": "object", "properties": {"error": {"type": "string"}, "request_id": {"type": "string"}}}}}}
    for path, model, summary, description in [
        ("/api/search", SearchRequest, "Find nearby charging stations", "Returns stations, center [lat,lon], location and retrieved_at. ZIP is required in ZIP mode; both coordinates are required in internal coordinate mode. Distances are straight-line miles; reported status is not occupancy."),
        ("/api/compatibility", CompatibilityRequest, "Check physical connector fit", "Returns physical and network results separately. Adapter direction and current type must match; no inferred Supercharger authorization."),
        ("/api/estimate", EstimateRequest, "Estimate charging time and cost", "Constant-power approximation capped by charger and supplied vehicle limits. Missing tariff fields leave total unknown. Returns battery/grid energy, minutes, added_miles, fees, tax, total and assumptions."),
        ("/api/route", RouteRequest, "Route and sample a charging corridor", "Requires server ROUTING_BASE_URL. Returns driving geometry, miles, minutes, sampled stations, detours and conditional stop plan. No traffic or exhaustive coverage guarantee."),
    ]:
        schema["paths"][path] = {"post": {"tags": ["Charging companion"], "summary": summary, "description": description, "operationId": model.__name__, "requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{model.__name__}"}}}}, "responses": {"200": {"description": "Normalized result", "content": {"application/json": {"schema": {"type": "object"}}}}, **{str(status): error for status in (400, 429, 502, 503, 504)}}}}
    for path, summary in [("/api/config", "Public provider capabilities (no credentials)"), ("/health", "Process health"), ("/ready", "Configuration readiness; does not probe providers")]:
        schema["paths"][path] = {"get": {"tags": ["Service"], "summary": summary, "responses": {"200": {"description": "Service information", "content": {"application/json": {"schema": {"type": "object"}}}}}}}
    schema["paths"]["/api/station/{station_id}"] = {"get": {"tags": ["Charging companion"], "summary": "Read a station by stable source ID", "parameters": [{"in": "path", "name": "station_id", "required": True, "schema": {"type": "string", "pattern": "^[1-9][0-9]{0,11}$"}, "description": "Positive Open Charge Map numeric ID."}], "responses": {"200": {"description": "station, retrieved_at"}, "400": error, "404": error, "503": error}}}
    app.openapi_schema = schema
    return schema


app.openapi = mounted_openapi
app.mount("/", WSGIMiddleware(flask_app))
