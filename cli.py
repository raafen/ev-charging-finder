"""Example: python cli.py 40.758 -73.9855 --demo"""
import argparse
import json
from finder import FinderError, search, lookup_zip

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Find nearby EV charging stations.")
    parser.add_argument("latitude", type=float, nargs="?")
    parser.add_argument("longitude", type=float, nargs="?")
    parser.add_argument("--zip", dest="zip_code", help="Five-digit US ZIP instead of coordinates")
    parser.add_argument("--radius", type=float, default=10, help="Search radius in miles (max 100)")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--operational", action="store_true")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    try:
        if args.zip_code is not None:
            if args.latitude is not None or args.longitude is not None:
                raise ValueError("Use either --zip or coordinates, not both.")
            args.latitude, args.longitude, _ = lookup_zip(args.zip_code, demo=args.demo)
        elif args.latitude is None or args.longitude is None:
            raise ValueError("Provide latitude and longitude, or --zip ZIP_CODE.")
        stations = search(args.latitude, args.longitude, args.radius, args.limit, args.operational, args.demo)
    except (ValueError, FinderError) as exc:
        parser.exit(1, f"Error: {exc}\n")
    if args.as_json:
        print(json.dumps(stations, indent=2))
    else:
        if args.demo:
            print("DEMO: fictional stations near Times Square")
        for station in stations:
            print(f"{station['name']} | {station['distance_miles']:.2f} miles | {station['status']}\n  {station['address']}\n  {station['source_url']} | Provider: {station['provider']} | {station['license']}")
        if not stations:
            print("No matching stations found.")
