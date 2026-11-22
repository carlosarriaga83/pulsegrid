import api from '../api.js';
import { showToast } from './toast.js';
import { translateDpLabel, translateUnit, formatDateTime, formatTime, formatNumber } from '../utils/formatters.js';

const DAYS_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const OPERATORS = [
  { value: '>', label: '> mayor que' },
  { value: '<', label: '< menor que' },
  { value: '>=', label: '>= mayor o igual' },
  { value: '<=', label: '<= menor o igual' },
  { value: '==', label: '== igual a' },
  { value: '!=', label: '!= distinto de' },
];
const WEATHER_METRICS = [
  { value: 'temperature', label: 'Temperatura exterior (°C)' },
  { value: 'apparentTemperature', label: 'Sensación térmica (°C)' },
  { value: 'humidity', label: 'Humedad exterior (%)' },
  { value: 'windSpeed', label: 'Viento (km/h)' },
  { value: 'precipitation', label: 'Precipitación (mm)' },
  { value: 'weatherCategory', label: 'Clima (clear/cloudy/rain/storm)' },
];
const SOLAR_RULES = [
  { value: 'after_sunset', label: 'Después del atardecer' },
  { value: 'before_sunset', label: 'Antes del atardecer' },
  { value: 'after_sunrise', label: 'Después del amanecer' },
  { value: 'before_sunrise', label: 'Antes del amanecer' },
  { value: 'night', label: 'Durante la noche (atardecer a amanecer)' },
  { value: 'day', label: 'Durante el día (amanecer a atardecer)' },
];

let rules = [];
let getDevicesFn = () => [];
let editingRuleId = null;
let draftConditions = [];
let draftActions = [];
let draftDays = [0, 1, 2, 3, 4, 5, 6];

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDeviceName(id) {
  const d = getDevicesFn().find((x) => x.id === id);
  return d ? d.displayName : id || 'Dispositivo';
}

function getReadableDps(device) {
  if (!device) return [];
  const map = new Map();
  for (const s of device.dpSchema?.status || []) {
    map.set(s.code, {
      code: s.code,
      label: translateDpLabel(s.code, s.name),
      unit: translateUnit(s.parsedValues?.unit || ''),
    });
  }
  for (const f of device.dpSchema?.functions || []) {
    if (!map.has(f.code)) {
      map.set(f.code, {
        code: f.code,
        label: translateDpLabel(f.code, f.name),
        unit: translateUnit(f.parsedValues?.unit || ''),
      });
    }
  }
  for (const code of Object.keys(device.status || {})) {
    if (!map.has(code)) map.set(code, { code, label: translateDpLabel(code, code), unit: '' });
  }
  return Array.from(map.values());
}

function getWritableDps(device) {
  if (!device) return [];
  const fns = device.dpSchema?.functions || [];
  if (fns.length > 0) {
    return fns.map((f) => ({
      code: f.code,
      label: translateDpLabel(f.code, f.name),
      type: String(f.type || '').toLowerCase(),
      values: f.parsedValues || {},
    }));
  }
  return Object.entries(device.status || {}).map(([code, val]) => ({
    code,
    label: translateDpLabel(code, code),
    type: typeof val === 'boolean' ? 'boolean' : typeof val === 'number' ? 'integer' : 'string',
    values: {},
  }));
}

function describeCondition(c) {
  if (c.type === 'weather') {
    const m = WEATHER_METRICS.find((x) => x.value === c.weatherMetric)?.label || c.weatherMetric;
    return `${m} ${c.operator} ${c.value}`;
  }
  if (c.type === 'device_vs_device') {
    return `${getDeviceName(c.deviceId)} (${c.dpCode}) ${c.operator} ${getDeviceName(c.targetDeviceId)} (${c.targetDpCode})`;
  }
  return `${getDeviceName(c.deviceId)} (${c.dpCode}) ${c.operator} ${c.value}`;
}

function describeSchedule(s = {}) {
  const days = Array.isArray(s.days) ? s.days : [0, 1, 2, 3, 4, 5, 6];
  const dayText = days.length === 7 ? 'Todos los días' : days.map((d) => DAYS_SHORT[d]).join(', ');

  let timeText = 'a cualquier hora';
  if (s.mode === 'time_range') {
    timeText = `de ${s.startTime || '00:00'} a ${s.endTime || '23:59'}`;
  } else if (s.mode === 'solar') {
    const ruleLabel = SOLAR_RULES.find((r) => r.value === s.solarRule)?.label || s.solarRule;
    const off = Number(s.offsetMinutes || 0);
    const offText = off === 0 ? '' : off < 0 ? ` (${Math.abs(off)} min antes)` : ` (${off} min después)`;
    timeText = `${ruleLabel}${offText}`;
  }

  const wText = s.weatherCondition && s.weatherCondition !== 'any' ? ` · clima: ${s.weatherCondition}` : '';
  return `${dayText}, ${timeText}${wText}`;
}

function describeActions(actions = []) {
  if (actions.length === 0) return 'Sin acciones';
  return actions
    .map((a) => {
      if (a.type === 'send_email') return `Enviar alerta ("${a.subject || 'Notificación'}")`;
      return `${getDeviceName(a.deviceId)} → ${a.code} = ${a.value}`;
    })
    .join(' + ');
}

function buildNaturalSentence(rule) {
  const joiner = rule.conditionLogic === 'ANY' ? ' O ' : ' Y ';
  const si = (rule.conditions || []).length > 0 ? rule.conditions.map(describeCondition).join(joiner) : 'Siempre';
  const cuando = describeSchedule(rule.schedule);
  const entonces = describeActions(rule.actions);
  return { si, cuando, entonces };
}

function renderRuleCard(rule) {
  const snap = rule.lastEvalSnapshot;
  const sentence = buildNaturalSentence(rule);

  let statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] bg-slate-800 text-slate-400 border border-slate-700">Inactiva</span>';
  if (rule.isEnabled) {
    if (!snap) {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] bg-slate-800 text-slate-300 border border-slate-700">Pendiente</span>';
    } else if (snap.allMet && snap.inCooldown) {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/30">Cooldown (${Math.ceil(snap.cooldownRemainingSec / 60)}m)</span>`;
    } else if (snap.allMet) {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Cumplida</span>';
    } else {
      statusBadge = '<span class="px-2 py-0.5 rounded-full text-[11px] bg-sky-500/10 text-sky-300 border border-sky-500/30">En vigilancia</span>';
    }
  }

  const condRows = snap?.conditions?.length
    ? snap.conditions
        .map(
          (c) => `
          <div class="flex items-center justify-between gap-2 text-xs py-1.5 border-t border-slate-800/70">
            <div class="flex items-center gap-2 min-w-0">
              <span class="flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                c.met ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/15 text-rose-400'
              }">${c.met ? '✓' : '✗'}</span>
              <span class="text-slate-200 truncate">${esc(c.label)}</span>
            </div>
            <span class="font-mono text-[11px] flex-shrink-0 ${c.met ? 'text-emerald-400' : 'text-slate-400'}">${esc(c.reason)}</span>
          </div>`
        )
        .join('')
    : '<p class="text-xs text-slate-500 py-1">Sin condiciones evaluadas todavía.</p>';

  const schedRow = snap?.schedule
    ? `<div class="flex items-center justify-between gap-2 text-xs py-1.5 border-t border-slate-800/70">
        <div class="flex items-center gap-2">
          <span class="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
            snap.schedule.met ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/15 text-rose-400'
          }">${snap.schedule.met ? '✓' : '✗'}</span>
          <span class="text-slate-300">Bloque CUANDO</span>
        </div>
        <span class="font-mono text-[11px] text-slate-400 text-right">${esc(snap.schedule.detail)}</span>
      </div>`
    : '';

  const lastTriggerText = rule.lastTriggeredAt
    ? formatDateTime(rule.lastTriggeredAt)
    : 'Nunca';

  return `
    <article data-rule-id="${rule.id}" class="rounded-2xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-lg">
      <div class="p-5">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-base font-semibold text-slate-100">${esc(rule.name)}</h3>
              ${statusBadge}
              <span class="text-[11px] text-slate-500">Cooldown: ${formatNumber(rule.cooldownMinutes, 0)}m · Disparos: ${formatNumber(rule.triggerCount, 0)}</span>
            </div>
            ${rule.description ? `<p class="text-xs text-slate-400 mt-0.5">${esc(rule.description)}</p>` : ''}
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked="${rule.isEnabled ? 'true' : 'false'}"
              data-rule-toggle="${rule.id}"
              class="pg-toggle"
              title="Activar o desactivar regla"
            >
              <span class="pg-toggle-thumb"></span>
            </button>
          </div>
        </div>

        <!-- Frase en lenguaje natural -->
        <div class="rounded-xl bg-slate-950/70 border border-slate-800/80 p-3.5 text-xs space-y-1.5">
          <div><span class="inline-block w-20 font-bold text-sky-400">SI</span> <span class="text-slate-200">${esc(sentence.si)}</span></div>
          <div><span class="inline-block w-20 font-bold text-amber-400">CUANDO</span> <span class="text-slate-300">${esc(sentence.cuando)}</span></div>
          <div><span class="inline-block w-20 font-bold text-emerald-400">ENTONCES</span> <span class="text-slate-200">${esc(sentence.entonces)}</span></div>
        </div>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>Último disparo: <strong class="text-slate-300 font-medium">${esc(lastTriggerText)}</strong></span>
          <div class="flex items-center gap-1.5">
            <button type="button" data-rule-eval="${rule.id}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">Evaluar ahora</button>
            <button type="button" data-rule-edit="${rule.id}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">Editar</button>
            <button type="button" data-rule-delete="${rule.id}" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-rose-950/70 text-rose-400 border border-slate-800 hover:border-rose-500/40 transition">Eliminar</button>
          </div>
        </div>
      </div>

      <!-- Vista expandible de depuración en vivo y logs -->
      <div class="border-t border-slate-800/80 bg-slate-950/40 px-5 py-2.5">
        <details class="group" data-rule-details="${rule.id}">
          <summary class="list-none cursor-pointer select-none flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 transition">
            <span class="flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
              <span>Evaluación en vivo y trazabilidad (logs)</span>
            </span>
            <span class="text-[11px] text-slate-500">${snap?.evaluatedAt ? `Eval: ${formatTime(snap.evaluatedAt)}` : 'Sin evaluar'}</span>
          </summary>

          <div class="mt-3 space-y-3">
            <div>
              <p class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Desglose de condiciones</p>
              ${condRows}
              ${schedRow}
            </div>
            <div>
              <p class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Historial de ejecuciones (MySQL)</p>
              <div data-rule-logs="${rule.id}" class="text-xs text-slate-500">Abre para cargar historial...</div>
            </div>
          </div>
        </details>
      </div>
    </article>
  `;
}

async function loadLogsForRule(ruleId) {
  const box = document.querySelector(`[data-rule-logs="${ruleId}"]`);
  if (!box) return;
  box.innerHTML = '<span class="text-slate-500">Cargando logs...</span>';
  try {
    const res = await api.getAutomationLogs(ruleId, 10);
    if (!res.data || res.data.length === 0) {
      box.innerHTML = '<p class="text-slate-500 italic">Esta regla aún no se ha disparado.</p>';
      return;
    }
    box.innerHTML = res.data
      .map((l) => {
        const color =
          l.status === 'triggered'
            ? 'text-emerald-400'
            : l.status === 'partial_error'
              ? 'text-amber-400'
              : 'text-rose-400';
        return `
          <div class="flex items-center justify-between gap-2 py-1 border-t border-slate-800/70">
            <span class="${color} font-semibold uppercase text-[10px]">${esc(l.status)}</span>
            <span class="text-slate-400 truncate flex-1">${esc(l.errorMessage || `${(l.actionsResult || []).length} acción(es) ejecutada(s)`)}</span>
            <span class="font-mono text-[10px] text-slate-500">${formatDateTime(l.executedAt)}</span>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<span class="text-rose-400">${esc(err.message)}</span>`;
  }
}

function renderRulesList() {
  const listEl = document.getElementById('automations-list');
  const emptyEl = document.getElementById('automations-empty');
  const counterEl = document.getElementById('automations-counter');
  if (!listEl) return;

  const activeCount = rules.filter((r) => r.isEnabled).length;
  if (counterEl) counterEl.textContent = `${activeCount} activa(s) de ${rules.length}`;

  if (rules.length === 0) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }

  emptyEl?.classList.add('hidden');
  listEl.innerHTML = rules.map(renderRuleCard).join('');

  // Enlazar eventos de tarjetas
  listEl.querySelectorAll('[data-rule-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.ruleToggle);
      const next = btn.getAttribute('aria-checked') !== 'true';
      try {
        const res = await api.toggleAutomation(id, next);
        rules = rules.map((r) => (r.id === id ? res.data : r));
        renderRulesList();
        showToast(`Regla ${next ? 'activada' : 'desactivada'}`, 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  listEl.querySelectorAll('[data-rule-eval]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.ruleEval);
      btn.disabled = true;
      try {
        const res = await api.evaluateAutomation(id, false);
        rules = rules.map((r) => (r.id === id ? res.rule : r));
        renderRulesList();
        const st = res.result?.status;
        if (st === 'triggered') showToast('Regla cumplida y ejecutada', 'success');
        else if (st === 'skipped_cooldown') showToast('Condiciones cumplidas, pero la regla está en cooldown', 'warning');
        else showToast('Evaluación completada (condiciones aún no cumplidas)', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('[data-rule-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.ruleEdit);
      const rule = rules.find((r) => r.id === id);
      if (rule) openBuilderModal(rule);
    });
  });

  listEl.querySelectorAll('[data-rule-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.ruleDelete);
      if (!window.confirm('¿Eliminar esta regla de automatización y su historial?')) return;
      try {
        await api.deleteAutomation(id);
        rules = rules.filter((r) => r.id !== id);
        renderRulesList();
        showToast('Automatización eliminada', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  listEl.querySelectorAll('[data-rule-details]').forEach((det) => {
    det.addEventListener('toggle', () => {
      if (det.open) loadLogsForRule(Number(det.dataset.ruleDetails));
    });
  });
}

// =============================================================================
// CONSTRUCTOR VISUAL MODAL (SI / CUANDO / ENTONCES)
// =============================================================================

function renderDraftConditions() {
  const container = document.getElementById('builder-conditions-list');
  if (!container) return;
  const devices = getDevicesFn();

  if (draftConditions.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 italic">Sin condiciones (la regla se evaluará únicamente según el bloque CUANDO).</p>';
    updateNaturalPreview();
    return;
  }

  container.innerHTML = draftConditions
    .map((c, idx) => {
      const devA = devices.find((d) => d.id === c.deviceId) || devices[0];
      const dpsA = getReadableDps(devA);
      const devB = devices.find((d) => d.id === c.targetDeviceId) || devices[0];
      const dpsB = getReadableDps(devB);

      const devOptions = (selectedId) =>
        devices.length > 0
          ? devices.map((d) => `<option value="${esc(d.id)}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.displayName)}</option>`).join('')
          : '<option value="">Sin dispositivos</option>';

      const dpOptions = (list, selectedCode) =>
        list.length > 0
          ? list.map((dp) => `<option value="${esc(dp.code)}" ${dp.code === selectedCode ? 'selected' : ''}>${esc(dp.label)}${dp.unit ? ` (${esc(dp.unit)})` : ''}</option>`).join('')
          : '<option value="">Sin DPs</option>';

      const opOptions = OPERATORS.map(
        (o) => `<option value="${esc(o.value)}" ${c.operator === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
      ).join('');

      let innerFields = '';
      if (c.type === 'weather') {
        const wOpts = WEATHER_METRICS.map(
          (m) => `<option value="${esc(m.value)}" ${c.weatherMetric === m.value ? 'selected' : ''}>${esc(m.label)}</option>`
        ).join('');
        innerFields = `
          <select data-c-field="weatherMetric" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${wOpts}</select>
          <select data-c-field="operator" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${opOptions}</select>
          <input data-c-field="value" data-c-idx="${idx}" value="${esc(c.value)}" placeholder="Valor (ej. 25 o rain)" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 w-32" />
        `;
      } else if (c.type === 'device_vs_device') {
        innerFields = `
          <select data-c-field="deviceId" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100">${devOptions(c.deviceId)}</select>
          <select data-c-field="dpCode" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100">${dpOptions(dpsA, c.dpCode)}</select>
          <select data-c-field="operator" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100">${opOptions}</select>
          <select data-c-field="targetDeviceId" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100">${devOptions(c.targetDeviceId)}</select>
          <select data-c-field="targetDpCode" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-100">${dpOptions(dpsB, c.targetDpCode)}</select>
        `;
      } else {
        innerFields = `
          <select data-c-field="deviceId" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${devOptions(c.deviceId)}</select>
          <select data-c-field="dpCode" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${dpOptions(dpsA, c.dpCode)}</select>
          <select data-c-field="operator" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${opOptions}</select>
          <input data-c-field="value" data-c-idx="${idx}" value="${esc(c.value)}" placeholder="Valor (ej. 24.5 o true)" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 w-32" />
        `;
      }

      return `
        <div class="rounded-xl bg-slate-950/70 border border-slate-800 p-3 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <select data-c-field="type" data-c-idx="${idx}" class="rounded-lg bg-slate-900 border border-sky-500/30 px-2 py-1 text-[11px] font-medium text-sky-300">
              <option value="device_vs_value" ${c.type === 'device_vs_value' ? 'selected' : ''}>Dispositivo vs Valor fijo</option>
              <option value="device_vs_device" ${c.type === 'device_vs_device' ? 'selected' : ''}>Dispositivo A vs Dispositivo B</option>
              <option value="weather" ${c.type === 'weather' ? 'selected' : ''}>Clima exterior (Open-Meteo)</option>
            </select>
            <button type="button" data-c-remove="${idx}" class="text-xs text-rose-400 hover:text-rose-300">Quitar</button>
          </div>
          <div class="flex flex-wrap items-center gap-2">${innerFields}</div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-c-field]').forEach((el) => {
    const handler = () => {
      const idx = Number(el.dataset.cIdx);
      const field = el.dataset.cField;
      draftConditions[idx][field] = el.value;

      if (field === 'type' || field === 'deviceId' || field === 'targetDeviceId') {
        const devicesList = getDevicesFn();
        const cond = draftConditions[idx];
        if (field === 'deviceId' || field === 'type') {
          const dA = devicesList.find((x) => x.id === cond.deviceId) || devicesList[0];
          cond.deviceId = dA?.id || '';
          cond.dpCode = getReadableDps(dA)[0]?.code || '';
        }
        if (field === 'targetDeviceId' || field === 'type') {
          const dB = devicesList.find((x) => x.id === cond.targetDeviceId) || devicesList[1] || devicesList[0];
          cond.targetDeviceId = dB?.id || '';
          cond.targetDpCode = getReadableDps(dB)[0]?.code || '';
        }
        if (field === 'type' && cond.type === 'weather') {
          cond.weatherMetric = cond.weatherMetric || 'temperature';
        }
        renderDraftConditions();
      } else {
        updateNaturalPreview();
      }
    };
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', handler);
  });

  container.querySelectorAll('[data-c-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      draftConditions.splice(Number(btn.dataset.cRemove), 1);
      renderDraftConditions();
    });
  });

  updateNaturalPreview();
}

function renderDraftActions() {
  const container = document.getElementById('builder-actions-list');
  if (!container) return;
  const devices = getDevicesFn();

  if (draftActions.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 italic">Agrega al menos una acción sobre un dispositivo o activa la alerta por correo.</p>';
    updateNaturalPreview();
    return;
  }

  container.innerHTML = draftActions
    .map((a, idx) => {
      const dev = devices.find((d) => d.id === a.deviceId) || devices[0];
      const writable = getWritableDps(dev);
      const selectedDp = writable.find((x) => x.code === a.code) || writable[0];

      const devOpts =
        devices.length > 0
          ? devices.map((d) => `<option value="${esc(d.id)}" ${d.id === a.deviceId ? 'selected' : ''}>${esc(d.displayName)}</option>`).join('')
          : '<option value="">Sin dispositivos</option>';

      const dpOpts =
        writable.length > 0
          ? writable.map((dp) => `<option value="${esc(dp.code)}" ${dp.code === a.code ? 'selected' : ''}>${esc(dp.label)}</option>`).join('')
          : '<option value="">Sin controles escribibles</option>';

      let valInput = `<input data-a-field="value" data-a-idx="${idx}" value="${esc(a.value)}" placeholder="Valor" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100 w-28" />`;
      if (selectedDp?.type === 'boolean') {
        valInput = `
          <select data-a-field="value" data-a-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">
            <option value="true" ${String(a.value) === 'true' ? 'selected' : ''}>Encender (true)</option>
            <option value="false" ${String(a.value) === 'false' ? 'selected' : ''}>Apagar (false)</option>
          </select>
        `;
      } else if (selectedDp?.type === 'enum' && Array.isArray(selectedDp.values?.range)) {
        valInput = `
          <select data-a-field="value" data-a-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">
            ${selectedDp.values.range.map((opt) => `<option value="${esc(opt)}" ${String(a.value) === String(opt) ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
          </select>
        `;
      }

      return `
        <div class="rounded-xl bg-slate-950/70 border border-slate-800 p-3 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <select data-a-field="deviceId" data-a-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${devOpts}</select>
            <select data-a-field="code" data-a-idx="${idx}" class="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100">${dpOpts}</select>
            <span class="text-xs text-slate-500">=</span>
            ${valInput}
          </div>
          <button type="button" data-a-remove="${idx}" class="text-xs text-rose-400 hover:text-rose-300">Quitar</button>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-a-field]').forEach((el) => {
    const handler = () => {
      const idx = Number(el.dataset.aIdx);
      const field = el.dataset.aField;
      draftActions[idx][field] = el.value;
      if (field === 'deviceId' || field === 'code') {
        const dev = getDevicesFn().find((d) => d.id === draftActions[idx].deviceId) || getDevicesFn()[0];
        const writable = getWritableDps(dev);
        if (field === 'deviceId') draftActions[idx].code = writable[0]?.code || '';
        const dp = writable.find((x) => x.code === draftActions[idx].code) || writable[0];
        if (dp?.type === 'boolean') draftActions[idx].value = 'true';
        else if (dp?.type === 'enum' && dp.values?.range?.[0]) draftActions[idx].value = dp.values.range[0];
        renderDraftActions();
      } else {
        updateNaturalPreview();
      }
    };
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', handler);
  });

  container.querySelectorAll('[data-a-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      draftActions.splice(Number(btn.dataset.aRemove), 1);
      renderDraftActions();
    });
  });

  updateNaturalPreview();
}

function renderDayPills() {
  const wrap = document.getElementById('builder-days-pills');
  if (!wrap) return;
  wrap.innerHTML = DAYS_SHORT.map((lbl, idx) => {
    const active = draftDays.includes(idx);
    const cls = active
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
      : 'bg-slate-950 text-slate-500 border-slate-800 hover:text-slate-300';
    return `<button type="button" data-day-pill="${idx}" class="h-8 w-8 rounded-lg border text-xs font-semibold transition ${cls}">${lbl}</button>`;
  }).join('');

  wrap.querySelectorAll('[data-day-pill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.dayPill);
      if (draftDays.includes(d)) {
        if (draftDays.length > 1) draftDays = draftDays.filter((x) => x !== d);
      } else {
        draftDays = [...draftDays, d].sort((a, b) => a - b);
      }
      renderDayPills();
      updateNaturalPreview();
    });
  });
}

function collectPayloadFromModal() {
  const mode = document.getElementById('builder-schedule-mode').value;
  const emailEnabled = document.getElementById('builder-email-enabled').checked;

  const actions = draftActions
    .filter((a) => a.deviceId && a.code)
    .map((a) => ({
      type: 'device_command',
      deviceId: a.deviceId,
      code: a.code,
      value: a.value === 'true' ? true : a.value === 'false' ? false : a.value,
    }));

  if (emailEnabled) {
    actions.push({
      type: 'send_email',
      subject: document.getElementById('builder-email-subject').value.trim() || 'Alerta PulseGrid',
      message: document.getElementById('builder-email-message').value.trim() || 'Regla ejecutada automáticamente.',
    });
  }

  return {
    name: document.getElementById('builder-name').value.trim(),
    description: document.getElementById('builder-description').value.trim(),
    isEnabled: true,
    conditionLogic: document.getElementById('builder-logic').value,
    conditions: draftConditions,
    schedule: {
      mode,
      days: draftDays,
      startTime: document.getElementById('builder-start-time').value || '08:00',
      endTime: document.getElementById('builder-end-time').value || '22:00',
      solarRule: document.getElementById('builder-solar-rule').value || 'after_sunset',
      offsetMinutes: Number(document.getElementById('builder-solar-offset').value || 0),
      weatherCondition: document.getElementById('builder-weather-cond').value || 'any',
    },
    actions,
    cooldownMinutes: Number(document.getElementById('builder-cooldown').value || 5),
  };
}

function updateNaturalPreview() {
  const box = document.getElementById('builder-natural-preview');
  if (!box) return;
  const draft = collectPayloadFromModal();
  const s = buildNaturalSentence(draft);
  box.innerHTML = `
    <span class="text-sky-400 font-semibold">SI</span> ${esc(s.si)}
    <span class="text-amber-400 font-semibold ml-1">CUANDO</span> ${esc(s.cuando)}
    <span class="text-emerald-400 font-semibold ml-1">ENTONCES</span> ${esc(s.entonces)}.
  `;
}

function syncScheduleModeVisibility() {
  const mode = document.getElementById('builder-schedule-mode').value;
  document.getElementById('builder-time-range-fields')?.classList.toggle('hidden', mode !== 'time_range');
  document.getElementById('builder-solar-fields')?.classList.toggle('hidden', mode !== 'solar');
  updateNaturalPreview();
}

function openBuilderModal(rule = null) {
  const modal = document.getElementById('automation-modal');
  const titleEl = document.getElementById('automation-modal-title');
  const devices = getDevicesFn();

  editingRuleId = rule ? rule.id : null;
  titleEl.textContent = rule ? `Editar regla: ${rule.name}` : 'Nueva Automatización';

  document.getElementById('builder-name').value = rule?.name || '';
  document.getElementById('builder-description').value = rule?.description || '';
  document.getElementById('builder-logic').value = rule?.conditionLogic || 'ALL';
  document.getElementById('builder-cooldown').value = String(rule?.cooldownMinutes ?? 5);

  const sched = rule?.schedule || { mode: 'anytime', days: [0, 1, 2, 3, 4, 5, 6] };
  document.getElementById('builder-schedule-mode').value = sched.mode || 'anytime';
  document.getElementById('builder-start-time').value = sched.startTime || '08:00';
  document.getElementById('builder-end-time').value = sched.endTime || '22:00';
  document.getElementById('builder-solar-rule').value = sched.solarRule || 'after_sunset';
  document.getElementById('builder-solar-offset').value = String(sched.offsetMinutes ?? -30);
  document.getElementById('builder-weather-cond').value = sched.weatherCondition || 'any';
  draftDays = Array.isArray(sched.days) && sched.days.length > 0 ? [...sched.days] : [0, 1, 2, 3, 4, 5, 6];

  if (rule) {
    draftConditions = (rule.conditions || []).map((c) => ({ ...c }));
    const devActs = (rule.actions || []).filter((a) => a.type !== 'send_email');
    const mailAct = (rule.actions || []).find((a) => a.type === 'send_email');
    draftActions = devActs.map((a) => ({ ...a, value: String(a.value) }));
    document.getElementById('builder-email-enabled').checked = Boolean(mailAct);
    document.getElementById('builder-email-subject').value = mailAct?.subject || '';
    document.getElementById('builder-email-message').value = mailAct?.message || '';
  } else {
    const firstDev = devices[0];
    const firstDp = getReadableDps(firstDev)[0];
    const firstWritable = getWritableDps(firstDev)[0];
    draftConditions = firstDev
      ? [{ type: 'device_vs_value', deviceId: firstDev.id, dpCode: firstDp?.code || '', operator: '>', value: '25' }]
      : [];
    draftActions = firstDev && firstWritable
      ? [{ type: 'device_command', deviceId: firstDev.id, code: firstWritable.code, value: firstWritable.type === 'boolean' ? 'true' : '' }]
      : [];
    document.getElementById('builder-email-enabled').checked = false;
    document.getElementById('builder-email-subject').value = '';
    document.getElementById('builder-email-message').value = '';
  }

  document.getElementById('builder-email-fields')?.classList.toggle(
    'hidden',
    !document.getElementById('builder-email-enabled').checked
  );

  renderDayPills();
  renderDraftConditions();
  renderDraftActions();
  syncScheduleModeVisibility();

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeBuilderModal() {
  const modal = document.getElementById('automation-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  editingRuleId = null;
}

export async function loadAutomations() {
  try {
    const res = await api.getAutomations();
    rules = res.data || [];
    renderRulesList();
  } catch (err) {
    showToast(`Error cargando automatizaciones: ${err.message}`, 'error');
  }
}

export function handleLiveEvaluation(payload) {
  if (!payload?.automationId) return;
  let changed = false;
  rules = rules.map((r) => {
    if (r.id === payload.automationId) {
      changed = true;
      return { ...r, lastEvalSnapshot: payload.snapshot, lastEvaluatedAt: payload.snapshot?.evaluatedAt };
    }
    return r;
  });
  if (changed) renderRulesList();
}

export function handleLiveTrigger(payload) {
  if (!payload?.automationId) return;
  showToast(`Regla ejecutada: ${payload.name}`, payload.status === 'triggered' ? 'success' : 'warning');
  loadAutomations();
}

export function initAutomationsModule({ getDevices }) {
  getDevicesFn = getDevices;

  document.getElementById('btn-new-automation')?.addEventListener('click', () => openBuilderModal(null));
  document.getElementById('btn-empty-new-automation')?.addEventListener('click', () => openBuilderModal(null));

  document.getElementById('btn-eval-all-automations')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.evaluateAllAutomations();
      rules = res.data || rules;
      renderRulesList();
      showToast(
        `Motor evaluado: ${res.summary?.evaluated || 0} regla(s), ${res.summary?.triggered || 0} disparada(s)`,
        res.summary?.triggered > 0 ? 'success' : 'info'
      );
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('[data-close-automation-modal]').forEach((el) =>
    el.addEventListener('click', closeBuilderModal)
  );

  document.getElementById('btn-add-condition')?.addEventListener('click', () => {
    const devices = getDevicesFn();
    const first = devices[0];
    draftConditions.push({
      type: first ? 'device_vs_value' : 'weather',
      deviceId: first?.id || '',
      dpCode: getReadableDps(first)[0]?.code || '',
      weatherMetric: 'temperature',
      operator: '>',
      value: '25',
    });
    renderDraftConditions();
  });

  document.getElementById('btn-add-action')?.addEventListener('click', () => {
    const devices = getDevicesFn();
    const first = devices[0];
    const firstW = getWritableDps(first)[0];
    draftActions.push({
      type: 'device_command',
      deviceId: first?.id || '',
      code: firstW?.code || '',
      value: firstW?.type === 'boolean' ? 'true' : '',
    });
    renderDraftActions();
  });

  document.getElementById('builder-schedule-mode')?.addEventListener('change', syncScheduleModeVisibility);
  document.getElementById('builder-logic')?.addEventListener('change', updateNaturalPreview);
  document.getElementById('builder-start-time')?.addEventListener('input', updateNaturalPreview);
  document.getElementById('builder-end-time')?.addEventListener('input', updateNaturalPreview);
  document.getElementById('builder-solar-rule')?.addEventListener('change', updateNaturalPreview);
  document.getElementById('builder-solar-offset')?.addEventListener('input', updateNaturalPreview);
  document.getElementById('builder-weather-cond')?.addEventListener('change', updateNaturalPreview);

  document.getElementById('builder-email-enabled')?.addEventListener('change', (e) => {
    document.getElementById('builder-email-fields')?.classList.toggle('hidden', !e.target.checked);
    updateNaturalPreview();
  });
  document.getElementById('builder-email-subject')?.addEventListener('input', updateNaturalPreview);

  document.getElementById('automation-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = collectPayloadFromModal();
    if (!payload.name) {
      showToast('Escribe un nombre para la regla', 'warning');
      return;
    }
    if (payload.actions.length === 0) {
      showToast('Agrega al menos una acción en el bloque ENTONCES', 'warning');
      return;
    }

    try {
      if (editingRuleId) {
        const res = await api.updateAutomation(editingRuleId, payload);
        rules = rules.map((r) => (r.id === editingRuleId ? res.data : r));
        showToast('Automatización actualizada', 'success');
      } else {
        const res = await api.createAutomation(payload);
        rules = [res.data, ...rules];
        showToast('Automatización creada y activa', 'success');
      }
      renderRulesList();
      closeBuilderModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  loadAutomations();
}

export default { initAutomationsModule, loadAutomations, handleLiveEvaluation, handleLiveTrigger };
