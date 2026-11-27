import { MysaApiClient } from 'mysa-js-sdk';
import env from '../config/env.js';
import { query } from '../config/db.js';
import logger from '../utils/logger.js';

const MYSA_PREFIX = 'mysa_';

const MYSA_MODE_ID_TO_STR = {
  1: 'off',
  2: 'auto',
  3: 'heat',
  4: 'cool',
  5: 'fan_only',
  6: 'dry',
};

let client = null;
let lastSyncAt = 0;
let lastSyncError = null;
let realtimeActiveIds = new Set();
let onRealtimeDeviceUpdate = null;

export function registerRealtimeCallback(fn) {
  onRealtimeDeviceUpdate = fn;
}

export function isMysaDeviceId(deviceId) {
  return String(deviceId || '').startsWith(MYSA_PREFIX);
}

export function toRawMysaId(deviceId) {
  return String(deviceId || '').replace(/^mysa_/, '');
}

export function toPulsegridMysaId(rawId) {
  return `${MYSA_PREFIX}${rawId}`;
}

export function isMysaConfigured() {
  return Boolean(env.mysa.username && env.mysa.password);
}

function parseJsonSafe(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

async function loadSavedSession() {
  try {
    const rows = await query(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'mysa_session' LIMIT 1"
    );
    if (rows.length > 0) {
      const parsed = parseJsonSafe(rows[0].setting_value);
      if (parsed && parsed.username === env.mysa.username && parsed.refreshToken) {
        return parsed;
      }
    }
  } catch (err) {
    logger.debug('No se pudo cargar sesión Mysa guardada', { error: err.message });
  }
  return undefined;
}

async function saveSession(session) {
  if (!session) return;
  try {
    await query(
      `INSERT INTO app_settings (setting_key, setting_value, description)
       VALUES ('mysa_session', ?, 'Sesión Cognito persistida de mysa-js-sdk')
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(session)]
    );
  } catch (err) {
    logger.warn('No se pudo persistir sesión Mysa', { error: err.message });
  }
}

function buildMysaSchema(dev) {
  const isAC = Boolean(dev?.SupportedCaps || String(dev?.Model || '').toUpperCase().includes('AC'));
  const minSp = Math.round((Number(dev?.MinSetpoint) || 5) * 10);
  const maxSp = Math.round((Number(dev?.MaxSetpoint) || 30) * 10);
  const modes = isAC ? ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'] : ['off', 'heat'];

  const functions = [
    { code: 'switch', name: 'Encendido', type: 'Boolean', values: '{}', parsedValues: {} },
    {
      code: 'temp_set',
      name: 'Temperatura objetivo',
      type: 'Integer',
      values: JSON.stringify({ min: minSp, max: maxSp, scale: 1, step: 5, unit: '°C' }),
      parsedValues: { min: minSp, max: maxSp, scale: 1, step: 5, unit: '°C' },
    },
    {
      code: 'mode',
      name: 'Modo',
      type: 'Enum',
      values: JSON.stringify({ range: modes }),
      parsedValues: { range: modes },
    },
  ];

  if (isAC) {
    const fanRange = ['auto', 'low', 'medium', 'high', 'max'];
    functions.push({
      code: 'fan_speed',
      name: 'Velocidad ventilador',
      type: 'Enum',
      values: JSON.stringify({ range: fanRange }),
      parsedValues: { range: fanRange },
    });
  }

  const status = [
    ...functions,
    { code: 'temp_current', name: 'Temperatura actual', type: 'Integer', values: '{"scale":1,"unit":"°C"}', parsedValues: { scale: 1, unit: '°C' } },
    { code: 'humidity', name: 'Humedad', type: 'Integer', values: '{"scale":0,"unit":"%"}', parsedValues: { scale: 0, unit: '%' } },
    { code: 'duty_cycle', name: 'Ciclo de potencia', type: 'Integer', values: '{"min":0,"max":100,"scale":0,"unit":"%"}', parsedValues: { min: 0, max: 100, scale: 0, unit: '%' } },
    { code: 'cur_current', name: 'Corriente', type: 'Integer', values: '{"scale":1,"unit":"A"}', parsedValues: { scale: 1, unit: 'A' } },
    { code: 'cur_voltage', name: 'Voltaje', type: 'Integer', values: '{"scale":0,"unit":"V"}', parsedValues: { scale: 0, unit: 'V' } },
  ];

  return {
    category: 'wk',
    source: 'mysa_sdk',
    isAC,
    functions,
    status,
  };
}

function mapMysaStateToStatus(state = {}, prevStatus = {}) {
  const modeNum = state.Mode?.v ?? state.TstatMode?.v;
  const mode = MYSA_MODE_ID_TO_STR[modeNum] || prevStatus.mode || 'heat';
  const tempRaw = state.CorrectedTemp?.v ?? state.SensorTemp?.v;
  const setPointRaw = state.SetPoint?.v;
  const humidityRaw = state.Humidity?.v;
  const dutyRaw = state.Duty?.v;
  const currentRaw = state.Current?.v;
  const voltageRaw = state.Voltage?.v;

  const status = {
    ...prevStatus,
    switch: mode !== 'off',
    mode,
  };

  if (tempRaw !== undefined && tempRaw !== null) status.temp_current = Math.round(Number(tempRaw) * 10);
  if (setPointRaw !== undefined && setPointRaw !== null) status.temp_set = Math.round(Number(setPointRaw) * 10);
  if (humidityRaw !== undefined && humidityRaw !== null) status.humidity = Math.round(Number(humidityRaw));
  if (dutyRaw !== undefined && dutyRaw !== null) status.duty_cycle = Math.round(Number(dutyRaw) <= 1 && Number(dutyRaw) > 0 ? Number(dutyRaw) * 100 : Number(dutyRaw));
  if (currentRaw !== undefined && currentRaw !== null) status.cur_current = Math.round(Number(currentRaw) * 10);
  if (voltageRaw !== undefined && voltageRaw !== null) status.cur_voltage = Math.round(Number(voltageRaw));

  return status;
}

async function applyRealtimePatch(rawId, patch) {
  const pgId = toPulsegridMysaId(rawId);
  const rows = await query('SELECT * FROM devices WHERE id = ? LIMIT 1', [pgId]);
  if (rows.length === 0) return;

  const row = rows[0];
  const prevStatus = parseJsonSafe(row.last_status) || {};
  const nextStatus = { ...prevStatus, ...patch };

  await query(
    'UPDATE devices SET last_status = ?, is_online = 1, last_online_at = UTC_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(nextStatus), pgId]
  );

  const formatted = {
    id: row.id,
    name: row.name,
    customName: row.custom_name,
    displayName: row.custom_name || row.name,
    category: row.category,
    productId: row.product_id,
    productName: row.product_name,
    iconUrl: row.icon_url,
    room: row.room,
    isOnline: true,
    lastOnlineAt: new Date().toISOString(),
    dpSchema: parseJsonSafe(row.dp_schema),
    status: nextStatus,
    notifyOnOffline: Boolean(row.notify_on_offline),
    offlineCooldownMinutes: row.offline_cooldown_minutes,
    updatedAt: new Date().toISOString(),
  };

  if (typeof onRealtimeDeviceUpdate === 'function') {
    onRealtimeDeviceUpdate(formatted);
  }
}

async function getAuthenticatedClient() {
  if (!isMysaConfigured()) {
    throw new Error('Mysa no está configurado. Define MYSA_USERNAME y MYSA_PASSWORD en .env');
  }

  if (!client) {
    const saved = await loadSavedSession();
    client = new MysaApiClient(saved, {
      logger: {
        debug: () => {},
        info: (msg) => logger.debug(`[Mysa] ${msg}`),
        warn: (msg) => logger.warn(`[Mysa] ${msg}`),
        error: (msg) => logger.error(`[Mysa] ${msg}`),
      },
    });

    client.emitter.on('sessionChanged', (session) => {
      saveSession(session);
    });

    client.emitter.on('statusChanged', (st) => {
      const patch = {};
      if (st.temperature !== undefined) patch.temp_current = Math.round(Number(st.temperature) * 10);
      if (st.humidity !== undefined) patch.humidity = Math.round(Number(st.humidity));
      if (st.setPoint !== undefined) patch.temp_set = Math.round(Number(st.setPoint) * 10);
      if (st.current !== undefined) patch.cur_current = Math.round(Number(st.current) * 10);
      if (st.dutyCycle !== undefined) {
        const d = Number(st.dutyCycle);
        patch.duty_cycle = Math.round(d <= 1 && d > 0 ? d * 100 : d);
      }
      applyRealtimePatch(st.deviceId, patch).catch((err) =>
        logger.warn(`Error aplicando statusChanged Mysa (${st.deviceId})`, { error: err.message })
      );
    });

    client.emitter.on('setPointChanged', (ev) => {
      if (ev.newSetPoint !== undefined) {
        applyRealtimePatch(ev.deviceId, { temp_set: Math.round(Number(ev.newSetPoint) * 10) }).catch(() => {});
      }
    });

    client.emitter.on('stateChanged', (ev) => {
      const patch = {};
      if (ev.setPoint !== undefined) patch.temp_set = Math.round(Number(ev.setPoint) * 10);
      if (ev.mode) {
        patch.mode = ev.mode;
        patch.switch = ev.mode !== 'off';
      }
      if (ev.fanSpeed) patch.fan_speed = ev.fanSpeed;
      applyRealtimePatch(ev.deviceId, patch).catch(() => {});
    });
  }

  if (!client.isAuthenticated) {
    await client.login(env.mysa.username, env.mysa.password);
  }

  return client;
}

/**
 * Sincroniza todos los termostatos Mysa hacia la tabla devices de MySQL
 * y activa suscripción MQTT en tiempo real si MYSA_REALTIME_ENABLED=true.
 */
export async function syncMysaDevices() {
  if (!isMysaConfigured()) {
    return { synced: false, count: 0 };
  }

  try {
    const apiClient = await getAuthenticatedClient();
    const [devicesRes, statesRes] = await Promise.all([
      apiClient.getDevices(),
      apiClient.getDeviceStates(),
    ]);

    const devicesObj = devicesRes?.DevicesObj || {};
    const statesObj = statesRes?.DeviceStatesObj || {};
    const rawIds = Object.keys(devicesObj);

    for (const rawId of rawIds) {
      const dev = devicesObj[rawId];
      const state = statesObj[rawId] || {};
      const pgId = toPulsegridMysaId(rawId);
      const schema = buildMysaSchema(dev);

      const existingRows = await query('SELECT last_status FROM devices WHERE id = ? LIMIT 1', [pgId]);
      const prevStatus = existingRows.length > 0 ? parseJsonSafe(existingRows[0].last_status) || {} : {};
      const statusMap = mapMysaStateToStatus(state, prevStatus);
      const isOnline = state.Connected?.v !== undefined ? Boolean(state.Connected.v) : true;
      const name = dev.Name || `Mysa ${dev.Model || rawId.slice(-4)}`;

      await query(
        `INSERT INTO devices (id, name, category, product_id, product_name, room, is_online, last_online_at, dp_schema, last_status)
         VALUES (?, ?, 'wk', ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           product_name = VALUES(product_name),
           is_online = VALUES(is_online),
           last_online_at = IF(VALUES(is_online) = 1, UTC_TIMESTAMP(), last_online_at),
           dp_schema = VALUES(dp_schema),
           last_status = VALUES(last_status),
           updated_at = CURRENT_TIMESTAMP`,
        [
          pgId,
          name,
          dev.Model || 'mysa',
          `Mysa ${dev.Model || 'Thermostat'}`,
          dev.Zone || null,
          isOnline ? 1 : 0,
          isOnline ? new Date() : null,
          JSON.stringify(schema),
          JSON.stringify(statusMap),
        ]
      );

      if (env.mysa.realtimeEnabled && !realtimeActiveIds.has(rawId)) {
        try {
          await apiClient.startRealtimeUpdates(rawId);
          realtimeActiveIds.add(rawId);
        } catch (rtErr) {
          logger.warn(`No se pudo iniciar MQTT en vivo para Mysa ${rawId}`, { error: rtErr.message });
        }
      }
    }

    lastSyncAt = Date.now();
    lastSyncError = null;
    logger.info(`Mysa sincronizado: ${rawIds.length} termostato(s)`);
    return { synced: true, count: rawIds.length };
  } catch (err) {
    lastSyncError = { message: err.message, at: new Date().toISOString() };
    logger.error('Error sincronizando termostatos Mysa', err);
    throw err;
  }
}

/**
 * Envía comandos desde PulseGrid (switch, temp_set, mode, fan_speed) a un termostato Mysa vía MQTT.
 */
export async function sendMysaCommands(deviceId, commands) {
  const rawId = toRawMysaId(deviceId);
  const apiClient = await getAuthenticatedClient();

  const rows = await query('SELECT * FROM devices WHERE id = ? LIMIT 1', [deviceId]);
  if (rows.length === 0) {
    const err = new Error(`Termostato Mysa '${deviceId}' no encontrado`);
    err.statusCode = 404;
    throw err;
  }

  const row = rows[0];
  const prevStatus = parseJsonSafe(row.last_status) || {};
  const dpSchema = parseJsonSafe(row.dp_schema) || {};

  let setPoint;
  let mode;
  let fanSpeed;
  const nextStatus = { ...prevStatus };

  for (const cmd of commands) {
    if (cmd.code === 'temp_set') {
      const rawNum = Number(cmd.value);
      // En PulseGrid temp_set tiene scale: 1 (ej. 215 = 21.5°C); si llega <= 40 asumimos grados directos
      const celsius = rawNum > 45 ? Number((rawNum / 10).toFixed(1)) : Number(rawNum.toFixed(1));
      setPoint = celsius;
      nextStatus.temp_set = Math.round(celsius * 10);
    } else if (cmd.code === 'mode') {
      mode = String(cmd.value);
      nextStatus.mode = mode;
      nextStatus.switch = mode !== 'off';
    } else if (cmd.code === 'switch') {
      const turnOn = cmd.value === true || cmd.value === 'true' || cmd.value === 1;
      mode = turnOn ? (prevStatus.mode && prevStatus.mode !== 'off' ? prevStatus.mode : 'heat') : 'off';
      nextStatus.switch = turnOn;
      nextStatus.mode = mode;
    } else if (cmd.code === 'fan_speed') {
      fanSpeed = String(cmd.value);
      nextStatus.fan_speed = fanSpeed;
    }
  }

  await apiClient.setDeviceState(rawId, setPoint, mode, fanSpeed);

  await query('UPDATE devices SET last_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    JSON.stringify(nextStatus),
    deviceId,
  ]);

  return {
    deviceId,
    commands,
    device: {
      id: row.id,
      name: row.name,
      customName: row.custom_name,
      displayName: row.custom_name || row.name,
      category: row.category,
      productId: row.product_id,
      productName: row.product_name,
      iconUrl: row.icon_url,
      room: row.room,
      isOnline: Boolean(row.is_online),
      lastOnlineAt: row.last_online_at,
      dpSchema,
      status: nextStatus,
      notifyOnOffline: Boolean(row.notify_on_offline),
      offlineCooldownMinutes: row.offline_cooldown_minutes,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function stopMysaRealtime() {
  if (!client || realtimeActiveIds.size === 0) return;
  for (const rawId of realtimeActiveIds) {
    try {
      await client.stopRealtimeUpdates(rawId);
    } catch {
      // ignore on shutdown
    }
  }
  realtimeActiveIds.clear();
  logger.info('Suscripciones MQTT de Mysa cerradas correctamente');
}

export function getMysaStatus() {
  return {
    configured: isMysaConfigured(),
    authenticated: Boolean(client?.isAuthenticated),
    realtimeSubscriptions: realtimeActiveIds.size,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    lastSyncError,
  };
}

export default {
  isMysaDeviceId,
  isMysaConfigured,
  registerRealtimeCallback,
  syncMysaDevices,
  sendMysaCommands,
  stopMysaRealtime,
  getMysaStatus,
};
