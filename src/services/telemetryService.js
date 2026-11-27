import { query, pool } from '../config/db.js';
import env from '../config/env.js';
import tuyaService from './tuyaService.js';
import mysaService from './mysaService.js';
import weatherService from './weatherService.js';
import logger from '../utils/logger.js';

export const WEATHER_DEVICE_ID = 'weather_openmeteo';

const WEATHER_METRICS_META = [
  { code: 'weather_temperature', label: 'Temperatura exterior', unit: '°C', field: 'temperature', hourlyField: 'temperature_2m', valueType: 'number' },
  { code: 'weather_apparent_temp', label: 'Sensación térmica', unit: '°C', field: 'apparentTemperature', hourlyField: 'apparent_temperature', valueType: 'number' },
  { code: 'weather_humidity', label: 'Humedad exterior', unit: '%', field: 'humidity', hourlyField: 'relative_humidity_2m', valueType: 'number' },
  { code: 'weather_wind_speed', label: 'Viento exterior', unit: 'km/h', field: 'windSpeed', hourlyField: 'wind_speed_10m', valueType: 'number' },
  { code: 'weather_precipitation', label: 'Precipitación', unit: 'mm', field: 'precipitation', hourlyField: 'precipitation', valueType: 'number' },
  { code: 'weather_is_day', label: 'Luz solar (Día / Noche)', unit: '', field: 'isDay', hourlyField: 'is_day', valueType: 'boolean' },
];

const FRIENDLY_DP_LABELS = {
  switch: 'Interruptor',
  switch_1: 'Interruptor 1',
  switch_2: 'Interruptor 2',
  switch_led: 'Luz',
  switch_led_1: 'Luz 1',
  switch_usb1: 'USB 1',
  temp_current: 'Temperatura actual',
  temp_set: 'Temperatura objetivo',
  va_temperature: 'Temperatura',
  va_humidity: 'Humedad',
  humidity: 'Humedad',
  humidity_value: 'Humedad',
  cur_power: 'Potencia actual',
  cur_power_a: 'Potencia Canal A',
  cur_power_b: 'Potencia Canal B',
  power_a: 'Potencia Canal A',
  power_b: 'Potencia Canal B',
  total_power: 'Potencia total',
  cur_voltage: 'Voltaje',
  voltage_a: 'Voltaje A',
  cur_current: 'Corriente',
  cur_current_a: 'Corriente Canal A',
  cur_current_b: 'Corriente Canal B',
  current_a: 'Corriente Canal A',
  current_b: 'Corriente Canal B',
  add_ele: 'Energía acumulada',
  total_forward_energy: 'Energía directa total',
  forward_energy_total: 'Energía directa total',
  reverse_energy_total: 'Energía inversa total',
  energy_forword_a: 'Energía directa A',
  energy_forword_b: 'Energía directa B',
  energy_reverse_a: 'Energía inversa A',
  energy_reverse_b: 'Energía inversa B',
  power_factor: 'Factor de potencia',
  power_factor_a: 'Factor de potencia A',
  power_factor_b: 'Factor de potencia B',
  freq: 'Frecuencia',
  bright_value: 'Brillo',
  bright_value_1: 'Brillo 1',
  bright_value_v2: 'Brillo',
  temp_value: 'Temperatura color',
  temp_value_v2: 'Temperatura color',
  battery_percentage: 'Batería',
  fan_speed_percent: 'Velocidad ventilador',
  backlight: 'Retroiluminación',
  weather_temperature: 'Temperatura exterior',
  weather_apparent_temp: 'Sensación térmica',
  weather_humidity: 'Humedad exterior',
  weather_wind_speed: 'Viento exterior',
  weather_precipitation: 'Precipitación',
  weather_is_day: 'Luz solar (Día / Noche)',
};

function hasCJK(str) {
  return /[\u3400-\u9fff]/.test(String(str || ''));
}

function getFriendlyDpLabel(dpCode, rawName) {
  if (FRIENDLY_DP_LABELS[dpCode]) return FRIENDLY_DP_LABELS[dpCode];
  if (rawName && !hasCJK(rawName) && rawName !== dpCode) return rawName;
  return String(dpCode || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const UNIT_TRANSLATIONS = { '秒': 's', '分钟': 'min', '小时': 'h', '℃': '°C', '℉': '°F', '%RH': '%' };

function cleanUnit(rawUnit) {
  if (!rawUnit) return '';
  const u = String(rawUnit).trim();
  if (UNIT_TRANSLATIONS[u]) return UNIT_TRANSLATIONS[u];
  if (hasCJK(u)) return '';
  return u;
}

function getDpMeta(device, dpCode) {
  if (device?.id === WEATHER_DEVICE_ID) {
    const wm = WEATHER_METRICS_META.find((m) => m.code === dpCode);
    if (wm) {
      return {
        label: wm.label,
        scale: 0,
        unit: wm.unit,
        specType: wm.valueType === 'boolean' ? 'boolean' : 'integer',
      };
    }
  }
  const specs = [...(device?.dpSchema?.functions || []), ...(device?.dpSchema?.status || [])];
  const spec = specs.find((s) => s.code === dpCode);
  return {
    label: getFriendlyDpLabel(dpCode, spec?.name),
    scale: Number(spec?.parsedValues?.scale || 0),
    unit: cleanUnit(spec?.parsedValues?.unit || ''),
    specType: String(spec?.type || '').toLowerCase(),
  };
}

/**
 * Asegura la existencia del registro virtual 'weather_openmeteo' en devices
 * para cumplir la clave foránea de telemetry_logs sin aparecer en la lista Tuya.
 */
async function ensureWeatherDeviceRow(weatherData = null) {
  const locLabel = weatherData?.location?.label || 'Exterior';
  const statusObj = {};
  if (weatherData?.current) {
    for (const m of WEATHER_METRICS_META) {
      if (weatherData.current[m.field] !== null && weatherData.current[m.field] !== undefined) {
        statusObj[m.code] = Number(weatherData.current[m.field]);
      }
    }
  }

  await query(
    `INSERT INTO devices (id, name, category, product_name, room, is_online, last_online_at, last_status)
     VALUES (?, 'Clima Exterior (Open-Meteo)', 'weather', 'Open-Meteo API', ?, 1, UTC_TIMESTAMP(), ?)
     ON DUPLICATE KEY UPDATE
       room = VALUES(room),
       is_online = 1,
       last_online_at = UTC_TIMESTAMP(),
       last_status = IF(VALUES(last_status) = '{}', last_status, VALUES(last_status)),
       updated_at = CURRENT_TIMESTAMP`,
    [WEATHER_DEVICE_ID, locLabel, JSON.stringify(statusObj)]
  );
}

/**
 * Si aún no hay historial de clima en telemetry_logs, precarga las últimas 48h reales
 * desde Open-Meteo (hourly + past_days=2) para que la curva esté disponible de inmediato.
 */
async function backfillInitialWeatherHistoryIfEmpty() {
  const existingRows = await query(
    'SELECT dp_code, COUNT(*) AS cnt FROM telemetry_logs WHERE device_id = ? GROUP BY dp_code',
    [WEATHER_DEVICE_ID]
  );
  const existingMap = new Map(existingRows.map((r) => [r.dp_code, Number(r.cnt || 0)]));
  const missingMetrics = WEATHER_METRICS_META.filter((m) => (existingMap.get(m.code) || 0) === 0);
  if (missingMetrics.length === 0) return 0;

  const loc = await weatherService.getLocationSettings();
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    hourly: missingMetrics.map((m) => m.hourlyField).join(','),
    past_days: '2',
    forecast_days: '1',
    timezone: 'GMT',
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) return 0;
  const data = await res.json();
  const times = data?.hourly?.time || [];
  const nowMs = Date.now();
  const rows = [];

  for (let i = 0; i < times.length; i++) {
    const dt = new Date(`${times[i]}Z`);
    if (Number.isNaN(dt.getTime()) || dt.getTime() > nowMs) continue;
    for (const m of missingMetrics) {
      const val = data.hourly?.[m.hourlyField]?.[i];
      if (val === undefined || val === null || Number.isNaN(Number(val))) continue;
      if (m.valueType === 'boolean') {
        const b = Number(val) >= 1;
        rows.push([WEATHER_DEVICE_ID, m.code, 'boolean', b ? 1 : 0, b ? 'true' : 'false', dt]);
      } else {
        rows.push([WEATHER_DEVICE_ID, m.code, 'number', Number(val), null, dt]);
      }
    }
  }

  if (rows.length === 0) return 0;

  const chunkSize = 400;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    await pool.execute(
      `INSERT INTO telemetry_logs (device_id, dp_code, value_type, value_numeric, value_text, recorded_at)
       VALUES ${placeholders}`,
      chunk.flat()
    );
  }
  logger.info(`Historial inicial de clima Open-Meteo precargado: ${rows.length} lecturas (48h)`);
  return rows.length;
}

/**
 * Captura y guarda en telemetry_logs la temperatura y variables de clima de Open-Meteo.
 */
export async function recordWeatherTelemetry() {
  const weather = await weatherService.getWeather(false);
  if (!weather?.current) return 0;

  await ensureWeatherDeviceRow(weather);
  await backfillInitialWeatherHistoryIfEmpty().catch((err) => {
    logger.warn('No se pudo precargar historial de 48h de Open-Meteo', { error: err.message });
  });

  const placeholders = [];
  const params = [];

  for (const m of WEATHER_METRICS_META) {
    const val = weather.current[m.field];
    if (val === undefined || val === null) continue;
    if (m.valueType === 'boolean') {
      const b = Boolean(val);
      placeholders.push('(?, ?, ?, ?, ?, UTC_TIMESTAMP())');
      params.push(WEATHER_DEVICE_ID, m.code, 'boolean', b ? 1 : 0, b ? 'true' : 'false');
    } else if (!Number.isNaN(Number(val))) {
      placeholders.push('(?, ?, ?, ?, ?, UTC_TIMESTAMP())');
      params.push(WEATHER_DEVICE_ID, m.code, 'number', Number(val), null);
    }
  }

  if (placeholders.length === 0) return 0;

  await pool.execute(
    `INSERT INTO telemetry_logs (device_id, dp_code, value_type, value_numeric, value_text, recorded_at)
     VALUES ${placeholders.join(', ')}`,
    params
  );

  return placeholders.length;
}

function normalizeForTelemetry(rawValue, meta) {
  if (typeof rawValue === 'boolean') {
    return {
      valueType: 'boolean',
      valueNumeric: rawValue ? 1 : 0,
      valueText: rawValue ? 'true' : 'false',
    };
  }
  if (typeof rawValue === 'number' || (meta.specType === 'integer' && !Number.isNaN(Number(rawValue)))) {
    const num = Number(rawValue);
    const scaled = meta.scale > 0 ? Number((num / Math.pow(10, meta.scale)).toFixed(meta.scale)) : num;
    return {
      valueType: 'number',
      valueNumeric: scaled,
      valueText: null,
    };
  }
  if (typeof rawValue === 'object' && rawValue !== null) {
    return {
      valueType: 'json',
      valueNumeric: null,
      valueText: JSON.stringify(rawValue).slice(0, 255),
    };
  }
  return {
    valueType: 'string',
    valueNumeric: null,
    valueText: String(rawValue).slice(0, 255),
  };
}

/**
 * Registra en MySQL un snapshot de los DPs actuales de un dispositivo.
 */
export async function recordDeviceSnapshot(device) {
  if (!device?.id || !device.status) return 0;
  const entries = Object.entries(device.status);
  if (entries.length === 0) return 0;

  const placeholders = [];
  const params = [];

  for (const [code, rawVal] of entries) {
    if (rawVal === undefined || rawVal === null) continue;
    const meta = getDpMeta(device, code);
    const norm = normalizeForTelemetry(rawVal, meta);
    placeholders.push('(?, ?, ?, ?, ?, UTC_TIMESTAMP())');
    params.push(device.id, code, norm.valueType, norm.valueNumeric, norm.valueText);
  }

  if (placeholders.length === 0) return 0;

  await pool.execute(
    `INSERT INTO telemetry_logs (device_id, dp_code, value_type, value_numeric, value_text, recorded_at)
     VALUES ${placeholders.join(', ')}`,
    params
  );

  return placeholders.length;
}

/**
 * Registra cambios puntuales (ej. tras enviar un comando desde el dashboard o automatización).
 */
export async function recordCommandsTelemetry(device, commands) {
  if (!device?.id || !Array.isArray(commands) || commands.length === 0) return 0;

  const placeholders = [];
  const params = [];

  for (const cmd of commands) {
    const meta = getDpMeta(device, cmd.code);
    const norm = normalizeForTelemetry(cmd.value, meta);
    placeholders.push('(?, ?, ?, ?, ?, UTC_TIMESTAMP())');
    params.push(device.id, cmd.code, norm.valueType, norm.valueNumeric, norm.valueText);
  }

  await pool.execute(
    `INSERT INTO telemetry_logs (device_id, dp_code, value_type, value_numeric, value_text, recorded_at)
     VALUES ${placeholders.join(', ')}`,
    params
  );

  return placeholders.length;
}

/**
 * Registra snapshot periódico de todos los dispositivos online.
 * Si Tuya está configurada, fuerza primero una sincronización fresca para no guardar estados obsoletos o vacíos.
 */
export async function captureAllDevicesTelemetry() {
  if (tuyaService.isTuyaConfigured() || mysaService.isMysaConfigured()) {
    try {
      await tuyaService.syncDevices();
    } catch (err) {
      logger.warn('Sync previo a captura de telemetría falló, usando caché', { error: err.message });
    }
  }

  const devices = await tuyaService.getDevices(false);
  let totalInserted = 0;

  // Capturar siempre las variables de clima exterior (Open-Meteo)
  try {
    totalInserted += await recordWeatherTelemetry();
  } catch (err) {
    logger.warn('Error guardando telemetría de clima Open-Meteo', { error: err.message });
  }

  for (const dev of devices) {
    if (!dev.isOnline) continue;
    try {
      totalInserted += await recordDeviceSnapshot(dev);
    } catch (err) {
      logger.warn(`Error guardando telemetría de ${dev.id}`, { error: err.message });
    }
  }
  return totalInserted;
}

/**
 * Downsampling conservando primer, último y picos locales cuando una serie tiene miles de puntos.
 */
function downsamplePoints(points, maxPoints = 2000) {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const sampled = [points[0]];

  for (let i = 1; i < points.length - 1; i += bucketSize) {
    const slice = points.slice(i, Math.min(i + bucketSize, points.length - 1));
    if (slice.length === 0) continue;
    // Elegir punto medio o extremo del bucket para no perder transiciones bruscas
    let best = slice[0];
    let minP = slice[0];
    let maxP = slice[0];
    for (const p of slice) {
      if (p.y < minP.y) minP = p;
      if (p.y > maxP.y) maxP = p;
    }
    if (minP.x < maxP.x) {
      sampled.push(minP);
      if (maxP !== minP) sampled.push(maxP);
    } else {
      sampled.push(maxP);
      if (minP !== maxP) sampled.push(minP);
    }
    best = null;
    void best;
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}

/**
 * Devuelve series temporales ordenadas cronológicamente con timestamps Unix ms + ISO
 * optimizadas para Chart.js + chartjs-plugin-zoom.
 */
export async function getTelemetryHistory({ series = [], fromDate, toDate, maxPoints = 2500 }) {
  const devices = await tuyaService.getDevices(false);
  const deviceMap = new Map(devices.map((d) => [d.id, d]));

  const from = fromDate instanceof Date && !Number.isNaN(fromDate.getTime())
    ? fromDate
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = toDate instanceof Date && !Number.isNaN(toDate.getTime()) ? toDate : new Date();

  const results = [];

  for (const item of series) {
    const { deviceId, dpCode } = item;
    if (!deviceId || !dpCode) continue;

    const dev =
      deviceId === WEATHER_DEVICE_ID
        ? { id: WEATHER_DEVICE_ID, displayName: 'Clima Exterior (Open-Meteo)' }
        : deviceMap.get(deviceId);
    const meta = getDpMeta(dev, dpCode);

    const rows = await query(
      `SELECT value_type, value_numeric, recorded_at
       FROM telemetry_logs
       WHERE device_id = ? AND dp_code = ? AND value_numeric IS NOT NULL
         AND recorded_at >= ? AND recorded_at <= ?
       ORDER BY recorded_at ASC`,
      [deviceId, dpCode, from, to]
    );

    const rawPoints = rows.map((r) => {
      const dt = new Date(r.recorded_at);
      return {
        x: dt.getTime(),
        iso: dt.toISOString(),
        y: Number(r.value_numeric),
      };
    });

    const isBoolean = rows[0]?.value_type === 'boolean' || meta.specType === 'boolean';
    const points = downsamplePoints(rawPoints, maxPoints);

    let min = null;
    let max = null;
    let avg = null;
    if (rawPoints.length > 0) {
      let sum = 0;
      min = rawPoints[0].y;
      max = rawPoints[0].y;
      for (const p of rawPoints) {
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
        sum += p.y;
      }
      avg = Number((sum / rawPoints.length).toFixed(2));
    }

    results.push({
      key: `${deviceId}:${dpCode}`,
      deviceId,
      deviceName: dev?.displayName || deviceId,
      dpCode,
      dpLabel: meta.label,
      unit: isBoolean ? '' : meta.unit,
      valueType: isBoolean ? 'boolean' : 'number',
      stepped: isBoolean,
      totalRecords: rawPoints.length,
      stats: { min, max, avg },
      points,
    });
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    series: results,
  };
}

/**
 * Lista los pares (deviceId, dpCode) disponibles con metadatos enriquecidos y conteo real en telemetry_logs.
 */
export async function getAvailableSeries() {
  const devices = await tuyaService.getDevices(false);
  const countRows = await query(
    'SELECT device_id, dp_code, COUNT(*) AS cnt FROM telemetry_logs WHERE value_numeric IS NOT NULL GROUP BY device_id, dp_code'
  );
  const countMap = new Map(countRows.map((r) => [`${r.device_id}:${r.dp_code}`, Number(r.cnt || 0)]));

  const items = [];

  // Incluir siempre Clima Exterior (Open-Meteo) al principio para graficar temperatura junto con cualquier equipo
  let liveWeather = null;
  try {
    liveWeather = await weatherService.getWeather(false);
  } catch {
    liveWeather = null;
  }

  for (const m of WEATHER_METRICS_META) {
    const curVal = liveWeather?.current?.[m.field];
    const isBool = m.valueType === 'boolean';
    items.push({
      deviceId: WEATHER_DEVICE_ID,
      deviceName: 'Clima Exterior (Open-Meteo)',
      room: liveWeather?.location?.label || 'Exterior',
      category: 'weather',
      isOnline: true,
      dpCode: m.code,
      dpLabel: m.label,
      unit: m.unit,
      valueType: isBool ? 'boolean' : 'number',
      currentValue:
        curVal !== undefined && curVal !== null
          ? isBool
            ? curVal
              ? 'Día (Sol)'
              : 'Noche'
            : Number(curVal)
          : null,
      recordCount: countMap.get(`${WEATHER_DEVICE_ID}:${m.code}`) || 0,
    });
  }

  for (const dev of devices) {
    const seen = new Set();
    const specs = [...(dev.dpSchema?.status || []), ...(dev.dpSchema?.functions || [])];

    const pushItem = (code, rawName, valueType, unit, scale) => {
      if (seen.has(code)) return;
      seen.add(code);
      const rawVal = dev.status?.[code];
      let currentValue = null;
      if (rawVal !== undefined && rawVal !== null) {
        if (valueType === 'boolean') currentValue = Boolean(rawVal) ? 'ON' : 'OFF';
        else if (typeof rawVal === 'number') {
          currentValue = scale > 0 ? Number((rawVal / Math.pow(10, scale)).toFixed(scale)) : rawVal;
        }
      }
      items.push({
        deviceId: dev.id,
        deviceName: dev.displayName,
        room: dev.room || '',
        category: dev.category || 'unknown',
        isOnline: Boolean(dev.isOnline),
        dpCode: code,
        dpLabel: getFriendlyDpLabel(code, rawName),
        unit: valueType === 'boolean' ? '' : cleanUnit(unit || ''),
        valueType,
        currentValue,
        recordCount: countMap.get(`${dev.id}:${code}`) || 0,
      });
    };

    for (const s of specs) {
      const t = String(s.type || '').toLowerCase();
      if (t !== 'integer' && t !== 'boolean') continue;
      pushItem(
        s.code,
        s.name,
        t === 'boolean' ? 'boolean' : 'number',
        s.parsedValues?.unit || '',
        Number(s.parsedValues?.scale || 0)
      );
    }

    for (const [code, val] of Object.entries(dev.status || {})) {
      if (typeof val !== 'number' && typeof val !== 'boolean') continue;
      pushItem(code, code, typeof val === 'boolean' ? 'boolean' : 'number', '', 0);
    }
  }

  return items;
}

/**
 * Genera 48h de telemetría realista para los dispositivos existentes (útil para probar zoom/pan en Fase 5).
 */
export async function seedDemoTelemetry(hours = 48) {
  let devices = await tuyaService.getDevices(false);
  if (devices.length === 0) {
    devices = await tuyaService.seedDemoDevices();
  }

  const now = Date.now();
  const intervalMs = 15 * 60 * 1000; // 1 punto cada 15 min
  const steps = Math.floor((hours * 60 * 60 * 1000) / intervalMs);
  const batch = [];

  for (const dev of devices) {
    const specs = [...(dev.dpSchema?.status || []), ...(dev.dpSchema?.functions || [])];
    const uniqueCodes = new Map();
    for (const s of specs) {
      const t = String(s.type || '').toLowerCase();
      if ((t === 'integer' || t === 'boolean') && !uniqueCodes.has(s.code)) {
        uniqueCodes.set(s.code, { type: t, unit: s.parsedValues?.unit || '' });
      }
    }

    for (const [code, info] of uniqueCodes.entries()) {
      let boolState = true;
      for (let i = steps; i >= 0; i--) {
        const ts = new Date(now - i * intervalMs);
        const phase = (steps - i) / 8;

        if (info.type === 'boolean') {
          if (i % 14 === 0) boolState = !boolState;
          batch.push([dev.id, code, 'boolean', boolState ? 1 : 0, boolState ? 'true' : 'false', ts]);
        } else {
          let val = 22 + Math.sin(phase) * 3.5 + (Math.random() - 0.5) * 0.8;
          if (code.includes('humid')) val = 52 + Math.cos(phase) * 12 + (Math.random() - 0.5) * 2;
          else if (code.includes('power')) val = 110 + Math.abs(Math.sin(phase * 1.3)) * 180 + Math.random() * 15;
          else if (code.includes('voltage')) val = 121 + (Math.random() - 0.5) * 2.4;
          else if (code.includes('bright')) val = 300 + Math.abs(Math.sin(phase)) * 650;
          else if (code.includes('battery')) val = Math.max(15, 95 - (steps - i) * 0.25);

          batch.push([dev.id, code, 'number', Number(val.toFixed(2)), null, ts]);
        }
      }
    }
  }

  // Insertar en bloques de 500 para máxima velocidad
  const chunkSize = 500;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk = batch.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const flat = chunk.flat();
    await pool.execute(
      `INSERT INTO telemetry_logs (device_id, dp_code, value_type, value_numeric, value_text, recorded_at)
       VALUES ${placeholders}`,
      flat
    );
  }

  return { inserted: batch.length, hours };
}

export async function purgeOldTelemetry() {
  const days = env.polling.telemetryRetentionDays || 90;
  const res = await query(
    'DELETE FROM telemetry_logs WHERE recorded_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [days]
  );
  return res.affectedRows || 0;
}

export default {
  WEATHER_DEVICE_ID,
  recordDeviceSnapshot,
  recordCommandsTelemetry,
  recordWeatherTelemetry,
  captureAllDevicesTelemetry,
  getTelemetryHistory,
  getAvailableSeries,
  seedDemoTelemetry,
  purgeOldTelemetry,
};
