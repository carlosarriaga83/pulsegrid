import api from './api.js';
import { connectSocket, onSocketEvent, emitDeviceCommand } from './socket.js';
import { createDeviceCard, patchDeviceCard } from './ui/deviceCard.js';
import {
  initAutomationsModule,
  handleLiveEvaluation,
  handleLiveTrigger,
} from './ui/automationBuilder.js';
import { showToast } from './ui/toast.js';

const state = {
  devices: new Map(),
  tuyaConfigured: false,
  weather: null,
  activeTab: 'devices',
  filters: {
    search: '',
    room: 'all',
    status: 'all', // all | online | offline
  },
  editingDeviceId: null,
};

// Referencias DOM
const els = {
  socketBadge: document.getElementById('socket-badge'),
  weatherPill: document.getElementById('weather-pill'),
  tuyaWarningBanner: document.getElementById('tuya-warning-banner'),
  syncBtn: document.getElementById('btn-sync-tuya'),
  seedDemoBtn: document.getElementById('btn-seed-demo'),
  clearDemoBtn: document.getElementById('btn-clear-demo'),
  searchInput: document.getElementById('filter-search'),
  statusFilter: document.getElementById('filter-status'),
  roomPills: document.getElementById('room-pills'),
  devicesGrid: document.getElementById('devices-grid'),
  emptyState: document.getElementById('devices-empty'),
  kpiTotal: document.getElementById('kpi-total'),
  kpiOnline: document.getElementById('kpi-online'),
  kpiOffline: document.getElementById('kpi-offline'),
  kpiActive: document.getElementById('kpi-active'),

  // Modal Dispositivo
  deviceModal: document.getElementById('device-modal'),
  deviceForm: document.getElementById('device-form'),
  deviceModalTitle: document.getElementById('device-modal-title'),
  inputCustomName: document.getElementById('input-custom-name'),
  inputRoom: document.getElementById('input-room'),
  inputNotifyOffline: document.getElementById('input-notify-offline'),
  inputOfflineCooldown: document.getElementById('input-offline-cooldown'),

  // Modal Ubicación / Clima
  locationModal: document.getElementById('location-modal'),
  locationForm: document.getElementById('location-form'),
  inputLocLabel: document.getElementById('input-loc-label'),
  inputLocLat: document.getElementById('input-loc-lat'),
  inputLocLon: document.getElementById('input-loc-lon'),
  inputLocTz: document.getElementById('input-loc-tz'),
};

function isDeviceActive(device) {
  const s = device.status || {};
  return Boolean(s.switch || s.switch_1 || s.switch_led || s.power_go);
}

function updateKpis() {
  const list = Array.from(state.devices.values());
  const online = list.filter((d) => d.isOnline).length;
  const offline = list.length - online;
  const active = list.filter((d) => d.isOnline && isDeviceActive(d)).length;

  els.kpiTotal.textContent = String(list.length);
  els.kpiOnline.textContent = String(online);
  els.kpiOffline.textContent = String(offline);
  els.kpiActive.textContent = String(active);

  const hasDemo = list.some((d) => String(d.id).startsWith('demo_'));
  els.clearDemoBtn?.classList.toggle('hidden', !hasDemo);
}

function renderRoomPills() {
  const rooms = new Set();
  for (const d of state.devices.values()) {
    if (d.room) rooms.add(d.room);
  }

  const sortedRooms = ['all', ...Array.from(rooms).sort((a, b) => a.localeCompare(b))];
  if (!sortedRooms.includes(state.filters.room)) {
    state.filters.room = 'all';
  }

  els.roomPills.innerHTML = sortedRooms
    .map((room) => {
      const active = state.filters.room === room;
      const label = room === 'all' ? 'Todas las zonas' : room;
      const cls = active
        ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
        : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-200';
      return `<button type="button" data-room-filter="${room.replace(/"/g, '&quot;')}" class="px-3 py-1 rounded-full text-xs font-medium border transition ${cls}">${label}</button>`;
    })
    .join('');

  els.roomPills.querySelectorAll('[data-room-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.room = btn.dataset.roomFilter;
      renderRoomPills();
      reconcileGrid();
    });
  });
}

function getFilteredDevices() {
  const q = state.filters.search.trim().toLowerCase();
  return Array.from(state.devices.values()).filter((d) => {
    if (state.filters.status === 'online' && !d.isOnline) return false;
    if (state.filters.status === 'offline' && d.isOnline) return false;
    if (state.filters.room !== 'all' && (d.room || '') !== state.filters.room) return false;
    if (q) {
      const hay = `${d.displayName} ${d.name} ${d.room || ''} ${d.category} ${d.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Reconcilia el grid de tarjetas preservando nodos existentes (para no interrumpir interacciones en vivo).
 */
function reconcileGrid() {
  const filtered = getFilteredDevices();
  const visibleIds = new Set(filtered.map((d) => d.id));

  // Eliminar tarjetas que ya no cumplen el filtro o fueron borradas
  els.devicesGrid.querySelectorAll('article[data-device-id]').forEach((card) => {
    if (!visibleIds.has(card.dataset.deviceId)) {
      card.remove();
    }
  });

  // Insertar o actualizar tarjetas existentes en el orden filtrado
  filtered.forEach((device) => {
    const existing = els.devicesGrid.querySelector(`article[data-device-id="${CSS.escape(device.id)}"]`);
    if (existing) {
      patchDeviceCard(existing, device);
    } else {
      const card = createDeviceCard(device, {
        onSendCommand: handleSendCommand,
        onOpenSettings: openDeviceModal,
      });
      els.devicesGrid.appendChild(card);
    }
  });

  const isEmpty = filtered.length === 0;
  els.emptyState.classList.toggle('hidden', !isEmpty);
  els.devicesGrid.classList.toggle('hidden', isEmpty);
}

async function handleSendCommand(deviceId, commands) {
  try {
    try {
      await emitDeviceCommand(deviceId, commands);
    } catch (wsErr) {
      if (wsErr.message === 'SOCKET_OFFLINE') {
        await api.sendCommands(deviceId, commands);
      } else {
        throw wsErr;
      }
    }
  } catch (err) {
    showToast(err.message || 'No se pudo enviar el comando', 'error');
    throw err;
  }
}

function applyDevicesSnapshot(devices, tuyaConfigured) {
  if (typeof tuyaConfigured === 'boolean') {
    state.tuyaConfigured = tuyaConfigured;
    els.tuyaWarningBanner?.classList.toggle('hidden', tuyaConfigured);
  }

  state.devices.clear();
  for (const dev of devices || []) {
    state.devices.set(dev.id, dev);
  }

  updateKpis();
  renderRoomPills();
  reconcileGrid();
}

function applySingleDeviceUpdate(device) {
  if (!device?.id) return;
  const prev = state.devices.get(device.id);
  state.devices.set(device.id, device);
  updateKpis();

  if (!prev || prev.room !== device.room) {
    renderRoomPills();
  }

  const card = els.devicesGrid.querySelector(`article[data-device-id="${CSS.escape(device.id)}"]`);
  if (card) {
    patchDeviceCard(card, device);
  } else {
    reconcileGrid();
  }
}

function renderWeatherPill(weather) {
  if (!weather?.current) return;
  state.weather = weather;
  const temp = weather.current.temperature !== null ? `${Math.round(weather.current.temperature)}°C` : '--°C';
  const sr = weather.solar?.sunrise ? weather.solar.sunrise.slice(11, 16) : '--:--';
  const ss = weather.solar?.sunset ? weather.solar.sunset.slice(11, 16) : '--:--';
  const icon = weather.current.isDay ? '☀️' : '🌙';

  els.weatherPill.innerHTML = `
    <span class="text-sm">${icon}</span>
    <span class="font-semibold text-slate-100">${temp}</span>
    <span class="hidden sm:inline text-slate-400">· ${weather.current.weatherLabel}</span>
    <span class="hidden lg:inline text-slate-500 text-[11px] border-l border-slate-700 pl-2">☀ ${sr} / ☾ ${ss}</span>
  `;
}

async function loadWeather(refresh = false) {
  try {
    const res = await api.getWeather(refresh);
    renderWeatherPill(res.data);
  } catch {
    els.weatherPill.innerHTML = '<span class="text-amber-400">Clima no disponible</span>';
  }
}

// --- Modales ---

function openDeviceModal(deviceId) {
  const device = state.devices.get(deviceId);
  if (!device) return;
  state.editingDeviceId = deviceId;

  els.deviceModalTitle.textContent = device.name;
  els.inputCustomName.value = device.customName || '';
  els.inputRoom.value = device.room || '';
  els.inputNotifyOffline.checked = Boolean(device.notifyOnOffline);
  els.inputOfflineCooldown.value = String(device.offlineCooldownMinutes || 60);

  els.deviceModal.classList.remove('hidden');
  els.deviceModal.classList.add('flex');
}

function closeDeviceModal() {
  state.editingDeviceId = null;
  els.deviceModal.classList.add('hidden');
  els.deviceModal.classList.remove('flex');
}

function openLocationModal() {
  const loc = state.weather?.location || {};
  els.inputLocLabel.value = loc.label || '';
  els.inputLocLat.value = loc.latitude ?? 19.4326;
  els.inputLocLon.value = loc.longitude ?? -99.1332;
  els.inputLocTz.value = loc.timezone || 'America/Mexico_City';

  els.locationModal.classList.remove('hidden');
  els.locationModal.classList.add('flex');
}

function closeLocationModal() {
  els.locationModal.classList.add('hidden');
  els.locationModal.classList.remove('flex');
}

// --- Navegación de pestañas ---

function setupTabs() {
  document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tabBtn;
      state.activeTab = target;

      document.querySelectorAll('[data-tab-btn]').forEach((b) => {
        const isActive = b.dataset.tabBtn === target;
        b.className = isActive
          ? 'px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-800 text-slate-100 border border-slate-700 transition'
          : 'px-3.5 py-2 text-xs font-medium rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent transition';
      });

      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.tabPanel !== target);
      });
    });
  });
}

// --- Inicialización ---

async function init() {
  setupTabs();

  // Eventos de filtros
  els.searchInput?.addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    reconcileGrid();
  });

  els.statusFilter?.addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    reconcileGrid();
  });

  // Botón sincronizar Tuya
  els.syncBtn?.addEventListener('click', async () => {
    els.syncBtn.disabled = true;
    const prevText = els.syncBtn.textContent;
    els.syncBtn.textContent = 'Sincronizando...';
    try {
      const res = await api.syncDevices();
      applyDevicesSnapshot(res.devices, res.synced ? true : state.tuyaConfigured);
      if (res.synced) {
        showToast(`Sincronización completa (${res.devices.length} dispositivos)`, 'success');
      } else {
        showToast(res.reason || 'Tuya Cloud no está configurada aún', 'warning');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      els.syncBtn.disabled = false;
      els.syncBtn.textContent = prevText;
    }
  });

  // Botones Demo (pruebas en Hostinger antes de vincular Tuya)
  const triggerSeedDemo = async () => {
    try {
      const res = await api.seedDemoDevices();
      applyDevicesSnapshot(res.data, state.tuyaConfigured);
      showToast('Dispositivos de ejemplo cargados (interactivos en tiempo real)', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  els.seedDemoBtn?.addEventListener('click', triggerSeedDemo);
  document.getElementById('btn-empty-demo')?.addEventListener('click', triggerSeedDemo);

  els.clearDemoBtn?.addEventListener('click', async () => {
    try {
      const res = await api.clearDemoDevices();
      applyDevicesSnapshot(res.data, state.tuyaConfigured);
      showToast('Dispositivos de ejemplo eliminados', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Modales
  els.weatherPill?.addEventListener('click', openLocationModal);
  document.querySelectorAll('[data-close-device-modal]').forEach((el) => el.addEventListener('click', closeDeviceModal));
  document.querySelectorAll('[data-close-location-modal]').forEach((el) => el.addEventListener('click', closeLocationModal));

  els.deviceForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingDeviceId) return;
    try {
      const res = await api.updateDevice(state.editingDeviceId, {
        customName: els.inputCustomName.value,
        room: els.inputRoom.value,
        notifyOnOffline: els.inputNotifyOffline.checked,
        offlineCooldownMinutes: Number(els.inputOfflineCooldown.value || 60),
      });
      applySingleDeviceUpdate(res.data);
      closeDeviceModal();
      showToast('Configuración del dispositivo guardada', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  els.locationForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api.saveLocation({
        label: els.inputLocLabel.value,
        latitude: Number(els.inputLocLat.value),
        longitude: Number(els.inputLocLon.value),
        timezone: els.inputLocTz.value,
      });
      renderWeatherPill(res.weather);
      closeLocationModal();
      showToast('Ubicación de Open-Meteo actualizada', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Conexión Socket.io en tiempo real
  connectSocket();

  onSocketEvent('status', ({ connected }) => {
    if (connected) {
      els.socketBadge.innerHTML = '<span class="h-2 w-2 rounded-full bg-emerald-400"></span><span>Tiempo real</span>';
      els.socketBadge.className =
        'inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30';
    } else {
      els.socketBadge.innerHTML = '<span class="h-2 w-2 rounded-full bg-rose-400"></span><span>Reconectando...</span>';
      els.socketBadge.className =
        'inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/30';
    }
  });

  onSocketEvent('snapshot', (payload) => {
    applyDevicesSnapshot(payload.devices, payload.tuyaConfigured);
  });

  onSocketEvent('deviceUpdate', (payload) => {
    applySingleDeviceUpdate(payload.device);
  });

  onSocketEvent('weatherUpdate', (weather) => {
    renderWeatherPill(weather);
  });

  onSocketEvent('automationEvaluated', (payload) => {
    handleLiveEvaluation(payload);
  });

  onSocketEvent('automationTriggered', (payload) => {
    handleLiveTrigger(payload);
  });

  // Carga inicial vía REST (fallback instantáneo mientras conecta Socket.io)
  try {
    const devRes = await api.getDevices(false);
    applyDevicesSnapshot(devRes.data, devRes.tuyaConfigured);
  } catch (err) {
    showToast(`Error cargando dispositivos: ${err.message}`, 'error');
  }

  loadWeather(false);

  // Inicializar módulo de automatizaciones (Fase 4)
  initAutomationsModule({
    getDevices: () => Array.from(state.devices.values()),
  });
}

init();
