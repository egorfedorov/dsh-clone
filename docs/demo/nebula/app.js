(function () {
  var host = document.getElementById("latency-chart");
  if (!host) return;

  var W = 584;
  var H = 213;
  var plot = { left: 22, right: 576, top: 6, bottom: 178 };
  var maxMs = 600;

  var series = [
    {
      name: "p99",
      color: "#a78bfa",
      values: [8, 65, 14, 138, 197, 169, 348, 314, 434, 521, 421, 341, 266, 203, 166]
    },
    {
      name: "p95",
      color: "#22d3ee",
      values: [4, 50, 6, 124, 166, 155, 305, 265, 390, 452, 355, 295, 220, 166, 120]
    },
    {
      name: "p50",
      color: "#34d399",
      values: [2, 38, 4, 95, 125, 118, 228, 200, 293, 332, 268, 226, 170, 128, 95]
    }
  ];

  function xAt(i, n) {
    return plot.left + (i * (plot.right - plot.left)) / (n - 1);
  }

  function yAt(ms) {
    var ratio = Math.max(0, Math.min(1, ms / maxMs));
    return plot.bottom - ratio * (plot.bottom - plot.top);
  }

  function points(values) {
    return values.map(function (ms, i) {
      return [xAt(i, values.length), yAt(ms)];
    });
  }

  function lineD(pts) {
    return pts
      .map(function (p, i) {
        return (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1);
      })
      .join(" ");
  }

  function areaD(pts) {
    return (
      "M" + pts[0][0].toFixed(1) + " " + plot.bottom +
      pts.map(function (p) { return " L" + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("") +
      " L" + pts[pts.length - 1][0].toFixed(1) + " " + plot.bottom + " Z"
    );
  }

  var grid = "";
  [600, 450, 300, 150, 0].forEach(function (ms) {
    var y = yAt(ms);
    grid +=
      '<line x1="' + (plot.left + 10) + '" y1="' + y.toFixed(1) + '" x2="' + plot.right + '" y2="' + y.toFixed(1) +
      '" stroke="#243049" stroke-width="1" opacity="' + (ms === 0 ? ".75" : ".55") + '"/>' +
      '<text x="0" y="' + (y + 3).toFixed(1) + '" text-anchor="start">' + ms + "ms</text>";
  });

  var ticks = "";
  ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"].forEach(function (label, i) {
    var x = plot.left + (i * (plot.right - plot.left)) / 5;
    var anchor = i === 0 ? "start" : i === 5 ? "end" : "middle";
    ticks += '<text x="' + x.toFixed(1) + '" y="202" text-anchor="' + anchor + '">' + label + "</text>";
  });

  var paths = "";
  var area = areaD(points(series[2].values));
  paths +=
    '<defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#22d3ee" stop-opacity=".26"/>' +
    '<stop offset=".65" stop-color="#22d3ee" stop-opacity=".10"/>' +
    '<stop offset="1" stop-color="#22d3ee" stop-opacity=".02"/>' +
    "</linearGradient></defs>" +
    '<path d="' + area + '" fill="url(#area-fill)"/>';

  series.forEach(function (s) {
    paths +=
      '<path d="' + lineD(points(s.values)) + '" fill="none" stroke="' + s.color +
      '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>';
  });

  host.innerHTML =
    '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="100%" role="presentation" aria-hidden="true">' +
    grid +
    paths +
    ticks +
    "</svg>";
})();
