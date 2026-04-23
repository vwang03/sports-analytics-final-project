const TICK_COLORS = {
  made_shot: "#166534",
  missed_shot: "#6A6362",
  def_rebound: "#46029C",
  off_rebound: "#1d4ed8",
  turnover: "#DB242F",
  foul: "#FF7518",
  steal: "#AF1D26",
  block: "#E25059",
  assist: "#A6C3A8",
  timeout: "#704214",
  other: "#704214",
};

const HALF_SECONDS = 20 * 60;
const QUARTER_SECONDS = 10 * 60;
const OT_SECONDS = 5 * 60;
/** Elapsed seconds at end of regulation (2×20 min halves or 4×10 min quarters). */
const REGULATION_END_SECONDS = 40 * 60;
const RUN_TEAM_FILL = "#dffcdf";
const RUN_OPPONENT_FILL = "#fecaca";
const DATA_VERSION = "run-highlight-9";
const DIFF_LANE_GAP = 18;
const DIFF_LANE_WIDTH = 128;

function parseClockToRemainingSeconds(clock) {
  if (!clock || clock === "--") return null;
  const [m, s] = clock.split(":").map(Number);
  if (Number.isNaN(m) || Number.isNaN(s)) return null;
  return m * 60 + s;
}

/**
 * Returns { offsetSeconds, periodLengthSeconds } for game clock → absolute elapsed mapping.
 * Ordinals without "Half"/"Quarter" (e.g. NCAA WBB "1st") are treated as 10-minute quarters.
 */
function periodOffsetAndLength(period) {
  const p = String(period || "").trim();
  const lower = p.toLowerCase();

  if (lower.includes("half")) {
    const isSecondHalf = /2nd\s+half/i.test(p);
    return { offsetSeconds: isSecondHalf ? HALF_SECONDS : 0, periodLengthSeconds: HALF_SECONDS };
  }

  let quarterIndex = null;
  if (lower.includes("quarter")) {
    const m = p.match(/(\d)\s*(?:st|nd|rd|th)\s+quarter/i);
    if (m) quarterIndex = parseInt(m[1], 10) - 1;
  } else {
    const m = p.match(/^(\d+)(st|nd|rd|th)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 4) quarterIndex = n - 1;
    }
  }
  if (quarterIndex !== null) {
    return {
      offsetSeconds: quarterIndex * QUARTER_SECONDS,
      periodLengthSeconds: QUARTER_SECONDS,
    };
  }

  if (/ot|overtime/i.test(p)) {
    return { offsetSeconds: REGULATION_END_SECONDS, periodLengthSeconds: OT_SECONDS };
  }

  return { offsetSeconds: 0, periodLengthSeconds: HALF_SECONDS };
}

function toAbsoluteElapsed(period, clock) {
  const remaining = parseClockToRemainingSeconds(clock);
  if (remaining === null) return null;
  const { offsetSeconds, periodLengthSeconds } = periodOffsetAndLength(period);
  return offsetSeconds + (periodLengthSeconds - remaining);
}

function getTickEventCategory(eventType) {
  const normalized = String(eventType || "").toUpperCase();
  if (normalized.includes("TIMEOUT")) return "timeout";
  if (normalized.includes("ASSIST")) return "assist";
  if (normalized.includes("STEAL")) return "steal";
  if (normalized.includes("BLOCK")) return "block";
  if (normalized.includes("TURNOVER")) return "turnover";
  if (normalized.includes("FOUL")) return "foul";
  if (normalized.includes("REBOUND OFF")) return "off_rebound";
  if (normalized.includes("REBOUND DEF")) return "def_rebound";
  if (normalized.includes("GOOD")) return "made_shot";
  if (normalized.includes("MISS")) return "missed_shot";
  return "other";
}

function formatTimeRange(possession) {
  if (!possession) return "--";
  const start = possession.startTime ?? "--";
  const end = possession.endTime ?? "--";
  return `${start}–${end}`;
}

function computeDurationSeconds(possession) {
  const startRemaining = parseClockToRemainingSeconds(possession.start_time);
  const endRemaining = parseClockToRemainingSeconds(possession.end_time);
  if (startRemaining === null) return 1;
  if (endRemaining === null) return 1;
  return Math.max(1, startRemaining - endRemaining);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatEventDescription(event) {
  const type = String(event?.type || "event");
  const player = String(event?.player || "").trim();
  return player ? `${type} - ${player}` : type;
}

const OUTCOME_COLORS = {
  free_throw: TICK_COLORS.foul,
  three_pointer: "#14532d",
  layup_dunk: "#22c55e",
  two_pointer: "#86efac",
  turnover: "#dc2626",
  other: "#6b7280",
};

const OUTCOME_LABELS = {
  free_throw_made: "Free throw made",
  free_throw_missed: "Free throw missed",
  three_pointer_made: "3-pointer made",
  three_pointer_missed: "3-pointer missed",
  layup_dunk_made: "Layup/Dunk made",
  layup_dunk_missed: "Layup/Dunk missed",
  two_pointer_made: "2-pointer made",
  two_pointer_missed: "2-pointer missed",
  turnover: "Turnover",
  other: "Other",
};

const TUFTS_BLUE = "#002E6D";
const TUFTS_BROWN = "#6F4E37";

const TEAM_COLORS = {
  home: TUFTS_BLUE,
  away: TUFTS_BROWN,
};

const SHOT_TYPE_LABELS = {
  free_throw: "Free throw",
  three_pointer: "3PT",
  layup_dunk: "Layup/Dunk",
  two_pointer: "2PT",
};

const LENGTH_BUCKET_SIZE_SECONDS = 4;

function normalizeTeamKey(team) {
  return String(team || "").trim().toLowerCase();
}

function classifyShotType(eventTypeUpper) {
  if (!eventTypeUpper) return null;
  if (eventTypeUpper.includes("FT")) return "free_throw";
  if (eventTypeUpper.includes("3PTR") || eventTypeUpper.includes("3-PT")) return "three_pointer";
  if (eventTypeUpper.includes("LAYUP") || eventTypeUpper.includes("DUNK")) return "layup_dunk";
  return "two_pointer";
}

function isShotAttemptEvent(eventTypeUpper) {
  return eventTypeUpper.startsWith("GOOD ") || eventTypeUpper.startsWith("MISS ");
}

function isMadeShotEvent(eventTypeUpper) {
  return eventTypeUpper.startsWith("GOOD ");
}

function findTerminalDecisiveEvent(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const eventTypeUpper = String(events[i]?.type || "").toUpperCase();
    if (!eventTypeUpper) continue;
    if (eventTypeUpper.includes("TURNOVER")) return events[i];
    if (isShotAttemptEvent(eventTypeUpper)) return events[i];
  }
  return null;
}

function classifyPossessionOutcome(possession) {
  const terminalEvent = findTerminalDecisiveEvent(possession.detailEvents || []);
  if (!terminalEvent) {
    return "other";
  }
  const eventTypeUpper = String(terminalEvent.type || "").toUpperCase();
  if (eventTypeUpper.includes("TURNOVER")) return "turnover";
  if (isShotAttemptEvent(eventTypeUpper)) {
    const shotType = classifyShotType(eventTypeUpper);
    if (!shotType) return "other";
    return isMadeShotEvent(eventTypeUpper) ? `${shotType}_made` : `${shotType}_missed`;
  }
  return "other";
}

function createTeamAggregate(teamKey) {
  return {
    teamKey,
    totalPossessions: 0,
    outcomeCounts: Object.fromEntries(Object.keys(OUTCOME_LABELS).map((key) => [key, 0])),
    durationByOutcomeSamples: {
      made_shot: [],
      missed_shot: [],
      turnover: [],
    },
    durationSamples: [],
    shotStats: {
      free_throw: { makes: 0, attempts: 0 },
      three_pointer: { makes: 0, attempts: 0 },
      layup_dunk: { makes: 0, attempts: 0 },
      two_pointer: { makes: 0, attempts: 0 },
    },
    turnoverPossessions: 0,
    totalPoints: 0,
    secondChanceWithOrebPoints: 0,
    secondChanceWithOrebPossessions: 0,
    secondChanceWithoutOrebPoints: 0,
    secondChanceWithoutOrebPossessions: 0,
    fastBreakPoints: 0,
    fastBreakPossessions: 0,
    histogramBuckets: [],
  };
}

function isMadeOutcome(outcome) {
  return String(outcome || "").endsWith("_made");
}

function isMissedOutcome(outcome) {
  return String(outcome || "").endsWith("_missed");
}

function isBadOutcome(outcome) {
  const value = String(outcome || "");
  return value === "turnover" || isMissedOutcome(value);
}

function getOutcomeBaseKey(outcome) {
  const value = String(outcome || "");
  if (value.endsWith("_made")) return value.slice(0, -5);
  if (value.endsWith("_missed")) return value.slice(0, -7);
  return value;
}

function formatPercent(numerator, denominator, decimals = 1) {
  if (!denominator) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(decimals)}%`;
}

function buildDurationBucketIndex(duration, bucketSize) {
  return Math.floor(Math.max(1, duration - 1) / bucketSize);
}

function buildDurationBucketLabel(index, bucketSize) {
  const start = index * bucketSize;
  const end = start + bucketSize;
  return `${start}-${end}s`;
}

function finalizeBuckets(rawBuckets, bucketSize) {
  const indexes = Object.keys(rawBuckets).map((value) => Number(value));
  if (!indexes.length) return [];
  const maxIndex = Math.max(...indexes);
  return d3.range(0, maxIndex + 1).map((index) => {
    const bucket = rawBuckets[index] || { count: 0, attempts: 0, makes: 0 };
    return {
      bucketIndex: index,
      label: buildDurationBucketLabel(index, bucketSize),
      count: bucket.count || 0,
      attempts: bucket.attempts || 0,
      makes: bucket.makes || 0,
      fgPct: bucket.attempts ? bucket.makes / bucket.attempts : null,
    };
  });
}

function deriveAnalytics({ teams, possessions }) {
  const teamKeys = [...new Set(teams.map((team) => normalizeTeamKey(team)).filter(Boolean))];
  const byTeam = {};
  teamKeys.forEach((teamKey) => {
    byTeam[teamKey] = createTeamAggregate(teamKey);
  });

  possessions.forEach((possession) => {
    const teamKey = normalizeTeamKey(possession.team);
    if (!byTeam[teamKey]) {
      byTeam[teamKey] = createTeamAggregate(teamKey);
      teamKeys.push(teamKey);
    }
    const teamData = byTeam[teamKey];
    const outcome = classifyPossessionOutcome(possession);
    const hasTurnover = (possession.detailEvents || []).some((event) =>
      String(event.type || "").toUpperCase().includes("TURNOVER"),
    );
    const hasOffRebound = (possession.detailEvents || []).some((event) =>
      String(event.type || "").toUpperCase().includes("REBOUND OFF"),
    );
    const isFastBreak = possession.duration < 5;

    teamData.totalPossessions += 1;
    teamData.outcomeCounts[outcome] = (teamData.outcomeCounts[outcome] || 0) + 1;
    teamData.durationSamples.push(possession.duration);
    teamData.totalPoints += possession.pointsScored || 0;

    if (outcome === "turnover" || hasTurnover) {
      teamData.turnoverPossessions += 1;
      teamData.durationByOutcomeSamples.turnover.push(possession.duration);
    } else if (isMissedOutcome(outcome)) {
      teamData.durationByOutcomeSamples.missed_shot.push(possession.duration);
    } else if (isMadeOutcome(outcome)) {
      teamData.durationByOutcomeSamples.made_shot.push(possession.duration);
    }

    if (hasOffRebound) {
      teamData.secondChanceWithOrebPoints += possession.pointsScored || 0;
      teamData.secondChanceWithOrebPossessions += 1;
    } else {
      teamData.secondChanceWithoutOrebPoints += possession.pointsScored || 0;
      teamData.secondChanceWithoutOrebPossessions += 1;
    }

    if (isFastBreak) {
      teamData.fastBreakPoints += possession.pointsScored || 0;
      teamData.fastBreakPossessions += 1;
    }

    const histogramIndex = buildDurationBucketIndex(possession.duration, LENGTH_BUCKET_SIZE_SECONDS);
    if (!teamData.histogramBuckets[histogramIndex]) {
      teamData.histogramBuckets[histogramIndex] = { count: 0, attempts: 0, makes: 0 };
    }
    teamData.histogramBuckets[histogramIndex].count += 1;

    (possession.detailEvents || []).forEach((event) => {
      const eventTypeUpper = String(event.type || "").toUpperCase();
      if (!isShotAttemptEvent(eventTypeUpper)) return;
      const shotType = classifyShotType(eventTypeUpper);
      if (!shotType) return;
      teamData.shotStats[shotType].attempts += 1;
      if (isMadeShotEvent(eventTypeUpper)) {
        teamData.shotStats[shotType].makes += 1;
      }
    });
  });

  teamKeys.forEach((teamKey) => {
    const teamData = byTeam[teamKey];
    teamData.durationByOutcome = {
      made_shot: d3.mean(teamData.durationByOutcomeSamples.made_shot) || 0,
      missed_shot: d3.mean(teamData.durationByOutcomeSamples.missed_shot) || 0,
      turnover: d3.mean(teamData.durationByOutcomeSamples.turnover) || 0,
    };
    teamData.histogram = finalizeBuckets(teamData.histogramBuckets, LENGTH_BUCKET_SIZE_SECONDS);
  });

  return { teamKeys, byTeam, pairChartTeamLabels: teams };
}

function normalizePossessions(rawPossessions, runData = null) {
  const ordinalOnly = /^\d+(st|nd|rd|th)$/i;
  const possessionsIn = rawPossessions.map((p) => {
    const per = String(p.period || "").trim();
    if (ordinalOnly.test(per) && p.start_time === "20:00") {
      return { ...p, start_time: "10:00" };
    }
    return p;
  });

  const teams = [...new Set(possessionsIn.map((d) => d.team).filter(Boolean))];
  const [teamA = "home", teamB = "away"] = teams;
  const possessionRunLookup = runData?.possession_run_lookup || {};
  const runsById = new Map((runData?.runs || []).map((run) => [run.run_id, run]));
  let previousHomeScore = 0;
  let previousAwayScore = 0;

  const possessions = possessionsIn.map((p, index) => {
    const possessionId = index + 1;
    const runId = possessionRunLookup[String(possessionId)] || null;
    const runMeta = runId ? runsById.get(runId) : null;
    const startAbs = toAbsoluteElapsed(p.period, p.start_time);
    const endAbs = toAbsoluteElapsed(p.period, p.end_time);
    const duration = computeDurationSeconds(p);
    const currentHomeScore = Number.isFinite(Number(p.home_score))
      ? Number(p.home_score)
      : previousHomeScore;
    const currentAwayScore = Number.isFinite(Number(p.away_score))
      ? Number(p.away_score)
      : previousAwayScore;
    const homePoints = Math.max(0, currentHomeScore - previousHomeScore);
    const awayPoints = Math.max(0, currentAwayScore - previousAwayScore);
    const teamLower = String(p.team || "").trim().toLowerCase();
    let pointsScored = 0;
    if (teamLower === "home") {
      pointsScored = homePoints;
    } else if (teamLower === "away") {
      pointsScored = awayPoints;
    } else if (homePoints > 0 && awayPoints === 0) {
      pointsScored = homePoints;
    } else if (awayPoints > 0 && homePoints === 0) {
      pointsScored = awayPoints;
    }
    previousHomeScore = currentHomeScore;
    previousAwayScore = currentAwayScore;

    const detailEvents = (p.events || []).map((event) => ({
      ...event,
      displayTime: event?.time || "--",
      displayDescription: formatEventDescription(event),
    }));
    let previousEventAbs = startAbs ?? null;
    const tickEvents = detailEvents
      .filter((event) => getTickEventCategory(event.type) !== "assist")
      .map((event) => {
      const eventAbs = toAbsoluteElapsed(p.period, event.time);
      const tickCategory = getTickEventCategory(event.type);
      const resolvedAbs = eventAbs ?? previousEventAbs ?? endAbs ?? startAbs ?? 0;

      if (eventAbs !== null) {
        previousEventAbs = eventAbs;
      } else {
        previousEventAbs = resolvedAbs;
      }

      return {
        ...event,
        // Events with "--" inherit the last known clock in this possession.
        abs: resolvedAbs,
        tickColor: TICK_COLORS[tickCategory] || TICK_COLORS.other,
      };
    });

    return {
      id: possessionId,
      team: p.team,
      period: p.period,
      startTime: p.start_time,
      endTime: p.end_time,
      startAbs: startAbs ?? 0,
      endAbs: endAbs ?? (startAbs ?? 0) + duration,
      duration,
      detailEvents,
      tickEvents,
      runId,
      runTeam: runMeta?.team || null,
      inRun: Boolean(runId),
      pointsScored,
      homeScore: currentHomeScore,
      awayScore: currentAwayScore,
    };
  });

  const pairs = [];
  let cumulativeDiff = 0;
  for (let i = 0; i < possessions.length; i += 2) {
    const chunk = possessions.slice(i, i + 2);
    const teamAPossession = chunk.find((p) => p.team === teamA) || null;
    const teamBPossession = chunk.find((p) => p.team === teamB) || null;
    // Differential sign follows chart orientation: right lane positive, left lane negative.
    const pairNet = (teamBPossession?.pointsScored || 0) - (teamAPossession?.pointsScored || 0);
    cumulativeDiff += pairNet;
    const endSnapshot = chunk.reduce((latest, possession) => {
      if (!latest) return possession;
      if ((possession.endAbs ?? 0) > (latest.endAbs ?? 0)) return possession;
      return latest;
    }, null);
    pairs.push({
      pairId: pairs.length + 1,
      teamA: teamAPossession,
      teamB: teamBPossession,
      anchorTime: Math.min(...chunk.map((p) => p.startAbs)),
      pairNet,
      cumulativeDiff,
      scoreAfterPair: {
        home: endSnapshot?.homeScore ?? 0,
        away: endSnapshot?.awayScore ?? 0,
      },
    });
  }

  return { teams: [teamA, teamB], pairs, possessions };
}

function positionChartDisclaimer() {
  const wrap = document.querySelector("#chart-section");
  const svg = document.querySelector("#possession-chart");
  const disc = document.querySelector("#disclaimer");
  if (!wrap || !svg || !disc) return;
  if (wrap.classList.contains("is-hidden")) return;
  const bottomYStr = svg.getAttribute("data-disclaimer-bottom-y");
  if (bottomYStr == null) return;
  const legendNoteBottomY = Number(bottomYStr);
  const vb = svg.viewBox.baseVal;
  if (!vb?.height) return;
  const scale = svg.getBoundingClientRect().height / vb.height;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const topPx = svg.offsetTop + legendNoteBottomY * scale - disc.offsetHeight;
  disc.style.top = `${topPx}px`;
}

function wireChartDisclaimerLayout() {
  const wrap = document.querySelector("#chart-section");
  if (!wrap || wrap.dataset.disclaimerLayoutWired) return;
  wrap.dataset.disclaimerLayoutWired = "1";
  const ro = new ResizeObserver(() => {
    positionChartDisclaimer();
  });
  ro.observe(wrap);
  const svg = document.querySelector("#possession-chart");
  if (svg) ro.observe(svg);
}

function drawChart({ teams, pairs }) {
  const svg = d3.select("#possession-chart");
  const chartWrap = d3.select(".chart-wrap");
  chartWrap.selectAll(".possession-tooltip").remove();
  const tooltip = chartWrap.append("div").attr("class", "possession-tooltip");
  const baseWidth = 980;
  const tickLegendRows = [
    [
      { label: "made shot", color: TICK_COLORS.made_shot },
      { label: "missed shot", color: TICK_COLORS.missed_shot },
    ],
    [
      { label: "defensive rebound", color: TICK_COLORS.def_rebound },
      { label: "offensive rebound", color: TICK_COLORS.off_rebound },
    ],
    [
      { label: "turnover", color: TICK_COLORS.turnover },
      { label: "steal", color: TICK_COLORS.steal },
      { label: "block", color: TICK_COLORS.block },
      { label: "foul", color: TICK_COLORS.foul },
    ],
    [
      { label: "timeout", color: TICK_COLORS.timeout },
      { label: "other", color: TICK_COLORS.other },
    ],
  ];
  const legendRows = tickLegendRows.length;
  const runLegendHeight = 22;
  const legendNoteHeight = 46;
  const legendH = 16 + legendRows * 20 + runLegendHeight + legendNoteHeight;
  const legendY = 20;
  const teamLabelY = legendY + legendH + 30;
  const topMargin = teamLabelY + 60;
  const pairGap = 34;
  const halftimeGap = 16;
  const halftimeSplitIndex = pairs.findIndex((pair) => {
    const possessions = [pair.teamA, pair.teamB].filter(Boolean);
    if (!possessions.length) return false;
    const earliestStart = d3.min(possessions, (possession) => possession.startAbs);
    return Number.isFinite(earliestStart) && earliestStart >= HALF_SECONDS;
  });
  const hasHalftimeSplit = halftimeSplitIndex > 0;
  const bottomMargin = 32;
  const chartHeight =
    topMargin
    + Math.max(1, pairs.length - 1) * pairGap
    + (hasHalftimeSplit ? halftimeGap : 0)
    + bottomMargin;

  svg.selectAll("*").remove();

  const midX = baseWidth / 2;
  const laneMaxWidth = 300;
  const laneHeight = 20;
  const leftAnchorX = midX - 8;
  const rightAnchorX = midX + 8;
  const leftTeamCx = midX - 140;
  const rightTeamCx = midX + 140;
  const metaX = 28;
  const diffLaneLeftX = rightAnchorX + laneMaxWidth + DIFF_LANE_GAP;
  const diffLaneRightX = diffLaneLeftX + DIFF_LANE_WIDTH;
  const width = diffLaneRightX + metaX;
  svg.attr("viewBox", `0 0 ${width} ${chartHeight}`);
  /** Horizontal axis for away | home labels (gutter left of widest away bar). */
  const pairLabelDividerX = (metaX + (leftAnchorX - laneMaxWidth)) / 2;

  const maxDuration =
    d3.max(pairs.flatMap((pair) => [pair.teamA, pair.teamB]).filter(Boolean), (d) => d.duration) || 1;
  const barWidthScale = d3.scaleLinear().domain([1, maxDuration]).range([28, laneMaxWidth]);

  function tooltipHtml(possession) {
    const items = possession.detailEvents.length
      ? possession.detailEvents
          .map(
            (event) =>
              `<li><span class="event-time">${escapeHtml(event.displayTime)}</span><span class="event-desc">${escapeHtml(event.displayDescription)}</span></li>`,
          )
          .join("")
      : '<li><span class="event-time">--</span><span class="event-desc">No events recorded</span></li>';

    return `
      <p class="tooltip-title">${escapeHtml(possession.team)} possession</p>
      <p class="tooltip-meta">${escapeHtml(possession.period)} | ${escapeHtml(possession.startTime)}-${escapeHtml(possession.endTime)}</p>
      <ul class="tooltip-events">${items}</ul>
    `;
  }

  function placeTooltip(event) {
    const wrapNode = chartWrap.node();
    const tooltipNode = tooltip.node();
    if (!wrapNode || !tooltipNode) return;
    const [pointerX, pointerY] = d3.pointer(event, wrapNode);
    const padding = 12;
    const offset = 14;
    const maxLeft = Math.max(
      padding,
      wrapNode.clientWidth - tooltipNode.offsetWidth - padding,
    );
    const maxTop = Math.max(
      padding,
      wrapNode.clientHeight - tooltipNode.offsetHeight - padding,
    );
    const left = Math.min(maxLeft, pointerX + offset);
    const top = Math.min(maxTop, pointerY + offset);
    tooltip.style("left", `${left}px`).style("top", `${top}px`);
  }

  function showTooltip(event, possession) {
    tooltip.html(tooltipHtml(possession)).classed("is-visible", true);
    placeTooltip(event);
  }

  function hideTooltip() {
    tooltip.classed("is-visible", false);
  }

  function appendPairSplitRow(group, y, leftText, rightText, { leftClass, rightClass, sepClass = "pair-split-sep" }) {
    const gutter = 3;
    group
      .append("text")
      .attr("class", leftClass)
      .attr("x", pairLabelDividerX - gutter)
      .attr("y", y)
      .attr("text-anchor", "end")
      .text(leftText);
    group
      .append("text")
      .attr("class", sepClass)
      .attr("x", pairLabelDividerX)
      .attr("y", y)
      .attr("text-anchor", "middle")
      .text("|");
    group
      .append("text")
      .attr("class", rightClass)
      .attr("x", pairLabelDividerX + gutter)
      .attr("y", y)
      .attr("text-anchor", "start")
      .text(rightText);
  }

  // Team labels (placed below the legend)
  svg
    .append("text")
    .attr("x", leftTeamCx)
    .attr("y", teamLabelY)
    .attr("text-anchor", "middle")
    .attr("class", "team-label")
    .attr("fill", getTeamColor(normalizeTeamKey(teams[0]), 0))
    .text(teams[0]);
  svg
    .append("text")
    .attr("x", rightTeamCx)
    .attr("y", teamLabelY)
    .attr("text-anchor", "middle")
    .attr("class", "team-label")
    .attr("fill", getTeamColor(normalizeTeamKey(teams[1]), 1))
    .text(teams[1]);

  // Center divider
  svg.append("line").attr("class", "mid-divider")
    .attr("x1", midX).attr("x2", midX)
    .attr("y1", teamLabelY + 10).attr("y2", chartHeight - bottomMargin + 10);
  svg.append("rect")
    .attr("x", metaX - 4).attr("y", legendY - 4)
    .attr("width", width - metaX * 2 + 8).attr("height", legendH)
    .attr("rx", 6).attr("fill", "none")
    .attr("stroke", "#e0e0e0").attr("stroke-width", 0.5);

  svg.append("text").attr("class", "legend-heading")
    .attr("x", metaX + 4).attr("y", legendY + 20).text("Event key");

  const colW = 128;
  tickLegendRows.forEach((rowItems, row) => {
    rowItems.forEach((item, col) => {
      const ix = metaX + 96 + col * colW;
      const iy = legendY + 18 + row * 20;
      const g = svg.append("g");
      g.append("line").attr("class", "legend-tick-swatch")
        .attr("stroke", item.color)
        .attr("x1", ix).attr("x2", ix)
        .attr("y1", iy - 8).attr("y2", iy + 4);
      g.append("text").attr("class", "legend-label")
        .attr("x", ix + 10).attr("y", iy + 2).text(item.label);
    });
  });

  const runLegendY = legendY + 18 + legendRows * 20 + 2;
  svg.append("rect")
    .attr("x", metaX + 96)
    .attr("y", runLegendY - 10)
    .attr("width", 22)
    .attr("height", 12)
    .attr("rx", 2)
    .attr("fill", RUN_TEAM_FILL)
    .attr("stroke", "#8aa56a")
    .attr("stroke-width", 1);
  svg.append("text").attr("class", "legend-label")
    .attr("x", metaX + 126).attr("y", runLegendY)
    .text("team on a run");
  svg.append("rect")
    .attr("x", metaX + 240)
    .attr("y", runLegendY - 10)
    .attr("width", 22)
    .attr("height", 12)
    .attr("rx", 2)
    .attr("fill", RUN_OPPONENT_FILL)
    .attr("stroke", "#c88787")
    .attr("stroke-width", 1);
  svg.append("text").attr("class", "legend-label")
    .attr("x", metaX + 270).attr("y", runLegendY)
    .text("team on a slump");
  const diffLegendX = metaX + 390;
  svg.append("line")
    .attr("class", "diff-legend-line")
    .attr("x1", diffLegendX)
    .attr("x2", diffLegendX + 22)
    .attr("y1", runLegendY - 4)
    .attr("y2", runLegendY - 4);
  svg.append("circle")
    .attr("class", "diff-legend-point")
    .attr("cx", diffLegendX + 11)
    .attr("cy", runLegendY - 4)
    .attr("r", 3);
  svg.append("text").attr("class", "legend-label")
    .attr("x", diffLegendX + 30).attr("y", runLegendY)
    .text("cumulative point differential");

  svg.append("line").attr("class", "section-rule")
    .attr("x1", metaX).attr("x2", width - metaX)
    .attr("y1", legendY + legendH - 2).attr("y2", legendY + legendH - 2);

  // Pair rows
  const pairsGroup = svg.append("g").attr("class", "pairs");
  const rowY = (pairIndex) =>
    topMargin + pairIndex * pairGap + (hasHalftimeSplit && pairIndex >= halftimeSplitIndex ? halftimeGap : 0);
  appendPairSplitRow(
    pairsGroup,
    topMargin - 20,
    String(teams[0]).toUpperCase(),
    String(teams[1]).toUpperCase(),
    {
      leftClass: "pair-meta-heading pair-meta-heading-side",
      rightClass: "pair-meta-heading pair-meta-heading-side",
      sepClass: "pair-split-sep pair-split-sep--heading",
    },
  );

  pairs.forEach((pair, pairIndex) => {
    const y = rowY(pairIndex);

    const awayTimes = formatTimeRange(pair.teamA);
    const homeTimes = formatTimeRange(pair.teamB);
    const scoreAfterPair = pair.scoreAfterPair || { home: 0, away: 0 };
    const teamAScore = String(teams[0]).toLowerCase() === "home"
      ? scoreAfterPair.home
      : scoreAfterPair.away;
    const teamBScore = String(teams[1]).toLowerCase() === "home"
      ? scoreAfterPair.home
      : scoreAfterPair.away;
    appendPairSplitRow(pairsGroup, y - 6, String(teamAScore), String(teamBScore), {
      leftClass: "pair-score",
      rightClass: "pair-score",
    });
    appendPairSplitRow(pairsGroup, y + 6, awayTimes, homeTimes, {
      leftClass: "pair-meta",
      rightClass: "pair-meta",
    });

    [
      { possession: pair.teamA, side: "left" },
      { possession: pair.teamB, side: "right" },
    ].forEach(({ possession, side }) => {
      if (!possession) return;

      const barWidth = barWidthScale(possession.duration);
      const x = side === "left" ? leftAnchorX - barWidth : rightAnchorX;
      const laneClass = possession.inRun
        ? (possession.team === possession.runTeam ? "lane-bg lane-bg-run-team" : "lane-bg lane-bg-run-opponent")
        : "lane-bg";

      const bar = pairsGroup
        .append("rect")
        .attr("class", `${laneClass} possession-bar`)
        .attr("x", x)
        .attr("y", y - laneHeight / 2)
        .attr("width", barWidth)
        .attr("height", laneHeight);

      bar
        .on("mouseenter", (event) => showTooltip(event, possession))
        .on("mousemove", (event) => placeTooltip(event))
        .on("mouseleave", hideTooltip);

      const eventPositionScale = d3
        .scaleLinear()
        .domain([possession.startAbs, Math.max(possession.startAbs + 1, possession.endAbs)])
        .range(side === "left" ? [x, leftAnchorX] : [x, x + barWidth]);

      const innerTop = y - laneHeight / 2;
      const innerBottom = y + laneHeight / 2;
      const innerHeight = innerBottom - innerTop;
      const ticksByTime = d3.groups(possession.tickEvents, (tick) => tick.abs);

      ticksByTime.forEach(([abs, ticksAtSameTime]) => {
        const tickX = eventPositionScale(Number(abs));
        const segmentHeight = innerHeight / ticksAtSameTime.length;

        ticksAtSameTime.forEach((tick, segmentIndex) => {
          const y1 = innerTop + segmentIndex * segmentHeight;
          const y2 =
            segmentIndex === ticksAtSameTime.length - 1
              ? innerBottom
              : innerTop + (segmentIndex + 1) * segmentHeight;

          pairsGroup
            .append("line")
            .attr("class", "event-tick")
            .attr("stroke", tick.tickColor)
            .attr("x1", tickX)
            .attr("x2", tickX)
            .attr("y1", y1)
            .attr("y2", y2);
        });
      });
    });
  });

  if (hasHalftimeSplit) {
    const splitY = (rowY(halftimeSplitIndex - 1) + rowY(halftimeSplitIndex)) / 2;
    svg
      .append("line")
      .attr("class", "halftime-divider")
      .attr("x1", metaX)
      .attr("x2", width - metaX)
      .attr("y1", splitY)
      .attr("y2", splitY);
  }

  const diffPoints = pairs.map((pair, pairIndex) => ({
    pair,
    y: rowY(pairIndex),
    cumulativeDiff: pair.cumulativeDiff || 0,
  }));
  const maxAbsDiff = d3.max(diffPoints, (point) => Math.abs(point.cumulativeDiff)) || 0;
  const diffDomainMax = Math.max(2, maxAbsDiff);
  const diffLeftX = diffLaneLeftX;
  const diffRightX = diffLaneRightX;
  const diffXScale = d3
    .scaleLinear()
    .domain([-diffDomainMax, diffDomainMax])
    .range([diffLeftX, diffRightX]);
  const firstRowY = topMargin;
  const lastRowY = topMargin + Math.max(0, pairs.length - 1) * pairGap;

  const diffGroup = svg
    .append("g")
    .attr("class", "diff-group")
    .attr("pointer-events", "none");
  diffGroup
    .append("g")
    .attr("class", "diff-axis")
    .attr("transform", `translate(0, ${teamLabelY + 36})`)
    .call(d3.axisTop(diffXScale).ticks(5).tickSizeOuter(0));
  diffGroup
    .append("text")
    .attr("class", "diff-axis-label")
    .attr("x", (diffLeftX + diffRightX) / 2)
    .attr("y", teamLabelY + 18)
    .attr("text-anchor", "middle")
    .text("Cumulative point differential");

  diffGroup
    .append("line")
    .attr("class", "diff-zero-line")
    .attr("x1", diffXScale(0))
    .attr("x2", diffXScale(0))
    .attr("y1", firstRowY - laneHeight / 2)
    .attr("y2", lastRowY + laneHeight / 2);

  if (diffPoints.length > 1) {
    const diffLine = d3
      .line()
      .x((point) => diffXScale(point.cumulativeDiff))
      .y((point) => point.y);
    const diffSegments = hasHalftimeSplit
      ? [diffPoints.slice(0, halftimeSplitIndex), diffPoints.slice(halftimeSplitIndex)]
      : [diffPoints];
    diffSegments.forEach((segment) => {
      if (segment.length < 2) return;
      diffGroup
        .append("path")
        .datum(segment)
        .attr("class", "diff-line")
        .attr("d", diffLine);
    });
  }

  diffGroup
    .selectAll("circle")
    .data(diffPoints)
    .enter()
    .append("circle")
    .attr("class", "diff-point")
    .attr("cx", (point) => diffXScale(point.cumulativeDiff))
    .attr("cy", (point) => point.y)
    .attr("r", 3.2);

  const minDiff = d3.min(diffPoints, (point) => point.cumulativeDiff);
  const maxDiff = d3.max(diffPoints, (point) => point.cumulativeDiff);
  const labelIndexes = new Set();
  if (diffPoints.length) {
    labelIndexes.add(0);
    labelIndexes.add(diffPoints.length - 1);
    if (minDiff !== undefined) {
      const minIndex = diffPoints.findIndex((point) => point.cumulativeDiff === minDiff);
      if (minIndex >= 0) labelIndexes.add(minIndex);
    }
    if (maxDiff !== undefined) {
      const maxIndex = diffPoints.findIndex((point) => point.cumulativeDiff === maxDiff);
      if (maxIndex >= 0) labelIndexes.add(maxIndex);
    }
  }

  diffGroup
    .selectAll(".diff-point-label")
    .data([...labelIndexes].map((index) => diffPoints[index]))
    .enter()
    .append("text")
    .attr("class", "diff-point-label")
    .attr("x", (point) => diffXScale(point.cumulativeDiff) + (point.cumulativeDiff >= 0 ? 6 : -6))
    .attr("y", (point) => point.y + 3)
    .attr("text-anchor", (point) => (point.cumulativeDiff >= 0 ? "start" : "end"))
    .text((point) => point.cumulativeDiff);

  svg.on("mouseleave", hideTooltip);

  const legendNoteBottomY = legendY + legendH - 8;
  svg.node().setAttribute("data-disclaimer-bottom-y", String(legendNoteBottomY));
  positionChartDisclaimer();
}

/** Display label for the team in the paired chart lane at index 0 (left) or 1 (right). */
function pairChartTeamLabel(analytics, index) {
  const raw = analytics.pairChartTeamLabels?.[index];
  if (raw != null && String(raw).length) return String(raw);
  return analytics.teamKeys[index] ?? "";
}

function getTeamColor(teamKey, index) {
  return TEAM_COLORS[teamKey] || (index === 0 ? TEAM_COLORS.home : TEAM_COLORS.away);
}

const OUTCOME_SLICE_TOOLTIP_ID = "outcome-slice-tooltip";

function getOutcomeSliceTooltip() {
  const existing = d3.select(`#${OUTCOME_SLICE_TOOLTIP_ID}`);
  if (!existing.empty()) return existing;
  return d3
    .select("body")
    .append("div")
    .attr("id", OUTCOME_SLICE_TOOLTIP_ID)
    .attr("class", "outcome-slice-tooltip");
}

function placeOutcomeSliceTooltip(event) {
  const tip = d3.select(`#${OUTCOME_SLICE_TOOLTIP_ID}`).node();
  if (!tip) return;
  const offset = 10;
  const pad = 8;
  let left = event.clientX + offset;
  let top = event.clientY + offset;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  left = Math.min(left, window.innerWidth - w - pad);
  top = Math.min(top, window.innerHeight - h - pad);
  left = Math.max(pad, left);
  top = Math.max(pad, top);
  d3.select(tip).style("left", `${left}px`).style("top", `${top}px`);
}

function showOutcomeSliceTooltip(event, d, teamData) {
  const label = OUTCOME_LABELS[d.data.key] || d.data.key;
  const n = d.data.count;
  const noun = n === 1 ? "possession" : "possessions";
  getOutcomeSliceTooltip()
    .classed("is-visible", true)
    .html(
      `<strong>${escapeHtml(label)}</strong><br/><span>${n} ${noun} (${escapeHtml(
        formatPercent(n, teamData.totalPossessions),
      )} of team total)</span>`,
    );
  placeOutcomeSliceTooltip(event);
}

function hideOutcomeSliceTooltip() {
  d3.select(`#${OUTCOME_SLICE_TOOLTIP_ID}`).classed("is-visible", false);
}

function drawOutcomePie(svgId, teamData, teamColor) {
  const svg = d3.select(`#${svgId}`);
  if (svg.empty()) return;
  const width = 440;
  const height = 280;
  const innerRadius = 40;
  const outerRadius = 100;
  const cx = 128;
  const cy = 128;
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const entries = Object.entries(teamData.outcomeCounts)
    .map(([key, count]) => ({ key, count }))
    .filter((entry) => entry.count > 0);

  const fallbackEntries = entries.length ? entries : [{ key: "other", count: 1 }];
  const pie = d3.pie().value((d) => d.count).sort(null);
  const arc = d3.arc().innerRadius(innerRadius).outerRadius(outerRadius);

  const defs = svg.append("defs");
  const patternIds = new Map();
  fallbackEntries.forEach((entry) => {
    if (!isBadOutcome(entry.key) || patternIds.has(entry.key)) return;
    const baseKey = getOutcomeBaseKey(entry.key);
    const color = OUTCOME_COLORS[baseKey] || teamColor;
    const patternId = `${svgId}-${entry.key}-hatch`.replace(/[^a-zA-Z0-9_-]/g, "-");
    const pattern = defs
      .append("pattern")
      .attr("id", patternId)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("width", 8)
      .attr("height", 8)
      .attr("patternTransform", "rotate(45)");
    pattern.append("rect").attr("width", 8).attr("height", 8).attr("fill", color).attr("opacity", 0.16);
    pattern
      .append("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", 0)
      .attr("y2", 8)
      .attr("stroke", color)
      .attr("stroke-width", 2.4)
      .attr("opacity", 0.95);
    patternIds.set(entry.key, patternId);
  });

  function getOutcomeFill(key) {
    const baseKey = getOutcomeBaseKey(key);
    const color = OUTCOME_COLORS[baseKey] || teamColor;
    if (!isBadOutcome(key)) return color;
    const patternId = patternIds.get(key);
    return patternId ? `url(#${patternId})` : color;
  }

  const group = svg.append("g").attr("transform", `translate(${cx}, ${cy})`);

  function allSlices() {
    return group.selectAll("path.outcome-slice");
  }

  function resetSliceOpacity() {
    allSlices().attr("opacity", 1);
  }

  const slicePaths = group
    .selectAll("path")
    .data(pie(fallbackEntries))
    .enter()
    .append("path")
    .attr("class", "outcome-slice")
    .attr("d", arc)
    .attr("fill", (d) => getOutcomeFill(d.data.key))
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 1.2)
    .attr("cursor", "pointer")
    .on("mouseenter", function (event, d) {
      allSlices().attr("opacity", 0.38);
      d3.select(this).attr("opacity", 1);
      showOutcomeSliceTooltip(event, d, teamData);
    })
    .on("mousemove", (event) => placeOutcomeSliceTooltip(event))
    .on("mouseleave", function (event) {
      const rel = event.relatedTarget;
      if (rel && rel.classList && rel.classList.contains("outcome-slice")) return;
      resetSliceOpacity();
      hideOutcomeSliceTooltip();
    });

  slicePaths.append("title").text((d) => {
    const label = OUTCOME_LABELS[d.data.key] || d.data.key;
    return `${label}: ${d.data.count} ${d.data.count === 1 ? "possession" : "possessions"}`;
  });

  group
    .append("circle")
    .attr("r", innerRadius - 1)
    .attr("fill", teamColor)
    .attr("opacity", 0.22)
    .attr("stroke", teamColor)
    .attr("stroke-width", 1);

  group
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "-0.1em")
    .style("font-size", "0.95rem")
    .style("font-weight", "700")
    .style("fill", teamColor)
    .text(teamData.totalPossessions);

  group
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "1.15em")
    .style("font-size", "0.7rem")
    .style("fill", "#64748b")
    .text("possessions");

  const legend = svg.append("g").attr("transform", "translate(248, 20)");
  fallbackEntries.forEach((entry, index) => {
    const y = index * 26;
    legend
      .append("rect")
      .attr("x", 0)
      .attr("y", y)
      .attr("width", 11)
      .attr("height", 11)
      .attr("fill", getOutcomeFill(entry.key));
    legend
      .append("text")
      .attr("x", 18)
      .attr("y", y + 9)
      .attr("class", "analytics-legend")
      .text(`${OUTCOME_LABELS[entry.key] || entry.key}: ${formatPercent(entry.count, teamData.totalPossessions)}`);
  });
}

function renderOutcomePieCharts(analytics) {
  const leftKey = analytics.teamKeys[0];
  const rightKey = analytics.teamKeys[1];
  const leftLabel = pairChartTeamLabel(analytics, 0);
  const rightLabel = pairChartTeamLabel(analytics, 1);

  const leftCap = document.querySelector("#outcome-pie-home")?.closest("figure")?.querySelector("figcaption");
  const rightCap = document.querySelector("#outcome-pie-away")?.closest("figure")?.querySelector("figcaption");
  if (leftCap) {
    leftCap.textContent = leftLabel;
    leftCap.style.color = getTeamColor(leftKey, 0);
  }
  if (rightCap) {
    rightCap.textContent = rightLabel;
    rightCap.style.color = getTeamColor(rightKey, 1);
  }

  d3.select("#outcome-pie-home").attr("aria-label", `${leftLabel} possession outcome distribution`);
  d3.select("#outcome-pie-away").attr("aria-label", `${rightLabel} possession outcome distribution`);

  drawOutcomePie("outcome-pie-home", analytics.byTeam[leftKey], getTeamColor(leftKey, 0));
  drawOutcomePie("outcome-pie-away", analytics.byTeam[rightKey], getTeamColor(rightKey, 1));
}

function renderDurationByOutcome(analytics) {
  const svg = d3.select("#duration-by-outcome-chart");
  if (svg.empty()) return;
  svg.selectAll("*").remove();

  const width = 700;
  const height = 260;
  const margin = { top: 24, right: 16, bottom: 56, left: 52 };
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const categories = [
    { key: "made_shot", label: "Made shot" },
    { key: "missed_shot", label: "Missed shot" },
    { key: "turnover", label: "Turnover" },
  ];
  const chartTeams = [analytics.teamKeys[0], analytics.teamKeys[1]];
  const records = categories.flatMap((category) =>
    chartTeams.map((teamKey, idx) => ({
      category: category.label,
      teamKey,
      teamIndex: idx,
      value: analytics.byTeam[teamKey].durationByOutcome[category.key] || 0,
    })),
  );
  const maxValue = d3.max(records, (record) => record.value) || 1;
  const x0 = d3
    .scaleBand()
    .domain(categories.map((d) => d.label))
    .range([margin.left, width - margin.right])
    .paddingInner(0.3);
  const x1 = d3.scaleBand().domain(chartTeams).range([0, x0.bandwidth()]).padding(0.2);
  const y = d3
    .scaleLinear()
    .domain([0, maxValue * 1.25])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg
    .append("g")
    .attr("class", "analytics-axis")
    .attr("transform", `translate(0, ${height - margin.bottom})`)
    .call(d3.axisBottom(x0));

  svg
    .append("g")
    .attr("class", "analytics-axis")
    .attr("transform", `translate(${margin.left}, 0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat((value) => `${value}s`));

  svg
    .append("g")
    .selectAll("rect")
    .data(records)
    .enter()
    .append("rect")
    .attr("x", (d) => x0(d.category) + x1(d.teamKey))
    .attr("y", (d) => y(d.value))
    .attr("width", x1.bandwidth())
    .attr("height", (d) => y(0) - y(d.value))
    .attr("fill", (d) => getTeamColor(d.teamKey, d.teamIndex))
    .attr("opacity", 0.82);

  chartTeams.forEach((teamKey, index) => {
    const x = width - margin.right - 170 + index * 86;
    svg
      .append("rect")
      .attr("x", x)
      .attr("y", 6)
      .attr("width", 14)
      .attr("height", 14)
      .attr("fill", getTeamColor(teamKey, index));
    svg
      .append("text")
      .attr("x", x + 20)
      .attr("y", 18)
      .attr("class", "analytics-team-legend")
      .attr("fill", getTeamColor(teamKey, index))
      .text(pairChartTeamLabel(analytics, index));
  });
}

function mergeHistogramDomains(analytics, chartTeams) {
  const labels = new Set();
  chartTeams.forEach((teamKey) => {
    analytics.byTeam[teamKey].histogram.forEach((bucket) => labels.add(bucket.label));
  });
  const resolved = [...labels].sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  return resolved.length ? resolved : ["0-4s"];
}

function renderPossessionLengthHistogram(analytics) {
  const svg = d3.select("#possession-length-histogram");
  if (svg.empty()) return;
  svg.selectAll("*").remove();

  const width = 700;
  const height = 260;
  const margin = { top: 26, right: 16, bottom: 54, left: 48 };
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const chartTeams = [analytics.teamKeys[0], analytics.teamKeys[1]];
  const labels = mergeHistogramDomains(analytics, chartTeams);
  const records = labels.flatMap((label) =>
    chartTeams.map((teamKey, index) => {
      const found = analytics.byTeam[teamKey].histogram.find((bucket) => bucket.label === label);
      return {
        label,
        teamKey,
        teamIndex: index,
        count: found?.count || 0,
      };
    }),
  );
  const maxCount = d3.max(records, (record) => record.count) || 1;
  const x0 = d3
    .scaleBand()
    .domain(labels)
    .range([margin.left, width - margin.right])
    .paddingInner(0.26);
  const x1 = d3.scaleBand().domain(chartTeams).range([0, x0.bandwidth()]).padding(0.2);
  const y = d3
    .scaleLinear()
    .domain([0, maxCount * 1.2])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg
    .append("g")
    .attr("class", "analytics-axis")
    .attr("transform", `translate(0, ${height - margin.bottom})`)
    .call(d3.axisBottom(x0).tickValues(labels.filter((_, index) => index % 2 === 0)));
  svg
    .append("g")
    .attr("class", "analytics-axis")
    .attr("transform", `translate(${margin.left}, 0)`)
    .call(d3.axisLeft(y).ticks(5));

  svg
    .append("g")
    .selectAll("rect")
    .data(records)
    .enter()
    .append("rect")
    .attr("x", (d) => x0(d.label) + x1(d.teamKey))
    .attr("y", (d) => y(d.count))
    .attr("width", x1.bandwidth())
    .attr("height", (d) => y(0) - y(d.count))
    .attr("fill", (d) => getTeamColor(d.teamKey, d.teamIndex))
    .attr("opacity", 0.75);

  chartTeams.forEach((teamKey, index) => {
    const x = width - margin.right - 170 + index * 86;
    svg
      .append("rect")
      .attr("x", x)
      .attr("y", 6)
      .attr("width", 14)
      .attr("height", 14)
      .attr("fill", getTeamColor(teamKey, index));
    svg
      .append("text")
      .attr("x", x + 20)
      .attr("y", 18)
      .attr("class", "analytics-team-legend")
      .attr("fill", getTeamColor(teamKey, index))
      .text(pairChartTeamLabel(analytics, index));
  });
}

function buildFactCard(
  title,
  leftValue,
  leftSubValue,
  rightValue,
  rightSubValue,
  leftLabel,
  rightLabel,
  leftTeamKey,
  rightTeamKey,
) {
  const leftSubValueHtml = leftSubValue ? `<p class="fact-subvalue">${escapeHtml(leftSubValue)}</p>` : "";
  const rightSubValueHtml = rightSubValue ? `<p class="fact-subvalue">${escapeHtml(rightSubValue)}</p>` : "";
  const card = document.createElement("article");
  card.className = "fact-card";
  card.innerHTML = `
    <p class="fact-title">${escapeHtml(title)}</p>
    <div class="fact-team-row team-signal-${escapeHtml(leftTeamKey)}">
      <p class="fact-team-label">${escapeHtml(leftLabel)}</p>
      <div>
        <p class="fact-value">${escapeHtml(leftValue)}</p>
        ${leftSubValueHtml}
      </div>
    </div>
    <div class="fact-team-row team-signal-${escapeHtml(rightTeamKey)}">
      <p class="fact-team-label">${escapeHtml(rightLabel)}</p>
      <div>
        <p class="fact-value">${escapeHtml(rightValue)}</p>
        ${rightSubValueHtml}
      </div>
    </div>
  `;
  return card;
}

function renderQuickFacts(analytics) {
  const grid = document.querySelector("#quick-facts-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const leftKey = analytics.teamKeys[0];
  const rightKey = analytics.teamKeys[1];
  const leftLabel = pairChartTeamLabel(analytics, 0);
  const rightLabel = pairChartTeamLabel(analytics, 1);
  const home = analytics.byTeam[leftKey];
  const away = analytics.byTeam[rightKey];
  const getFgAttempts = (team) =>
    team.shotStats.three_pointer.attempts + team.shotStats.layup_dunk.attempts + team.shotStats.two_pointer.attempts;
  const getFgMakes = (team) =>
    team.shotStats.three_pointer.makes + team.shotStats.layup_dunk.makes + team.shotStats.two_pointer.makes;

  const cards = [
    buildFactCard(
      "FG Percentage",
      formatPercent(getFgMakes(home), getFgAttempts(home)),
      `${getFgMakes(home)}/${getFgAttempts(home)} FG attempts`,
      formatPercent(getFgMakes(away), getFgAttempts(away)),
      `${getFgMakes(away)}/${getFgAttempts(away)} FG attempts`,
      leftLabel,
      rightLabel,
      leftKey,
      rightKey,
    ),
    ...Object.entries(SHOT_TYPE_LABELS).map(([shotType, label]) =>
      buildFactCard(
        `${label} success`,
        formatPercent(home.shotStats[shotType].makes, home.shotStats[shotType].attempts),
        `${home.shotStats[shotType].makes}/${home.shotStats[shotType].attempts} made`,
        formatPercent(away.shotStats[shotType].makes, away.shotStats[shotType].attempts),
        `${away.shotStats[shotType].makes}/${away.shotStats[shotType].attempts} made`,
        leftLabel,
        rightLabel,
        leftKey,
        rightKey,
      )),
    buildFactCard(
      "Turnover rate",
      formatPercent(home.turnoverPossessions, home.totalPossessions),
      `${home.turnoverPossessions}/${home.totalPossessions} possessions`,
      formatPercent(away.turnoverPossessions, away.totalPossessions),
      `${away.turnoverPossessions}/${away.totalPossessions} possessions`,
      leftLabel,
      rightLabel,
      leftKey,
      rightKey,
    ),
    buildFactCard(
      "Points per possession",
      (home.totalPoints / Math.max(1, home.totalPossessions)).toFixed(2),
      `${home.totalPoints} points / ${home.totalPossessions} possessions`,
      (away.totalPoints / Math.max(1, away.totalPossessions)).toFixed(2),
      `${away.totalPoints} points / ${away.totalPossessions} possessions`,
      leftLabel,
      rightLabel,
      leftKey,
      rightKey,
    ),
    buildFactCard(
      "Second-chance points",
      `${home.secondChanceWithOrebPoints} pts`,
      "",
      `${away.secondChanceWithOrebPoints} pts`,
      "",
      leftLabel,
      rightLabel,
      leftKey,
      rightKey,
    ),
    buildFactCard(
      "Fast-break points (<5s)",
      `${home.fastBreakPoints} pts`,
      `${home.fastBreakPossessions} fast-break possessions`,
      `${away.fastBreakPoints} pts`,
      `${away.fastBreakPossessions} fast-break possessions`,
      leftLabel,
      rightLabel,
      leftKey,
      rightKey,
    ),
  ];

  cards.forEach((card) => grid.appendChild(card));
}

function runAnalyticsValidation(analytics) {
  analytics.teamKeys.forEach((teamKey) => {
    const team = analytics.byTeam[teamKey];
    const outcomeTotal = Object.values(team.outcomeCounts).reduce((sum, value) => sum + value, 0);
    console.assert(
      outcomeTotal === team.totalPossessions,
      `${teamKey}: outcome total mismatch (${outcomeTotal} vs ${team.totalPossessions})`,
    );
    const fgAttempts =
      team.shotStats.three_pointer.attempts +
      team.shotStats.layup_dunk.attempts +
      team.shotStats.two_pointer.attempts;
    const fgMakes =
      team.shotStats.three_pointer.makes +
      team.shotStats.layup_dunk.makes +
      team.shotStats.two_pointer.makes;
    console.assert(
      fgMakes <= fgAttempts,
      `${teamKey}: FG makes exceed attempts (${fgMakes}/${fgAttempts})`,
    );
  });
}

function renderAnalyticsDashboard(analytics) {
  renderOutcomePieCharts(analytics);
  renderDurationByOutcome(analytics);
  renderPossessionLengthHistogram(analytics);
  renderQuickFacts(analytics);
}

function setLoadStatus(message, { isError = false } = {}) {
  const statusEl = document.querySelector("#game-load-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", isError);
}

function setVisualizationVisibility(isVisible) {
  const sectionIds = ["#chart-section", "#analytics-section", "#quick-facts-section"];
  sectionIds.forEach((selector) => {
    const node = document.querySelector(selector);
    if (!node) return;
    node.classList.toggle("is-hidden", !isVisible);
  });
}

function renderFromRawData(raw, runData = null) {
  if (!Array.isArray(raw)) throw new Error("possession data must be an array");
  const normalized = normalizePossessions(raw, runData);
  drawChart(normalized);
  const analytics = deriveAnalytics(normalized);
  runAnalyticsValidation(analytics);
  renderAnalyticsDashboard(analytics);
  setVisualizationVisibility(true);
}

async function scrapeGameFromUrl(gameUrl) {
  const response = await fetch("./api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: gameUrl }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const msg = payload?.error || `Scrape request failed (${response.status})`;
    throw new Error(msg);
  }
  if (!payload || !Array.isArray(payload.possessions)) {
    throw new Error("Scraper response did not include possession data");
  }
  return payload;
}

function wireGameUrlForm() {
  const form = document.querySelector("#game-url-form");
  const input = document.querySelector("#game-url-input");
  const button = document.querySelector("#game-url-submit");
  if (!form || !input || !button) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const gameUrl = String(input.value || "").trim();
    if (!gameUrl) {
      setLoadStatus("Please paste a game URL.", { isError: true });
      return;
    }

    button.disabled = true;
    setLoadStatus("Running scraper and rebuilding visualizations...");
    try {
      const payload = await scrapeGameFromUrl(gameUrl);
      renderFromRawData(payload.possessions, payload.run_data || null);
      setLoadStatus(`Loaded ${payload.possessions.length} possessions from ${payload.source_url}.`);
    } catch (error) {
      setLoadStatus(error.message, { isError: true });
      console.error(error);
    } finally {
      button.disabled = false;
    }
  });
}

async function init() {
  wireGameUrlForm();
  wireChartDisclaimerLayout();
  setVisualizationVisibility(false);
  setLoadStatus("Paste a game URL to load the visualizations.");
}

init();