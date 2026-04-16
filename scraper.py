from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import json
import re

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
    PBP tables are formatted as follows: 
    Time | away play | away score | [logo] | home score | home play. 
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


def _extract_team_play(play: dict) -> tuple[str, str] | None:
    home = play.get("home_play", "").strip()
    away = play.get("away_play", "").strip()

    if not home and not away:
        return None

    if home and away:
        # Both columns populated in the same row (rare); skip subs, take first non-sub.
        candidates = [(t, txt) for t, txt in [("away", away), ("home", home)] if not _is_sub(txt)]
        return candidates[0] if candidates else None
    if home:
        if _is_sub(home):
            return None
        return ("home", home)
    if _is_sub(away):
        return None
    return ("away", away)


def _foul_flips_to_next_possession(
    rows: list,
    idx: int,
    period_label: str,
    headers: list[str],
    foul_team: str,
    foul_time: str,
) -> bool:
    """
    Detect a defensive foul row that should belong to the *next* possession.
    We treat this as true when the next same-clock event by the other team is a FT.
    """
    if foul_time == "--":
        return False

    other_team = "away" if foul_team == "home" else "home"

    for j in range(idx + 1, len(rows)):
        next_cells = rows[j].find_all(["td", "th"])
        if not next_cells:
            continue
        next_text = [c.get_text(strip=True) for c in next_cells]
        next_play = _parse_pbp_row(period_label, next_text, headers)
        extracted = _extract_team_play(next_play)
        if extracted is None:
            continue

        team, play_text = extracted
        time = next_play.get("time", "--")

        if time not in ("--", foul_time):
            break

        event_type = _parse_event(play_text, time)["type"].upper()
        if team == other_team and "FT" in event_type:
            return True

    return False


def _is_trailing_event(event_type_upper: str) -> bool:
    """
    Events that can be logged after the primary action without changing possession.
    """
    return (
        "ASSIST" in event_type_upper
        or "TEAM REBOUND" in event_type_upper
        or "TIMEOUT" in event_type_upper
    )


def _is_made_field_goal(event_type_upper: str) -> bool:
    return event_type_upper.startswith("GOOD ") and "FT" not in event_type_upper


def _is_turnover_event(event_type_upper: str) -> bool:
    return "TURNOVER" in event_type_upper


def _is_defensive_rebound_event(event_type_upper: str) -> bool:
    return "REBOUND DEF" in event_type_upper or "REBOUND DEADB" in event_type_upper


def _is_block_event(event_type_upper: str) -> bool:
    return "BLOCK" in event_type_upper


def _period_start(label: str) -> str:
    lower = label.lower()
    if "quarter" in lower:
        return "10:00"
    if "ot" in lower or "overtime" in lower:
        return "05:00"
    return "20:00"


def scrape_pbp(url: str) -> list[dict]:
    """
    Scrape the play-by-play table and build possessions.

    Each possession contains the team indicator, period, start/end times, 
    current scores for both teams, and a list of events.
    """
    possessions: list[dict] = []
    current: dict | None = None
    pending_possession_event: tuple[str, str, dict] | None = None
    expected_next_team: str | None = None
    current_has_made_shot = False
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

        for idx, row in enumerate(rows):
            cells = row.find_all(["td", "th"])
            if not cells:
                continue
            text = [c.get_text(strip=True) for c in cells]
            play = _parse_pbp_row(period_label, text, headers)

            time = play.get("time", "--")

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

            extracted = _extract_team_play(play)
            if extracted is None:
                continue
            team, play_text = extracted

            event = _parse_event(play_text, time)
            event_type_upper = event["type"].upper()
            timeout_caller_team = team
            possession_team = team
            is_timeout = "TIMEOUT" in event_type_upper
            force_flip_after_made_shot = False

            if is_timeout:
                event["player"] = timeout_caller_team

            # Timeout rows are administrative and do not, by themselves, imply
            # a possession change. Keep them on the current possession unless
            # a prior event already confirmed the next offensive team.
            if is_timeout and current is not None and current["period"] == period_label:
                if expected_next_team is not None:
                    possession_team = expected_next_team
                else:
                    possession_team = current["team"]

            # A foul committed by the non-possessing team does not transfer possession;
            # attach it to the ongoing possession rather than starting a new one.
            is_foul = "FOUL" in event_type_upper
            # After a made basket, a foul on the scoring team is typically the
            # new defense committing a foul in the opponent's possession.
            if (
                is_foul
                and current is not None
                and current["period"] == period_label
                and current_has_made_shot
                and expected_next_team is not None
                and team == current["team"]
            ):
                possession_team = expected_next_team
                force_flip_after_made_shot = True

            foul_on_other_team = (
                is_foul
                and current is not None
                and current["team"] != possession_team
                and current["period"] == period_label
                and not force_flip_after_made_shot
            )

            # A block by the non-possessing team is a defensive/trailing action on
            # the same shot attempt. Possession should not change until the rebound
            # (or another possession-confirming event) resolves control.
            is_block = _is_block_event(event_type_upper)
            block_on_other_team = (
                is_block
                and current is not None
                and current["team"] != possession_team
                and current["period"] == period_label
            )
            if block_on_other_team:
                possession_team = current["team"]

            # If a foul appears on the current team's column but the next same-clock
            # event is opponent free throws, defer the foul and attach it to that
            # upcoming possession.
            if (
                is_foul
                and current is not None
                and current["team"] == team
                and current["period"] == period_label
                and _foul_flips_to_next_possession(rows, idx, period_label, headers, team, time)
            ):
                # This foul is explicitly reassigned to the upcoming possession,
                # so it must not move the current possession's end boundary.
                target_team = "away" if team == "home" else "home"
                pending_possession_event = (period_label, target_team, event)
                continue

            switch_possession = False
            if current is None or current["period"] != period_label:
                switch_possession = True
            elif current["team"] != possession_team and not foul_on_other_team:
                # Team changed in the feed: confirm with stateful possession-change signals.
                if expected_next_team is None:
                    switch_possession = True
                elif possession_team == expected_next_team:
                    switch_possession = True
                elif not _is_trailing_event(event_type_upper):
                    switch_possession = True

            if switch_possession:
                if current is None or current["period"] != period_label:
                    new_start = _period_start(period_label)
                else:
                    new_start = current["end_time"] if current["end_time"] is not None else current["start_time"]

                if current is not None:
                    possessions.append(current)

                current = {
                    "team": possession_team,
                    "period": period_label,
                    "start_time": new_start,
                    "end_time": None,
                    "home_score": home_score,
                    "away_score": away_score,
                    "events": [],
                }
                expected_next_team = None
                current_has_made_shot = False

            if (
                pending_possession_event is not None
                and current is not None
                and current["period"] == pending_possession_event[0]
                and current["team"] == pending_possession_event[1]
            ):
                current["events"].append(pending_possession_event[2])
                pending_possession_event = None

            current["home_score"] = home_score
            current["away_score"] = away_score

            if time != "--":
                current["end_time"] = time

            current["events"].append(event)

            # Stateful confirmation for possession-changing events.
            # We don't hard-switch immediately on all of these because trailing
            # rows (e.g., ASSIST) can be logged after the primary action.
            if current is not None:
                if _is_made_field_goal(event_type_upper):
                    current_has_made_shot = True
                    expected_next_team = "away" if current["team"] == "home" else "home"
                elif _is_turnover_event(event_type_upper):
                    expected_next_team = "away" if current["team"] == "home" else "home"
                elif _is_defensive_rebound_event(event_type_upper):
                    # Defensive rebound confirms the ball is secured by this team.
                    expected_next_team = None
                    current_has_made_shot = False
                elif not _is_trailing_event(event_type_upper):
                    # A non-trailing event by the current offense means play has advanced.
                    # If we were waiting solely due to a prior made basket, clear it.
                    if current_has_made_shot and current["team"] == possession_team:
                        current_has_made_shot = False

    if current is not None:
        possessions.append(current)

    return possessions


def save_json(possessions: list[dict], path: str = "pbp_data.json") -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(possessions, f, indent=2, ensure_ascii=False)
    print(f"Saved {len(possessions)} possessions → {path}")


if __name__ == "__main__":
    url = input("Enter the URL of the game: ")
    if not url:
        url = "https://gotuftsjumbos.com/sports/mens-basketball/stats/2025-26/emerson-college/boxscore/15814#play-by-play"
    possessions = scrape_pbp(url)

    if not possessions:
        print("ERROR: No play-by-play data was extracted. Check that the page loaded correctly.")
        exit(1)

    print(f"\nTotal possessions: {len(possessions)}")
    print("\nFirst 3 possessions:")
    for p in possessions[:3]:
        print(" ", p)

    save_json(possessions, "pbp_data.json")