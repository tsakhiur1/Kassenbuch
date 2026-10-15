// Small SVG charts for the dashboard. Thin marks, 4px rounded data ends, 2px gaps, hairline grid,
// one shared tooltip. Every value shown on hover is also in a table or a label next to the chart.
// Colours come from CSS tokens (--c-inc, --c-exp, --c-bal, --c-ctx), so light and dark just work.

import { esc } from "./util.js";

// On phones the chart is drawn narrower, so the axis text is not shrunk to a few pixels.
const chartWidth = () => (typeof innerWidth !== "undefined" && innerWidth < 600 ? 380 : 640);

const compact = (cent) => {
  const e = cent / 100, a = Math.abs(e);
  if (a >= 1e6) return (e / 1e6).toLocaleString("de-CH", { maximumFractionDigits: 1 }) + "M";
  if (a >= 1000) return (e / 1000).toLocaleString("de-CH", { maximumFractionDigits: 1 }) + "k";
  return String(Math.round(e));
};

// round numbers for the y axis: 0 / 1k / 2k ...
export function niceScale(min, max, ticks = 4) {
  if (max <= min) max = min + 100;
  const raw = (max - min) / ticks, e = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * e).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(v);
  return { lo, hi, ticks: out };
}

// column with a 4px rounded top, square at the baseline (works downwards for negative values)
function column(x, w, y0, y, r = 4) {
  const h = Math.abs(y0 - y); r = Math.min(r, w / 2, h);
  if (h < 0.5) return "";
  if (y <= y0) return `M${x},${y0}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y0}Z`;
  return `M${x},${y0}V${y - r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y - r}V${y0}Z`;
}

// tooltip rows travel as data attributes: "Titel" and "label|wert|farbe;..."
const tipAttr = (title, rows) => `data-tip-title="${esc(title)}" data-tip-rows="${esc(rows.map((r) => [r.label, r.value, r.color || ""].join("|")).join(";"))}"`;

/**
 * Grouped columns (one group per x position) with an optional line on the same axis.
 * groups: [{ label, title, values: { key: cent } , dim? }]; series: [{ key, label, color }]; line: { key, label, color }
 */
export function columnChart({ groups, series, line, height = 240, fmt, ariaLabel }) {
  const W = chartWidth(), H = height, L = 40, R = 8, T = 12, B = 26;
  const all = groups.flatMap((g) => [...series.map((s) => g.values[s.key] || 0), line ? g.values[line.key] ?? 0 : 0]);
  const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const ys = (v) => T + (H - T - B) * (sc.hi - v) / (sc.hi - sc.lo);
  const n = groups.length, cw = (W - L - R) / n;
  const bw = Math.min(24, (cw * 0.7 - (series.length - 1) * 2) / series.length);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
  for (const v of sc.ticks) svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="axis" x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  const pts = [];
  groups.forEach((g, i) => {
    const cx = L + cw * i + cw / 2, total = series.length * bw + (series.length - 1) * 2;
    svg += `<g class="col-group${g.dim ? " dim" : ""}">`;
    series.forEach((s, j) => {
      const x = cx - total / 2 + j * (bw + 2), v = g.values[s.key] || 0;
      svg += `<path d="${column(x, bw, ys(0), ys(v))}" fill="${s.color}"/>`;
    });
    svg += `</g><text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(g.label)}</text>`;
    if (line && g.values[line.key] != null) pts.push([cx, ys(g.values[line.key]), g.values[line.key]]);
  });
  if (line && pts.length > 1) svg += `<polyline class="ln" stroke="${line.color}" points="${pts.map((p) => p[0] + "," + p[1]).join(" ")}"/>`;
  if (line) pts.forEach((p) => { svg += `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="4" fill="${line.color}"/>`; });
  // hit areas: the whole column band, bigger than the marks; keyboard focus shows the same tooltip
  groups.forEach((g, i) => {
    const rows = series.map((s) => ({ label: s.label, value: fmt(g.values[s.key] || 0), color: s.color }));
    if (line && g.values[line.key] != null) rows.push({ label: line.label, value: fmt(g.values[line.key]), color: line.color });
    const drill = g.drill ? ` data-act="drill" data-v="${esc(g.drill)}" role="button" aria-label="${esc(`Buchungen ${g.title || g.label} anzeigen`)}"` : "";
    svg += `<rect class="hit${g.drill ? " link" : ""}" x="${L + cw * i}" y="${T}" width="${cw}" height="${H - T - B}" tabindex="0"${drill} ${tipAttr(g.title || g.label, rows)}><title>${esc(g.title || g.label)}</title></rect>`;
  });
  return svg + "</svg>";
}

/**
 * Lines over x positions on one axis, with a crosshair. series: [{ key, label, color, values: [cent|null], width? }]
 * xs: labels for each x; ticks: indexes to label on the x axis.
 */
export function lineChart({ xs, series, ticks, height = 220, fmt, ariaLabel, endLabels = true }) {
  const W = chartWidth(), H = height, L = 40, R = endLabels ? 44 : 10, T = 12, B = 26;
  const vals = series.flatMap((s) => s.values.filter((v) => v != null));
  const sc = niceScale(Math.min(0, ...vals), Math.max(0, ...vals));
  const n = xs.length, xAt = (i) => L + (n === 1 ? (W - L - R) / 2 : (W - L - R) * i / (n - 1));
  const ys = (v) => T + (H - T - B) * (sc.hi - v) / (sc.hi - sc.lo);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
  for (const v of sc.ticks) svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="axis" x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  for (const i of ticks) svg += `<text class="axis" x="${xAt(i)}" y="${H - 8}" text-anchor="middle">${esc(xs[i])}</text>`;
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : [xAt(i), ys(v)])).filter(Boolean);
    if (pts.length > 1) svg += `<polyline class="ln${s.context ? " ctx" : ""}" stroke="${s.color}" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    const last = pts[pts.length - 1], lastV = [...s.values].reverse().find((v) => v != null);
    if (last) {
      svg += `<circle class="dot" cx="${last[0]}" cy="${last[1]}" r="4" fill="${s.color}"/>`;
      if (endLabels && !s.context) svg += `<text class="end-label" x="${last[0] + 8}" y="${last[1] + 4}">${esc(fmtShort(lastV))}</text>`;
    }
  }
  // crosshair: one band per x, the hairline appears on hover/focus
  const bw = n > 1 ? (W - L - R) / (n - 1) : W - L - R;
  xs.forEach((x, i) => {
    const rows = series.filter((s) => s.values[i] != null).map((s) => ({ label: s.label, value: fmt(s.values[i]), color: s.color }));
    if (!rows.length) return;
    svg += `<g class="xhair"><line x1="${xAt(i)}" x2="${xAt(i)}" y1="${T}" y2="${H - B}"/><rect class="hit" x="${xAt(i) - bw / 2}" y="${T}" width="${bw}" height="${H - T - B}" tabindex="-1" ${tipAttr(x, rows)}/></g>`;
  });
  return svg + "</svg>";
}
const fmtShort = (cent) => compact(cent);

// 12-point sparkline in the context colour, the current point in the accent
export function sparkline(values, color = "var(--c-ctx)", accent = "var(--accent)") {
  const W = 120, H = 32, P = 4;
  const v = values.map((x) => x || 0), max = Math.max(...v, 1), min = Math.min(...v, 0);
  const xAt = (i) => P + (W - 2 * P) * i / Math.max(1, v.length - 1), yAt = (x) => H - P - (H - 2 * P) * (x - min) / (max - min || 1);
  const pts = v.map((x, i) => `${xAt(i)},${yAt(x)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" stroke="${color}"/><circle cx="${xAt(v.length - 1)}" cy="${yAt(v[v.length - 1])}" r="3" fill="${accent}"/></svg>`;
}

// One tooltip for the whole page. Text goes in with textContent: labels come from bank data.
let tip = null;
export function bindTooltips(root) {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip"; tip.setAttribute("role", "tooltip"); tip.hidden = true;
    document.body.appendChild(tip);
  }
  const show = (el, x, y) => {
    tip.replaceChildren();
    const h = document.createElement("div"); h.className = "tip-title"; h.textContent = el.dataset.tipTitle; tip.appendChild(h);
    for (const row of (el.dataset.tipRows || "").split(";").filter(Boolean)) {
      const [label, value, color] = row.split("|");
      const r = document.createElement("div"); r.className = "tip-row";
      const key = document.createElement("i"); if (color) key.style.background = color;
      const v = document.createElement("b"); v.textContent = value;
      const l = document.createElement("span"); l.textContent = label;
      r.append(key, v, l); tip.appendChild(r);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, x + 14)) + "px";
    tip.style.top = Math.max(8, y - th - 12 < 8 ? y + 18 : y - th - 12) + "px";
  };
  const hide = () => { tip.hidden = true; };
  root.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.("[data-tip-title]");
    if (el && root.contains(el)) show(el, e.clientX, e.clientY); else hide();
  });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-tip-title]"); if (!el) return;
    const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top + 10);
  });
  root.addEventListener("focusout", hide);
}
