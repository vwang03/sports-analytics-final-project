from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import json
import re
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


def _is_sub(text: str) -> bool:
    up = text.upper()
    return "SUB IN" in up or "SUB OUT" in up


def _extract_score(s: str) -> int | None:
    """Parse score strings like '2(+2)' or '14' into an integer."""
    m = re.match(r"(\d+)", s.strip())
    return int(m.group(1)) if m else None


def _parse_event(play: str, time: str) -> dict:
    """
    Parse 'EVENT TYPE by PLAYER,NAME(details)' into a structured event dict.
    """
    play = play.strip()
    if " by " in play:
        event_type, rest = play.split(" by ", 1)
        player = rest.split("(")[0].strip()
    else:
        event_type = play
        player = None

    event: dict = {"type": event_type.strip(), "time": time}
    if player:
        event["player"] = player
    return event


def _period_start(label: str) -> str:
    lower = label.lower()
    if "quarter" in lower:
        return "10:00"
    if "ot" in lower or "overtime" in lower:
        return "05:00"
    return "20:00"


def scrape_pbp(url: str = URL) -> list[dict]:
    """
    Scrape the play-by-play table and build possession objects on the fly.

    A new possession begins whenever the acting team switches sides.
    Each possession contains the team indicator, period, start/end times
    (clock counting down, so start_time >= end_time), current scores for both
    teams, and a list of events. Substitution rows are ignored.

    start_time is assigned at possession-creation time:
      - First possession of a period → period clock start (20:00 / 10:00 / 05:00).
      - All other possessions → end_time of the previous possession. If the
        previous possession had no timed events, its start_time is used.

    home_score / away_score reflect the score at the END of the possession.
    Both score columns from the table are parsed on every scoring row so the
    tracker stays accurate for both teams simultaneously.
    """
    possessions: list[dict] = []
    current: dict | None = None
    home_score = 0
    away_score = 0

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

            home = play.get("home_play", "").strip()
            away = play.get("away_play", "").strip()
            time = play.get("time", "--")

            if not home and not away:
                continue

            # Update the running score from whichever score columns are populated.
            # Both columns are present on scoring plays (scoring team shows "N(+M)",
            # the other team shows their current total as a plain number).
            for col, side in [("home_score", "home"), ("away_score", "away")]:
                val = play.get(col, "").strip()
                if val:
                    parsed = _extract_score(val)
                    if parsed is not None:
                        if side == "home":
                            home_score = parsed
                        else:
                            away_score = parsed

            if home and away:
                # Both columns populated in the same row (rare); skip subs, take first non-sub
                candidates = [(t, txt) for t, txt in [("away", away), ("home", home)]
                              if not _is_sub(txt)]
                if not candidates:
                    continue
                team, play_text = candidates[0]
            elif home:
                if _is_sub(home):
                    continue
                team, play_text = "home", home
            else:
                if _is_sub(away):
                    continue
                team, play_text = "away", away

            event = _parse_event(play_text, time)

            # A foul committed by the non-possessing team does not transfer possession;
            # attach it to the ongoing possession rather than starting a new one.
            is_foul = "FOUL" in event["type"].upper()
            foul_on_other_team = (
                is_foul
                and current is not None
                and current["team"] != team
                and current["period"] == period_label
            )

            if not foul_on_other_team:
                if current is None or current["team"] != team or current["period"] != period_label:
                    if current is None or current["period"] != period_label:
                        new_start = _period_start(period_label)
                    else:
                        new_start = current["end_time"] if current["end_time"] is not None else current["start_time"]

                    if current is not None:
                        possessions.append(current)

                    current = {
                        "team": team,
                        "period": period_label,
                        "start_time": new_start,
                        "end_time": None,
                        "home_score": home_score,
                        "away_score": away_score,
                        "events": [],
                    }

            current["home_score"] = home_score
            current["away_score"] = away_score

            if time != "--":
                current["end_time"] = time

            current["events"].append(event)

    if current is not None:
        possessions.append(current)

    return possessions


def save_json(possessions: list[dict], path: str = "pbp_data.json") -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(possessions, f, indent=2, ensure_ascii=False)
    print(f"Saved {len(possessions)} possessions → {path}")


if __name__ == "__main__":
    url = input("Enter the URL of the game: ")
    possessions = scrape_pbp(url)

    if not possessions:
        print("ERROR: No play-by-play data was extracted. Check that the page loaded correctly.")
        sys.exit(1)

    print(f"\nTotal possessions: {len(possessions)}")
    print("\nFirst 3 possessions:")
    for p in possessions[:3]:
        print(" ", p)

    save_json(possessions, "pbp_data.json")