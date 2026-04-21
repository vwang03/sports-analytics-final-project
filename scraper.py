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


def _is_made_free_throw(event_type_upper: str) -> bool:
    return event_type_upper.startswith("GOOD FT")


def _is_turnover_event(event_type_upper: str) -> bool:
    return "TURNOVER" in event_type_upper


def _is_defensive_rebound_event(event_type_upper: str) -> bool:
    return "REBOUND DEF" in event_type_upper or "REBOUND DEADB" in event_type_upper


def _is_block_event(event_type_upper: str) -> bool:
    return "BLOCK" in event_type_upper


def _has_follow_up_same_clock_free_throw(
    rows: list,
    idx: int,
    period_label: str,
    headers: list[str],
    shooting_team: str,
    shot_time: str,
) -> bool:
    """
    True when another FT by the same team appears at the same clock value.
    This identifies non-terminal FT attempts in a multi-shot trip.
    """
    if shot_time == "--":
        return False

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
        if time not in ("--", shot_time):
            break

        event_type = _parse_event(play_text, time)["type"].upper()
        if team == shooting_team and "FT" in event_type:
            return True

    return False


def _period_start(label: str) -> str:
    lower = label.lower()
    if "quarter" in lower:
        return "10:00"
    if "ot" in lower or "overtime" in lower:
        return "05:00"
    return "20:00"


def _parse_clock_seconds(clock: str) -> int | None:
    if not clock or clock == "--":
        return None
    parts = clock.split(":")
    if len(parts) != 2:
        return None
    try:
        minutes = int(parts[0])
        seconds = int(parts[1])
    except ValueError:
        return None
    return minutes * 60 + seconds


def _compute_possession_duration_seconds(possession: dict) -> int:
    start_seconds = _parse_clock_seconds(possession.get("start_time", "--"))
    end_seconds = _parse_clock_seconds(possession.get("end_time", "--"))
    if start_seconds is None or end_seconds is None:
        return 1
    return max(1, start_seconds - end_seconds)


def _to_int_score(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def analyze_unanswered_runs(possessions: list[dict], min_unanswered_points: int = 8) -> dict:
    runs: list[dict] = []
    active_run: dict | None = None
    prev_home_score = 0
    prev_away_score = 0

    def finalize_run(run: dict) -> None:
        start_pair = ((run["start_possession_id"] - 1) // 2) + 1
        end_pair = ((run["end_possession_id"] - 1) // 2) + 1
        pair_ids = list(range(start_pair, end_pair + 1))

        run_id = f"run_{len(runs) + 1}"
        qualifies = run["threshold_possession_id"] is not None
        highlight_end_possession_id = run["threshold_possession_id"] if qualifies else None
        highlight_pair_ids: list[int] = []
        if highlight_end_possession_id is not None:
            highlight_start_pair = ((run["start_possession_id"] - 1) // 2) + 1
            highlight_end_pair = ((highlight_end_possession_id - 1) // 2) + 1
            highlight_pair_ids = list(range(highlight_start_pair, highlight_end_pair + 1))
        runs.append(
            {
                "run_id": run_id,
                "team": run["team"],
                "points": run["points"],
                "qualifies": qualifies,
                "start_possession_id": run["start_possession_id"],
                "end_possession_id": run["end_possession_id"],
                "pair_ids": pair_ids,
                "possession_count": run["possession_count"],
                "scoring_possessions": run["scoring_possessions"],
                "duration_seconds": run["duration_seconds"],
                "start_period": run["start_period"],
                "start_time": run["start_time"],
                "end_period": run["end_period"],
                "end_time": run["end_time"],
                "highlight_end_possession_id": highlight_end_possession_id,
                "highlight_possession_count": run["threshold_possession_count"] if qualifies else None,
                "highlight_duration_seconds": run["threshold_duration_seconds"] if qualifies else None,
                "highlight_end_period": run["threshold_end_period"] if qualifies else None,
                "highlight_end_time": run["threshold_end_time"] if qualifies else None,
                "highlight_score_diff_end": run["threshold_score_diff_end"] if qualifies else None,
                "highlight_pair_ids": highlight_pair_ids,
                "start_home_score": run["start_home_score"],
                "start_away_score": run["start_away_score"],
                "end_home_score": run["end_home_score"],
                "end_away_score": run["end_away_score"],
                "score_diff_start": run["score_diff_start"],
                "score_diff_end": run["score_diff_end"],
            }
        )

    for idx, possession in enumerate(possessions):
        possession_id = idx + 1
        home_score = _to_int_score(possession.get("home_score"), prev_home_score)
        away_score = _to_int_score(possession.get("away_score"), prev_away_score)

        home_delta = max(0, home_score - prev_home_score)
        away_delta = max(0, away_score - prev_away_score)

        prev_home_score = home_score
        prev_away_score = away_score

        scoring_team: str | None = None
        scored_points = 0
        if home_delta > 0 and away_delta == 0:
            scoring_team = "home"
            scored_points = home_delta
        elif away_delta > 0 and home_delta == 0:
            scoring_team = "away"
            scored_points = away_delta

        if active_run is None:
            if scoring_team is None:
                continue
            active_run = {
                "team": scoring_team,
                "points": scored_points,
                "start_possession_id": possession_id,
                "end_possession_id": possession_id,
                "possession_count": 1,
                "scoring_possessions": 1,
                "duration_seconds": _compute_possession_duration_seconds(possession),
                "start_period": possession.get("period"),
                "start_time": possession.get("start_time"),
                "end_period": possession.get("period"),
                "end_time": possession.get("end_time"),
                "start_home_score": home_score - home_delta,
                "start_away_score": away_score - away_delta,
                "end_home_score": home_score,
                "end_away_score": away_score,
                "score_diff_start": (home_score - home_delta) - (away_score - away_delta),
                "score_diff_end": home_score - away_score,
                "threshold_possession_id": possession_id if scored_points >= min_unanswered_points else None,
                "threshold_possession_count": 1 if scored_points >= min_unanswered_points else None,
                "threshold_duration_seconds": _compute_possession_duration_seconds(possession) if scored_points >= min_unanswered_points else None,
                "threshold_end_period": possession.get("period") if scored_points >= min_unanswered_points else None,
                "threshold_end_time": possession.get("end_time") if scored_points >= min_unanswered_points else None,
                "threshold_score_diff_end": (home_score - away_score) if scored_points >= min_unanswered_points else None,
            }
            continue

        opponent_scored = (away_delta > 0) if active_run["team"] == "home" else (home_delta > 0)
        if opponent_scored:
            finalize_run(active_run)
            active_run = None

            if scoring_team is None:
                continue

            active_run = {
                "team": scoring_team,
                "points": scored_points,
                "start_possession_id": possession_id,
                "end_possession_id": possession_id,
                "possession_count": 1,
                "scoring_possessions": 1,
                "duration_seconds": _compute_possession_duration_seconds(possession),
                "start_period": possession.get("period"),
                "start_time": possession.get("start_time"),
                "end_period": possession.get("period"),
                "end_time": possession.get("end_time"),
                "start_home_score": home_score - home_delta,
                "start_away_score": away_score - away_delta,
                "end_home_score": home_score,
                "end_away_score": away_score,
                "score_diff_start": (home_score - home_delta) - (away_score - away_delta),
                "score_diff_end": home_score - away_score,
                "threshold_possession_id": possession_id if scored_points >= min_unanswered_points else None,
                "threshold_possession_count": 1 if scored_points >= min_unanswered_points else None,
                "threshold_duration_seconds": _compute_possession_duration_seconds(possession) if scored_points >= min_unanswered_points else None,
                "threshold_end_period": possession.get("period") if scored_points >= min_unanswered_points else None,
                "threshold_end_time": possession.get("end_time") if scored_points >= min_unanswered_points else None,
                "threshold_score_diff_end": (home_score - away_score) if scored_points >= min_unanswered_points else None,
            }
            continue

        active_run["end_possession_id"] = possession_id
        active_run["possession_count"] += 1
        active_run["duration_seconds"] += _compute_possession_duration_seconds(possession)
        active_run["end_period"] = possession.get("period")
        active_run["end_time"] = possession.get("end_time")
        active_run["end_home_score"] = home_score
        active_run["end_away_score"] = away_score
        active_run["score_diff_end"] = home_score - away_score

        if scoring_team == active_run["team"]:
            active_run["points"] += scored_points
            active_run["scoring_possessions"] += 1
            if active_run["threshold_possession_id"] is None and active_run["points"] >= min_unanswered_points:
                active_run["threshold_possession_id"] = possession_id
                active_run["threshold_possession_count"] = active_run["possession_count"]
                active_run["threshold_duration_seconds"] = active_run["duration_seconds"]
                active_run["threshold_end_period"] = possession.get("period")
                active_run["threshold_end_time"] = possession.get("end_time")
                active_run["threshold_score_diff_end"] = home_score - away_score

    if active_run is not None:
        finalize_run(active_run)

    qualifying_runs = [run for run in runs if run["qualifies"]]
    possession_run_lookup: dict[str, str] = {}
    for run in qualifying_runs:
        highlight_end = run.get("highlight_end_possession_id")
        if highlight_end is None:
            continue
        for possession_id in range(run["start_possession_id"], highlight_end + 1):
            possession_run_lookup[str(possession_id)] = run["run_id"]

    return {
        "source": "pbp_data.json",
        "thresholds": {"min_unanswered_points": min_unanswered_points},
        "runs": runs,
        "qualified_run_ids": [run["run_id"] for run in qualifying_runs],
        "possession_run_lookup": possession_run_lookup,
    }


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
                elif _is_made_free_throw(event_type_upper):
                    # Only the final made FT in a same-clock sequence should
                    # trigger a possession flip expectation.
                    if not _has_follow_up_same_clock_free_throw(
                        rows,
                        idx,
                        period_label,
                        headers,
                        current["team"],
                        time,
                    ):
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


def save_run_data(run_data: dict, path: str = "run_data.json") -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(run_data, f, indent=2, ensure_ascii=False)
    print(f"Saved run analysis ({len(run_data.get('runs', []))} runs) → {path}")


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
    run_data = analyze_unanswered_runs(possessions, min_unanswered_points=8)
    save_run_data(run_data, "run_data.json")