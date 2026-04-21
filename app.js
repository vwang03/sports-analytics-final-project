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
const DATA_VERSION = "run-highlight-7";
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

function normalizePossessions(rawPossessions, runData = null) {
  // Scrapes before ordinal-quarter handling used 20:00 as period starts; WBB clocks never go above 10:00.
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
    pairs.push({
      pairId: pairs.length + 1,
      teamA: teamAPossession,
      teamB: teamBPossession,
      anchorTime: Math.min(...chunk.map((p) => p.startAbs)),
      pairNet,
      cumulativeDiff,
    });
  }

  return { teams: [teamA, teamB], pairs };
}

function drawChart({ teams, pairs }) {
  const svg = d3.select("#possession-chart");
  const chartWrap = d3.select(".chart-wrap");
  chartWrap.style("position", "relative");
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
  const legendH = 16 + legendRows * 20 + runLegendHeight;
  const legendY = 20;
  const teamLabelY = legendY + legendH + 30;
  const topMargin = teamLabelY + 60;
  const pairGap = 28;
  const bottomMargin = 32;
  const chartHeight = topMargin + Math.max(1, pairs.length - 1) * pairGap + bottomMargin;

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

  // Team labels (placed below the legend)
  svg.append("text").attr("x", leftTeamCx).attr("y", teamLabelY).attr("text-anchor", "middle").attr("class", "team-label").text(teams[0]);
  svg.append("text").attr("x", rightTeamCx).attr("y", teamLabelY).attr("text-anchor", "middle").attr("class", "team-label").text(teams[1]);

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

  pairs.forEach((pair, pairIndex) => {
    const y = topMargin + pairIndex * pairGap;

    const pairMeta = `${teams[0]} ${formatTimeRange(pair.teamA)}  |  ${teams[1]} ${formatTimeRange(pair.teamB)}`;
    pairsGroup
      .append("text")
      .attr("x", metaX)
      .attr("y", y + 4)
      .attr("class", "pair-meta")
      .text(pairMeta);

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

  const diffPoints = pairs.map((pair, pairIndex) => ({
    pair,
    y: topMargin + pairIndex * pairGap,
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

    diffGroup
      .append("path")
      .datum(diffPoints)
      .attr("class", "diff-line")
      .attr("d", diffLine);
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
}

async function init() {
  try {
    const [raw, runData] = await Promise.all([
      d3.json(`./pbp_data.json?v=${DATA_VERSION}`),
      d3.json(`./run_data.json?v=${DATA_VERSION}`).catch(() => null),
    ]);
    if (!Array.isArray(raw)) throw new Error("pbp_data.json must be an array of possessions");
    const normalized = normalizePossessions(raw, runData);
    drawChart(normalized);
  } catch (error) {
    const container = document.querySelector(".chart-wrap");
    if (!container) return;
    container.innerHTML = `<p>Could not load possession data: ${error.message}</p>`;
    console.error(error);
  }
}

init();