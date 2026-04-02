"""
scrape_pbp.py
Scrapes play-by-play data from a Tufts Jumbos (Sidearm Sports) boxscore page.

Usage:
    python3 scrape_pbp.py

Requirements:
    pip install playwright beautifulsoup4
    playwright install chromium
"""

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import csv
import json
import sys

URL = "https://gotuftsjumbos.com/sports/womens-basketball/stats/2025-26/marian-university/boxscore/15679#play-by-play"

PERIODS = {
    "1st Half":    "period-1",
    "2nd Half":    "period-2",
    "1st Quarter": "period-1",
    "2nd Quarter": "period-2",
    "3rd Quarter": "period-3",
    "4th Quarter": "period-4",
    "OT":          "period-5",
}


def scrape_pbp(url: str = URL) -> list[dict]:
    plays = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        print(f"Loading: {url}")
        page.goto(url, wait_until="networkidle", timeout=30_000)
        page.evaluate("document.getElementById('play-by-play')?.scrollIntoView()")
        page.wait_for_timeout(1500)

        html = page.content()
        browser.close()

    soup = BeautifulSoup(html, "lxml")

    period_labels = {}
    for i in range(1, 6):
        panel = soup.find("div", id=f"period-{i}")
        if not panel:
            continue
        caption = panel.find("caption")
        label = caption.get_text(strip=True).split(" - ")[-1] if caption else f"Period {i}"
        period_labels[f"period-{i}"] = label

    print(f"  Detected periods: {list(period_labels.values())}")

    for period_id, period_label in period_labels.items():
        panel = soup.find("div", id=period_id)
        table = panel.find("table", class_="sidearm-table") if panel else None
        if not table:
            print(f"  Warning: no play-by-play table found in {period_label}")
            continue

        thead = table.find("thead")
        headers = [th.get_text(strip=True) for th in thead.find_all("th")] if thead else []

        tbody = table.find("tbody")
        if not tbody:
            continue

        rows = tbody.find_all("tr")
        print(f"  {period_label}: {len(rows)} rows found")

        for row in rows:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue
            text = [c.get_text(strip=True) for c in cells]

            if len(text) >= 5:
                play = {"period": period_label, "time": text[0], "home_play": text[1],
                        "home_score": text[2], "away_score": text[3], "away_play": text[4]}
            elif len(text) == 4:
                play = {"period": period_label, "time": text[0], "home_play": text[1],
                        "score": text[2], "away_play": text[3]}
            else:
                play = {"period": period_label}
                for i, val in enumerate(text):
                    play[headers[i] if i < len(headers) else f"col_{i}"] = val

            plays.append(play)

    return plays


def save_csv(plays: list[dict], path: str = "pbp_data.csv") -> None:
    if not plays:
        print("No plays to save.")
        return
    fieldnames = list(plays[0].keys())
    # Make sure all keys appear across all rows
    all_keys: list[str] = []
    seen = set()
    for play in plays:
        for k in play:
            if k not in seen:
                all_keys.append(k)
                seen.add(k)

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(plays)
    print(f"Saved {len(plays)} plays → {path}")


def save_json(plays: list[dict], path: str = "pbp_data.json") -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(plays, f, indent=2, ensure_ascii=False)
    print(f"Saved {len(plays)} plays → {path}")


if __name__ == "__main__":
    plays = scrape_pbp()

    if not plays:
        print("ERROR: No play-by-play data was extracted. Check that the page loaded correctly.")
        sys.exit(1)

    print(f"\nTotal plays scraped: {len(plays)}")
    print("\nFirst 5 plays:")
    for p in plays[:5]:
        print(" ", p)

    save_csv(plays, "pbp_data.csv")
    save_json(plays, "pbp_data.json")