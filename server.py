from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from scraper import analyze_unanswered_runs, save_json, save_run_data, scrape_pbp


ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=str(ROOT), static_url_path="")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/scrape")
def scrape_game():
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url", "")).strip()
    if not url:
        return jsonify({"error": "Missing URL in request body."}), 400

    if not url.startswith(("http://", "https://")):
        return jsonify({"error": "URL must start with http:// or https://"}), 400

    try:
        possessions = scrape_pbp(url)
        if not possessions:
            return jsonify({"error": "No play-by-play possessions were extracted from that URL."}), 422

        run_data = analyze_unanswered_runs(possessions, min_unanswered_points=8)
        save_json(possessions, str(ROOT / "pbp_data.json"))
        save_run_data(run_data, str(ROOT / "run_data.json"))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {
            "source_url": url,
            "possession_count": len(possessions),
            "possessions": possessions,
            "run_data": run_data,
        }
    )


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=8000)
