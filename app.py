"""Run locally with python app.py; deploy using gunicorn app:app."""
from flask import Flask, render_template, request, jsonify
from finder import FinderError, search, lookup_zip

app = Flask(__name__)

@app.route("/", methods=["GET", "POST"])
def index():
    values = {"latitude": "40.7580", "longitude": "-73.9855", "radius": "10", "limit": "20", "zip_code": "", "location_mode": "coordinates"}
    stations, error, location = None, None, None
    demo = operational = False
    if request.method == "POST":
        values = {key: request.form.get(key, values[key]) for key in values}
        demo = request.form.get("demo") == "on"
        operational = request.form.get("operational") == "on"
        try:
            radius, limit = float(values["radius"]), int(values["limit"])
            if values["location_mode"] == "zip":
                from finder import validate
                validate(0, 0, radius, limit)
                latitude, longitude, location = lookup_zip(values["zip_code"], demo=demo)
            elif values["location_mode"] == "coordinates":
                latitude, longitude = float(values["latitude"]), float(values["longitude"])
            else:
                raise ValueError("Choose ZIP code or coordinates.")
            stations = search(latitude, longitude, radius, limit, operational, demo)
        except (ValueError, FinderError) as exc:
            error = str(exc)
    return render_template("index.html", values=values, stations=stations, error=error, demo=demo, operational=operational, location=location)



@app.post("/api/search")
def api_search():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error="Invalid search request."), 400
    try:
        radius, limit = float(data.get("radius", 10)), int(data.get("limit", 100))
        from finder import validate
        validate(0, 0, radius, limit)
        demo = data.get("demo") is True
        mode = data.get("location_mode", "coordinates")
        if mode == "zip":
            lat, lon, location = lookup_zip(str(data.get("zip_code", "")), demo=demo)
        elif mode == "coordinates":
            lat, lon = float(data.get("latitude", 40.758)), float(data.get("longitude", -73.9855))
            location = "Selected coordinates"
        else:
            raise ValueError("Choose ZIP code or coordinates.")
        stations = search(lat, lon, radius, limit, demo=demo)
        return jsonify(stations=stations, center=[lat, lon], location=location, demo=demo)
    except (TypeError, ValueError, FinderError) as exc:
        return jsonify(error=str(exc)), 400

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
