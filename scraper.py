from dataclasses import dataclass, field
from typing import Iterator, Optional
import json
import re

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

PERIODS = {
    "1st Half":    "period-1",
    "2nd Half":    "period-2",
    "1st Quarter": "period-1",
    "2nd Quarter": "period-2",
    "3rd Quarter": "period-3",
    "4th Quarter": "period-4",
    "OT":          "period-5",
}


def flip(team: str) -> str:
    return "away" if team == "home" else "home"


def _extract_score(s: str) -> Optional[int]:
    m = re.match(r"(\d+)", s.strip())
    return int(m.group(1)) if m else None


def _update_score(current: int, text: str) -> int:
    parsed = _extract_score(text) if text else None
    return parsed if parsed is not None else current


def _is_sub(text: str) -> bool:
    up = text.upper()
    return "SUB IN" in up or "SUB OUT" in up


def _period_start(label: str) -> str:
    lower = label.lower().strip()
    if "ot" in lower or "overtime" in lower:
        return "05:00"
    if "half" in lower:
        return "20:00"
    if "quarter" in lower:
        return "10:00"
    # NCAA WBB (and similar feeds) often use caption-only ordinals ("1st", "2nd", …).
    if re.match(r"^\d+(st|nd|rd|th)\s*$", lower):
        return "10:00"
    return "20:00"


def _parse_clock_seconds(clock: str) -> Optional[int]:
    if not clock or clock == "--":
        return None
    parts = clock.split(":")
    if len(parts) != 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Row and event parsing
# ---------------------------------------------------------------------------

def _parse_pbp_row(period_label: str, cells: list[str], headers: list[str]) -> dict:
    """
    PBP tables are formatted as:
        Time | away play | away score | [logo] | home score | home play
    Some feeds omit the logo cell, producing a 5-column row.
    """
    n = len(cells)
    if n >= 5:
        has_logo = n >= 6
        return {
            "period": period_label,
            "time": cells[0],
            "away_play": cells[1],
            "away_score": cells[2],
            "home_score": cells[4] if has_logo else cells[3],
            "home_play": cells[5] if has_logo else cells[4],
        }
    play: dict = {"period": period_label}
    for i, val in enumerate(cells):
        play[headers[i] if i < len(headers) else f"col_{i}"] = val
    return play


def _extract_team_play(play: dict) -> Optional[tuple[str, str]]:
    home = play.get("home_play", "").strip()
    away = play.get("away_play", "").strip()

    if not home and not away:
        return None

    if home and away:
        # Both columns populated in the same row (rare); skip subs, take first non-sub.
        candidates = [(t, txt) for t, txt in [("away", away), ("home", home)] if not _is_sub(txt)]
        return candidates[0] if candidates else None
    if home:
        return None if _is_sub(home) else ("home", home)
    return None if _is_sub(away) else ("away", away)


def _parse_event(play: str, time: str) -> dict:
    """Parse 'EVENT TYPE by PLAYER,NAME(details)' into a structured event dict."""
    play = play.strip()
    if " by " in play:
        event_type, rest = play.split(" by ", 1)
        player = rest.split("(")[0].strip()
    else:
        event_type, player = play, None

    event: dict = {"type": event_type.strip(), "time": time}
    if player:
        event["player"] = player
    return event


def classify(event_type_upper: str) -> str:
    """
    Single source of truth for event categories used by the possession state
    machine. Order matters: 'GOOD FT' must be checked before 'GOOD '.
    """
    u = event_type_upper
    if "TURNOVER" in u:
        return "turnover"
    if "REBOUND DEF" in u or "REBOUND DEADB" in u:
        return "def_rebound"
    if "BLOCK" in u:
        return "block"
    if u.startswith("GOOD FT"):
        return "made_ft"
    if u.startswith("GOOD "):
        return "made_fg"
    if "FOUL" in u:
        return "foul"
    if "TIMEOUT" in u:
        return "timeout"
    if "ASSIST" in u or "TEAM REBOUND" in u:
        return "trailing"
    return "other"


def _is_trailing(event_type_upper: str) -> bool:
    return classify(event_type_upper) in ("trailing", "timeout")


# ---------------------------------------------------------------------------
# Same-clock lookahead (unified replacement for the two prior helpers)
# ---------------------------------------------------------------------------

def _iter_same_clock_events(
    rows: list,
    idx: int,
    period_label: str,
    headers: list[str],
    clock: str,
) -> Iterator[tuple[str, str]]:
    """
    Yield (team, event_type_upper) for rows after `idx` while the clock stays
    at `clock` (or is '--'). Stops as soon as a different clock value appears.
    """
    if clock == "--":
        return
    for j in range(idx + 1, len(rows)):
        next_cells = rows[j].find_all(["td", "th"])
        if not next_cells:
            continue
        next_text = [c.get_text(strip=True) for c in next_cells]
        next_play = _parse_pbp_row(period_label, next_text, headers)
        extracted = _extract_team_play(next_play)
        if extracted is None:
            continue

        time = next_play.get("time", "--")
        if time not in ("--", clock):
            return

        team, play_text = extracted
        event_type_upper = _parse_event(play_text, time)["type"].upper()
        yield team, event_type_upper


def _opponent_ft_follows(rows, idx, period_label, headers, foul_team, foul_time) -> bool:
    """Defensive foul that belongs to the *next* possession (next FT by the other team)."""
    other = flip(foul_team)
    return any(
        t == other and "FT" in et
        for t, et in _iter_same_clock_events(rows, idx, period_label, headers, foul_time)
    )


def _same_team_ft_follows(rows, idx, period_label, headers, shooting_team, shot_time) -> bool:
    """Another FT by the same team at the same clock (non-terminal FT in a multi-shot trip)."""
    return any(
        t == shooting_team and "FT" in et
        for t, et in _iter_same_clock_events(rows, idx, period_label, headers, shot_time)
    )


# ---------------------------------------------------------------------------
# Possession extraction
# ---------------------------------------------------------------------------

@dataclass
class PossessionState:
    current: Optional[dict] = None
    pending_event: Optional[tuple[str, str, dict]] = None  # (period, target_team, event)
    expected_next_team: Optional[str] = None
    current_has_made_shot: bool = False
    home_score: int = 0
    away_score: int = 0
    possessions: list[dict] = field(default_factory=list)

    def close_current(self) -> None:
        if self.current is not None:
            self.possessions.append(self.current)
            self.current = None

    def start_new(self, team: str, period_label: str) -> None:
        if self.current is None or self.current["period"] != period_label:
            new_start = _period_start(period_label)
        else:
            new_start = self.current["end_time"] or self.current["start_time"]

        self.close_current()
        self.current = {
            "team": team,
            "period": period_label,
            "start_time": new_start,
            "end_time": None,
            "home_score": self.home_score,
            "away_score": self.away_score,
            "events": [],
        }
        self.expected_next_team = None
        self.current_has_made_shot = False


def _fetch_html(url: str) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        print(f"Loading: {url}")
        page.goto(url, wait_until="networkidle", timeout=30_000)
        page.evaluate("document.getElementById('play-by-play')?.scrollIntoView()")
        page.wait_for_timeout(1500)
        html = page.content()
        browser.close()
        return html


def _detect_period_labels(soup: BeautifulSoup) -> dict[str, str]:
    labels: dict[str, str] = {}
    for i in range(1, 6):
        panel = soup.find("div", id=f"period-{i}")
        if not panel:
            continue
        caption = panel.find("caption")
        label = caption.get_text(strip=True).split(" - ")[-1] if caption else f"Period {i}"
        labels[f"period-{i}"] = label
    return labels


def _process_row(
    state: PossessionState,
    rows: list,
    idx: int,
    period_label: str,
    headers: list[str],
) -> None:
    row = rows[idx]
    cells = row.find_all(["td", "th"])
    if not cells:
        return

    text = [c.get_text(strip=True) for c in cells]
    play = _parse_pbp_row(period_label, text, headers)
    time = play.get("time", "--")

    state.home_score = _update_score(state.home_score, play.get("home_score", ""))
    state.away_score = _update_score(state.away_score, play.get("away_score", ""))

    extracted = _extract_team_play(play)
    if extracted is None:
        return
    team, play_text = extracted

    event = _parse_event(play_text, time)
    etype = event["type"].upper()
    kind = classify(etype)
    possession_team = team
    current = state.current
    same_period = current is not None and current["period"] == period_label

    # Timeout rows are administrative and do not, by themselves, imply a
    # possession change. Keep them on the current possession unless a prior
    # event already confirmed the next offensive team.
    if kind == "timeout":
        event["player"] = team
        if same_period:
            possession_team = state.expected_next_team or current["team"]

    # After a made basket, a foul on the scoring team is typically the new
    # defense committing a foul in the opponent's possession.
    force_flip_after_made_shot = (
        kind == "foul"
        and same_period
        and state.current_has_made_shot
        and state.expected_next_team is not None
        and team == current["team"]
    )
    if force_flip_after_made_shot:
        possession_team = state.expected_next_team  # type: ignore[assignment]

    # A foul by the non-possessing team does not transfer possession; attach
    # it to the ongoing possession rather than starting a new one.
    foul_on_other_team = (
        kind == "foul"
        and same_period
        and current["team"] != possession_team
        and not force_flip_after_made_shot
    )

    # A block by the non-possessing team is a defensive/trailing action on the
    # same shot attempt. Possession should not change until the rebound (or
    # another possession-confirming event) resolves control.
    if kind == "block" and same_period and current["team"] != possession_team:
        possession_team = current["team"]

    # If a foul appears on the current team's column but the next same-clock
    # event is opponent free throws, defer the foul and attach it to that
    # upcoming possession.
    if (
        kind == "foul"
        and same_period
        and current["team"] == team
        and _opponent_ft_follows(rows, idx, period_label, headers, team, time)
    ):
        state.pending_event = (period_label, flip(team), event)
        return

    # Decide whether to cut a new possession.
    is_new_period = current is None or current["period"] != period_label
    team_changed = current is not None and current["team"] != possession_team
    switch_possession = is_new_period or (
        team_changed
        and not foul_on_other_team
        and (
            state.expected_next_team is None
            or possession_team == state.expected_next_team
            or not _is_trailing(etype)
        )
    )

    if switch_possession:
        state.start_new(possession_team, period_label)
        current = state.current

    # Attach a previously-deferred foul to the now-current possession if it matches.
    pending = state.pending_event
    if (
        pending is not None
        and current is not None
        and current["period"] == pending[0]
        and current["team"] == pending[1]
    ):
        current["events"].append(pending[2])
        state.pending_event = None

    assert current is not None  # invariant: switch_possession guarantees this
    current["home_score"] = state.home_score
    current["away_score"] = state.away_score
    if time != "--":
        current["end_time"] = time
    current["events"].append(event)

    # Stateful confirmation for possession-changing events. We don't hard-switch
    # immediately on all of these because trailing rows (e.g., ASSIST) can be
    # logged after the primary action.
    if kind == "made_fg":
        state.current_has_made_shot = True
        state.expected_next_team = flip(current["team"])
    elif kind == "made_ft":
        # Only the final made FT in a same-clock sequence triggers a possession flip.
        if not _same_team_ft_follows(rows, idx, period_label, headers, current["team"], time):
            state.current_has_made_shot = True
            state.expected_next_team = flip(current["team"])
    elif kind == "turnover":
        state.expected_next_team = flip(current["team"])
    elif kind == "def_rebound":
        # Defensive rebound confirms the ball is secured by this team.
        state.expected_next_team = None
        state.current_has_made_shot = False
    elif not _is_trailing(etype):
        # A non-trailing event by the current offense means play has advanced.
        # If we were waiting solely due to a prior made basket, clear it.
        if state.current_has_made_shot and current["team"] == possession_team:
            state.current_has_made_shot = False


def parse_possessions_from_html(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    period_labels = _detect_period_labels(soup)
    print(f"  Detected periods: {list(period_labels.values())}")

    state = PossessionState()

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

        for idx in range(len(rows)):
            _process_row(state, rows, idx, period_label, headers)

    state.close_current()
    return state.possessions


def scrape_pbp(url: str) -> list[dict]:
    """
    Scrape the play-by-play table and build possessions.

    Each possession contains the team indicator, period, start/end times,
    current scores for both teams, and a list of events.
    """
    return parse_possessions_from_html(_fetch_html(url))


# ---------------------------------------------------------------------------
# Run analysis
# ---------------------------------------------------------------------------

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


def _start_run(
    possession: dict,
    possession_id: int,
    scoring_team: str,
    scored_points: int,
    home_score: int,
    away_score: int,
    home_delta: int,
    away_delta: int,
    min_points: int,
) -> dict:
    duration = _compute_possession_duration_seconds(possession)
    score_diff_end = home_score - away_score
    qualifies = scored_points >= min_points
    return {
        "team": scoring_team,
        "points": scored_points,
        "start_possession_id": possession_id,
        "end_possession_id": possession_id,
        "possession_count": 1,
        "scoring_possessions": 1,
        "duration_seconds": duration,
        "start_period": possession.get("period"),
        "start_time": possession.get("start_time"),
        "end_period": possession.get("period"),
        "end_time": possession.get("end_time"),
        "start_home_score": home_score - home_delta,
        "start_away_score": away_score - away_delta,
        "end_home_score": home_score,
        "end_away_score": away_score,
        "score_diff_start": (home_score - home_delta) - (away_score - away_delta),
        "score_diff_end": score_diff_end,
        "threshold_possession_id": possession_id if qualifies else None,
        "threshold_possession_count": 1 if qualifies else None,
        "threshold_duration_seconds": duration if qualifies else None,
        "threshold_end_period": possession.get("period") if qualifies else None,
        "threshold_end_time": possession.get("end_time") if qualifies else None,
        "threshold_score_diff_end": score_diff_end if qualifies else None,
    }


def _finalize_run(active_run: dict, runs: list[dict]) -> None:
    start_pair = ((active_run["start_possession_id"] - 1) // 2) + 1
    end_pair = ((active_run["end_possession_id"] - 1) // 2) + 1
    pair_ids = list(range(start_pair, end_pair + 1))

    qualifies = active_run["threshold_possession_id"] is not None
    highlight_end = active_run["threshold_possession_id"] if qualifies else None
    highlight_pair_ids: list[int] = []
    if highlight_end is not None:
        highlight_end_pair = ((highlight_end - 1) // 2) + 1
        highlight_pair_ids = list(range(start_pair, highlight_end_pair + 1))

    runs.append({
        "run_id": f"run_{len(runs) + 1}",
        "team": active_run["team"],
        "points": active_run["points"],
        "qualifies": qualifies,
        "start_possession_id": active_run["start_possession_id"],
        "end_possession_id": active_run["end_possession_id"],
        "pair_ids": pair_ids,
        "possession_count": active_run["possession_count"],
        "scoring_possessions": active_run["scoring_possessions"],
        "duration_seconds": active_run["duration_seconds"],
        "start_period": active_run["start_period"],
        "start_time": active_run["start_time"],
        "end_period": active_run["end_period"],
        "end_time": active_run["end_time"],
        "highlight_end_possession_id": highlight_end,
        "highlight_possession_count": active_run["threshold_possession_count"] if qualifies else None,
        "highlight_duration_seconds": active_run["threshold_duration_seconds"] if qualifies else None,
        "highlight_end_period": active_run["threshold_end_period"] if qualifies else None,
        "highlight_end_time": active_run["threshold_end_time"] if qualifies else None,
        "highlight_score_diff_end": active_run["threshold_score_diff_end"] if qualifies else None,
        "highlight_pair_ids": highlight_pair_ids,
        "start_home_score": active_run["start_home_score"],
        "start_away_score": active_run["start_away_score"],
        "end_home_score": active_run["end_home_score"],
        "end_away_score": active_run["end_away_score"],
        "score_diff_start": active_run["score_diff_start"],
        "score_diff_end": active_run["score_diff_end"],
    })


def analyze_unanswered_runs(possessions: list[dict], min_unanswered_points: int = 8) -> dict:
    runs: list[dict] = []
    active_run: Optional[dict] = None
    prev_home_score = 0
    prev_away_score = 0

    for idx, possession in enumerate(possessions):
        possession_id = idx + 1
        home_score = _to_int_score(possession.get("home_score"), prev_home_score)
        away_score = _to_int_score(possession.get("away_score"), prev_away_score)

        home_delta = max(0, home_score - prev_home_score)
        away_delta = max(0, away_score - prev_away_score)
        prev_home_score, prev_away_score = home_score, away_score

        if home_delta > 0 and away_delta == 0:
            scoring_team, scored_points = "home", home_delta
        elif away_delta > 0 and home_delta == 0:
            scoring_team, scored_points = "away", away_delta
        else:
            scoring_team, scored_points = None, 0

        if active_run is None:
            if scoring_team is None:
                continue
            active_run = _start_run(
                possession, possession_id, scoring_team, scored_points,
                home_score, away_score, home_delta, away_delta, min_unanswered_points,
            )
            continue

        opponent_scored = (away_delta > 0) if active_run["team"] == "home" else (home_delta > 0)
        if opponent_scored:
            _finalize_run(active_run, runs)
            active_run = None
            if scoring_team is None:
                continue
            active_run = _start_run(
                possession, possession_id, scoring_team, scored_points,
                home_score, away_score, home_delta, away_delta, min_unanswered_points,
            )
            continue

        # Extend the active run (possession belongs to the same team or no-score).
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
        _finalize_run(active_run, runs)

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


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

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
