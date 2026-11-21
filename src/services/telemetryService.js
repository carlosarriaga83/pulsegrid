import { query, pool } from '../config/db.js';
import env from '../config/env.js';
import tuyaService from './tuyaService.js';
import logger from '../utils/logger.js';

function getDpMeta(device, dpCode) {
  const specs = [...(device?.dpSchema?.functions || []), ...(device?.dpSchema?.status || [])];
  const spec = specs.find((s) => s.code === dpCode);
  return {
    label: spec?.name || dpCode,
    scale: Number(spec?.parsedValues?.scale || 0),
    unit: spec?.parsedValues?.unit || '',
    specType: String(spec?.type || '').toLowerCase(),
  };
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
    placeholders.push('(?, ?, ?, ?, ?, NOW())');
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
    placeholders.push('(?, ?, ?, ?, ?, NOW())');
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
 */
export async function captureAllDevicesTelemetry() {
  const devices = await tuyaService.getDevices(false);
  let totalInserted = 0;
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

    const dev = deviceMap.get(deviceId);
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
 * Lista los pares (deviceId, dpCode) disponibles con historial o con DPs graficables.
 */
export async function getAvailableSeries() {
  const devices = await tuyaService.getDevices(false);
  const items = [];

  for (const dev of devices) {
    const seen = new Set();
    const specs = [...(dev.dpSchema?.status || []), ...(dev.dpSchema?.functions || [])];
    for (const s of specs) {
      const t = String(s.type || '').toLowerCase();
      if (t !== 'integer' && t !== 'boolean') continue;
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      items.push({
        deviceId: dev.id,
        deviceName: dev.displayName,
        dpCode: s.code,
        dpLabel: s.name || s.code,
        unit: t === 'boolean' ? '' : s.parsedValues?.unit || '',
        valueType: t === 'boolean' ? 'boolean' : 'number',
      });
    }
    for (const [code, val] of Object.entries(dev.status || {})) {
      if (seen.has(code)) continue;
      if (typeof val !== 'number' && typeof val !== 'boolean') continue;
      seen.add(code);
      items.push({
        deviceId: dev.id,
        deviceName: dev.displayName,
        dpCode: code,
        dpLabel: code,
        unit: '',
        valueType: typeof val === 'boolean' ? 'boolean' : 'number',
      });
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
  recordDeviceSnapshot,
  recordCommandsTelemetry,
  captureAllDevicesTelemetry,
  getTelemetryHistory,
  getAvailableSeries,
  seedDemoTelemetry,
  purgeOldTelemetry,
};
