from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import csv
import json
import sys

URL = "https://gotuftsjumbos.com/sports/mens-basketball/stats/2025-26/emerson-college/boxscore/15814#play-by-play"

PERIODS = {
    "1st Half":    "period-1",
    "2nd Half":    "period-2",
    "1st Quarter": "period-1",
    "2nd Quarter": "period-2",
    "3rd Quarter": "period-3",
    "4th Quarter": "period-4",
    "OT":          "period-5",
}


def _parse_pbp_row(period_label: str, cells: list[str], headers: list[str]) -> dict:
    """
    Sidearm boxscore PBP tables are: Time | away play | away score | [logo] |
    home score | home play. Away is listed first (left), home second (right).
    """
    n = len(cells)
    if n >= 6:
        return {
            "period": period_label,
            "time": cells[0],
            "away_play": cells[1],
            "away_score": cells[2],
            "home_score": cells[4],
            "home_play": cells[5],
        }
    if n == 5:
        return {
            "period": period_label,
            "time": cells[0],
            "away_play": cells[1],
            "away_score": cells[2],
            "home_score": cells[3],
            "home_play": cells[4],
        }
    play: dict = {"period": period_label}
    for i, val in enumerate(cells):
        play[headers[i] if i < len(headers) else f"col_{i}"] = val
    return play


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

            play = _parse_pbp_row(period_label, text, headers)
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
    url = input("Enter the URL of the game: ")
    plays = scrape_pbp(url)

    if not plays:
        print("ERROR: No play-by-play data was extracted. Check that the page loaded correctly.")
        sys.exit(1)

    print(f"\nTotal plays scraped: {len(plays)}")
    print("\nFirst 5 plays:")
    for p in plays[:5]:
        print(" ", p)

    # save_csv(plays, "pbp_data.csv")
    save_json(plays, "pbp_data.json")