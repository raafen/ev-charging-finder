import {
  el,
  icon,
  button,
  link,
  inputField,
  selectField,
  formSection,
} from "./ui.js";
import {
  CONNECTORS,
  CONNECTOR_LABELS,
  compatibility,
  compatibilityLabel,
  estimate,
} from "./domain.js";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const boot = JSON.parse($("#initial-data").textContent),
  config = boot.config || {};
const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(`current-${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(`current-${key}`, JSON.stringify(value));
  } catch {
    toast(
      "Local storage is unavailable. Changes will last only for this visit.",
    );
  }
};
const isSourceStation = (station) =>
  station && /^[1-9]\d*$/.test(String(station.id));
const savedZipSearches = load("searches", [])
  .filter((s) => !s.demo && /^\d{5}$/.test(String(s.zip_code || "")))
  .map((s) => ({
    zip_code: s.zip_code,
    radius: s.radius || 10,
    saved_at: s.saved_at,
  }));
const state = {
  stations: (boot.stations || []).filter(isSourceStation),
  filtered: [],
  selected: null,
  center: boot.center || [39.5, -98.35],
  radius: Number($("[name=radius]").value),
  hasSearched: Boolean(boot.center),
  query: boot.center
    ? {
        location_mode: "zip",
        zip_code: $("#zip").value,
        radius: Number($("[name=radius]").value),
      }
    : null,
  retrieved: boot.retrieved_at || null,
  vehicles: load("vehicles", []),
  activeVehicle: load("active-vehicle", null),
  favorites: load("favorites", []).filter(isSourceStation),
  recent: load("recent", []).filter(isSourceStation),
  searches: savedZipSearches,
  preferred: load("networks", []),
  comparison: [],
  tripStops: [],
  route: null,
  fly: load("fly", false),
};
let map,
  markers = [],
  requestNumber = 0,
  locationAttempt = 0,
  lastRequest = null,
  controller,
  explorerCleanup,
  modalEpoch = 0,
  toastTimer,
  mapFailed = false,
  shellCache = null;
const vehicle = () => state.vehicles.find((v) => v.id === state.activeVehicle);
function toast(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function status(s) {
  const n = el(
    "span",
    null,
    `status ${s.operational === true ? "good" : s.operational === false ? "bad" : ""}`,
  );
  n.append(
    el("span", null, "status-dot"),
    document.createTextNode(
      s.operational === true
        ? "Reported operational"
        : s.operational === false
          ? "Reported unavailable"
          : "Status unknown",
    ),
  );
  return n;
}
const stationName = (s) => s.name;
const networkName = (s) => s.network || "Network not reported";
const dateLabel = (value) => {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Not provided"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
};
function setNavigation(id = "explore-nav") {
  for (const nav of $$(".nav-link")) {
    const active = nav.id === id;
    nav.classList.toggle("active", active);
    if (active) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
}
function openModal(title) {
  explorerCleanup?.();
  explorerCleanup = null;
  modalEpoch++;
  $("#modal-title").textContent = title;
  setNavigation(
    title === "Plan a trip"
      ? "trip-nav"
      : title === "Connectors"
        ? "learn-nav"
        : "explore-nav",
  );
  $("#modal").scrollTop = 0;
  $("#modal-body").replaceChildren();
  if (!$("#modal").open) $("#modal").showModal();
  return $("#modal-body");
}
function closeModal() {
  explorerCleanup?.();
  explorerCleanup = null;
  modalEpoch++;
  setNavigation();
  $("#modal").close();
}
$("#modal-close").onclick = closeModal;
$("#modal").addEventListener("cancel", () => {
  explorerCleanup?.();
  explorerCleanup = null;
  modalEpoch++;
  setNavigation();
});
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeModal();
  }
});
const theme = load(
  "theme",
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
);
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle("outdoor", load("outdoor", false));
$("#theme").onclick = () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  save("theme", document.documentElement.dataset.theme);
  if (map && !mapFailed) map.setStyle(mapStyle());
};
save("favorites", state.favorites);
save("recent", state.recent);
save("searches", state.searches);
$("#clear-location").hidden = !$("#zip").value;
$("#zip").addEventListener("input", () => {
  $("#clear-location").hidden = !$("#zip").value;
});
$("#clear-location").onclick = () => {
  $("#zip").value = "";
  $("#clear-location").hidden = true;
  $("#zip").focus();
};
$("[name=radius]").onchange = () => {
  if (state.query)
    search({ ...state.query, radius: Number($("[name=radius]").value) });
  else $("#radius-label").textContent = `${$("[name=radius]").value} mi radius`;
};
function filterStations() {
  const power = $("#power").getAttribute("aria-pressed") === "true",
    operational = $("#operational").getAttribute("aria-pressed") === "true",
    connector = $("#connector").value,
    network = $("#network").value;
  const source = $("#favorites-only").checked
    ? [
        ...new Map(
          [...state.stations, ...state.favorites].map((s) => [String(s.id), s]),
        ).values(),
      ]
    : state.stations;
  state.filtered = source.filter(
    (s) =>
      (!power || s.max_power_kw >= 150) &&
      (!operational || s.operational === true) &&
      (!connector || s.connectors?.includes(connector)) &&
      (!network || networkName(s) === network) &&
      (!$("#favorites-only").checked ||
        state.favorites.some((f) => f.id === s.id)) &&
      (!$("#preferred-only").checked ||
        state.preferred.includes(networkName(s))) &&
      (!$("#compatible").checked ||
        ["compatible", "adapter_required"].includes(
          compatibility(vehicle(), s).physical,
        )),
  );
  const sort = $("#sort").value;
  state.filtered.sort((a, b) =>
    sort === "power"
      ? (b.max_power_kw || 0) - (a.max_power_kw || 0)
      : sort === "name"
        ? a.name.localeCompare(b.name)
        : (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity),
  );
  const count = [
    power,
    operational,
    connector,
    network,
    $("#favorites-only").checked,
    $("#preferred-only").checked,
    $("#compatible").checked,
  ].filter(Boolean).length;
  $("#filter-count").hidden = !count;
  $("#filter-count").textContent = count;
  $("#quick-reset").hidden = !count;
  $("#favorites-nav").setAttribute(
    "aria-pressed",
    $("#favorites-only").checked,
  );
}
function toggleFavorite(s) {
  const found = state.favorites.findIndex((f) => f.id === s.id);
  if (found < 0)
    state.favorites.push({ ...s, saved_at: new Date().toISOString() });
  else state.favorites.splice(found, 1);
  save("favorites", state.favorites);
  render();
  toast(
    found < 0
      ? "Saved on this device. Station data is a snapshot, not live."
      : "Removed from saved stations.",
  );
}
function toggleCompare(s) {
  const index = state.comparison.findIndex((f) => f.id === s.id);
  if (index >= 0) state.comparison.splice(index, 1);
  else if (state.comparison.length < 3) state.comparison.push(s);
  else return toast("Compare up to three stations. Remove one first.");
  render();
}
function card(s) {
  const article = el(
    "article",
    null,
    `station-card ${state.selected === s.id ? "selected" : ""}`,
  );
  article.dataset.station = s.id;
  const top = el("div", null, "card-top");
  const heading = el("div", null, "card-title");
  heading.append(el("h3", stationName(s)), el("p", networkName(s)));
  top.append(
    heading,
    el(
      "span",
      Number.isFinite(s.distance_miles)
        ? `${s.distance_miles.toFixed(1)} mi`
        : "— mi",
      "distance",
    ),
  );
  const specs = el("div", null, "card-specs"),
    power = el("span", null, "power-spec");
  power.append(
    document.createTextNode(s.max_power_kw ?? "—"),
    el("small", "kW"),
  );
  specs.append(power, el("span", null, "spec-divider"));
  for (const connector of (s.connectors?.length
    ? s.connectors
    : ["Unknown"]
  ).slice(0, 2))
    specs.append(el("span", connector, "connector-badge"));
  specs.append(el("span", `${s.points ?? "—"} points`, "points-label"));
  const bottom = el("div", null, "card-bottom"),
    details = button("", () => showDetail(s), "card-link");
  details.setAttribute("aria-label", `View details for ${s.name}`);
  const compare = button(
    "",
    () => toggleCompare(s),
    "icon-button compare-button",
    "layers",
  );
  compare.setAttribute("aria-label", `Compare ${s.name}`);
  compare.setAttribute(
    "aria-pressed",
    state.comparison.some((x) => x.id === s.id),
  );
  const saved = state.favorites.some((x) => x.id === s.id),
    favorite = button(
      "",
      () => toggleFavorite(s),
      `icon-button ${saved ? "saved" : ""}`,
      "heart",
    );
  favorite.setAttribute("aria-label", `${saved ? "Unsave" : "Save"} ${s.name}`);
  favorite.setAttribute("aria-pressed", saved);
  bottom.append(status(s), compare, favorite);
  article.append(details, top, specs);
  if (vehicle())
    article.append(
      el(
        "p",
        compatibilityLabel(compatibility(vehicle(), s).physical),
        "assumptions",
      ),
    );
  article.append(bottom);
  return article;
}
function render() {
  filterStations();
  const savedOnly = $("#favorites-only").checked;
  $(".results-toolbar").hidden = !state.hasSearched && !savedOnly;
  $("#sort").hidden = !state.hasSearched && !savedOnly;
  $("#result-title").textContent =
    `${state.filtered.length} ${savedOnly ? "saved " : ""}station${state.filtered.length === 1 ? "" : "s"}${savedOnly ? "" : " nearby"}`;
  $("#result-subtitle").textContent = savedOnly
    ? "Saved on this device · not live"
    : "Straight-line distance · reported status";
  const results = $("#results");
  results.replaceChildren(...state.filtered.map(card));
  if (!state.filtered.length) {
    const empty = el("div", null, "empty-state");
    if (savedOnly) {
      empty.append(
        el("h3", "No saved stations"),
        el(
          "p",
          "Tap the heart next to a charging station to save it on this device.",
        ),
        button("Explore stations", resetFilters, "text-button"),
      );
    } else if (!state.hasSearched) {
      empty.append(
        icon("pin"),
        el("h2", "Where would you like to charge?"),
        el(
          "p",
          "Enter a US ZIP code above, or choose Use my location. Your location is only requested when you ask.",
        ),
      );
    } else {
      empty.append(
        el("h3", "No matching stations"),
        el("p", "Try a wider radius or clear your filters."),
      );
      if (!$("#quick-reset").hidden)
        empty.append(button("Clear filters", resetFilters, "text-button"));
      else {
        const radius = [5, 10, 25, 50, 100].find(
          (value) => value > state.radius,
        );
        if (radius && state.query)
          empty.append(
            button(
              `Search within ${radius} miles`,
              () => {
                $("[name=radius]").value = String(radius);
                search({ ...state.query, radius });
              },
              "text-button",
            ),
          );
      }
    }
    results.append(empty);
  }
  $("#comparison-tray").hidden = !state.comparison.length;
  $("#comparison-count").textContent =
    `${state.comparison.length} of 3 stations`;
  $("#garage-label").textContent = vehicle()
    ? `${vehicle().make} ${vehicle().model}`
    : "My garage";
  const mapReady = Boolean(map && !mapFailed);
  $("#pitch").disabled =
    !mapReady || (!state.hasSearched && !state.filtered.length);
  $("#recenter").disabled = !mapReady || !state.hasSearched;
  $("#fit").disabled = !mapReady || !state.filtered.length;
  updateMapData();
}
function clearDetail() {
  state.selected = null;
  $("#detail").hidden = true;
  $("#results").hidden = false;
  render();
}
function resetFilters() {
  for (const id of ["power", "operational"])
    $("#" + id).setAttribute("aria-pressed", "false");
  $("#connector").value = "";
  $("#network").value = "";
  for (const id of ["compatible", "favorites-only", "preferred-only"])
    $("#" + id).checked = false;
  clearDetail();
}
$("#reset-filters").onclick = resetFilters;
$("#quick-reset").onclick = resetFilters;
for (const id of ["power", "operational"])
  $("#" + id).onclick = () => {
    $("#" + id).setAttribute(
      "aria-pressed",
      $("#" + id).getAttribute("aria-pressed") !== "true",
    );
    clearDetail();
  };
for (const id of [
  "connector",
  "network",
  "compatible",
  "favorites-only",
  "preferred-only",
  "sort",
])
  $("#" + id).onchange = () => {
    clearDetail();
    $("#message").textContent =
      "Filters apply to the retrieved subset, not every station in this area.";
  };
$("#filters-toggle").onclick = () => {
  const expanded = $("#filters-panel").hidden;
  $("#filters-panel").hidden = !expanded;
  $("#filters-toggle").setAttribute("aria-expanded", expanded);
};
$("#favorites-nav").onclick = () => {
  $("#favorites-only").checked = !$("#favorites-only").checked;
  $("#filters-panel").hidden = false;
  $("#filters-toggle").setAttribute("aria-expanded", "true");
  clearDetail();
  if (innerWidth <= 800) setSheet(true);
};
function updateNetworkOptions() {
  const current = $("#network").value;
  $("#network").replaceChildren(new Option("All networks", ""));
  for (const name of [...new Set(state.stations.map(networkName))].sort())
    $("#network").add(new Option(name, name));
  $("#network").value = current;
  if ($("#network").selectedIndex < 0 && current) {
    $("#network").add(new Option(current, current));
    $("#network").value = current;
  }
}
function setSheet(expanded) {
  $(".sidebar").classList.toggle("expanded", expanded);
  $("#sheet-toggle").setAttribute("aria-expanded", expanded);
  $("#sheet-toggle").textContent = expanded
    ? "Collapse station list"
    : "Expand station list";
}
$("#sheet-toggle").onclick = () =>
  setSheet(!$(".sidebar").classList.contains("expanded"));
function setListMode(list) {
  $(".workspace").classList.toggle("list-only", list);
  $("#list-view").setAttribute("aria-pressed", list);
  $("#map-view").setAttribute("aria-pressed", !list);
  if (!list) {
    map?.resize();
    setSheet(false);
  }
  save("list", list);
}
$("#list-view").onclick = () => setListMode(true);
$("#map-view").onclick = () => setListMode(false);
const mapStyle = () =>
  `https://tiles.openfreemap.org/styles/${document.documentElement.dataset.theme === "dark" ? "dark" : "positron"}`;
function mapFallback(message) {
  mapFailed = true;
  $("#map-warning").textContent = message;
  $("#map-warning").hidden = false;
  for (const id of ["pitch", "recenter", "fit"]) $("#" + id).disabled = true;
  if (!map) {
    $(".map-fallback p").textContent = message;
    $(".map-fallback h2").textContent = "Map unavailable";
  }
}
function initMap() {
  if (!window.maplibregl)
    return mapFallback(
      "Map unavailable on this device. Use the fully functional station list.",
    );
  try {
    map = new maplibregl.Map({
      container: "map",
      style: mapStyle(),
      center: [state.center[1], state.center[0]],
      zoom: state.hasSearched ? 13.2 : 3.4,
      maxZoom: 18,
      pitch: 0,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: false },
      maxTileCacheSize: 60,
    });
    map.addControl(
      new maplibregl.NavigationControl({ showZoom: false, showCompass: true }),
      "top-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ unit: "imperial", maxWidth: 80 }),
    );
    map.on("style.load", () => {
      mapFailed = false;
      $("#map-warning").hidden = true;
      $("#pitch").disabled = !state.hasSearched && !state.filtered.length;
      $("#recenter").disabled = !state.hasSearched;
      $("#fit").disabled = !state.filtered.length;
      setupMapLayers();
    });
    map.on("dragend", () => ($("#search-area").hidden = false));
    map.on("zoomend", updateMarkers);
    map.on("moveend", updateMarkers);
    map.on("idle", updateMarkers);
    map.on("sourcedata", (e) => {
      if (e.sourceId === "stations") updateMarkers();
    });
    map.on("error", () => {
      if (!map.isStyleLoaded()) {
        mapFallback(
          "Some map tiles could not load. Station results are unaffected. Switch to List for a low-power experience.",
        );
      }
    });
    map
      .getCanvas()
      .addEventListener("webglcontextlost", () =>
        mapFallback(
          "Map graphics are unavailable. Station results and directions remain accessible in List mode.",
        ),
      );
  } catch {
    mapFallback(
      "Map graphics are unavailable. Station search still works in List mode.",
    );
  }
}
function setupMapLayers() {
  if (!map.getSource("stations"))
    map.addSource("stations", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 12,
    });
  if (!map.getLayer("station-source-loader"))
    map.addLayer({
      id: "station-source-loader",
      type: "circle",
      source: "stations",
      paint: { "circle-radius": 0, "circle-opacity": 0 },
    });
  if (!map.getSource("radius"))
    map.addSource("radius", { type: "geojson", data: radiusGeoJSON() });
  if (!map.getLayer("radius-fill"))
    map.addLayer({
      id: "radius-fill",
      type: "fill",
      source: "radius",
      paint: { "fill-color": "#3a7954", "fill-opacity": 0.035 },
    });
  if (!map.getLayer("radius-line"))
    map.addLayer({
      id: "radius-line",
      type: "line",
      source: "radius",
      paint: {
        "line-color": "#4a815d",
        "line-width": 1.4,
        "line-dasharray": [4, 4],
        "line-opacity": 0.65,
      },
    });
  const style = map.getStyle(),
    building = style.layers.find((l) => l["source-layer"] === "building");
  if (building && !map.getLayer("current-buildings"))
    map.addLayer({
      id: "current-buildings",
      type: "fill-extrusion",
      source: building.source,
      "source-layer": "building",
      minzoom: 14,
      layout: {
        visibility:
          $("#pitch").getAttribute("aria-pressed") === "true"
            ? "visible"
            : "none",
      },
      paint: {
        "fill-extrusion-color":
          document.documentElement.dataset.theme === "dark"
            ? "#465449"
            : "#d6ded3",
        "fill-extrusion-height": [
          "coalesce",
          ["get", "render_height"],
          ["get", "height"],
          8,
        ],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.72,
      },
    });
  if (config.terrain_url && !map.getSource("terrain")) {
    map.addSource("terrain", {
      type: "raster-dem",
      url: config.terrain_url,
      tileSize: 256,
    });
    $("#terrain").hidden = false;
  }
  if (config.satellite_url && !map.getSource("satellite")) {
    map.addSource("satellite", {
      type: "raster",
      tiles: [config.satellite_url],
      tileSize: 256,
      attribution:
        config.satellite_attribution || "Configured satellite provider",
    });
    map.addLayer(
      {
        id: "satellite-layer",
        type: "raster",
        source: "satellite",
        layout: { visibility: "none" },
      },
      "radius-fill",
    );
    $("#satellite").hidden = false;
  }
  updateMapData();
  drawRoute();
}
function radiusGeoJSON() {
  if (!state.hasSearched) return { type: "FeatureCollection", features: [] };
  const [lat, lon] = state.center,
    coords = [],
    angular = state.radius / 3958.7613,
    rad = Math.PI / 180;
  for (let i = 0; i <= 90; i++) {
    const bearing = (i / 90) * Math.PI * 2,
      phi = lat * rad,
      lambda = lon * rad;
    const p = Math.asin(
      Math.sin(phi) * Math.cos(angular) +
        Math.cos(phi) * Math.sin(angular) * Math.cos(bearing),
    );
    const l =
      lambda +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(phi),
        Math.cos(angular) - Math.sin(phi) * Math.sin(p),
      );
    coords.push([l / rad, p / rad]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}
function updateMapData() {
  if (!map?.getSource("stations")) return;
  map.getSource("stations").setData({
    type: "FeatureCollection",
    features: state.filtered.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
      properties: { id: String(s.id) },
    })),
  });
  map.getSource("radius")?.setData(radiusGeoJSON());
  updateMarkers();
}
function updateMarkers() {
  if (!map?.getSource("stations") || !map.isSourceLoaded("stations")) return;
  markers.forEach((m) => m.remove());
  markers = [];
  const features = map.queryRenderedFeatures({ layers: ["station-source-loader"] }),
    seen = new Set();
  for (const feature of features) {
    const p = feature.properties,
      key = p.cluster ? `c${p.cluster_id}` : `s${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let node;
    if (p.cluster) {
      node = button(
        String(p.point_count),
        async () => {
          try {
            const zoom = await map
              .getSource("stations")
              .getClusterExpansionZoom(p.cluster_id);
            map.easeTo({
              center: feature.geometry.coordinates,
              zoom,
              duration: motion() ? 220 : 0,
            });
          } catch {
            toast("Zoom in to explore this cluster.");
          }
        },
        "cluster-pin",
      );
      node.setAttribute(
        "aria-label",
        `Expand cluster of ${p.point_count} stations`,
      );
    } else {
      const s = state.filtered.find((s) => String(s.id) === String(p.id));
      if (!s) continue;
      node = button(
        state.selected === s.id ? `${s.max_power_kw ?? "—"} kW` : "",
        () => showDetail(s),
        `station-pin ${s.operational === false ? "unavailable" : s.operational === true ? "" : "unknown"} ${s.max_power_kw >= 150 ? "high-power" : ""} ${state.selected === s.id ? "selected" : ""}`,
        s.operational === false
          ? "close"
          : s.operational === true
            ? "bolt"
            : "info",
      );
      node.setAttribute(
        "aria-label",
        `${s.name}, ${s.status}, ${s.max_power_kw ?? "unknown"} kW`,
      );
    }
    markers.push(
      new maplibregl.Marker({ element: node, anchor: "bottom" })
        .setLngLat(feature.geometry.coordinates)
        .addTo(map),
    );
  }
}
const motion = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
function fitResults() {
  if (!map || !state.filtered.length) return;
  const bounds = new maplibregl.LngLatBounds();
  state.filtered.forEach((s) => bounds.extend([s.longitude, s.latitude]));
  map.fitBounds(bounds, {
    padding: {
      top: 150,
      right: 75,
      bottom:
        innerWidth <= 800
          ? Math.round($(".workspace").clientHeight * 0.5)
          : 120,
      left: 65,
    },
    maxZoom: 14,
    duration: motion() ? 220 : 0,
  });
}
$("#fit").onclick = fitResults;
$("#recenter").onclick = () =>
  map?.easeTo({
    center: [state.center[1], state.center[0]],
    zoom: 13.2,
    bearing: 0,
    duration: motion() ? 220 : 0,
  });
$("#pitch").onclick = () => {
  if (!map) return;
  const pitched = $("#pitch").getAttribute("aria-pressed") !== "true";
  $("#pitch").setAttribute("aria-pressed", pitched);
  map.easeTo({
    pitch: pitched ? 55 : 0,
    zoom: pitched ? Math.max(14.5, map.getZoom()) : map.getZoom(),
    duration: motion() ? 250 : 0,
  });
  if (map.getLayer("current-buildings"))
    map.setLayoutProperty(
      "current-buildings",
      "visibility",
      pitched ? "visible" : "none",
    );
  else if (pitched)
    toast(
      "Pitched view enabled. Building geometry is unavailable in this style.",
    );
};
$("#terrain").onclick = () => {
  const active = $("#terrain").getAttribute("aria-pressed") !== "true";
  $("#terrain").setAttribute("aria-pressed", active);
  map.setTerrain(active ? { source: "terrain", exaggeration: 1 } : null);
};
$("#satellite").onclick = () => {
  const active = $("#satellite").getAttribute("aria-pressed") !== "true";
  $("#satellite").setAttribute("aria-pressed", active);
  map.setLayoutProperty(
    "satellite-layer",
    "visibility",
    active ? "visible" : "none",
  );
};
$("#search-area").onclick = () => {
  const center = map.getCenter();
  search({
    location_mode: "coordinates",
    latitude: center.lat,
    longitude: center.lng,
    label: "This map area",
  });
};
async function api(path, data, signal) {
  let response;
  try {
    response = await fetch(new URL(path, config.api_base || document.baseURI), {
      method: data ? "POST" : "GET",
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      signal,
      credentials: "omit",
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw Error(
      "Unable to connect to the station service. Check your connection and try again.",
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error(
      "The station service is temporarily unavailable. Please try again.",
    );
  }
  if (!response.ok)
    throw Error(
      result.error ||
        result.detail?.[0]?.msg ||
        "Search could not be completed. Please try again.",
    );
  return result;
}
function searchValues() {
  return {
    location_mode: "zip",
    zip_code: $("#zip").value.trim(),
    radius: Number($("[name=radius]").value),
    limit: 100,
  };
}
async function search(override = {}) {
  const id = ++requestNumber;
  locationAttempt++;
  controller?.abort();
  controller = new AbortController();
  const data = { ...searchValues(), ...override };
  lastRequest = data;
  $("#submit").disabled = true;
  $("#message").classList.remove("error");
  $("#message").textContent = "Finding charging stations…";
  $("#retry").hidden = true;
  $("#results").setAttribute("aria-busy", "true");
  if (!state.stations.length)
    $("#results").replaceChildren(
      ...Array.from({ length: 3 }, () => el("div", null, "skeleton")),
    );
  try {
    const result = await api("api/search", data, controller.signal);
    if (id !== requestNumber) return;
    state.stations = result.stations;
    state.center = result.center;
    state.radius = Number(data.radius);
    state.retrieved = result.retrieved_at;
    state.hasSearched = true;
    state.query = data;
    const label =
      data.location_mode === "zip"
        ? result.location
        : data.label || "Nearby charging";
    save("last-results", {
      ...result,
      radius: state.radius,
      location: label,
      query: data,
    });
    $("#clear-location").hidden = !$("#zip").value;
    updateNetworkOptions();
    clearDetail();
    $("#message").textContent =
      `${result.stations.length} stations found. Live plug availability is not provided.`;
    $("#map-location").textContent = label;
    $("#map-location-sub").textContent =
      data.location_mode === "zip"
        ? "Distances from the ZIP code center"
        : "Distances from your search location";
    $("#radius-label").textContent = `${state.radius} mi radius`;
    $("#search-area").hidden = true;
    fitResults();
  } catch (error) {
    if (error.name !== "AbortError" && id === requestNumber) {
      $("#message").textContent =
        error.message +
        (state.stations.length
          ? " Your previous results are still shown."
          : "");
      $("#message").classList.add("error");
      $("#retry").hidden = false;
      if (!state.stations.length) render();
    }
  } finally {
    if (id === requestNumber) {
      $("#submit").disabled = false;
      $("#results").removeAttribute("aria-busy");
    }
  }
}
$("#search").onsubmit = (event) => {
  event.preventDefault();
  search();
};
$("#retry").onclick = () => search(lastRequest || {});
$("#locate").onclick = () => {
  if (!navigator.geolocation)
    return toast(
      "Location is unavailable on this device. Enter a ZIP code instead.",
    );
  const attempt = ++locationAttempt;
  $("#locate").disabled = true;
  $("#message").textContent = "Waiting for your location permission…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      $("#locate").disabled = false;
      if (attempt !== locationAttempt) return;
      $("#zip").value = "";
      $("#clear-location").hidden = true;
      search({
        location_mode: "coordinates",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label: "Near your location",
      });
    },
    () => {
      $("#locate").disabled = false;
      if (attempt !== locationAttempt) return;
      $("#message").textContent =
        "Location access was unavailable. Enter a US ZIP code to search instead.";
      $("#zip").focus();
    },
    { timeout: 10000 },
  );
};
function infoRow(container, label, value) {
  const row = el("div", null, "info-row");
  row.append(el("span", label), el("strong", value ?? "Not provided"));
  container.append(row);
}
function showDetail(s) {
  if (innerWidth <= 800) {
    $("#filters-panel").hidden = true;
    $("#filters-toggle").setAttribute("aria-expanded", "false");
  }
  state.selected = s.id;
  render();
  const panel = $("#detail");
  panel.replaceChildren();
  const back = button(
    "Back to stations",
    () => {
      clearDetail();
      $(`[data-station="${CSS.escape(String(s.id))}"] .card-link`)?.focus();
    },
    "back",
    "arrow",
  );
  panel.append(back, el("h2", stationName(s)), el("p", s.address), status(s));
  const metrics = el("div", null, "detail-metrics");
  for (const [value, label] of [
    [`${s.max_power_kw ?? "—"} kW`, "maximum advertised power"],
    [
      `${Number.isFinite(s.distance_miles) ? s.distance_miles.toFixed(1) : "—"} mi`,
      "straight-line distance",
    ],
  ]) {
    const box = el("div");
    box.append(el("strong", value), el("small", label));
    metrics.append(box);
  }
  panel.append(metrics);
  const actions = el("div", null, "detail-actions");
  actions.append(
    link(
      "Get directions",
      `https://www.google.com/maps/dir/?api=1&destination=${s.latitude},${s.longitude}`,
      "primary",
    ),
  );
  actions.append(
    button("Estimate charge", () => openEstimator(s), "secondary", "bolt"),
  );
  panel.append(actions);
  panel.append(el("h3", "Connections & compatibility"));
  const comp = compatibility(vehicle(), s);
  for (const c of s.connections || []) {
    const row = el("div", null, "connection-row");
    row.append(
      el("strong", CONNECTOR_LABELS[c.connector] || "Unknown connector"),
      el("span", `${c.current_type || "Unknown"} · ${c.power_kw ?? "—"} kW`),
      el(
        "small",
        `${c.quantity ?? "Unknown"} reported connectors · ${c.voltage ?? "—"} V · ${c.amps ?? "—"} A`,
      ),
    );
    const rule = comp.connections.find(
      (x) => x.connector === c.connector && x.current_type === c.current_type,
    );
    if (rule)
      row.append(
        el("small", `${compatibilityLabel(rule.physical)} — ${rule.reason}`),
      );
    panel.append(row);
  }
  if (!s.connections?.length)
    panel.append(el("p", "Connection details not provided."));
  panel.append(
    el(
      "p",
      `${s.points ?? "Unknown"} charging points reported. Connector quantity is not a count of simultaneously usable parking spaces.`,
    ),
  );
  panel.append(
    button(
      vehicle() ? "Edit my vehicle" : "Add a vehicle for compatibility",
      openGarage,
      "text-button",
      "car",
    ),
  );
  panel.append(
    el(
      "div",
      `Network access: ${comp.network === "allowed" ? "recorded by you; verify with operator" : "unknown"}. Physical fit does not establish network authorization. A NACS inlet alone does not establish Supercharger access.`,
      "notice",
    ),
  );
  panel.append(el("h3", "Before you go"));
  infoRow(panel, "Network / operator", networkName(s));
  infoRow(panel, "Station host", s.host);
  infoRow(panel, "Reported access", s.access);
  infoRow(panel, "Reported opening hours", s.hours);
  infoRow(
    panel,
    "Membership",
    s.membership_required === true
      ? "Reported required"
      : s.membership_required === false
        ? "Reported not required"
        : "Unknown",
  );
  panel.append(
    el(
      "p",
      s.access_comments ||
        "No additional access notes supplied. Missing information does not mean public access.",
    ),
  );
  panel.append(
    el("h3", "Reported pricing"),
    el("p", s.pricing || "Price not provided"),
    el(
      "p",
      `Source: ${s.provider || "Unknown provider"}. Pricing text is not a verified structured tariff; fees may apply.`,
    ),
    el("h3", "Availability"),
    el(
      "div",
      "Live availability unavailable. Reported operational status is not real-time occupancy or a guarantee that equipment works now.",
      "notice warning",
    ),
  );
  const sourceDetails = el("details", null, "source-details");
  sourceDetails.append(el("summary", "Source, freshness & data completeness"));
  infoRow(sourceDetails, "Last verified", dateLabel(s.verified));
  infoRow(sourceDetails, "Last updated", dateLabel(s.updated));
  const fields = [
      s.max_power_kw,
      s.connections?.length,
      s.access,
      s.hours,
      s.verified,
      s.updated,
    ],
    complete = fields.filter(Boolean).length;
  sourceDetails.append(
    el(
      "p",
      `${complete} of 6 detail fields supplied — completeness, not reliability.`,
    ),
  );
  const bar = el("div", null, "quality-bar"),
    fill = el("span");
  fill.style.width = `${(complete / 6) * 100}%`;
  bar.append(fill);
  sourceDetails.append(
    bar,
    el(
      "p",
      "Old or missing verification dates increase uncertainty. Confirm access and equipment with the operator. Photos, site geometry and amenities are omitted when licensed, verified evidence is unavailable.",
    ),
  );
  if (s.source_url)
    sourceDetails.append(
      link("View source / report incorrect data", s.source_url),
    );
  sourceDetails.append(
    el(
      "p",
      `Provider: ${s.provider || "Unknown"} · ${s.license || "See source licensing."}`,
    ),
  );
  panel.append(sourceDetails);
  const tools = el("div", null, "detail-actions");
  tools.append(
    button(
      "Save",
      (event) => {
        toggleFavorite(s);
        event.currentTarget.setAttribute(
          "aria-pressed",
          state.favorites.some((f) => f.id === s.id),
        );
      },
      "secondary",
      "heart",
    ),
    button(
      "Compare",
      (event) => {
        toggleCompare(s);
        event.currentTarget.setAttribute(
          "aria-pressed",
          state.comparison.some((c) => c.id === s.id),
        );
      },
      "secondary",
      "layers",
    ),
    button("Share station", () => shareStation(s), "secondary", "external"),
    button(
      "Add to trip",
      () => {
        if (!state.tripStops.some((x) => x.id === s.id))
          state.tripStops.push(s);
        toast("Added to your trip on this device.");
      },
      "secondary",
      "route",
    ),
  );
  panel.append(tools);
  for (const [index, pressed] of [
    [0, state.favorites.some((f) => f.id === s.id)],
    [1, state.comparison.some((c) => c.id === s.id)],
  ])
    tools.children[index].setAttribute("aria-pressed", pressed);
  if (map)
    panel.append(
      button(
        "Show on map",
        () => {
          setSheet(false);
          map.flyTo({
            center: [s.longitude, s.latitude],
            zoom: Math.max(map.getZoom(), 14),
            offset:
              innerWidth <= 800
                ? [0, -$(".workspace").clientHeight * 0.22]
                : [0, 0],
            duration: state.fly && motion() ? 900 : 0,
          });
          if (innerWidth <= 800) keepSelectedPinVisible(s);
        },
        "text-button",
        "pin",
      ),
    );
  $("#results").hidden = true;
  panel.hidden = false;
  panel.scrollTop = 0;
  back.focus({ preventScroll: true });
  if (innerWidth <= 800) setSheet(false);
  state.recent = [
    { ...s, viewed_at: new Date().toISOString() },
    ...state.recent.filter((x) => x.id !== s.id),
  ].slice(0, 12);
  save("recent", state.recent);
  // Desktop details preserve the map. Mobile pins move only when chrome covers them.
  if (innerWidth <= 800) {
    keepSelectedPinVisible(s);
    setTimeout(() => {
      if (state.selected === s.id) keepSelectedPinVisible(s);
    }, 230);
  }
}
function keepSelectedPinVisible(s) {
  if (!map || $(".workspace").classList.contains("list-only")) return;
  const bounds = $("#map").getBoundingClientRect();
  const searchBottom =
    $(".sidebar-top").getBoundingClientRect().bottom - bounds.top;
  const sheetTop = $(".sidebar").getBoundingClientRect().top - bounds.top;
  const top = searchBottom + 48;
  const bottom = sheetTop - 32;
  const point = map.project([s.longitude, s.latitude]);
  if (
    point.y < top ||
    point.y > bottom ||
    point.x < 28 ||
    point.x > bounds.width - 60
  ) {
    const targetY = Math.max(top, (top + bottom) / 2);
    map.easeTo({
      center: [s.longitude, s.latitude],
      offset: [0, targetY - bounds.height / 2],
      duration: 0,
    });
  }
}
async function shareURL(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. No API keys or personal history included.");
  } catch {
    const body = openModal("Share this link");
    const input = el("input");
    input.value = url;
    input.readOnly = true;
    input.style.width = "100%";
    body.append(input);
    input.select();
  }
}
function shareStation(s) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("station", s.id);
  shareURL(url.href);
}
async function openExplorer() {
  const body = openModal("Connectors"),
    epoch = modalEpoch;
  body.append(el("p", "Loading connector diagrams…"));
  try {
    const module = await import("./explorer.js");
    if (epoch !== modalEpoch) return;
    body.replaceChildren();
    const cleanup = await module.mountExplorer(body);
    if (epoch !== modalEpoch) cleanup();
    else explorerCleanup = cleanup;
  } catch {
    if (epoch === modalEpoch)
      body.replaceChildren(
        el(
          "div",
          "Connector studio could not load. NACS and CCS1 support DC charging when the vehicle and network permit it. J1772 is AC. CHAdeMO is DC. Confirm exact vehicle compatibility with its manufacturer.",
          "notice",
        ),
      );
  }
}
$("#learn-nav").onclick = openExplorer;
$("#learn-card").onclick = openExplorer;
$("#garage-nav").onclick = openGarage;
$("#explore-nav").onclick = () => {
  closeModal();
};
function openGarage(editId) {
  const body = openModal("My garage");
  body.append(
    el(
      "p",
      "Saved on this device; no account needed. Enter specifications from your owner’s manual or manufacturer documentation. Entries are not independently verified.",
    ),
  );
  const saved = el("div", null, "vehicle-list");
  saved.setAttribute("aria-label", "Saved vehicles");
  if (state.vehicles.length) saved.setAttribute("role", "list");
  if (state.vehicles.length) body.append(el("h3", "Saved vehicles"));
  else
    saved.append(
      el(
        "p",
        "No saved vehicles. Add your vehicle below to check compatibility and prefill charging estimates.",
        "assumptions",
      ),
    );
  for (const v of state.vehicles) {
    const item = el(
        "div",
        null,
        `vehicle-card ${v.id === state.activeVehicle ? "active" : ""}`,
      ),
      choose = button(
        `${v.make} ${v.model}`,
        () => {
          state.activeVehicle = v.id;
          save("active-vehicle", v.id);
          render();
          openGarage();
        },
        "text-button",
        "car",
      );
    choose.setAttribute("aria-pressed", String(v.id === state.activeVehicle));
    choose.setAttribute(
      "aria-label",
      `Use ${v.make} ${v.model}${v.id === state.activeVehicle ? ", selected vehicle" : ""}`,
    );
    item.setAttribute("role", "listitem");
    item.append(
      choose,
      button("Edit", () => openGarage(v.id), "text-button"),
      button(
        "Remove",
        () => {
          state.vehicles = state.vehicles.filter((x) => x.id !== v.id);
          if (state.activeVehicle === v.id)
            state.activeVehicle = state.vehicles[0]?.id ?? null;
          save("vehicles", state.vehicles);
          save("active-vehicle", state.activeVehicle);
          render();
          openGarage();
        },
        "text-button",
      ),
    );
    const controls = $$("button", item);
    controls[1].setAttribute("aria-label", `Edit ${v.make} ${v.model}`);
    controls[2].setAttribute("aria-label", `Remove ${v.make} ${v.model}`);
    if (v.id === state.activeVehicle)
      item.append(el("small", "Selected vehicle"));
    saved.append(item);
  }
  body.append(saved);
  const editing = state.vehicles.find((v) => v.id === editId),
    form = el("form"),
    details = formSection("Vehicle"),
    grid = el("div", null, "form-grid"),
    specifications = formSection("Charging specifications"),
    specificationGrid = el("div", null, "form-grid"),
    source = formSection(
      "Specification source",
      "Required so you can review the origin and age of your manual entries.",
    ),
    sourceGrid = el("div", null, "form-grid");
  inputField(grid, "Make", "make", editing?.make || "", "text", {
    required: true,
    maxLength: 60,
    placeholder: "e.g. Hyundai",
  });
  inputField(grid, "Model", "model", editing?.model || "", "text", {
    required: true,
    maxLength: 60,
    placeholder: "e.g. IONIQ 5",
  });
  inputField(grid, "Model year", "year", editing?.year || "", "number", {
    min: 1990,
    max: new Date().getFullYear() + 2,
    required: true,
  });
  inputField(grid, "Trim (optional)", "trim", editing?.trim || "", "text", {
    maxLength: 60,
  });
  selectField(
    grid,
    "Vehicle inlet",
    "inlet",
    CONNECTORS.map((c) => [c, CONNECTOR_LABELS[c]]),
    editing?.connectors?.[0] || "CCS1",
  );
  inputField(
    specificationGrid,
    "Usable battery capacity (kWh)",
    "battery_kwh",
    editing?.battery_kwh ?? "",
    "number",
    { min: 1, max: 500, step: "any", placeholder: "From a verified source" },
  );
  inputField(
    specificationGrid,
    "Maximum AC power (kW)",
    "max_ac_kw",
    editing?.max_ac_kw ?? "",
    "number",
    { min: 0, max: 100, step: "any" },
  );
  inputField(
    specificationGrid,
    "Maximum DC power (kW)",
    "max_dc_kw",
    editing?.max_dc_kw ?? "",
    "number",
    { min: 0, max: 1000, step: "any" },
  );
  inputField(
    specificationGrid,
    "Consumption (kWh / 100 mi)",
    "consumption_kwh_per_100_miles",
    editing?.consumption_kwh_per_100_miles ?? "",
    "number",
    { min: 1, max: 200, step: "any" },
  );
  inputField(
    sourceGrid,
    "Specification source URL or reference",
    "source",
    editing?.source || "",
    "text",
    { required: true, maxLength: 500 },
  );
  inputField(
    sourceGrid,
    "Source checked on",
    "source_date",
    editing?.source_date || new Date().toISOString().slice(0, 10),
    "date",
    { required: true },
  );
  details.append(grid);
  specifications.append(specificationGrid);
  source.append(sourceGrid);
  form.append(details, specifications, source);
  const adapterSection = formSection(
    "Adapters you own",
    "Record only adapters approved for your vehicle and current type. This is not a safety certification.",
  );
  const adapterList = el("div", null, "adapter-list");
  const addAdapter = (a = {}) => {
    const row = el("div", null, "adapter-row");
    selectField(
      row,
      "Charger connector",
      "adapter_from",
      CONNECTORS,
      a.from || "NACS",
    );
    selectField(row, "Vehicle inlet", "adapter_to", CONNECTORS, a.to || "CCS1");
    selectField(
      row,
      "Current",
      "adapter_current",
      ["AC", "DC"],
      a.current_type || "DC",
    );
    row.append(
      button(
        "Remove adapter",
        () => {
          const focusTarget =
            row.nextElementSibling?.querySelector("select") ||
            row.previousElementSibling?.querySelector("select") ||
            adapterList.nextElementSibling;
          row.remove();
          focusTarget?.focus();
        },
        "text-button",
      ),
    );
    adapterList.append(row);
    return row;
  };
  for (const a of editing?.adapters || []) addAdapter(a);
  adapterSection.append(
    adapterList,
    button(
      "Add an adapter",
      () => addAdapter().querySelector("select").focus(),
      "text-button",
      "plug",
    ),
  );
  form.append(adapterSection);
  const access = formSection(
    "Network access",
    "Enter only networks where you have confirmed authorization. A NACS inlet does not guarantee Supercharger access.",
  );
  inputField(
    access,
    "Confirmed networks, separated by commas",
    "networks",
    editing?.networks?.join(", ") || "",
  );
  form.append(access);
  const error = el("p", null, "message error");
  error.setAttribute("role", "alert");
  form.append(error);
  const actions = el("div", null, "form-actions"),
    submit = el("button", editing ? "Save changes" : "Add vehicle", "primary");
  submit.type = "submit";
  actions.append(submit);
  form.append(actions);
  body.append(form);
  form.onsubmit = (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form)),
      v = {
        ...values,
        id: editing?.id || crypto.randomUUID(),
        connectors: [values.inlet],
        networks: values.networks
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        adapters: $$(".adapter-row", adapterList).map((row) => ({
          from: $("[name=adapter_from]", row).value,
          to: $("[name=adapter_to]", row).value,
          current_type: $("[name=adapter_current]", row).value,
        })),
      };
    for (const key of [
      "battery_kwh",
      "max_ac_kw",
      "max_dc_kw",
      "consumption_kwh_per_100_miles",
    ])
      v[key] = values[key] === "" ? null : Number(values[key]);
    delete v.adapter_from;
    delete v.adapter_to;
    delete v.adapter_current;
    delete v.inlet;
    state.vehicles = [...state.vehicles.filter((x) => x.id !== v.id), v];
    state.activeVehicle = v.id;
    save("vehicles", state.vehicles);
    save("active-vehicle", v.id);
    render();
    toast("Vehicle saved on this device. Specifications remain user-supplied.");
    openGarage();
  };
}
function openEstimator(s, second) {
  const body = openModal(
    second ? "Compare charging estimates" : "Charging estimate",
  );
  body.append(
    el(
      "p",
      "A constant-power estimate, not a charging prediction. Use your vehicle specifications and enter fees manually; station pricing text is not interpreted.",
    ),
  );
  const v = vehicle(),
    form = el("form"),
    charging = formSection("Charging assumptions"),
    grid = el("div", null, "form-grid"),
    fees = formSection(
      "Fees",
      "Leave a fee blank if unknown; enter 0 if none. Any unknown fee makes the total unknown. Amounts are before tax unless you enter tax-inclusive rates.",
    ),
    feeGrid = el("div", null, "form-grid");
  inputField(grid, "Starting battery (%)", "start", 20, "number", {
    min: 0,
    max: 99,
    required: true,
  });
  inputField(grid, "Target battery (%)", "target", 80, "number", {
    min: 1,
    max: 100,
    required: true,
  });
  inputField(
    grid,
    "Usable battery capacity (kWh)",
    "battery",
    v?.battery_kwh ?? "",
    "number",
    { min: 1, max: 500, step: "any", required: true },
  );
  const current = selectField(
    grid,
    "Charging current",
    "current",
    ["DC", "AC"],
    s?.connections?.[0]?.current_type === "AC" ? "AC" : "DC",
  );
  const vehicleLimit = inputField(
    grid,
    "Vehicle charging limit (kW)",
    "vehicle",
    current.value === "DC" ? (v?.max_dc_kw ?? "") : (v?.max_ac_kw ?? ""),
    "number",
    { min: 0.1, max: 2000, step: "any", required: true },
  );
  inputField(
    grid,
    "Charger reported limit (kW)",
    "charger",
    s?.max_power_kw ?? "",
    "number",
    { min: 0.1, max: 2000, step: "any", required: true },
  );
  inputField(grid, "Charging efficiency (%)", "efficiency", 90, "number", {
    min: 1,
    max: 100,
    step: "any",
    required: true,
  });
  inputField(
    grid,
    "Vehicle consumption (kWh / 100 mi)",
    "consumption",
    v?.consumption_kwh_per_100_miles ?? 30,
    "number",
    { min: 1, max: 200, step: "any", required: true },
  );
  current.onchange = () =>
    (vehicleLimit.value =
      current.value === "DC" ? (v?.max_dc_kw ?? "") : (v?.max_ac_kw ?? ""));
  for (const [name, label] of [
    ["kwh_rate", "Energy rate ($ / kWh)"],
    ["minute_rate", "Time rate ($ / minute)"],
    ["session_fee", "Session fee ($)"],
    ["parking_fee", "Parking fee ($)"],
  ])
    inputField(feeGrid, label, name, "", "number", {
      min: 0,
      max: 10000,
      step: "any",
      placeholder: "Unknown; enter 0 if none",
    });
  charging.append(grid);
  fees.append(feeGrid);
  const feeFeedback = el("p", null, "assumptions");
  feeFeedback.id = "estimate-fee-feedback";
  feeFeedback.setAttribute("role", "status");
  feeFeedback.setAttribute("aria-live", "polite");
  feeFeedback.setAttribute("aria-atomic", "true");
  const updateFeeFeedback = () => {
    const missing = $$("input", feeGrid).filter(
      (input) => input.value === "",
    ).length;
    feeFeedback.textContent = missing
      ? `${missing} ${missing === 1 ? "fee is" : "fees are"} unknown. The total cost will be unknown.`
      : "All fees entered. The estimate can include a total cost.";
  };
  for (const input of $$("input", feeGrid)) {
    input.setAttribute("aria-describedby", feeFeedback.id);
    input.addEventListener("input", updateFeeFeedback);
  }
  updateFeeFeedback();
  fees.append(feeFeedback);
  form.append(charging, fees);
  if (second) {
    const box = formSection(`Second stop: ${stationName(second)}`);
    inputField(
      box,
      "Second charger limit (kW)",
      "second_power",
      second.max_power_kw ?? "",
      "number",
      { min: 0.1, max: 2000, step: "any", required: true },
    );
    form.append(
      box,
      el(
        "p",
        "Both stops use the same vehicle, state of charge, efficiency and manually entered fees. This compares power, not verified real-world tariffs.",
        "assumptions",
      ),
    );
  }
  const submit = el("button", "Calculate estimate", "primary");
  submit.type = "submit";
  const output = el("section");
  output.setAttribute("aria-label", "Charging estimate results");
  output.setAttribute("aria-live", "polite");
  form.append(el("div", null, "form-actions"));
  $(".form-actions", form).append(submit);
  body.append(form, output);
  form.onsubmit = (e) => {
    e.preventDefault();
    output.replaceChildren();
    try {
      const values = Object.fromEntries(new FormData(form));
      for (const [station, input] of [
        [s, values],
        ...(second
          ? [[second, { ...values, charger: values.second_power }]]
          : []),
      ]) {
        const result = estimate(input);
        output.append(
          el("h3", station ? stationName(station) : "Your estimate"),
        );
        const stats = el("div", null, "estimate-results");
        for (const [number, label] of [
          [`${Math.ceil(result.minutes)} min`, "constant-power charging"],
          [`${result.batteryEnergy.toFixed(1)} kWh`, "energy added to battery"],
          [
            result.total === null ? "Unknown" : `$${result.total.toFixed(2)}`,
            "session cost · before tax",
          ],
        ]) {
          const cell = el("div", null, "estimate-stat");
          cell.append(el("strong", number), el("small", label));
          stats.append(cell);
        }
        output.append(
          stats,
          el(
            "p",
            `Capped at ${result.power.toFixed(1)} kW (minimum of vehicle and charger). ${result.gridEnergy.toFixed(1)} kWh from charger at ${values.efficiency}% efficiency; approximately ${Math.round(result.miles)} miles added at ${values.consumption} kWh/100 mi.`,
            "assumptions",
          ),
        );
        for (const [label, value] of Object.entries(result.fees))
          infoRow(
            output,
            `${label[0].toUpperCase() + label.slice(1)} charge`,
            value === null ? "Not provided" : `$${value.toFixed(2)}`,
          );
        if (!result.complete)
          output.append(
            el(
              "p",
              `Known fees subtotal: $${result.known.toFixed(2)}. Missing fees prevent a complete cost estimate.`,
              "assumptions",
            ),
          );
      }
      output.append(
        el(
          "div",
          "Power tapers as the battery fills, especially at high state of charge. Temperature, battery conditioning, battery health, charger sharing and charging losses affect results. No verified vehicle-specific charging curve is configured.",
          "notice warning",
        ),
      );
    } catch (error) {
      const message = el("p", error.message, "message error");
      message.setAttribute("role", "alert");
      output.append(message);
    }
  };
}
function openComparison() {
  if (!state.comparison.length) return;
  const body = openModal("Compare stations"),
    wrap = el("div", null, "table-scroll"),
    table = el("table", null, "comparison-table"),
    thead = el("thead"),
    tbody = el("tbody"),
    head = el("tr");
  table.append(el("caption", "Reported station details"));
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute(
    "aria-label",
    "Station comparison; scroll horizontally for more stations",
  );
  head.append(el("th", "Station"));
  state.comparison.forEach((s) => head.append(el("th", stationName(s))));
  for (const cell of head.children) cell.scope = "col";
  thead.append(head);
  table.append(thead, tbody);
  for (const [label, value] of [
    ["Reported status", (s) => s.status],
    ["Maximum advertised power", (s) => `${s.max_power_kw ?? "Unknown"} kW`],
    ["Connectors", (s) => s.connectors?.join(", ") || "Unknown"],
    ["Charging points", (s) => s.points ?? "Unknown"],
    ["Straight-line miles", (s) => s.distance_miles?.toFixed(2) ?? "Unknown"],
    ["Network", networkName],
    ["Access", (s) => s.access || "Unknown"],
    ["Pricing text", (s) => s.pricing || "Price not provided"],
    [
      "Physical compatibility",
      (s) => compatibilityLabel(compatibility(vehicle(), s).physical),
    ],
    ["Last verified", (s) => dateLabel(s.verified)],
  ]) {
    const row = el("tr");
    row.append(el("th", label));
    row.firstElementChild.scope = "row";
    state.comparison.forEach((s) => row.append(el("td", value(s))));
    tbody.append(row);
  }
  wrap.append(table);
  body.append(
    wrap,
    el(
      "div",
      "Reported operational status is not live occupancy. Confirm pricing and access with the operator before you travel.",
      "notice",
    ),
  );
  if (state.comparison.length >= 2)
    body.append(
      button(
        "Compare charging estimates",
        () => openEstimator(state.comparison[0], state.comparison[1]),
        "primary",
        "bolt",
      ),
    );
}
$("#compare-open").onclick = openComparison;
$("#compare-clear").onclick = () => {
  state.comparison = [];
  render();
};
const networkLinks = {
  "Tesla Supercharger": "https://www.tesla.com/supercharger",
  "Tesla Destination": "https://www.tesla.com/destination-charging",
  "Electrify America": "https://www.electrifyamerica.com/",
  EVgo: "https://www.evgo.com/",
  ChargePoint: "https://www.chargepoint.com/",
};
function openNetworks() {
  const body = openModal("Charging networks");
  body.append(
    el(
      "p",
      "Access, payment and vehicle authorization vary by site. A connector match does not guarantee network access. Current is not affiliated with these operators.",
    ),
  );
  const chips = el("div", null, "network-chips"),
    grid = el("div", null, "network-grid");
  const networks = [...new Set(state.stations.map(networkName))];
  for (const name of networks) {
    const stations = state.stations.filter((s) => networkName(s) === name),
      matches = state.filtered.filter((s) => networkName(s) === name).length;
    chips.append(
      button(
        `${name} · ${matches}`,
        () => {
          $("#network").value = name;
          clearDetail();
          closeModal();
        },
        "chip",
      ),
    );
    const card = el("section", null, "network-card");
    card.append(
      el("h3", name),
      el("p", `${matches} matching of ${stations.length} retrieved stations`),
      el(
        "p",
        `Connectors: ${[...new Set(stations.flatMap((s) => s.connectors))].join(", ") || "Unknown"}`,
      ),
      el(
        "p",
        "Access and payment requirements: see individual source records.",
      ),
    );
    const label = el("label"),
      check = el("input");
    check.type = "checkbox";
    check.checked = state.preferred.includes(name);
    check.onchange = () => {
      state.preferred = check.checked
        ? [...new Set([...state.preferred, name])]
        : state.preferred.filter((n) => n !== name);
      save("networks", state.preferred);
      render();
    };
    label.append(check, document.createTextNode(`Prefer ${name}`));
    card.append(label);
    if (networkLinks[name])
      card.append(link("Official network information", networkLinks[name]));
    grid.append(card);
  }
  if (!networks.length)
    grid.append(
      el(
        "p",
        "No networks loaded. Search for stations to view networks and set preferences.",
        "assumptions",
      ),
    );
  body.append(chips, grid);
}
$("#networks-open").onclick = openNetworks;
function drawRoute() {
  if (!map?.isStyleLoaded() || !state.route?.geometry) return;
  const data = {
    type: "Feature",
    properties: {},
    geometry: state.route.geometry,
  };
  if (map.getSource("trip-route")) map.getSource("trip-route").setData(data);
  else {
    map.addSource("trip-route", { type: "geojson", data });
    map.addLayer({
      id: "trip-route-line",
      type: "line",
      source: "trip-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#3c7c54", "line-width": 5, "line-opacity": 0.85 },
    });
  }
}
function openTrip() {
  const body = openModal("Plan a trip");
  body.append(
    el(
      "p",
      "Choose departure and destination ZIP codes. Route and charging-stop estimates use explicit range assumptions.",
    ),
  );
  const routingDisabled = !config.routing;
  if (routingDisabled) {
    const notice = el(
      "div",
      "Driving routes are unavailable in this deployment. You can still add stops from station details and navigate each leg. Manual stops have no calculated driving distance or arrival battery estimate.",
      "notice warning",
    );
    notice.id = "routing-unavailable";
    body.append(notice);
  }
  const form = el("form"),
    routeSection = formSection("Route"),
    grid = el("div", null, "form-grid"),
    assumptions = formSection("Range assumptions"),
    assumptionGrid = el("div", null, "form-grid");
  inputField(
    grid,
    "From · US ZIP code",
    "origin_zip",
    state.query?.zip_code || "",
    "text",
    {
      required: true,
      inputMode: "numeric",
      pattern: "[0-9]{5}",
      maxLength: 5,
      placeholder: "Departure ZIP",
    },
  );
  inputField(grid, "To · US ZIP code", "destination_zip", "", "text", {
    required: true,
    inputMode: "numeric",
    pattern: "[0-9]{5}",
    maxLength: 5,
    placeholder: "Destination ZIP",
  });
  inputField(
    assumptionGrid,
    "Assumed full-charge range (mi)",
    "range",
    250,
    "number",
    {
      min: 1,
      max: 1000,
      required: true,
    },
  );
  inputField(assumptionGrid, "Starting battery (%)", "start", 80, "number", {
    min: 1,
    max: 100,
    required: true,
  });
  inputField(
    assumptionGrid,
    "Minimum arrival reserve (%)",
    "reserve",
    15,
    "number",
    {
      min: 0,
      max: 90,
      required: true,
    },
  );
  inputField(
    assumptionGrid,
    "Station corridor width (mi)",
    "corridor",
    5,
    "number",
    {
      min: 1,
      max: 25,
      required: true,
    },
  );
  routeSection.append(grid);
  assumptions.append(assumptionGrid);
  form.append(routeSection, assumptions);
  if (routingDisabled) {
    routeSection.disabled = true;
    assumptions.disabled = true;
    form.setAttribute("aria-describedby", "routing-unavailable");
  }
  const actions = el("div", null, "form-actions"),
    submit = el("button", "Plan driving route", "primary");
  submit.type = "submit";
  submit.disabled = routingDisabled;
  if (routingDisabled)
    submit.setAttribute("aria-describedby", "routing-unavailable");
  actions.append(submit);
  form.append(actions);
  body.append(form);
  const result = el("div");
  body.append(result);
  const renderTimeline = () => {
    result.replaceChildren();
    if (state.route) {
      const route = state.route;
      result.append(
        el(
          "div",
          `${route.distance_miles.toFixed(1)} driving miles · ${Math.round(route.duration_minutes)} minutes without live traffic. Sampled corridor search is not exhaustive.`,
          "notice",
        ),
      );
      result.append(
        el(
          "p",
          route.stop_plan?.reason || "Check every leg against your reserve.",
          "assumptions",
        ),
      );
      const alternatives = route.alternatives;
      if (alternatives?.fast?.length)
        result.append(
          el(
            "p",
            `Lower-detour candidates: ${alternatives.fast.map((id) => stationName(route.stations.find((s) => s.id === id) || { name: String(id) })).join(", ")}. Ranked by reported driving detour, not guaranteed fastest total trip.`,
            "assumptions",
          ),
        );
      if (!alternatives?.cheap?.length)
        result.append(
          el(
            "p",
            "Lower-cost ranking unavailable until you supply comparable numeric session-cost assumptions. Ambiguous pricing text is not used.",
            "assumptions",
          ),
        );
      for (const s of route.stations || []) {
        const row = el("div", null, "info-row");
        row.append(
          el("span", stationName(s)),
          el(
            "small",
            `${s.route?.detour_miles?.toFixed(1) ?? "—"} mi / ${Math.round(s.route?.detour_minutes ?? 0)} min driving detour`,
          ),
          button(
            "Add stop",
            () => {
              if (!state.tripStops.some((x) => x.id === s.id))
                state.tripStops.push(s);
              renderTimeline();
            },
            "text-button",
          ),
        );
        $("button", row).setAttribute(
          "aria-label",
          `Add ${stationName(s)} to trip`,
        );
        result.append(row);
      }
    }
    const timeline = el("div", null, "trip-timeline");
    if (!state.tripStops.length)
      timeline.append(
        el(
          "p",
          "No stops yet. Open a station’s details and choose Add to trip, or choose a charging stop along your route.",
          "assumptions",
        ),
      );
    state.tripStops.forEach((s, i) => {
      const stop = el("div", null, "trip-stop");
      stop.append(
        el("strong", `${i + 1}. ${stationName(s)}`),
        el(
          "p",
          s.route
            ? `Driving detour: ${s.route.detour_miles.toFixed(1)} mi · ${Math.round(s.route.detour_minutes)} min. Charging duration requires vehicle assumptions.`
            : "Manual stop. Driving leg and arrival state of charge not computed.",
        ),
      );
      const origin =
        i > 0
          ? `&origin=${state.tripStops[i - 1].latitude},${state.tripStops[i - 1].longitude}`
          : "";
      stop.append(
        link(
          "Navigate this leg",
          `https://www.google.com/maps/dir/?api=1&destination=${s.latitude},${s.longitude}${origin}`,
        ),
        button("Estimate charging", () => openEstimator(s), "text-button"),
        button(
          "Remove stop",
          () => {
            state.tripStops.splice(i, 1);
            renderTimeline();
          },
          "text-button",
        ),
      );
      $("a", stop).setAttribute("aria-label", `Navigate to ${stationName(s)}`);
      const stopButtons = $$("button", stop);
      stopButtons[0].setAttribute(
        "aria-label",
        `Estimate charging at ${stationName(s)}`,
      );
      stopButtons[1].setAttribute(
        "aria-label",
        `Remove ${stationName(s)} from trip`,
      );
      timeline.append(stop);
    });
    result.append(el("h3", "Trip stops"), timeline);
  };
  renderTimeline();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    try {
      const range = Number(values.range),
        start = Number(values.start),
        reserve = Number(values.reserve);
      if (reserve >= start)
        throw Error("Starting battery percentage must exceed arrival reserve.");
      state.route = await api("api/route", {
        origin_zip: values.origin_zip,
        destination_zip: values.destination_zip,
        range_miles: (range * start) / 100,
        reserve_miles: (range * reserve) / 100,
        corridor_miles: Number(values.corridor),
        include_stations: true,
        vehicle: vehicle() || {},
      });
      state.stations = state.route.stations;
      updateNetworkOptions();
      render();
      drawRoute();
      renderTimeline();
      toast("Route ready. Review assumptions and sampled station coverage.");
    } catch (error) {
      const message = el("div", error.message, "notice warning");
      message.setAttribute("role", "alert");
      result.prepend(message);
    } finally {
      submit.disabled = routingDisabled;
    }
  };
}
$("#trip-nav").onclick = openTrip;
function exportCSV() {
  const columns = [
    "id",
    "name",
    "network",
    "latitude",
    "longitude",
    "distance_miles",
    "max_power_kw",
    "points",
    "status",
    "access",
    "pricing",
    "verified",
  ];
  const escape = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const content = [
    columns.join(","),
    ...state.filtered.map((s) =>
      columns.map((key) => escape(s[key])).join(","),
    ),
  ].join("\r\n");
  const a = el("a");
  a.href = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  a.download = "current-stations.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function openTools() {
  const body = openModal("Settings and saved searches"),
    grid = el("div", null, "tool-grid");
  grid.append(
    button("Export filtered results to CSV", exportCSV, "secondary", "list"),
    button(
      "Save ZIP search",
      () => {
        if (!state.query?.zip_code)
          return toast("Search a ZIP code first to save that location.");
        state.searches = [
          {
            zip_code: state.query.zip_code,
            radius: state.radius,
            saved_at: new Date().toISOString(),
          },
          ...state.searches,
        ].slice(0, 10);
        save("searches", state.searches);
        openTools();
        toast("Search saved locally.");
      },
      "secondary",
      "bookmark",
    ),
    button(
      "Share filter settings",
      () => {
        const url = new URL(location.pathname, location.origin);
        for (const key of ["connector", "network"])
          if ($("#" + key).value) url.searchParams.set(key, $("#" + key).value);
        if ($("#power").getAttribute("aria-pressed") === "true")
          url.searchParams.set("power", "150");
        if ($("#operational").getAttribute("aria-pressed") === "true")
          url.searchParams.set("operational", "1");
        shareURL(url.href);
      },
      "secondary",
      "external",
    ),
    button("Charging estimate", () => openEstimator(), "secondary", "bolt"),
  );
  body.append(grid);
  body.append(el("h3", "Display and map"));
  for (const [label, key, current] of [
    [
      "Reduce transparency for outdoor use",
      "outdoor",
      document.documentElement.classList.contains("outdoor"),
    ],
    ["Animate map moves to selected stations", "fly", state.fly],
  ]) {
    const row = el("label", null, "check-row"),
      input = el("input");
    input.type = "checkbox";
    input.checked = current;
    input.onchange = () => {
      save(key, input.checked);
      if (key === "outdoor")
        document.documentElement.classList.toggle("outdoor", input.checked);
      else state.fly = input.checked;
    };
    row.append(input, document.createTextNode(label));
    body.append(row);
  }
  body.append(el("h3", "Saved searches"));
  if (!state.searches.length)
    body.append(
      el(
        "p",
        "Save a ZIP search to return to the same area later. Saved searches stay on this device.",
        "assumptions",
      ),
    );
  state.searches.forEach((s, i) => {
    const row = el("div", null, "saved-search");
    row.append(
      el("span", `ZIP ${s.zip_code} · ${s.radius} mi`),
      button(
        "Search",
        () => {
          $("#zip").value = s.zip_code;
          $("[name=radius]").value = String(s.radius);
          $("#clear-location").hidden = false;
          closeModal();
          search();
        },
        "text-button",
      ),
      button(
        "Remove",
        () => {
          state.searches.splice(i, 1);
          save("searches", state.searches);
          openTools();
        },
        "text-button",
      ),
    );
    const searchLabel = row.firstElementChild.textContent;
    const searchButtons = $$("button", row);
    searchButtons[0].setAttribute(
      "aria-label",
      `Run saved search: ${searchLabel}`,
    );
    searchButtons[1].setAttribute(
      "aria-label",
      `Remove saved search: ${searchLabel}`,
    );
    body.append(row);
  });
  body.append(el("h3", "Recently viewed"));
  if (!state.recent.length)
    body.append(
      el("p", "Open a station’s details to find it here later.", "assumptions"),
    );
  for (const s of state.recent.slice(0, 6))
    body.append(
      button(
        stationName(s),
        () => {
          closeModal();
          showDetail(s);
        },
        "text-button",
      ),
    );
  body.append(el("h3", "Data on this device"));
  body.append(
    el(
      "div",
      `Local data is not live. ${state.retrieved ? `Station retrieval: ${new Date(state.retrieved).toLocaleString()}. ` : ""}${shellCache ? `Interface cached: ${new Date(shellCache).toLocaleString()}. ` : ""}Offline use requires a previous successful visit. Basemap tiles are not cached. No accounts or cross-device syncing.`,
      "notice",
    ),
  );
  body.append(
    link(
      "API documentation",
      new URL("docs", config.api_base || document.baseURI).href,
      "secondary",
    ),
  );
}
$("#more-actions").onclick = openTools;
window.addEventListener("offline", () => {
  $("#message").textContent =
    "Offline · showing retained station snapshots, not live data. Maps may be unavailable.";
});
async function initialize() {
  updateNetworkOptions();
  const params = new URLSearchParams(location.search);
  for (const key of ["connector", "network"]) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    if (
      key === "network" &&
      ![...$("#network").options].some((option) => option.value === value)
    )
      $("#network").add(new Option(value, value));
    $("#" + key).value = value;
  }
  if (params.get("power") === "150")
    $("#power").setAttribute("aria-pressed", "true");
  if (params.get("operational") === "1")
    $("#operational").setAttribute("aria-pressed", "true");
  const cached = load("last-results", null);
  if (cached?.demo === true) {
    try {
      localStorage.removeItem("current-last-results");
    } catch {}
  } else if (
    !navigator.onLine &&
    cached?.retrieved_at &&
    Array.isArray(cached.stations)
  ) {
    state.stations = cached.stations.filter(isSourceStation);
    state.center = cached.center;
    state.retrieved = cached.retrieved_at;
    state.radius = cached.radius;
    state.query = cached.query || null;
    state.hasSearched = true;
    $("#message").textContent =
      `Offline snapshot retrieved ${new Date(cached.retrieved_at).toLocaleString()}. Not live.`;
    $("#map-location").textContent = cached.location || "Saved search area";
  }
  render();
  initMap();
  if (config.api_base && navigator.onLine) {
    api("api/config")
      .then((capabilities) => {
        for (const key of [
          "routing",
          "live_search",
          "terrain_url",
          "satellite_url",
        ])
          config[key] = capabilities[key];
        if (
          map?.isStyleLoaded() &&
          (config.terrain_url || config.satellite_url)
        )
          setupMapLayers();
      })
      .catch(() => {});
  }
  if (load("list", false)) setListMode(true);
  if (boot.error) {
    $("#message").textContent = boot.error;
    $("#message").classList.add("error");
  }
  const stationId = params.get("station");
  if (stationId) {
    let station = state.stations.find((s) => String(s.id) === stationId);
    if (!station) {
      try {
        station = (await api(`api/station/${encodeURIComponent(stationId)}`))
          .station;
        state.stations.push(station);
      } catch (error) {
        toast(error.message);
      }
    }
    if (station) showDetail(station);
    else toast("This station could not be loaded. Try searching its ZIP code.");
  }
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register(
        new URL("./sw.js", document.baseURI),
        { scope: "./" },
      );
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data?.type === "EV_CACHE_STATUS") shellCache = e.data.cached_at;
      });
      (registration.active || registration.waiting)?.postMessage({
        type: "CACHE_STATUS",
      });
    } catch {
      /* Offline support is optional; search remains functional. */
    }
  }
}
initialize();
