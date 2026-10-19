"""Run locally with python app.py; deploy using gunicorn app:app."""
from flask import Flask, render_template, request
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

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
