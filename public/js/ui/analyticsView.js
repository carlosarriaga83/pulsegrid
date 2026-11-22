import api from '../api.js';
import { showToast } from './toast.js';

const PALETTE = [
  '#38bdf8', // sky-400
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#a78bfa', // violet-400
  '#fb7185', // rose-400
  '#2dd4bf', // teal-400
  '#f97316', // orange-500
];

// Plugin custom de Chart.js para dibujar línea vertical guía (Crosshair) sincronizada con el cursor
const crosshairPlugin = {
  id: 'pulsegridCrosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (active.length === 0) return;

    const x = active[0].element?.x;
    if (x === undefined || Number.isNaN(x)) return;

    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.stroke();
    ctx.restore();
  },
};

const VISITOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const VISITOR_LOCALE = navigator.language || 'es';

let chartInstance = null;
let availableSeries = [];
let groupedDevices = []; // [{ deviceId, deviceName, room, category, isOnline, totalRecords, params: [...] }]
let activeDeviceId = null;
let selectedKeys = [];
let currentRange = '24h';
let interactionMode = 'zoom'; // 'zoom' (drag-to-zoom, shift+drag pan) | 'pan' (drag-to-pan)
let pickerVisible = true;

function getVisitorRangeBounds() {
  const now = new Date();
  if (currentRange === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { fromDate: start, toDate: end };
  }
  if (currentRange === 'custom') {
    const fromVal = document.getElementById('analytics-from')?.value;
    const toVal = document.getElementById('analytics-to')?.value;
    const f = fromVal ? new Date(fromVal) : new Date(now.getTime() - 24 * 3600 * 1000);
    const t = toVal ? new Date(toVal) : now;
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f < t) {
      return { fromDate: f, toDate: t };
    }
  }
  const hoursMap = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
  const hours = hoursMap[currentRange] || 24;
  return {
    fromDate: new Date(now.getTime() - hours * 3600 * 1000),
    toDate: now,
  };
}

function formatVisitorDateTime(ms) {
  try {
    return new Intl.DateTimeFormat(VISITOR_LOCALE, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: VISITOR_TZ,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

const pickerFilters = {
  deviceQuery: '',
  dpQuery: '',
  onlyOnline: false,
  onlyWithData: false,
};

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setResetButtonState(zoomed) {
  const btn = document.getElementById('btn-reset-zoom');
  if (!btn) return;
  btn.disabled = !zoomed;
  if (zoomed) {
    btn.className =
      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold shadow-md shadow-sky-500/20 transition';
  } else {
    btn.className =
      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-slate-500 border border-slate-800 text-xs font-medium cursor-not-allowed transition';
  }
}

function updateModeButtons() {
  const zoomBtn = document.getElementById('btn-mode-zoom');
  const panBtn = document.getElementById('btn-mode-pan');
  if (!zoomBtn || !panBtn) return;

  const activeCls = 'px-2.5 py-1 rounded-md text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40';
  const idleCls = 'px-2.5 py-1 rounded-md text-xs font-medium text-slate-400 hover:text-slate-200 border border-transparent';

  zoomBtn.className = interactionMode === 'zoom' ? activeCls : idleCls;
  panBtn.className = interactionMode === 'pan' ? activeCls : idleCls;

  if (chartInstance) {
    chartInstance.options.plugins.zoom.zoom.drag.enabled = interactionMode === 'zoom';
    chartInstance.options.plugins.zoom.pan.enabled = true;
    chartInstance.options.plugins.zoom.pan.modifierKey = interactionMode === 'zoom' ? 'shift' : null;
    chartInstance.update('none');
  }
}

function buildGroupedDevices() {
  const map = new Map();
  for (const item of availableSeries) {
    if (!map.has(item.deviceId)) {
      map.set(item.deviceId, {
        deviceId: item.deviceId,
        deviceName: item.deviceName,
        room: item.room || '',
        category: item.category || '',
        isOnline: Boolean(item.isOnline),
        totalRecords: 0,
        params: [],
      });
    }
    const dev = map.get(item.deviceId);
    dev.totalRecords += Number(item.recordCount || 0);
    dev.params.push(item);
  }

  groupedDevices = Array.from(map.values()).sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.totalRecords !== b.totalRecords) return b.totalRecords - a.totalRecords;
    return a.deviceName.localeCompare(b.deviceName);
  });

  if (!activeDeviceId || !map.has(activeDeviceId)) {
    activeDeviceId = groupedDevices[0]?.deviceId || null;
  }
}

function toggleSeriesKey(key) {
  if (selectedKeys.includes(key)) {
    selectedKeys = selectedKeys.filter((k) => k !== key);
  } else {
    if (selectedKeys.length >= 6) {
      showToast('Puedes comparar hasta 6 series simultáneamente', 'warning');
      return;
    }
    selectedKeys.push(key);
  }
  renderActiveSeriesBar();
  renderDeviceList();
  renderDpList();
  loadHistoryChart();
}

function renderActiveSeriesBar() {
  const wrap = document.getElementById('analytics-active-series');
  const countEl = document.getElementById('analytics-selected-count');
  const clearBtn = document.getElementById('btn-clear-series');
  if (!wrap) return;

  if (countEl) countEl.textContent = `${selectedKeys.length}/6`;
  clearBtn?.classList.toggle('hidden', selectedKeys.length === 0);

  if (selectedKeys.length === 0) {
    wrap.innerHTML =
      '<span class="text-xs text-slate-500 italic">Ninguna serie seleccionada. Elige un dispositivo y marca uno o más parámetros abajo.</span>';
    return;
  }

  const seriesMap = new Map(availableSeries.map((s) => [`${s.deviceId}:${s.dpCode}`, s]));

  wrap.innerHTML = selectedKeys
    .map((key, idx) => {
      const s = seriesMap.get(key);
      const color = PALETTE[idx % PALETTE.length];
      const label = s ? `${s.deviceName} · ${s.dpLabel}` : key;
      return `
        <span class="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-full text-xs bg-slate-800/90 text-slate-100 border border-slate-700">
          <span class="h-2 w-2 rounded-full flex-shrink-0" style="background:${color}"></span>
          <span class="truncate max-w-[220px]">${esc(label)}</span>
          <button type="button" data-remove-series="${esc(key)}" title="Quitar serie" class="h-4 w-4 rounded-full hover:bg-slate-700 text-slate-400 hover:text-slate-100 inline-flex items-center justify-center leading-none">&times;</button>
        </span>
      `;
    })
    .join('');

  wrap.querySelectorAll('[data-remove-series]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSeriesKey(btn.dataset.removeSeries));
  });
}

function renderDeviceList() {
  const container = document.getElementById('analytics-device-list');
  if (!container) return;

  const q = pickerFilters.deviceQuery.trim().toLowerCase();
  const filtered = groupedDevices.filter((d) => {
    if (pickerFilters.onlyOnline && !d.isOnline) return false;
    if (pickerFilters.onlyWithData && d.totalRecords === 0) return false;
    if (q) {
      const hay = `${d.deviceName} ${d.room} ${d.category} ${d.deviceId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 italic py-3 text-center">No se encontraron dispositivos con este filtro.</p>';
    return;
  }

  if (!filtered.some((d) => d.deviceId === activeDeviceId)) {
    activeDeviceId = filtered[0].deviceId;
    renderDpList();
  }

  container.innerHTML = filtered
    .map((d) => {
      const isSelectedDev = d.deviceId === activeDeviceId;
      const selectedCount = selectedKeys.filter((k) => k.startsWith(`${d.deviceId}:`)).length;

      return `
        <button
          type="button"
          data-pick-device="${esc(d.deviceId)}"
          class="w-full text-left px-2.5 py-2 rounded-lg border transition flex items-center justify-between gap-2 ${
            isSelectedDev
              ? 'bg-sky-500/15 border-sky-500/40 text-slate-100'
              : 'bg-slate-900/60 border-transparent hover:bg-slate-900 hover:border-slate-800 text-slate-300'
          }"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="h-2 w-2 rounded-full flex-shrink-0 ${d.isOnline ? 'bg-emerald-400' : 'bg-rose-500/80'}"></span>
            <div class="min-w-0">
              <div class="text-xs font-medium truncate">${esc(d.deviceName)}</div>
              <div class="text-[10px] text-slate-500 truncate">${esc(d.room || d.category)} · ${d.params.length} parám.</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${
              selectedCount > 0
                ? `<span class="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/25 text-sky-300">${selectedCount}</span>`
                : ''
            }
            ${
              d.totalRecords > 0
                ? `<span class="h-1.5 w-1.5 rounded-full bg-emerald-400/70" title="Tiene historial guardado"></span>`
                : ''
            }
          </div>
        </button>
      `;
    })
    .join('');

  container.querySelectorAll('[data-pick-device]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDeviceId = btn.dataset.pickDevice;
      renderDeviceList();
      renderDpList();
    });
  });
}

function renderDpList() {
  const container = document.getElementById('analytics-dp-list');
  const headerEl = document.getElementById('analytics-dp-header');
  const countEl = document.getElementById('analytics-dp-count');
  if (!container) return;

  const dev = groupedDevices.find((d) => d.deviceId === activeDeviceId);
  if (!dev) {
    if (headerEl) headerEl.textContent = '2. Parámetros disponibles';
    if (countEl) countEl.textContent = '0';
    container.innerHTML = '<p class="text-xs text-slate-500 italic py-4 text-center">Selecciona un dispositivo en la lista izquierda.</p>';
    return;
  }

  if (headerEl) headerEl.textContent = `2. Parámetros de ${dev.deviceName}`;

  const q = pickerFilters.dpQuery.trim().toLowerCase();
  const params = dev.params.filter((p) => {
    if (!q) return true;
    return `${p.dpLabel} ${p.dpCode} ${p.unit}`.toLowerCase().includes(q);
  });

  if (countEl) countEl.textContent = `${params.length} disponibles`;

  if (params.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 italic py-4 text-center">Sin parámetros que coincidan con el filtro.</p>';
    return;
  }

  const numericParams = params.filter((p) => p.valueType !== 'boolean');
  const boolParams = params.filter((p) => p.valueType === 'boolean');

  const renderGroup = (title, items) => {
    if (items.length === 0) return '';
    return `
      <div>
        <p class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">${title}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          ${items
            .map((p) => {
              const key = `${p.deviceId}:${p.dpCode}`;
              const selIdx = selectedKeys.indexOf(key);
              const isSelected = selIdx !== -1;
              const color = isSelected ? PALETTE[selIdx % PALETTE.length] : null;
              const liveTxt =
                p.currentValue !== null && p.currentValue !== undefined
                  ? `${p.currentValue}${p.unit ? ` ${p.unit}` : ''}`
                  : '—';

              return `
                <button
                  type="button"
                  data-toggle-dp="${esc(key)}"
                  class="text-left px-2.5 py-2 rounded-lg border transition flex items-center justify-between gap-2 ${
                    isSelected
                      ? 'bg-slate-800/90 border-slate-600 text-slate-100'
                      : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700 text-slate-300'
                  }"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="h-3.5 w-3.5 rounded flex-shrink-0 border flex items-center justify-center text-[10px] font-bold"
                      style="${isSelected ? `background:${color};border-color:${color};color:#020617;` : 'border-color:#475569;'}">
                      ${isSelected ? '✓' : ''}
                    </span>
                    <div class="min-w-0">
                      <div class="text-xs font-medium truncate">${esc(p.dpLabel)}</div>
                      <div class="text-[10px] font-mono text-slate-500 truncate">${esc(p.dpCode)}</div>
                    </div>
                  </div>
                  <div class="text-right flex-shrink-0">
                    <div class="text-[11px] font-mono font-semibold text-slate-200">${esc(liveTxt)}</div>
                    <div class="text-[10px] ${p.recordCount > 0 ? 'text-emerald-400' : 'text-slate-500'}">
                      ${p.recordCount > 0 ? `${p.recordCount} pts` : 'Sin historial'}
                    </div>
                  </div>
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  };

  container.innerHTML =
    renderGroup('Métricas numéricas (línea continua)', numericParams) +
    renderGroup('Estados ON / OFF (gráfica escalonada)', boolParams);

  container.querySelectorAll('[data-toggle-dp]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSeriesKey(btn.dataset.toggleDp));
  });
}

function renderStatsCards(seriesList) {
  const container = document.getElementById('analytics-stats');
  if (!container) return;

  if (!seriesList || seriesList.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = seriesList
    .map((s, idx) => {
      const color = PALETTE[idx % PALETTE.length];
      const u = s.unit ? ` ${s.unit}` : '';
      const minTxt = s.stats.min !== null ? (s.stepped ? (s.stats.min ? 'ON' : 'OFF') : `${s.stats.min}${u}`) : '—';
      const avgTxt = s.stats.avg !== null ? (s.stepped ? `${Math.round(s.stats.avg * 100)}% ON` : `${s.stats.avg}${u}`) : '—';
      const maxTxt = s.stats.max !== null ? (s.stepped ? (s.stats.max ? 'ON' : 'OFF') : `${s.stats.max}${u}`) : '—';

      return `
        <div class="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5">
          <div class="flex items-center gap-2 mb-2">
            <span class="h-2.5 w-2.5 rounded-full" style="background:${color}"></span>
            <span class="text-xs font-semibold text-slate-200 truncate">${esc(s.deviceName)} · ${esc(s.dpLabel)}</span>
          </div>
          <div class="grid grid-cols-4 gap-2 text-[11px]">
            <div><span class="block text-slate-500">Mín</span><strong class="text-slate-200 font-mono">${esc(minTxt)}</strong></div>
            <div><span class="block text-slate-500">Prom</span><strong class="text-sky-300 font-mono">${esc(avgTxt)}</strong></div>
            <div><span class="block text-slate-500">Máx</span><strong class="text-slate-200 font-mono">${esc(maxTxt)}</strong></div>
            <div><span class="block text-slate-500">Puntos</span><strong class="text-slate-300 font-mono">${s.totalRecords}</strong></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderChart(seriesList, bounds) {
  const canvas = document.getElementById('telemetry-chart');
  const emptyOverlay = document.getElementById('chart-empty-overlay');
  if (!canvas || !window.Chart) return;

  const { fromDate, toDate } = bounds || getVisitorRangeBounds();
  const xMin = fromDate.getTime();
  const xMax = toDate.getTime();

  const totalPoints = seriesList.reduce((acc, s) => acc + s.points.length, 0);
  emptyOverlay?.classList.toggle('hidden', totalPoints > 0);

  const hasNumeric = seriesList.some((s) => !s.stepped);
  const hasBoolean = seriesList.some((s) => s.stepped);

  const datasets = seriesList.map((s, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    return {
      label: `${s.deviceName} · ${s.dpLabel}${s.unit ? ` (${s.unit})` : ''}`,
      data: s.points.map((p) => ({ x: p.x, y: p.y })),
      borderColor: color,
      backgroundColor: `${color}22`,
      borderWidth: 2,
      pointRadius: s.points.length > 150 ? 0 : 2.5,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: color,
      tension: s.stepped ? 0 : 0.25,
      stepped: s.stepped ? 'before' : false,
      fill: s.stepped ? 'origin' : false,
      yAxisID: s.stepped && hasNumeric ? 'yBool' : 'y',
      metaUnit: s.unit || '',
      metaStepped: s.stepped,
    };
  });

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  setResetButtonState(false);

  const scales = {
    x: {
      type: 'time',
      min: xMin,
      max: xMax,
      time: {
        displayFormats: {
          minute: 'HH:mm',
          hour: currentRange === 'today' ? 'HH:mm' : 'dd/MM HH:mm',
          day: 'dd MMM',
        },
      },
      grid: { color: 'rgba(51, 65, 85, 0.35)' },
      ticks: { color: '#94a3b8', maxRotation: 0, autoSkipPadding: 18, font: { size: 11 } },
    },
    y: {
      type: 'linear',
      position: 'left',
      grid: { color: 'rgba(51, 65, 85, 0.35)' },
      ticks: {
        color: '#94a3b8',
        font: { size: 11 },
        callback: (val) => {
          if (!hasNumeric && hasBoolean) return val === 1 ? 'ON' : val === 0 ? 'OFF' : '';
          return val;
        },
      },
      ...(!hasNumeric && hasBoolean ? { min: -0.1, max: 1.15 } : {}),
    },
  };

  if (hasNumeric && hasBoolean) {
    scales.yBool = {
      type: 'linear',
      position: 'right',
      min: -0.1,
      max: 1.2,
      grid: { drawOnChartArea: false },
      ticks: {
        stepSize: 1,
        color: '#10b981',
        font: { size: 11 },
        callback: (val) => (val === 1 ? 'ON' : val === 0 ? 'OFF' : ''),
      },
    };
  }

  chartInstance = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: {
        mode: 'index',
        intersect: false,
        axis: 'x',
      },
      scales,
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { color: '#cbd5e1', usePointStyle: true, boxWidth: 8, font: { size: 11 } },
        },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(2, 6, 23, 0.94)',
          borderColor: 'rgba(56, 189, 248, 0.35)',
          borderWidth: 1,
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          padding: 10,
          cornerRadius: 10,
          callbacks: {
            title(items) {
              const x = items?.[0]?.parsed?.x;
              return x !== undefined ? formatVisitorDateTime(x) : '';
            },
            label(ctx) {
              const ds = ctx.dataset;
              const y = ctx.parsed.y;
              if (ds.metaStepped) {
                return ` ${ds.label}: ${y >= 0.5 ? 'ENCENDIDO (ON)' : 'APAGADO (OFF)'}`;
              }
              return ` ${ds.label}: ${y}${ds.metaUnit ? ` ${ds.metaUnit}` : ''}`;
            },
          },
        },
        zoom: {
          limits: {
            x: { min: xMin, max: xMax, minRange: 60 * 1000 },
          },
          pan: {
            enabled: true,
            mode: 'x',
            modifierKey: interactionMode === 'zoom' ? 'shift' : null,
            onPanComplete: () => setResetButtonState(true),
          },
          zoom: {
            wheel: { enabled: true, speed: 0.1 },
            pinch: { enabled: true },
            drag: {
              enabled: interactionMode === 'zoom',
              backgroundColor: 'rgba(56, 189, 248, 0.18)',
              borderColor: 'rgba(56, 189, 248, 0.8)',
              borderWidth: 1,
              threshold: 8,
            },
            mode: 'x',
            onZoomComplete: () => setResetButtonState(true),
          },
        },
      },
    },
  });
}

export async function loadHistoryChart() {
  const bounds = getVisitorRangeBounds();

  if (selectedKeys.length === 0) {
    renderStatsCards([]);
    renderChart([], bounds);
    return;
  }

  try {
    const res = await api.getTelemetryHistory({
      series: selectedKeys,
      range: 'custom',
      from: bounds.fromDate.toISOString(),
      to: bounds.toDate.toISOString(),
    });

    const list = res.data?.series || [];
    renderStatsCards(list);
    renderChart(list, bounds);
  } catch (err) {
    showToast(`Error cargando historial: ${err.message}`, 'error');
  }
}

export async function refreshAvailableSeries() {
  try {
    const res = await api.getTelemetrySeries();
    availableSeries = res.data || [];
    buildGroupedDevices();

    // Preseleccionar hasta 2 series que ya tengan datos (o las 2 primeras disponibles)
    if (selectedKeys.length === 0 && availableSeries.length > 0) {
      const withData = availableSeries.filter((s) => s.recordCount > 0);
      const source = withData.length > 0 ? withData : availableSeries;
      selectedKeys = source.slice(0, 2).map((s) => `${s.deviceId}:${s.dpCode}`);
    } else {
      const validSet = new Set(availableSeries.map((s) => `${s.deviceId}:${s.dpCode}`));
      selectedKeys = selectedKeys.filter((k) => validSet.has(k));
    }

    renderActiveSeriesBar();
    renderDeviceList();
    renderDpList();
    await loadHistoryChart();
  } catch (err) {
    showToast(`Error cargando series: ${err.message}`, 'error');
  }
}

export function initAnalyticsModule() {
  const tzBadge = document.getElementById('analytics-timezone-badge');
  if (tzBadge) {
    tzBadge.textContent = `Hora local: ${VISITOR_TZ}`;
  }

  if (window.Chart && window.ChartZoom) {
    try {
      window.Chart.register(window.ChartZoom);
    } catch {
      // Ya registrado por UMD
    }
  }

  // Buscadores y filtros del selector práctico de 2 columnas
  document.getElementById('analytics-device-search')?.addEventListener('input', (e) => {
    pickerFilters.deviceQuery = e.target.value;
    renderDeviceList();
  });

  document.getElementById('analytics-dp-search')?.addEventListener('input', (e) => {
    pickerFilters.dpQuery = e.target.value;
    renderDpList();
  });

  document.getElementById('analytics-only-online')?.addEventListener('change', (e) => {
    pickerFilters.onlyOnline = e.target.checked;
    renderDeviceList();
  });

  document.getElementById('analytics-only-with-data')?.addEventListener('change', (e) => {
    pickerFilters.onlyWithData = e.target.checked;
    renderDeviceList();
  });

  document.getElementById('btn-clear-series')?.addEventListener('click', () => {
    selectedKeys = [];
    renderActiveSeriesBar();
    renderDeviceList();
    renderDpList();
    loadHistoryChart();
  });

  document.getElementById('btn-toggle-picker')?.addEventListener('click', (e) => {
    pickerVisible = !pickerVisible;
    document.getElementById('analytics-picker-panel')?.classList.toggle('hidden', !pickerVisible);
    e.currentTarget.textContent = pickerVisible ? 'Ocultar selector' : 'Mostrar selector';
  });

  // Botones de rango (24h, 7d, 30d, custom)
  document.querySelectorAll('[data-range-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentRange = btn.dataset.rangeBtn;
      document.querySelectorAll('[data-range-btn]').forEach((b) => {
        const active = b.dataset.rangeBtn === currentRange;
        b.className = active
          ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40'
          : 'px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200';
      });
      document.getElementById('analytics-custom-dates')?.classList.toggle('hidden', currentRange !== 'custom');
      if (currentRange !== 'custom') loadHistoryChart();
    });
  });

  document.getElementById('btn-apply-custom-range')?.addEventListener('click', loadHistoryChart);

  // Modo Zoom vs Pan
  document.getElementById('btn-mode-zoom')?.addEventListener('click', () => {
    interactionMode = 'zoom';
    updateModeButtons();
  });
  document.getElementById('btn-mode-pan')?.addEventListener('click', () => {
    interactionMode = 'pan';
    updateModeButtons();
  });

  // Reset Zoom
  document.getElementById('btn-reset-zoom')?.addEventListener('click', () => {
    if (chartInstance && typeof chartInstance.resetZoom === 'function') {
      chartInstance.resetZoom();
      setResetButtonState(false);
    }
  });

  // Capturar snapshot ahora
  document.getElementById('btn-capture-telemetry')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.captureTelemetryNow();
      showToast(`Snapshot guardado (${res.inserted || 0} lecturas)`, 'success');
      await refreshAvailableSeries();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Generar historial de ejemplo (48h)
  document.getElementById('btn-seed-telemetry')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Generando...';
    try {
      const res = await api.seedDemoTelemetry(48);
      showToast(`Historial generado: ${res.data?.inserted || 0} registros (48h)`, 'success');
      await refreshAvailableSeries();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  updateModeButtons();
  setResetButtonState(false);
  refreshAvailableSeries();
}

export default { initAnalyticsModule, refreshAvailableSeries, loadHistoryChart };
