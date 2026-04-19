const TICK_COLORS = {
  made_shot: "#3b8a1f",
  missed_shot: "#aaa",
  def_rebound: "#3a42d4",
  off_rebound: "#3a92d4",
  turnover: "#d94040",
  foul: "#e8960f",
  steal: "#7c3aed",
  block: "#0f766e",
  assist: "#2563eb",
  timeout: "#b45309",
  other: "#000000",
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

function normalizePossessions(rawPossessions) {
  const teams = [...new Set(rawPossessions.map((d) => d.team).filter(Boolean))];
  const [teamA = "home", teamB = "away"] = teams;

  const possessions = rawPossessions.map((p, index) => {
    const startAbs = toAbsoluteElapsed(p.period, p.start_time);
    const endAbs = toAbsoluteElapsed(p.period, p.end_time);
    const duration = computeDurationSeconds(p);

    let previousEventAbs = startAbs ?? null;
    const tickEvents = (p.events || []).map((event) => {
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
      id: index + 1,
      team: p.team,
      period: p.period,
      startTime: p.start_time,
      endTime: p.end_time,
      startAbs: startAbs ?? 0,
      endAbs: endAbs ?? (startAbs ?? 0) + duration,
      duration,
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
  const tickLegend = [
    { label: "made shot", color: TICK_COLORS.made_shot },
    { label: "missed shot", color: TICK_COLORS.missed_shot },
    { label: "defensive rebound", color: TICK_COLORS.def_rebound },
    { label: "offensive rebound", color: TICK_COLORS.off_rebound },
    { label: "turnover", color: TICK_COLORS.turnover },
    { label: "foul", color: TICK_COLORS.foul },
    { label: "steal", color: TICK_COLORS.steal },
    { label: "block", color: TICK_COLORS.block },
    { label: "assist", color: TICK_COLORS.assist },
    { label: "timeout", color: TICK_COLORS.timeout },
    { label: "other", color: TICK_COLORS.other },
  ];
  const legendCols = 5;
  const legendRows = Math.ceil(tickLegend.length / legendCols);
  const legendH = 16 + legendRows * 20;
  const topMargin = 90 + legendH;
  const pairGap = 28;
  const bottomMargin = 32;
  const chartHeight = topMargin + Math.max(1, pairs.length - 1) * pairGap + bottomMargin;

  svg.attr("viewBox", `0 0 ${width} ${chartHeight}`);
  svg.selectAll("*").remove();

  const midX = width / 2;
  const laneMaxWidth = 300;
  const laneHeight = 20;
  const leftAnchorX = midX - 8;
  const rightAnchorX = midX + 8;
  const leftTeamCx = midX - 140;
  const rightTeamCx = midX + 140;
  const metaX = 28;

  const maxDuration =
    d3.max(pairs.flatMap((pair) => [pair.teamA, pair.teamB]).filter(Boolean), (d) => d.duration) || 1;
  const barWidthScale = d3.scaleLinear().domain([1, maxDuration]).range([28, laneMaxWidth]);

  // Team labels
  svg.append("text").attr("x", leftTeamCx).attr("y", 30).attr("text-anchor", "middle").attr("class", "team-label").text(teams[0]);
  svg.append("text").attr("x", rightTeamCx).attr("y", 30).attr("text-anchor", "middle").attr("class", "team-label").text(teams[1]);

  // Center divider
  svg.append("line").attr("class", "mid-divider")
    .attr("x1", midX).attr("x2", midX)
    .attr("y1", 58 + legendH).attr("y2", chartHeight - bottomMargin + 10);

  // Legend
  const legendY = 60;
  svg.append("rect")
    .attr("x", metaX - 4).attr("y", legendY - 4)
    .attr("width", width - metaX * 2 + 8).attr("height", legendH)
    .attr("rx", 6).attr("fill", "none")
    .attr("stroke", "#e0e0e0").attr("stroke-width", 0.5);

  svg.append("text").attr("class", "legend-heading")
    .attr("x", metaX + 4).attr("y", legendY + 20).text("Event key");

  const colW = 128;
  tickLegend.forEach((item, i) => {
    const col = i % legendCols;
    const row = Math.floor(i / legendCols);
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

  svg.append("line").attr("class", "section-rule")
    .attr("x1", metaX).attr("x2", width - metaX)
    .attr("y1", legendY + legendH - 2).attr("y2", legendY + legendH - 2);

  // Pair rows
  const pairsGroup = svg.append("g").attr("class", "pairs");

  pairs.forEach((pair, pairIndex) => {
    const y = topMargin + pairIndex * pairGap;

    pairsGroup
      .append("text")
      .attr("x", metaX)
      .attr("y", y + 2)
      .attr("class", "pair-label")
      .text(`#${pair.pairId}`);

    const pairMeta = `${teams[0]} ${formatTimeRange(pair.teamA)}  |  ${teams[1]} ${formatTimeRange(pair.teamB)}`;
    pairsGroup
      .append("text")
      .attr("x", metaX)
      .attr("y", y + 13)
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
        .attr("height", laneHeight);

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
    console.error(error);
  }
}

init();