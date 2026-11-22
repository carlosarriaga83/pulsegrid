/**
 * Componente DeviceCard de PulseGrid
 * - Divulgación progresiva (control principal y lecturas clave visibles; DPs técnicos en acordeón colapsado)
 * - Controles dinámicos según tipo de dato Tuya (Boolean, Integer con scale, Enum)
 * - Bloqueo de interacción (Interaction Lock) para evitar que actualizaciones Socket.io interrumpan al usuario
 */

import { translateDpLabel, translateUnit, formatNumber } from '../utils/formatters.js';

const CATEGORY_META = {
  wk: { label: 'Termostato', icon: '🌡️' },
  dj: { label: 'Iluminación', icon: '💡' },
  dd: { label: 'Tira LED', icon: '✨' },
  tgq: { label: 'Atenuador (Dimmer)', icon: '🔆' },
  cz: { label: 'Enchufe / Medidor', icon: '🔌' },
  pc: { label: 'Multicontacto', icon: '⚡' },
  kg: { label: 'Interruptor', icon: '🔘' },
  wsdcg: { label: 'Sensor Clima', icon: '🌦️' },
  mcs: { label: 'Sensor Puerta', icon: '🚪' },
  tdq: { label: 'Sensor / Interruptor', icon: '🚪' },
  pir: { label: 'Movimiento', icon: '👁️' },
  kt: { label: 'Aire Acond.', icon: '❄️' },
  fs: { label: 'Ventilador', icon: '🌀' },
  cl: { label: 'Cortina', icon: '🪟' },
  clkg: { label: 'Interruptor Cortina', icon: '🪟' },
  mk: { label: 'Cerradura Inteligente', icon: '🔐' },
  sos: { label: 'Botón SOS', icon: '🆘' },
};

const PRIMARY_SWITCH_CODES = ['switch', 'switch_1', 'switch_led', 'power_go', 'switch_all'];

// Mapa de bloqueos activos: key = `${deviceId}:${dpCode}`, value = { locked: boolean, timer: number }
const interactionLocks = new Map();

export function lockControl(deviceId, dpCode) {
  const key = `${deviceId}:${dpCode}`;
  const existing = interactionLocks.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  interactionLocks.set(key, { locked: true, timer: null });
}

export function unlockControl(deviceId, dpCode, graceMs = 450) {
  const key = `${deviceId}:${dpCode}`;
  const existing = interactionLocks.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    interactionLocks.delete(key);
  }, graceMs);
  interactionLocks.set(key, { locked: true, timer });
}

export function isControlLocked(deviceId, dpCode) {
  return interactionLocks.has(`${deviceId}:${dpCode}`);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function humanizeCode(code) {
  return String(code || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatScaledValue(rawValue, spec) {
  if (rawValue === undefined || rawValue === null) return '—';
  if (typeof rawValue === 'boolean') return rawValue ? 'ON' : 'OFF';

  const values = spec?.parsedValues || {};
  const scale = Number(values.scale || 0);
  const cleanU = translateUnit(values.unit || '');
  const unit = cleanU ? ` ${cleanU}` : '';

  if (typeof rawValue === 'number' || (!Number.isNaN(Number(rawValue)) && spec?.type === 'Integer')) {
    const num = Number(rawValue);
    const scaled = scale > 0 ? num / Math.pow(10, scale) : num;
    return `${formatNumber(scaled, scale > 0 ? scale : 0)}${unit}`;
  }

  return `${String(rawValue)}${unit}`;
}

function getSchemaSpec(device, code) {
  const fns = device.dpSchema?.functions || [];
  const sts = device.dpSchema?.status || [];
  return fns.find((x) => x.code === code) || sts.find((x) => x.code === code) || null;
}

function getWritableFunctions(device) {
  const fns = device.dpSchema?.functions;
  if (Array.isArray(fns) && fns.length > 0) return fns;

  // Fallback si el dispositivo aún no tiene dpSchema: inferir booleanos de status
  const inferred = [];
  for (const [code, value] of Object.entries(device.status || {})) {
    if (typeof value === 'boolean') {
      inferred.push({ code, name: humanizeCode(code), type: 'Boolean', parsedValues: {} });
    }
  }
  return inferred;
}

function findPrimarySwitch(device, functions) {
  for (const code of PRIMARY_SWITCH_CODES) {
    const fn = functions.find((f) => f.code === code && String(f.type).toLowerCase() === 'boolean');
    if (fn) return fn;
  }
  return functions.find((f) => String(f.type).toLowerCase() === 'boolean') || null;
}

function getReadOnlyMetrics(device, functions) {
  const writableCodes = new Set(functions.map((f) => f.code));
  const metrics = [];
  const statusSpecs = device.dpSchema?.status || [];

  for (const [code, value] of Object.entries(device.status || {})) {
    if (writableCodes.has(code)) continue;
    const spec = statusSpecs.find((s) => s.code === code) || null;
    metrics.push({
      code,
      label: translateDpLabel(code, spec?.name),
      formatted: formatScaledValue(value, spec),
      raw: value,
      spec,
    });
  }
  return metrics;
}

function renderControlHtml(device, fn) {
  const code = fn.code;
  const label = translateDpLabel(code, fn.name);
  const type = String(fn.type || '').toLowerCase();
  const currentVal = device.status?.[code];
  const constraints = fn.parsedValues || {};
  const cleanUnit = translateUnit(constraints.unit || '');
  const disabledAttr = !device.isOnline ? 'disabled' : '';

  if (type === 'boolean') {
    const checked = Boolean(currentVal);
    return `
      <div class="flex items-center justify-between gap-3 py-1.5" data-control-wrap="${escapeHtml(code)}">
        <span class="text-xs font-medium text-slate-300">${escapeHtml(label)}</span>
        <button
          type="button"
          role="switch"
          aria-checked="${checked ? 'true' : 'false'}"
          aria-label="${escapeHtml(label)}"
          data-dp-control="boolean"
          data-dp-code="${escapeHtml(code)}"
          class="pg-toggle"
          ${disabledAttr}
        >
          <span class="pg-toggle-thumb"></span>
        </button>
      </div>
    `;
  }

  if (type === 'integer') {
    const min = constraints.min ?? 0;
    const max = constraints.max ?? 100;
    const step = constraints.step ?? 1;
    const val = currentVal !== undefined ? Number(currentVal) : min;
    const display = formatScaledValue(val, fn);

    return `
      <div class="space-y-1.5 py-1.5" data-control-wrap="${escapeHtml(code)}">
        <div class="flex items-center justify-between text-xs">
          <span class="font-medium text-slate-300">${escapeHtml(label)}</span>
          <span class="font-mono font-semibold text-sky-400" data-slider-display="${escapeHtml(code)}">${escapeHtml(display)}</span>
        </div>
        <input
          type="range"
          min="${min}"
          max="${max}"
          step="${step}"
          value="${val}"
          data-dp-control="integer"
          data-dp-code="${escapeHtml(code)}"
          data-scale="${constraints.scale || 0}"
          data-unit="${escapeHtml(cleanUnit)}"
          class="pg-slider w-full"
          ${disabledAttr}
        />
      </div>
    `;
  }

  if (type === 'enum') {
    const range = Array.isArray(constraints.range) ? constraints.range : [];
    if (range.length > 0 && range.length <= 4) {
      const buttons = range
        .map((opt) => {
          const active = String(currentVal) === String(opt);
          const activeClasses = active
            ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
            : 'bg-slate-950/70 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200';
          return `
            <button
              type="button"
              data-dp-control="enum-btn"
              data-dp-code="${escapeHtml(code)}"
              data-dp-value="${escapeHtml(opt)}"
              class="flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border capitalize transition ${activeClasses}"
              ${disabledAttr}
            >${escapeHtml(opt)}</button>
          `;
        })
        .join('');

      return `
        <div class="space-y-1.5 py-1.5" data-control-wrap="${escapeHtml(code)}">
          <span class="block text-xs font-medium text-slate-300">${escapeHtml(label)}</span>
          <div class="flex items-center gap-1.5">${buttons}</div>
        </div>
      `;
    }

    const options = range
      .map(
        (opt) =>
          `<option value="${escapeHtml(opt)}" ${String(currentVal) === String(opt) ? 'selected' : ''}>${escapeHtml(opt)}</option>`
      )
      .join('');

    return `
      <div class="flex items-center justify-between gap-3 py-1.5" data-control-wrap="${escapeHtml(code)}">
        <span class="text-xs font-medium text-slate-300">${escapeHtml(label)}</span>
        <select
          data-dp-control="enum-select"
          data-dp-code="${escapeHtml(code)}"
          class="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          ${disabledAttr}
        >${options}</select>
      </div>
    `;
  }

  return '';
}

function renderDpTableRows(device) {
  const entries = Object.entries(device.status || {});
  if (entries.length === 0) {
    return '<tr><td colspan="2" class="py-2 text-slate-500 italic">Sin Data Points reportados</td></tr>';
  }
  return entries
    .map(([code, val]) => {
      const spec = getSchemaSpec(device, code);
      const formatted = formatScaledValue(val, spec);
      return `
        <tr class="border-t border-slate-800/80">
          <td class="py-1.5 pr-2 font-mono text-[11px] text-slate-400">${escapeHtml(code)}</td>
          <td class="py-1.5 text-right font-mono text-[11px] text-slate-200">${escapeHtml(formatted)}</td>
        </tr>
      `;
    })
    .join('');
}

/**
 * Crea el elemento DOM completo de una tarjeta de dispositivo y enlaza sus eventos.
 */
export function createDeviceCard(device, { onSendCommand, onOpenSettings }) {
  const card = document.createElement('article');
  card.dataset.deviceId = device.id;
  card.className =
    'rounded-2xl bg-slate-900/90 border border-slate-800 hover:border-slate-700/90 transition-all shadow-lg flex flex-col justify-between overflow-hidden';

  const cat = CATEGORY_META[device.category] || { label: device.category || 'IoT', icon: '📡' };
  const functions = getWritableFunctions(device);
  const primarySwitch = findPrimarySwitch(device, functions);
  const secondaryFunctions = functions.filter((f) => !primarySwitch || f.code !== primarySwitch.code);
  const metrics = getReadOnlyMetrics(device, functions);

  const isPrimaryOn = primarySwitch ? Boolean(device.status?.[primarySwitch.code]) : false;
  const onlineDotClass = device.isOnline ? 'bg-emerald-400' : 'bg-rose-500';
  const onlineBadgeClass = device.isOnline
    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
    : 'bg-rose-500/10 text-rose-300 border-rose-500/30';

  const metricsHtml =
    metrics.length > 0
      ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3" data-metrics-container>
          ${metrics
            .map((m) => {
              const isLowBattery = m.code.includes('battery') && Number(m.raw) <= 25;
              const valColor = isLowBattery ? 'text-amber-400' : 'text-slate-100';
              return `
                <div class="rounded-xl bg-slate-950/70 border border-slate-800/80 px-3 py-2" data-metric-code="${escapeHtml(m.code)}">
                  <div class="text-[10px] uppercase tracking-wider text-slate-400 truncate">${escapeHtml(m.label)}</div>
                  <div class="text-sm font-semibold mt-0.5 ${valColor}" data-metric-value>${escapeHtml(m.formatted)}</div>
                </div>
              `;
            })
            .join('')}
        </div>`
      : '';

  const secondaryHtml = secondaryFunctions.map((fn) => renderControlHtml(device, fn)).join('');

  card.innerHTML = `
    <div class="p-5 flex-1">
      <!-- Header: Estado + Nombre + Control Principal -->
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span data-online-badge class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${onlineBadgeClass}">
              <span data-online-dot class="h-1.5 w-1.5 rounded-full ${onlineDotClass}"></span>
              <span data-online-text>${device.isOnline ? 'Online' : 'Offline'}</span>
            </span>
            ${
              device.room
                ? `<span data-room-badge class="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/70">${escapeHtml(device.room)}</span>`
                : `<span data-room-badge class="hidden"></span>`
            }
            ${
              String(device.id).startsWith('demo_')
                ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">DEMO</span>`
                : ''
            }
          </div>
          <h3 data-display-name class="text-base font-semibold text-slate-100 truncate flex items-center gap-1.5">
            <span>${cat.icon}</span>
            <span class="truncate">${escapeHtml(device.displayName)}</span>
          </h3>
          <p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(cat.label)}${device.productName ? ` · ${escapeHtml(device.productName)}` : ''}</p>
        </div>

        ${
          primarySwitch
            ? `<div class="flex flex-col items-end gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked="${isPrimaryOn ? 'true' : 'false'}"
                  aria-label="Encender o apagar ${escapeHtml(device.displayName)}"
                  data-dp-control="boolean"
                  data-dp-code="${escapeHtml(primarySwitch.code)}"
                  data-primary-switch="true"
                  class="pg-toggle"
                  ${!device.isOnline ? 'disabled' : ''}
                >
                  <span class="pg-toggle-thumb"></span>
                </button>
                <span data-primary-label class="text-[10px] font-medium ${isPrimaryOn ? 'text-emerald-400' : 'text-slate-500'}">${isPrimaryOn ? 'ENCENDIDO' : 'APAGADO'}</span>
              </div>`
            : ''
        }
      </div>

      <!-- Lecturas clave (Sensores / Telemetría) -->
      ${metricsHtml}

      <!-- Controles dinámicos secundarios (Sliders, Enums, Toggles adicionales) -->
      <div class="divide-y divide-slate-800/70" data-controls-container>
        ${secondaryHtml}
      </div>

      <!-- Indicador sutil de envío en curso -->
      <div data-sending-bar class="hidden mt-2 text-[11px] text-sky-400 flex items-center gap-1.5">
        <span class="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 animate-ping"></span>
        <span>Sincronizando comando...</span>
      </div>
    </div>

    <!-- Divulgación progresiva: Acordeón colapsado por defecto + botón de ajustes -->
    <div class="border-t border-slate-800/80 bg-slate-950/40 px-5 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <details class="group flex-1 min-w-0">
          <summary class="list-none cursor-pointer select-none flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition">
            <svg class="w-3.5 h-3.5 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
            <span>Detalles técnicos y DPs</span>
          </summary>
          <div class="mt-3 pt-2 border-t border-slate-800/70 space-y-2">
            <div class="flex items-center justify-between text-[11px]">
              <span class="text-slate-500">ID Tuya</span>
              <span class="font-mono text-slate-300 select-all">${escapeHtml(device.id)}</span>
            </div>
            <table class="w-full text-left">
              <thead>
                <tr class="text-[10px] uppercase tracking-wider text-slate-500">
                  <th class="pb-1 font-medium">DP Code</th>
                  <th class="pb-1 text-right font-medium">Valor</th>
                </tr>
              </thead>
              <tbody data-dp-table-body>
                ${renderDpTableRows(device)}
              </tbody>
            </table>
          </div>
        </details>

        <button
          type="button"
          data-open-settings
          title="Configurar dispositivo"
          class="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition flex-shrink-0 self-start"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  bindCardEvents(card, device.id, { onSendCommand, onOpenSettings });
  return card;
}

function bindCardEvents(card, deviceId, { onSendCommand, onOpenSettings }) {
  const sendingBar = card.querySelector('[data-sending-bar]');

  const setSending = (busy) => {
    if (!sendingBar) return;
    sendingBar.classList.toggle('hidden', !busy);
  };

  // Botón de configuración
  card.querySelector('[data-open-settings]')?.addEventListener('click', () => {
    onOpenSettings(deviceId);
  });

  // Toggles booleanos
  card.querySelectorAll('[data-dp-control="boolean"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const code = btn.dataset.dpCode;
      const prev = btn.getAttribute('aria-checked') === 'true';
      const next = !prev;

      lockControl(deviceId, code);
      // Feedback optimista inmediato
      btn.setAttribute('aria-checked', String(next));
      if (btn.dataset.primarySwitch === 'true') {
        const lbl = card.querySelector('[data-primary-label]');
        if (lbl) {
          lbl.textContent = next ? 'ENCENDIDO' : 'APAGADO';
          lbl.className = `text-[10px] font-medium ${next ? 'text-emerald-400' : 'text-slate-500'}`;
        }
      }

      setSending(true);
      try {
        await onSendCommand(deviceId, [{ code, value: next }]);
      } catch {
        // Revertir si falló
        btn.setAttribute('aria-checked', String(prev));
        if (btn.dataset.primarySwitch === 'true') {
          const lbl = card.querySelector('[data-primary-label]');
          if (lbl) {
            lbl.textContent = prev ? 'ENCENDIDO' : 'APAGADO';
            lbl.className = `text-[10px] font-medium ${prev ? 'text-emerald-400' : 'text-slate-500'}`;
          }
        }
      } finally {
        setSending(false);
        unlockControl(deviceId, code);
      }
    });
  });

  // Sliders numéricos (con Interaction Lock mientras se arrastra)
  card.querySelectorAll('[data-dp-control="integer"]').forEach((slider) => {
    const code = slider.dataset.dpCode;
    const scale = Number(slider.dataset.scale || 0);
    const unit = slider.dataset.unit ? ` ${slider.dataset.unit}` : '';
    const displayEl = card.querySelector(`[data-slider-display="${CSS.escape(code)}"]`);

    const startLock = () => lockControl(deviceId, code);
    slider.addEventListener('pointerdown', startLock);
    slider.addEventListener('mousedown', startLock);
    slider.addEventListener('touchstart', startLock, { passive: true });
    slider.addEventListener('focus', startLock);

    // Feedback visual inmediato en tiempo real mientras arrastra (sin spamear la API)
    slider.addEventListener('input', () => {
      lockControl(deviceId, code);
      const num = Number(slider.value);
      const scaled = scale > 0 ? num / Math.pow(10, scale) : num;
      const formatted = formatNumber(scaled, scale > 0 ? scale : 0);
      if (displayEl) displayEl.textContent = `${formatted}${unit}`;
    });

    // Envía el comando al soltar / confirmar el valor
    slider.addEventListener('change', async () => {
      const value = Number(slider.value);
      setSending(true);
      try {
        await onSendCommand(deviceId, [{ code, value }]);
      } finally {
        setSending(false);
        unlockControl(deviceId, code, 600);
      }
    });

    slider.addEventListener('blur', () => unlockControl(deviceId, code, 400));
  });

  // Botones segmentados Enum
  card.querySelectorAll('[data-dp-control="enum-btn"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const code = btn.dataset.dpCode;
      const value = btn.dataset.dpValue;

      lockControl(deviceId, code);
      // Actualización optimista de estilo activo
      card.querySelectorAll(`[data-dp-control="enum-btn"][data-dp-code="${CSS.escape(code)}"]`).forEach((el) => {
        const isTarget = el.dataset.dpValue === value;
        el.className = `flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border capitalize transition ${
          isTarget
            ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
            : 'bg-slate-950/70 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200'
        }`;
      });

      setSending(true);
      try {
        await onSendCommand(deviceId, [{ code, value }]);
      } finally {
        setSending(false);
        unlockControl(deviceId, code);
      }
    });
  });

  // Selectores Enum (> 4 opciones)
  card.querySelectorAll('[data-dp-control="enum-select"]').forEach((sel) => {
    const code = sel.dataset.dpCode;
    sel.addEventListener('focus', () => lockControl(deviceId, code));
    sel.addEventListener('blur', () => unlockControl(deviceId, code, 400));
    sel.addEventListener('change', async () => {
      lockControl(deviceId, code);
      setSending(true);
      try {
        await onSendCommand(deviceId, [{ code, value: sel.value }]);
      } finally {
        setSending(false);
        unlockControl(deviceId, code, 500);
      }
    });
  });
}

/**
 * Actualiza una tarjeta existente en el DOM en tiempo real SIN destruir el nodo
 * y respetando los controles que el usuario está manipulando activamente.
 */
export function patchDeviceCard(card, device) {
  if (!card) return;

  // 1. Nombre y habitación
  const nameSpan = card.querySelector('[data-display-name] span:last-child');
  if (nameSpan) nameSpan.textContent = device.displayName;

  const roomBadge = card.querySelector('[data-room-badge]');
  if (roomBadge) {
    if (device.room) {
      roomBadge.textContent = device.room;
      roomBadge.className = 'text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/70';
    } else {
      roomBadge.className = 'hidden';
    }
  }

  // 2. Estado Online / Offline
  const onlineBadge = card.querySelector('[data-online-badge]');
  const onlineDot = card.querySelector('[data-online-dot]');
  const onlineText = card.querySelector('[data-online-text]');
  if (onlineBadge && onlineDot && onlineText) {
    onlineBadge.className = `inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${
      device.isOnline
        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
        : 'bg-rose-500/10 text-rose-300 border-rose-500/30'
    }`;
    onlineDot.className = `h-1.5 w-1.5 rounded-full ${device.isOnline ? 'bg-emerald-400' : 'bg-rose-500'}`;
    onlineText.textContent = device.isOnline ? 'Online' : 'Offline';
  }

  // 3. Controles booleanos (respetando lock)
  card.querySelectorAll('[data-dp-control="boolean"]').forEach((btn) => {
    const code = btn.dataset.dpCode;
    btn.disabled = !device.isOnline;
    if (isControlLocked(device.id, code)) return;

    const val = Boolean(device.status?.[code]);
    btn.setAttribute('aria-checked', String(val));
    if (btn.dataset.primarySwitch === 'true') {
      const lbl = card.querySelector('[data-primary-label]');
      if (lbl) {
        lbl.textContent = val ? 'ENCENDIDO' : 'APAGADO';
        lbl.className = `text-[10px] font-medium ${val ? 'text-emerald-400' : 'text-slate-500'}`;
      }
    }
  });

  // 4. Sliders numéricos (respetando lock)
  card.querySelectorAll('[data-dp-control="integer"]').forEach((slider) => {
    const code = slider.dataset.dpCode;
    slider.disabled = !device.isOnline;
    if (isControlLocked(device.id, code)) return;

    const rawVal = device.status?.[code];
    if (rawVal !== undefined) {
      slider.value = String(rawVal);
      const spec = getSchemaSpec(device, code);
      const displayEl = card.querySelector(`[data-slider-display="${CSS.escape(code)}"]`);
      if (displayEl) displayEl.textContent = formatScaledValue(rawVal, spec);
    }
  });

  // 5. Enums (botones y selects, respetando lock)
  card.querySelectorAll('[data-dp-control="enum-btn"]').forEach((btn) => {
    const code = btn.dataset.dpCode;
    btn.disabled = !device.isOnline;
    if (isControlLocked(device.id, code)) return;

    const isActive = String(device.status?.[code]) === String(btn.dataset.dpValue);
    btn.className = `flex-1 px-2 py-1.5 text-[11px] font-medium rounded-lg border capitalize transition ${
      isActive
        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
        : 'bg-slate-950/70 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200'
    }`;
  });

  card.querySelectorAll('[data-dp-control="enum-select"]').forEach((sel) => {
    const code = sel.dataset.dpCode;
    sel.disabled = !device.isOnline;
    if (isControlLocked(device.id, code)) return;
    if (device.status?.[code] !== undefined) sel.value = String(device.status[code]);
  });

  // 6. Métricas de solo lectura (sensores)
  card.querySelectorAll('[data-metric-code]').forEach((wrap) => {
    const code = wrap.dataset.metricCode;
    const valEl = wrap.querySelector('[data-metric-value]');
    if (!valEl) return;
    const raw = device.status?.[code];
    const spec = getSchemaSpec(device, code);
    valEl.textContent = formatScaledValue(raw, spec);
  });

  // 7. Tabla de detalles técnicos
  const tbody = card.querySelector('[data-dp-table-body]');
  if (tbody) {
    tbody.innerHTML = renderDpTableRows(device);
  }
}

export default { createDeviceCard, patchDeviceCard };
