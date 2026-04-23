# Sports Analytics Dashboard

This project is an interactive basketball possession dashboard. It scrapes play-by-play data from a game boxscore URL, converts it into possession-level data, and renders visual analytics in the browser.

## What the dashboard does

- Accepts a game boxscore URL (with play-by-play) and scrapes data live.
- Builds a possession-by-possession view of both teams.
- Highlights scoring runs and shows how momentum shifts over time.
- Computes outcome, duration, and efficiency metrics for each team.

## Prerequisites

- Python 3.10+ recommended
- `pip`
- A modern browser (Chrome, Edge, Firefox, Safari)

## Run locally

From the project root:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 -m playwright install chromium
python3 server.py
```

Then open [http://localhost:8000](http://localhost:8000).

## How to use

1. Paste a game boxscore URL that includes a play-by-play section.
2. Click **Load game**.
3. Wait for the status message to confirm the scrape and render are complete.
4. Review the three sections that appear:
  - Possession Pair Chart
  - Possession Analytics
  - Quick Facts

The visualization panels stay hidden until a game loads successfully.

## Dashboard features

### 1) Game URL Loader

- Input field + **Load game** button at the top of the page.
- Calls the backend `POST /api/scrape` endpoint.
- Shows loading, success, and error messages inline.

### 2) Possession Pair Chart (main chart)

- Displays possessions in alternating pairs (one row per pair).
- Encodes possession duration as bar width.
- Plots cumulative scoring differential across possession pairs.
- Shows halftime split context when applicable.
- Highlights unanswered scoring-run possessions:
  - Light green background: team currently on a qualifying run
  - Light red background: opponent possessions during that run window
- Hover tooltips show possession details (period/time/events/outcome).

### 3) Possession Outcomes (pie charts)

- One pie chart per team.
- Breaks possessions into outcome categories (made shots, misses, turnovers, free throws, etc.).
- Uses shading to emphasize unsuccessful outcomes (misses and turnovers).
- Supports hover interactions for exact counts and percentages.

### 4) Average Possession Duration by Outcome

- Compares average possession length by outcome category for both teams.
- Helps identify pace differences (for example: quick scoring vs long empty trips).

### 5) Possession Count by Duration Bucket

- Histogram of possession lengths grouped into time buckets.
- Side-by-side team comparison in each bucket.
- Useful for seeing whether a team plays faster or slower across the game.

### 6) Quick Facts Cards

Computes and compares high-level team metrics:

- Field goal percentage
- 3PT, layup/dunk, and 2PT success rates
- Turnover rate
- Points per possession
- Second-chance points
- Fast-break points (possessions under 5 seconds)

## Data files generated

When you load a game, the backend writes:

- `pbp_data.json`: possession-level extracted play-by-play data
- `run_data.json`: unanswered-run analysis metadata used for run highlighting

## Project structure (key files)

- `index.html` - dashboard layout
- `styles.css` - styling
- `app.js` - visualization and frontend analytics logic (D3)
- `server.py` - Flask server and scrape API endpoint
- `scraper.py` - Playwright/BeautifulSoup scraping and run analysis logic

## Troubleshooting

- If scrape fails, verify the URL starts with `http://` or `https://`.
- Confirm the game page actually has play-by-play data available.
- If Playwright browser binaries are missing, run:
  - `python3 -m playwright install chromium`

