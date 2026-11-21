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

let chartInstance = null;
let availableSeries = [];
let selectedKeys = [];
let currentRange = '24h';
let interactionMode = 'zoom'; // 'zoom' (drag-to-zoom, shift+drag pan) | 'pan' (drag-to-pan)
let isZoomed = false;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setResetButtonState(zoomed) {
  isZoomed = zoomed;
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

function renderSeriesChips() {
  const wrap = document.getElementById('analytics-series-chips');
  if (!wrap) return;

  if (availableSeries.length === 0) {
    wrap.innerHTML =
      '<span class="text-xs text-slate-500 italic">No hay dispositivos con métricas graficables. Sincroniza Tuya o carga dispositivos de ejemplo.</span>';
    return;
  }

  wrap.innerHTML = availableSeries
    .map((item) => {
      const key = `${item.deviceId}:${item.dpCode}`;
      const activeIdx = selectedKeys.indexOf(key);
      const isSelected = activeIdx !== -1;
      const color = isSelected ? PALETTE[activeIdx % PALETTE.length] : null;
      const typeTag = item.valueType === 'boolean' ? 'ON/OFF' : item.unit || 'Num';

      return `
        <button
          type="button"
          data-series-key="${esc(key)}"
          class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs border transition ${
            isSelected
              ? 'bg-slate-800/90 text-slate-100 border-slate-600 shadow-sm'
              : 'bg-slate-950/70 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200'
          }"
        >
          <span class="h-2.5 w-2.5 rounded-full flex-shrink-0" style="background:${color || '#334155'}"></span>
          <span class="font-medium">${esc(item.deviceName)}</span>
          <span class="text-slate-400">· ${esc(item.dpLabel)}</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400">${esc(typeTag)}</span>
        </button>
      `;
    })
    .join('');

  wrap.querySelectorAll('[data-series-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.seriesKey;
      if (selectedKeys.includes(key)) {
        selectedKeys = selectedKeys.filter((k) => k !== key);
      } else {
        if (selectedKeys.length >= 6) {
          showToast('Puedes comparar hasta 6 series simultáneamente', 'warning');
          return;
        }
        selectedKeys.push(key);
      }
      renderSeriesChips();
      loadHistoryChart();
    });
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

function renderChart(seriesList) {
  const canvas = document.getElementById('telemetry-chart');
  const emptyOverlay = document.getElementById('chart-empty-overlay');
  if (!canvas || !window.Chart) return;

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
      time: {
        tooltipFormat: 'dd/MM/yyyy HH:mm:ss',
        displayFormats: {
          minute: 'HH:mm',
          hour: 'dd/MM HH:mm',
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
            x: { min: 'original', max: 'original', minRange: 60 * 1000 },
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
  if (selectedKeys.length === 0) {
    renderStatsCards([]);
    renderChart([]);
    return;
  }

  try {
    const fromVal = document.getElementById('analytics-from')?.value;
    const toVal = document.getElementById('analytics-to')?.value;

    const res = await api.getTelemetryHistory({
      series: selectedKeys,
      range: currentRange,
      from: currentRange === 'custom' && fromVal ? new Date(fromVal).toISOString() : undefined,
      to: currentRange === 'custom' && toVal ? new Date(toVal).toISOString() : undefined,
    });

    const list = res.data?.series || [];
    renderStatsCards(list);
    renderChart(list);
  } catch (err) {
    showToast(`Error cargando historial: ${err.message}`, 'error');
  }
}

export async function refreshAvailableSeries() {
  try {
    const res = await api.getTelemetrySeries();
    availableSeries = res.data || [];

    // Preseleccionar hasta 2 series útiles si no hay selección aún
    if (selectedKeys.length === 0 && availableSeries.length > 0) {
      selectedKeys = availableSeries.slice(0, 2).map((s) => `${s.deviceId}:${s.dpCode}`);
    } else {
      const validSet = new Set(availableSeries.map((s) => `${s.deviceId}:${s.dpCode}`));
      selectedKeys = selectedKeys.filter((k) => validSet.has(k));
    }

    renderSeriesChips();
    await loadHistoryChart();
  } catch (err) {
    showToast(`Error cargando series: ${err.message}`, 'error');
  }
}

export function initAnalyticsModule() {
  // Registrar plugin zoom explícitamente si está presente en window
  if (window.Chart && window.ChartZoom) {
    try {
      window.Chart.register(window.ChartZoom);
    } catch {
      // Ya registrado automáticamente por UMD
    }
  }

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
      await loadHistoryChart();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Generar historial de ejemplo (48h) para probar zoom/pan/crosshair al instante
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
