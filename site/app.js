// Alberta Grid: renders data/latest.json and data/history.json.
// The pie chart and demand equation are ports of Kate Morley's PHP
// (classes/UI/PieChart.php and Equation.php, https://github.com/KateMorley/grid, CC0).
'use strict';

const LATEST_URL = 'data/latest.json';
const HISTORY_URL = 'data/history.json';
const REFRESH_LATEST_MS = 2 * 60 * 1000;
const REFRESH_HISTORY_MS = 10 * 60 * 1000;
const STALE_AFTER_MINUTES = 20;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Display order (also bottom-to-top stacking order in the history chart).
const ORDER = [
  'cogeneration', 'combined_cycle', 'simple_cycle', 'gas_fired_steam', 'dual_fuel', 'coal',
  'other', 'energy_storage', 'hydro', 'wind', 'solar',
];

const LABELS = {
  cogeneration: 'Cogeneration', combined_cycle: 'Combined cycle', simple_cycle: 'Simple cycle',
  gas_fired_steam: 'Gas-fired steam', dual_fuel: 'Dual fuel', coal: 'Coal', wind: 'Wind',
  solar: 'Solar', hydro: 'Hydro', other: 'Other', energy_storage: 'Energy storage',
};

// Typical direct (combustion) emissions, gCO2 per kWh generated.
const FACTORS = [
  ['cogeneration', 400, 'Cogeneration (gas; electricity share only)'],
  ['combined_cycle', 370, 'Combined cycle gas'],
  ['simple_cycle', 550, 'Simple cycle gas'],
  ['gas_fired_steam', 550, 'Gas-fired steam (converted coal units)'],
  ['dual_fuel', 600, 'Dual fuel'],
  ['coal', 1000, 'Coal'],
  ['wind', 0, 'Wind'],
  ['solar', 0, 'Solar'],
  ['hydro', 0, 'Hydro'],
  ['energy_storage', 0, 'Energy storage (counted where charged)'],
  ['other', 0, 'Other (mainly biomass; biogenic CO₂ not counted)'],
];
const FACTOR = Object.fromEntries(FACTORS.map(([key, value]) => [key, value]));

const KINDS = [
  { key: 'fossils', label: 'Fossil fuels' },
  { key: 'renewables', label: 'Renewables' },
  { key: 'others', label: 'Others' },
  { key: 'storage', label: 'Storage' },
];

let latest = null;
let history = null;

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, children = []) {
  const node = ['svg', 'path', 'rect', 'g', 'title'].includes(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  for (const child of [].concat(children)) {
    node.append(child);
  }
  return node;
}

function formatPower(mw) {
  const rounded = Math.round(mw);
  return (rounded < 0 ? '−' : '') + Math.abs(rounded).toLocaleString('en-CA');
}

function formatPercentage(fraction) {
  if (!Number.isFinite(fraction)) return '–';
  const value = (fraction * 100).toFixed(1);
  return value.startsWith('-') ? '−' + value.slice(1) : value;
}

function orderIndex(key) {
  const index = ORDER.indexOf(key);
  return index === -1 ? ORDER.length : index;
}

function kindOf(fuel) {
  if (fuel.key === 'energy_storage') return 'storage';
  if (fuel.category === 'renewable') return 'renewables';
  if (fuel.category === 'gas' || fuel.category === 'fossil') return 'fossils';
  return 'others';
}

// AESO publishes Alberta wall-clock times; the ISO string keeps that local
// time plus its UTC offset, so we display it directly rather than relying on
// the browser's time zone database.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseTime(iso) {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return { ms: Date.parse(iso), offsetMinutes };
}

// Wall-clock parts of an instant in a fixed UTC offset.
function wallClock(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60000);
  return {
    day: DAYS[d.getUTCDay()], date: d.getUTCDate(), month: MONTHS[d.getUTCMonth()],
    year: d.getUTCFullYear(), hour: d.getUTCHours(),
    time: String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'),
  };
}

// ---------------------------------------------------------------- derived values

function derive(data) {
  const fuels = [...data.generation].sort((a, b) => orderIndex(a.key) - orderIndex(b.key));
  const generation = data.summary.total_net_generation;
  const demand = data.summary.internal_load;
  const transfers = -data.summary.net_actual_interchange; // imports positive
  const positive = fuels.reduce((sum, f) => sum + Math.max(0, f.tng), 0);
  const emissions = fuels.reduce((sum, f) => sum + Math.max(0, f.tng) * (FACTOR[f.key] ?? 0), 0);
  const renewable = fuels.filter((f) => f.category === 'renewable')
    .reduce((sum, f) => sum + Math.max(0, f.tng), 0);
  return {
    fuels, generation, demand, transfers, positive,
    intensity: positive > 0 ? emissions / positive : NaN,
    renewableShare: positive > 0 ? renewable / positive : NaN,
  };
}

// ---------------------------------------------------------------- header & status

function renderTime() {
  if (!latest) return;
  const { ms, offsetMinutes } = parseTime(latest.updated);
  const t = wallClock(ms, offsetMinutes);
  const ageMinutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const age = ageMinutes < 1 ? 'just now' : ageMinutes === 1 ? '1 minute ago' : `${ageMinutes} minutes ago`;
  document.getElementById('asof').textContent =
    `As of ${t.time} on ${t.day} ${t.date} ${t.month} ${t.year} (Alberta time) · ${age}`;
  document.getElementById('status-time').textContent = t.time;

  const stale = document.getElementById('stale');
  if (ageMinutes > STALE_AFTER_MINUTES) {
    stale.textContent = `This data is ${ageMinutes} minutes old; updates may be delayed`;
    stale.hidden = false;
  } else {
    stale.hidden = true;
  }
}

function setValue(id, value, unit) {
  const dd = document.getElementById(id);
  dd.replaceChildren(value, el('abbr', { text: unit }));
}

function renderStatus(d) {
  setValue('status-emissions', Number.isFinite(d.intensity) ? String(Math.round(d.intensity)) : '–', 'g/kWh');
  setValue('status-renewables', formatPercentage(d.renewableShare), '%');
}

// Port of Equation.php: demand = generation ± transfers.
function renderEquation(d) {
  document.getElementById('equation').dataset.operator = d.transfers < 0 ? '−' : '+';
  setValue('eq-demand', formatPower(d.demand), 'MW');
  setValue('eq-generation', formatPower(d.generation), 'MW');
  setValue('eq-transfers', formatPower(Math.abs(d.transfers)), 'MW');
}

// ---------------------------------------------------------------- source tables

function sparkline(values, symmetric) {
  const svg = el('svg', { viewBox: '0 0 30 28', 'aria-hidden': 'true' });
  const points = values.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  if (points.length < 2) return svg;
  const n = values.length - 1;
  const max = Math.max(1, ...points.map(([, v]) => (symmetric ? Math.abs(v) : v)));
  const y = symmetric ? (v) => 14 - (v / max) * 11 : (v) => 25 - (Math.max(0, v) / max) * 22;
  const d = points.map(([i, v], j) => `${j ? 'L' : 'M'}${((i / n) * 28 + 1).toFixed(2)},${y(v).toFixed(2)}`).join('');
  svg.append(el('path', { d }));
  return svg;
}

function recentSeries(pick) {
  if (!history || !latest) return [];
  const end = parseTime(latest.updated).ms;
  return history.snapshots
    .filter((s) => { const t = Date.parse(s.t); return t > end - 864e5 && t <= end; })
    .map(pick);
}

function sourceTable(kind, title, total, share, rows, transfers) {
  const classes = transfers ? `${kind} transfers` : kind;
  const head = el('thead', {}, el('tr', {}, [
    el('th'), el('th', { text: title }),
    el('th', { text: formatPower(total) }), el('th', { text: formatPercentage(share) }),
  ]));
  const body = el('tbody', {}, rows.map((r) => el('tr', {}, [
    el('td', { class: r.key }, sparkline(r.spark, transfers)),
    el('td', {}, r.note ? [r.label, el('span', { class: 'dir', text: r.note })] : [r.label]),
    el('td', { text: formatPower(r.value) }),
    el('td', { text: formatPercentage(r.share) }),
  ])));
  return el('table', { class: classes }, [head, body]);
}

function renderSources(d) {
  const tables = [];
  for (const kind of KINDS) {
    const fuels = d.fuels.filter((f) => kindOf(f) === kind.key);
    if (!fuels.length) continue;
    const total = fuels.reduce((sum, f) => sum + f.tng, 0);
    const rows = fuels.map((f) => ({
      key: f.key, label: f.label || LABELS[f.key] || f.key, value: f.tng,
      share: f.tng / d.positive, spark: recentSeries((s) => s.gen?.[f.key]),
    }));
    tables.push(sourceTable(kind.key, kind.label, total, total / d.positive, rows, kind.key === 'storage'));
  }

  const paths = latest.interchange.map((p) => ({
    key: p.key, label: p.label, value: -p.flow, share: Math.abs(p.flow) / d.demand,
    note: p.flow > 0 ? 'export' : p.flow < 0 ? 'import' : '',
    spark: recentSeries((s) => (s.ic && Number.isFinite(s.ic[p.key]) ? -s.ic[p.key] : NaN)),
  }));
  tables.push(sourceTable('interconnectors', 'Interties', d.transfers, Math.abs(d.transfers) / d.demand, paths, true));

  document.getElementById('sources').replaceChildren(...tables);
}

// ---------------------------------------------------------------- pie chart (port of PieChart.php)

const OUTER_RADIUS = 0.75;
const INNER_RADIUS = 0.50;

function arcPoint(fraction, radius) {
  return `${(radius * Math.sin(fraction * 2 * Math.PI)).toFixed(4)},${(radius * -Math.cos(fraction * 2 * Math.PI)).toFixed(4)}`;
}

function arcPath(fraction, offset, inner, outer) {
  const f = Math.min(fraction, 0.99999); // a full circle needs a hair of gap
  const large = f < 0.5 ? 0 : 1;
  return `M${arcPoint(offset, outer)}A${outer},${outer} 0 ${large} 1 ${arcPoint(offset + f, outer)}`
    + `L${arcPoint(offset + f, inner)}A${inner},${inner} 0 ${large} 0 ${arcPoint(offset, inner)}z`;
}

function ring(items, total, inner, outer) {
  let offset = 0;
  const paths = [];
  for (const item of items) {
    if (item.power <= 0) continue;
    const fraction = item.power / total;
    const path = el('path', { class: item.key, d: arcPath(fraction, offset, inner, outer) });
    path.dataset.label = item.label;
    path.dataset.power = formatPower(item.power);
    path.dataset.percentage = formatPercentage(fraction);
    path.append(el('title', { text: `${item.label}: ${formatPower(item.power)} MW (${formatPercentage(fraction)}%)` }));
    paths.push(path);
    offset += fraction;
  }
  return paths;
}

function setPieCentre(label, swatchClass, power, percentage) {
  document.getElementById('pie-label').textContent = label;
  document.getElementById('pie-swatch').className = swatchClass;
  document.getElementById('pie-power').textContent = power;
  document.getElementById('pie-percentage').textContent = percentage;
}

function renderPie(d) {
  const svg = document.getElementById('pie-svg');
  const sources = d.fuels.map((f) => ({ key: f.key, label: f.label || LABELS[f.key], power: f.tng }));
  const kinds = ['fossils', 'renewables', 'others'].map((key) => ({
    key,
    label: KINDS.find((k) => k.key === key).label,
    power: d.fuels.filter((f) => (kindOf(f) === 'storage' ? 'others' : kindOf(f)) === key)
      .reduce((sum, f) => sum + Math.max(0, f.tng), 0),
  }));
  svg.replaceChildren(
    ...ring(sources, d.positive, OUTER_RADIUS, 1),
    ...ring(kinds, d.positive, INNER_RADIUS, OUTER_RADIUS),
  );

  const reset = () => {
    setPieCentre('Generation', 'generation', formatPower(d.generation), formatPercentage(d.generation / d.demand));
    svg.querySelectorAll('path').forEach((p) => p.classList.remove('dim'));
  };
  svg.onmouseover = (event) => {
    const path = event.target.closest('path');
    if (!path) return;
    setPieCentre(path.dataset.label, path.getAttribute('class').split(' ')[0],
      path.dataset.power, path.dataset.percentage);
    svg.querySelectorAll('path').forEach((p) => p.classList.toggle('dim', p !== path));
  };
  svg.onmouseleave = reset;
  reset();
}

// ---------------------------------------------------------------- past 24 hours

function niceStep(max) {
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * magnitude >= raw) return m * magnitude;
  }
  return 10 * magnitude;
}

function renderHistory() {
  const container = document.getElementById('history-graph');
  if (!history || !latest) return;

  const end = parseTime(latest.updated);
  const start = end.ms - 864e5;
  const snaps = history.snapshots
    .map((s) => ({ ...s, ms: Date.parse(s.t) }))
    .filter((s) => s.ms >= start && s.ms <= end.ms)
    .sort((a, b) => a.ms - b.ms);

  if (snaps.length < 2) {
    container.replaceChildren(el('p', { class: 'empty', text: 'The chart fills in as updates are collected (one every 5 minutes or so).' }));
    return;
  }

  const keys = [...new Set(snaps.flatMap((s) => Object.keys(s.gen)))]
    .filter((k) => snaps.some((s) => s.gen[k] > 0))
    .sort((a, b) => orderIndex(a) - orderIndex(b));
  const totals = snaps.map((s) => keys.reduce((sum, k) => sum + Math.max(0, s.gen[k] ?? 0), 0));
  const step = niceStep(Math.max(...totals));
  const top = Math.ceil(Math.max(...totals) / step) * step;

  const W = 1000;
  const H = 1000;
  const x = (ms) => ((ms - start) / 864e5) * W;
  const y = (mw) => H - (mw / top) * H;

  // Stacked areas, bottom to top.
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': 'Stacked generation by source over the past 24 hours' });
  const base = snaps.map(() => 0);
  for (const key of keys) {
    const lower = [...base];
    snaps.forEach((s, i) => { base[i] += Math.max(0, s.gen[key] ?? 0); });
    const upperLine = snaps.map((s, i) => `${x(s.ms).toFixed(1)},${y(base[i]).toFixed(1)}`);
    const lowerLine = snaps.map((s, i) => `${x(s.ms).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
    svg.append(el('path', { class: `area ${key}`, d: `M${upperLine.join('L')}L${lowerLine.join('L')}z` }));
  }

  // Hover targets: one column per snapshot.
  const tooltip = el('div', { class: 'tooltip', hidden: '' });
  snaps.forEach((s, i) => {
    const left = i === 0 ? x(s.ms) : (x(snaps[i - 1].ms) + x(s.ms)) / 2;
    const right = i === snaps.length - 1 ? x(s.ms) : (x(s.ms) + x(snaps[i + 1].ms)) / 2;
    const rect = el('rect', { x: left.toFixed(1), y: 0, width: Math.max(1, right - left).toFixed(1), height: H });
    rect.addEventListener('mouseenter', () => showTooltip(tooltip, svg, s, keys, totals[i], x(s.ms) / W, end.offsetMinutes));
    svg.append(rect);
  });
  svg.addEventListener('mouseleave', () => { tooltip.hidden = true; });

  // Y axis: label/line pairs from top to bottom (Kate Morley's graph layout).
  const yAxis = el('div');
  for (let v = top; v >= 0; v -= step) {
    yAxis.append(el('div', { text: v.toLocaleString('en-CA') }), el('div', v === 0 ? { class: 'axis' } : {}));
  }

  // X axis: every 6 hours on the Alberta clock.
  const xAxis = el('div', { class: 'x-axis' });
  const firstHour = Math.ceil(start / 36e5) * 36e5;
  for (let t = firstHour; t <= end.ms; t += 36e5) {
    const wall = wallClock(t, end.offsetMinutes);
    if (wall.hour % 6 !== 0) continue;
    const label = wall.hour === 0 ? `${wall.day} 00:00` : wall.time;
    xAxis.append(el('div', { text: label, style: `left:${((t - start) / 864e5 * 100).toFixed(2)}%` }));
  }

  const graph = el('div', { class: 'graph' }, [yAxis, xAxis, svg, tooltip]);
  graph.style.setProperty('--axis-width', '48px');
  const legend = el('ul', { class: 'legend' },
    [...keys].reverse().map((k) => el('li', { class: k }, el('span', { text: LABELS[k] || k }))));
  container.replaceChildren(graph, legend);
}

function showTooltip(tooltip, svg, snap, keys, total, position, offsetMinutes) {
  const wall = wallClock(snap.ms, offsetMinutes);
  const rows = [...keys].reverse()
    .filter((k) => (snap.gen[k] ?? 0) > 0)
    .map((k) => el('tr', {}, [
      el('td', { class: k }), el('td', { text: LABELS[k] || k }), el('td', { text: `${formatPower(snap.gen[k])} MW` }),
    ]));
  rows.push(el('tr', { class: 'total' }, [el('td'), el('td', { text: 'Total' }), el('td', { text: `${formatPower(total)} MW` })]));
  tooltip.replaceChildren(el('div', { text: `${wall.day} ${wall.time}` }), el('table', {}, rows));
  tooltip.hidden = false;

  const graphBox = tooltip.parentElement.getBoundingClientRect();
  const svgBox = svg.getBoundingClientRect();
  const px = svgBox.left - graphBox.left + position * svgBox.width;
  const width = tooltip.offsetWidth;
  tooltip.style.left = `${position < 0.5 ? px + 12 : px - width - 12}px`;
}

// ---------------------------------------------------------------- factors table

function renderFactors() {
  const body = document.querySelector('#factors tbody');
  body.replaceChildren(...FACTORS.map(([, value, label]) => el('tr', {}, [
    el('td', { text: label }), el('td', { text: String(value) }),
  ])));
  body.append(el('tr', {}, [el('td', { text: 'Imports' }), el('td', { text: 'not counted' })]));
}

// ---------------------------------------------------------------- loading

function render() {
  if (!latest) return;
  const d = derive(latest);
  renderTime();
  renderStatus(d);
  renderEquation(d);
  renderSources(d);
  renderPie(d);
  renderHistory();
}

async function getJSON(url) {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadLatest() {
  try {
    const data = await getJSON(LATEST_URL);
    if (!latest || data.updated !== latest.updated) {
      latest = data;
      render();
    }
  } catch (error) {
    console.warn('Could not load latest data', error);
    if (!latest) document.getElementById('asof').textContent = 'Could not load the latest data. Retrying…';
  }
}

async function loadHistory() {
  try {
    history = await getJSON(HISTORY_URL);
    render();
  } catch (error) {
    console.warn('Could not load history', error);
    if (!history) {
      document.getElementById('history-graph')
        .replaceChildren(el('p', { class: 'empty', text: 'History is not available yet.' }));
    }
  }
}

renderFactors();
loadLatest();
loadHistory();
setInterval(loadLatest, REFRESH_LATEST_MS);
setInterval(loadHistory, REFRESH_HISTORY_MS);
setInterval(renderTime, 30 * 1000);
