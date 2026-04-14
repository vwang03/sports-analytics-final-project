const EVENT_COLORS = {
  made_shot: "#3b7f17",
  def_rebound: "#4a90d9",
  turnover: "#e24a4a",
  other: "#575757",
};

const TICK_COLORS = {
  made_shot: "#3b7f17",
  missed_shot: "#7c7c7c",
  rebound: "#4a90d9",
  turnover: "#e24a4a",
  foul: "#f39c12",
  other: "#4f4f4f",
};

const HALF_SECONDS = 20 * 60;

function parseClockToRemainingSeconds(clock) {
  if (!clock || clock === "--") return null;
  const [m, s] = clock.split(":").map(Number);
  if (Number.isNaN(m) || Number.isNaN(s)) return null;
  return m * 60 + s;
}

function toAbsoluteElapsed(period, clock) {
  const remaining = parseClockToRemainingSeconds(clock);
  if (remaining === null) return null;
  const halfOffset = period === "2nd Half" ? HALF_SECONDS : 0;
  return halfOffset + (HALF_SECONDS - remaining);
}

function getPrimaryEventType(possession) {
  const events = possession.events || [];
  const eventTypes = events.map((event) => String(event.type || "").toUpperCase());

  if (eventTypes.some((eventType) => eventType.includes("TURNOVER"))) return "turnover";
  if (eventTypes.some((eventType) => eventType.includes("GOOD"))) return "made_shot";
  if (eventTypes.some((eventType) => eventType.includes("REBOUND DEF"))) return "def_rebound";
  return "other";
}

function isTickEvent(eventType) {
  const normalized = String(eventType || "").toUpperCase();
  if (normalized.includes("FOUL")) return true;
  if (normalized.includes("GOOD")) return true;
  if (normalized.includes("MISS")) return true;
  if (normalized.includes("TURNOVER")) return true;
  if (normalized.includes("REBOUND")) return true;
  return false;
}

function getTickEventCategory(eventType) {
  const normalized = String(eventType || "").toUpperCase();
  if (normalized.includes("TURNOVER")) return "turnover";
  if (normalized.includes("FOUL")) return "foul";
  if (normalized.includes("REBOUND")) return "rebound";
  if (normalized.includes("GOOD")) return "made_shot";
  if (normalized.includes("MISS")) return "missed_shot";
  return "other";
}

function formatTimeRange(possession) {
  if (!possession) return "--";
  const start = possession.startTime ?? "--";
  const end = possession.endTime ?? "--";
  return `${start}-${end}`;
}

function computeDurationSeconds(possession) {
  const startRemaining = parseClockToRemainingSeconds(possession.start_time);
  const endRemaining = parseClockToRemainingSeconds(possession.end_time);
  if (startRemaining === null) return 1;
  if (endRemaining === null) return 1;
  return Math.max(1, startRemaining - endRemaining);
}

function normalizePossessions(rawPossessions) {
  const teams = [...new Set(rawPossessions.map((d) => d.team).filter(Boolean))];
  const [teamA = "home", teamB = "away"] = teams;

  const possessions = rawPossessions.map((p, index) => {
    const startAbs = toAbsoluteElapsed(p.period, p.start_time);
    const endAbs = toAbsoluteElapsed(p.period, p.end_time);
    const duration = computeDurationSeconds(p);
    const primaryEvent = getPrimaryEventType(p);
    const outcomeColor = EVENT_COLORS[primaryEvent] || EVENT_COLORS.other;

    const tickEvents = (p.events || [])
      .filter((event) => isTickEvent(event.type))
      .map((event) => {
        const eventAbs = toAbsoluteElapsed(p.period, event.time);
        const tickCategory = getTickEventCategory(event.type);
        return {
          ...event,
          abs: eventAbs,
          tickColor: TICK_COLORS[tickCategory] || TICK_COLORS.other,
        };
      })
      .filter((event) => event.abs !== null);

    return {
      id: index + 1,
      team: p.team,
      period: p.period,
      startTime: p.start_time,
      endTime: p.end_time,
      startAbs: startAbs ?? 0,
      endAbs: endAbs ?? (startAbs ?? 0) + duration,
      duration,
      outcomeColor,
      tickEvents,
    };
  });

  const pairs = [];
  for (let i = 0; i < possessions.length; i += 2) {
    const chunk = possessions.slice(i, i + 2);
    pairs.push({
      pairId: pairs.length + 1,
      teamA: chunk.find((p) => p.team === teamA) || null,
      teamB: chunk.find((p) => p.team === teamB) || null,
      anchorTime: Math.min(...chunk.map((p) => p.startAbs)),
    });
  }

  return { teams: [teamA, teamB], pairs };
}

function drawChart({ teams, pairs }) {
  const svg = d3.select("#possession-chart");
  const width = 980;
  const pairGap = 30;
  const topMargin = 80;
  const bottomMargin = 140;
  const chartHeight = topMargin + Math.max(1, pairs.length - 1) * pairGap + bottomMargin;

  svg.attr("viewBox", `0 0 ${width} ${chartHeight}`);
  svg.selectAll("*").remove();

  const midX = width / 2;
  const centerGap = 20;
  const leftAnchorX = midX - centerGap;
  const rightAnchorX = midX + centerGap;
  const leftTeamCenter = 390;
  const rightTeamCenter = 590;
  const laneMaxWidth = 250;
  const laneHeight = 16;

  const maxDuration = d3.max(pairs.flatMap((pair) => [pair.teamA, pair.teamB]).filter(Boolean), (d) => d.duration) || 1;
  const barWidthScale = d3.scaleLinear().domain([1, maxDuration]).range([20, laneMaxWidth]);

  svg
    .append("text")
    .attr("x", leftTeamCenter)
    .attr("y", 32)
    .attr("text-anchor", "middle")
    .attr("class", "team-label")
    .text(teams[0]);

  svg
    .append("text")
    .attr("x", rightTeamCenter)
    .attr("y", 32)
    .attr("text-anchor", "middle")
    .attr("class", "team-label")
    .text(teams[1]);

  svg
    .append("line")
    .attr("class", "mid-divider")
    .attr("x1", midX)
    .attr("x2", midX)
    .attr("y1", 45)
    .attr("y2", chartHeight - bottomMargin + 18);

  const pairsGroup = svg.append("g").attr("class", "pairs");

  pairs.forEach((pair, pairIndex) => {
    const y = topMargin + pairIndex * pairGap;

    pairsGroup
      .append("text")
      .attr("x", 32)
      .attr("y", y + 1)
      .attr("class", "pair-label")
      .text(`pair ${pair.pairId}`);

    const pairMeta = `${teams[0]} ${formatTimeRange(pair.teamA)} | ${teams[1]} ${formatTimeRange(pair.teamB)}`;
    pairsGroup
      .append("text")
      .attr("x", 32)
      .attr("y", y + 12)
      .attr("class", "pair-meta")
      .text(pairMeta);

    [
      { possession: pair.teamA, side: "left" },
      { possession: pair.teamB, side: "right" },
    ].forEach(({ possession, side }) => {
      if (!possession) return;

      const barWidth = barWidthScale(possession.duration);
      const x = side === "left" ? leftAnchorX - barWidth : rightAnchorX;

      pairsGroup
        .append("rect")
        .attr("class", "lane-bg")
        .attr("x", x)
        .attr("y", y - laneHeight / 2)
        .attr("width", barWidth)
        .attr("height", laneHeight)
        .attr("rx", 5);

      const eventPositionScale = d3
        .scaleLinear()
        .domain([possession.startAbs, Math.max(possession.startAbs + 1, possession.endAbs)])
        .range(side === "left" ? [x, leftAnchorX] : [x, x + barWidth]);

      possession.tickEvents.forEach((tick) => {
        const tickX = eventPositionScale(tick.abs);
        pairsGroup
          .append("line")
          .attr("class", "event-tick")
          .attr("stroke", tick.tickColor)
          .attr("x1", tickX)
          .attr("x2", tickX)
          .attr("y1", y - laneHeight / 2 + 2)
          .attr("y2", y + laneHeight / 2 - 2);
      });

      const endTickX = eventPositionScale(possession.endAbs);
      pairsGroup
        .append("line")
        .attr("class", "event-tick")
        .attr("stroke", possession.outcomeColor)
        .attr("x1", endTickX)
        .attr("x2", endTickX)
        .attr("y1", y - laneHeight / 2 + 2)
        .attr("y2", y + laneHeight / 2 - 2);
    });
  });

  const tickLegend = [
    { label: "made shot", color: TICK_COLORS.made_shot },
    { label: "missed shot", color: TICK_COLORS.missed_shot },
    { label: "rebound", color: TICK_COLORS.rebound },
    { label: "turnover", color: TICK_COLORS.turnover },
    { label: "foul", color: TICK_COLORS.foul },
    { label: "other", color: TICK_COLORS.other },
  ];

  const legendBaseX = 28;
  const tickTitleY = chartHeight - 118;
  const tickRow1Y = chartHeight - 94;
  const tickRow2Y = chartHeight - 66;
  const itemSpacingTick = 118;

  svg
    .append("text")
    .attr("class", "legend-heading")
    .attr("x", legendBaseX)
    .attr("y", tickTitleY)
    .text("Tick colors (sub-events; tick at possession end = outcome)");

  tickLegend.slice(0, 3).forEach((item, index) => {
    const itemX = legendBaseX + index * itemSpacingTick;
    const g = svg.append("g").attr("class", "legend-item");
    g.append("line")
      .attr("class", "legend-tick-swatch")
      .attr("stroke", item.color)
      .attr("x1", itemX + 3)
      .attr("x2", itemX + 3)
      .attr("y1", tickRow1Y - 9)
      .attr("y2", tickRow1Y + 3);
    g.append("text").attr("class", "legend-label").attr("x", itemX + 12).attr("y", tickRow1Y).text(item.label);
  });

  tickLegend.slice(3).forEach((item, index) => {
    const itemX = legendBaseX + index * itemSpacingTick;
    const g = svg.append("g").attr("class", "legend-item");
    g.append("line")
      .attr("class", "legend-tick-swatch")
      .attr("stroke", item.color)
      .attr("x1", itemX + 3)
      .attr("x2", itemX + 3)
      .attr("y1", tickRow2Y - 9)
      .attr("y2", tickRow2Y + 3);
    g.append("text").attr("class", "legend-label").attr("x", itemX + 12).attr("y", tickRow2Y).text(item.label);
  });

  svg
    .append("text")
    .attr("class", "footnote")
    .attr("x", width / 2)
    .attr("y", chartHeight - 22)
    .attr("text-anchor", "middle")
    .text(
      "Bar width = possession duration · y-position = pair order · thick ticks = events; end-of-possession tick uses outcome color (made shot, def. rebound, turnover, other)"
    );
}

async function init() {
  try {
    const raw = await d3.json("./pbp_data.json");
    if (!Array.isArray(raw)) throw new Error("pbp_data.json must be an array of possessions");
    const normalized = normalizePossessions(raw);
    drawChart(normalized);
  } catch (error) {
    const container = document.querySelector(".chart-wrap");
    if (!container) return;
    container.innerHTML = `<p>Could not load possession data: ${error.message}</p>`;
    // Keep this logged for local debugging.
    console.error(error);
  }
}

init();
