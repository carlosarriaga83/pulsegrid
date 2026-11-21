import { TuyaContext } from '@tuya/tuya-connector-nodejs';
import env from '../config/env.js';
import { query } from '../config/db.js';
import logger from '../utils/logger.js';

let tuyaClient = null;

// Caché en memoria para reducir llamadas a Tuya Cloud y acelerar el dashboard
const deviceCache = new Map();
const specCache = new Map();
let lastSyncAt = 0;

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

export function isTuyaConfigured() {
  return Boolean(env.tuya.baseUrl && env.tuya.accessKey && env.tuya.secretKey);
}

function getClient() {
  if (!isTuyaConfigured()) {
    throw new Error('Tuya Cloud API no está configurada. Define TUYA_ACCESS_KEY y TUYA_SECRET_KEY en .env');
  }
  if (!tuyaClient) {
    tuyaClient = new TuyaContext({
      baseUrl: env.tuya.baseUrl,
      accessKey: env.tuya.accessKey,
      secretKey: env.tuya.secretKey,
    });
  }
  return tuyaClient;
}

/**
 * Normaliza el array de status [{ code, value }] de Tuya a un objeto clave-valor { code: value }.
 */
export function statusArrayToMap(statusArray) {
  const map = {};
  if (!Array.isArray(statusArray)) return map;
  for (const item of statusArray) {
    if (item && item.code !== undefined) {
      map[item.code] = item.value;
    }
  }
  return map;
}

/**
 * Serializa y valida el valor de un comando según el esquema DP de Tuya (Boolean, Integer, Enum, String, Json).
 */
export function coerceCommandValue(dpCode, rawValue, dpSchema) {
  const functions = dpSchema?.functions || [];
  const spec = functions.find((fn) => fn.code === dpCode);

  if (!spec) {
    return rawValue;
  }

  const type = String(spec.type || '').toLowerCase();
  const constraints = parseJsonSafe(spec.values) || {};

  if (type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (rawValue === 'true' || rawValue === 1 || rawValue === '1') return true;
    if (rawValue === 'false' || rawValue === 0 || rawValue === '0') return false;
    return Boolean(rawValue);
  }

  if (type === 'integer') {
    let num = Number(rawValue);
    if (Number.isNaN(num)) {
      throw new Error(`El parámetro '${dpCode}' requiere un valor numérico entero`);
    }
    num = Math.round(num);
    if (constraints.min !== undefined && num < constraints.min) num = constraints.min;
    if (constraints.max !== undefined && num > constraints.max) num = constraints.max;
    return num;
  }

  if (type === 'enum') {
    const strVal = String(rawValue);
    if (Array.isArray(constraints.range) && !constraints.range.includes(strVal)) {
      throw new Error(`Valor '${strVal}' inválido para '${dpCode}'. Permitidos: ${constraints.range.join(', ')}`);
    }
    return strVal;
  }

  if (type === 'json') {
    return typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
  }

  return String(rawValue);
}

/**
 * Mapea tipos del Thing Model v2.0 de Tuya al formato estándar usado en PulseGrid.
 */
function mapThingModelType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (t === 'bool' || t === 'boolean') return 'Boolean';
  if (t === 'value' || t === 'integer' || t === 'int' || t === 'float' || t === 'double') return 'Integer';
  if (t === 'enum') return 'Enum';
  if (t === 'raw') return 'Raw';
  return 'String';
}

/**
 * Fallback v2.0 Thing Model: obtiene el esquema de propiedades para dispositivos
 * en modo DP (ej. medidores de energía duales, cortinas, sensores custom).
 */
async function fetchThingModelV2(deviceId) {
  const client = getClient();
  const res = await client.request({
    path: `/v2.0/cloud/thing/${deviceId}/model`,
    method: 'GET',
  });

  if (!res.success || !res.result?.model) {
    return null;
  }

  const model = parseJsonSafe(res.result.model);
  const services = Array.isArray(model?.services) ? model.services : [];
  const functions = [];
  const status = [];

  for (const svc of services) {
    for (const prop of svc.properties || []) {
      const ts = prop.typeSpec || {};
      const mappedType = mapThingModelType(ts.type);
      const parsedValues = {};

      if (mappedType === 'Integer') {
        if (ts.min !== undefined) parsedValues.min = Number(ts.min);
        if (ts.max !== undefined) parsedValues.max = Number(ts.max);
        if (ts.scale !== undefined) parsedValues.scale = Number(ts.scale);
        if (ts.step !== undefined) parsedValues.step = Number(ts.step);
        if (ts.unit !== undefined) parsedValues.unit = String(ts.unit);
      } else if (mappedType === 'Enum' && Array.isArray(ts.range)) {
        parsedValues.range = ts.range;
      }

      const entry = {
        code: prop.code,
        name: prop.name || prop.code,
        type: mappedType,
        dpId: prop.abilityId,
        accessMode: prop.accessMode || 'ro',
        values: JSON.stringify(parsedValues),
        parsedValues,
      };

      status.push(entry);
      if (prop.accessMode === 'rw' || prop.accessMode === 'wr') {
        functions.push(entry);
      }
    }
  }

  if (status.length === 0 && functions.length === 0) return null;

  return {
    category: null,
    source: 'thing_model_v2',
    functions,
    status,
  };
}

/**
 * Fallback v2.0 Shadow Properties: obtiene los valores actuales de dispositivos en modo DP.
 */
async function fetchShadowPropertiesV2(deviceId) {
  const client = getClient();
  const res = await client.request({
    path: `/v2.0/cloud/thing/${deviceId}/shadow/properties`,
    method: 'GET',
  });

  if (!res.success || !Array.isArray(res.result?.properties)) {
    return { statusMap: {}, properties: [] };
  }

  const statusMap = {};
  for (const prop of res.result.properties) {
    if (prop && prop.code !== undefined && prop.value !== undefined) {
      statusMap[prop.code] = prop.value;
    }
  }

  return { statusMap, properties: res.result.properties };
}

/**
 * Obtiene las especificaciones de funciones/estados de un dispositivo (con caché).
 * Si v1.0 /specification viene vacío (común en power meters y dispositivos DP),
 * recurre automáticamente a Tuya v2.0 Thing Model y Shadow Properties.
 */
export async function getDeviceSpecification(deviceId, forceRefresh = false) {
  const cached = specCache.get(deviceId);
  const cachedHasEntries = (cached?.functions?.length || 0) + (cached?.status?.length || 0) > 0;
  if (!forceRefresh && cachedHasEntries) {
    return cached;
  }

  if (!isTuyaConfigured()) {
    const rows = await query('SELECT dp_schema FROM devices WHERE id = ? LIMIT 1', [deviceId]);
    const schema = parseJsonSafe(rows[0]?.dp_schema) || null;
    if (schema) specCache.set(deviceId, schema);
    return schema;
  }

  const client = getClient();
  let schema = null;

  try {
    const res = await client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/specification`,
      method: 'GET',
    });

    if (res.success) {
      const fns = (res.result?.functions || []).map((f) => ({
        ...f,
        parsedValues: parseJsonSafe(f.values) || {},
      }));
      const sts = (res.result?.status || []).map((s) => ({
        ...s,
        parsedValues: parseJsonSafe(s.values) || {},
      }));

      if (fns.length > 0 || sts.length > 0) {
        schema = {
          category: res.result?.category || null,
          source: 'standard_v1',
          functions: fns,
          status: sts,
        };
      }
    }
  } catch (err) {
    logger.warn(`Error consultando v1.0 specification de ${deviceId}`, { error: err.message });
  }

  // Fallback a Thing Model v2.0 para medidores de energía / dispositivos en modo DP
  if (!schema) {
    try {
      schema = await fetchThingModelV2(deviceId);
    } catch (err) {
      logger.warn(`Error consultando v2.0 model de ${deviceId}`, { error: err.message });
    }
  }

  // Último respaldo: inferir esquema desde shadow/properties v2.0
  if (!schema) {
    try {
      const shadow = await fetchShadowPropertiesV2(deviceId);
      if (shadow.properties.length > 0) {
        schema = {
          category: null,
          source: 'thing_model_v2',
          functions: [],
          status: shadow.properties.map((p) => ({
            code: p.code,
            name: p.custom_name || p.code,
            type: mapThingModelType(p.type),
            dpId: p.dp_id,
            values: '{}',
            parsedValues: {},
          })),
        };
      }
    } catch (err) {
      logger.warn(`Error consultando v2.0 shadow properties de ${deviceId}`, { error: err.message });
    }
  }

  if (!schema) {
    return cached || null;
  }

  specCache.set(deviceId, schema);
  await query('UPDATE devices SET dp_schema = ? WHERE id = ?', [JSON.stringify(schema), deviceId]);
  return schema;
}

/**
 * Obtiene la lista de dispositivos directamente desde Tuya Cloud.
 */
async function fetchDevicesFromTuya() {
  const client = getClient();

  // Ruta principal cuando se provee el UID del usuario de la app Smart Life / Tuya Smart
  if (env.tuya.userUid) {
    const res = await client.request({
      path: `/v1.0/users/${env.tuya.userUid}/devices`,
      method: 'GET',
    });
    if (res.success && Array.isArray(res.result)) {
      return res.result;
    }
    logger.warn('Fallback en listado de dispositivos Tuya', { msg: res.msg, code: res.code });
  }

  // Ruta alternativa para proyectos IoT Core (v1.0/iot-01/associated-users/devices)
  const fallbackRes = await client.request({
    path: '/v1.0/iot-01/associated-users/devices',
    method: 'GET',
    query: { last_row_key: '', size: 100 },
  });

  if (!fallbackRes.success) {
    throw new Error(`Error Tuya API (${fallbackRes.code}): ${fallbackRes.msg}`);
  }

  return fallbackRes.result?.devices || fallbackRes.result || [];
}

/**
 * Carga dispositivos desde MySQL a la caché en memoria (útil al iniciar o sin Tuya configurado).
 */
export async function loadDevicesFromDb() {
  const rows = await query('SELECT * FROM devices ORDER BY room ASC, COALESCE(custom_name, name) ASC');
  deviceCache.clear();

  for (const row of rows) {
    const formatted = formatDbDevice(row);
    deviceCache.set(formatted.id, formatted);
    if (formatted.dpSchema) {
      specCache.set(formatted.id, formatted.dpSchema);
    }
  }

  return Array.from(deviceCache.values());
}

function formatDbDevice(row) {
  return {
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
    dpSchema: parseJsonSafe(row.dp_schema),
    status: parseJsonSafe(row.last_status) || {},
    notifyOnOffline: Boolean(row.notify_on_offline),
    offlineCooldownMinutes: row.offline_cooldown_minutes,
    updatedAt: row.updated_at,
  };
}

/**
 * Sincroniza todos los dispositivos desde Tuya Cloud hacia MySQL y la caché en memoria.
 * Devuelve la lista actualizada y un array de cambios detectados para Socket.io / telemetría.
 */
export async function syncDevices() {
  if (!isTuyaConfigured()) {
    const dbDevices = await loadDevicesFromDb();
    return {
      synced: false,
      reason: 'Tuya Cloud API no configurada',
      devices: dbDevices,
      changes: [],
    };
  }

  const tuyaDevices = await fetchDevicesFromTuya();
  const changes = [];

  for (const dev of tuyaDevices) {
    let statusMap = statusArrayToMap(dev.status);
    const isOnline = Boolean(dev.online);
    const previous = deviceCache.get(dev.id);
    const iconUrl = dev.icon
      ? (dev.icon.startsWith('http') ? dev.icon : `https://images.tuyaus.com/${dev.icon}`)
      : null;

    // Si v1.0 devolvió status vacío (típico en power meters / modo DP), consultar v2.0 shadow/properties
    if (Object.keys(statusMap).length === 0) {
      try {
        const shadow = await fetchShadowPropertiesV2(dev.id);
        if (Object.keys(shadow.statusMap).length > 0) {
          statusMap = shadow.statusMap;
        }
      } catch (shadowErr) {
        logger.debug(`Shadow v2.0 no disponible para ${dev.id}`, { error: shadowErr.message });
      }
    }

    await query(
      `INSERT INTO devices (id, name, category, product_id, product_name, icon_url, is_online, last_online_at, last_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         category = VALUES(category),
         product_id = VALUES(product_id),
         product_name = VALUES(product_name),
         icon_url = VALUES(icon_url),
         is_online = VALUES(is_online),
         last_online_at = IF(VALUES(is_online) = 1, NOW(), last_online_at),
         last_status = VALUES(last_status),
         updated_at = CURRENT_TIMESTAMP`,
      [
        dev.id,
        dev.name || dev.id,
        dev.category || 'unknown',
        dev.product_id || null,
        dev.product_name || null,
        iconUrl,
        isOnline ? 1 : 0,
        isOnline ? new Date() : null,
        JSON.stringify(statusMap),
      ]
    );

    // Asegurar que tenemos un dp_schema con entradas reales (reintentar si estaba vacío)
    let dpSchema = specCache.get(dev.id) || previous?.dpSchema || null;
    const hasSchemaEntries = (dpSchema?.functions?.length || 0) + (dpSchema?.status?.length || 0) > 0;
    if (!hasSchemaEntries) {
      try {
        dpSchema = await getDeviceSpecification(dev.id, true);
      } catch (specErr) {
        logger.warn(`Error cargando specification para ${dev.id}`, { error: specErr.message });
      }
    }

    const updatedDevice = {
      id: dev.id,
      name: dev.name || dev.id,
      customName: previous?.customName || null,
      displayName: previous?.customName || dev.name || dev.id,
      category: dev.category || 'unknown',
      productId: dev.product_id || null,
      productName: dev.product_name || null,
      iconUrl,
      room: previous?.room || null,
      isOnline,
      lastOnlineAt: isOnline ? new Date().toISOString() : previous?.lastOnlineAt || null,
      dpSchema,
      status: statusMap,
      notifyOnOffline: previous?.notifyOnOffline || false,
      offlineCooldownMinutes: previous?.offlineCooldownMinutes || 60,
      updatedAt: new Date().toISOString(),
    };

    const statusChanged = !previous || JSON.stringify(previous.status) !== JSON.stringify(statusMap);
    const onlineChanged = previous && previous.isOnline !== isOnline;

    if (statusChanged || onlineChanged) {
      changes.push({
        device: updatedDevice,
        onlineChanged,
        wentOffline: Boolean(onlineChanged && !isOnline),
        statusChanged,
      });
    }

    deviceCache.set(dev.id, updatedDevice);
  }

  lastSyncAt = Date.now();
  // Refrescar metadatos locales (custom_name, room, notify_on_offline) desde DB
  const fullList = await loadDevicesFromDb();

  return {
    synced: true,
    syncedAt: new Date(lastSyncAt).toISOString(),
    devices: fullList,
    changes,
  };
}

/**
 * Devuelve todos los dispositivos desde caché (o DB/Tuya si la caché está vacía o expirada).
 */
export async function getDevices(forceRefresh = false) {
  const ttlMs = env.polling.intervalSeconds * 1000;
  const cacheExpired = Date.now() - lastSyncAt > ttlMs;

  if (forceRefresh || (deviceCache.size === 0 && cacheExpired)) {
    if (isTuyaConfigured()) {
      const result = await syncDevices();
      return result.devices;
    }
    return loadDevicesFromDb();
  }

  if (deviceCache.size === 0) {
    return loadDevicesFromDb();
  }

  return Array.from(deviceCache.values());
}

/**
 * Devuelve un dispositivo específico desde caché o DB.
 */
export async function getDeviceById(deviceId, forceStatusRefresh = false) {
  if (deviceCache.size === 0) {
    await loadDevicesFromDb();
  }

  let device = deviceCache.get(deviceId);
  if (!device) {
    const rows = await query('SELECT * FROM devices WHERE id = ? LIMIT 1', [deviceId]);
    if (rows.length === 0) return null;
    device = formatDbDevice(rows[0]);
    deviceCache.set(deviceId, device);
  }

  if (forceStatusRefresh && isTuyaConfigured()) {
    const client = getClient();
    let statusMap = {};

    const res = await client.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });
    if (res.success && Array.isArray(res.result) && res.result.length > 0) {
      statusMap = statusArrayToMap(res.result);
    } else {
      const shadow = await fetchShadowPropertiesV2(deviceId);
      statusMap = shadow.statusMap;
    }

    if (Object.keys(statusMap).length > 0) {
      device.status = statusMap;
      device.updatedAt = new Date().toISOString();
      await query('UPDATE devices SET last_status = ? WHERE id = ?', [JSON.stringify(statusMap), deviceId]);
      deviceCache.set(deviceId, device);
    }
  }

  return device;
}

/**
 * Envía uno o múltiples comandos DP a un dispositivo Tuya asegurando la serialización correcta.
 * @param {string} deviceId
 * @param {Array<{code: string, value: any}>} commands
 */
export async function sendDeviceCommands(deviceId, commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('Debes proporcionar al menos un comando { code, value }');
  }

  const device = await getDeviceById(deviceId);
  if (!device) {
    const err = new Error(`Dispositivo '${deviceId}' no encontrado`);
    err.statusCode = 404;
    throw err;
  }

  const dpSchema = device.dpSchema || (await getDeviceSpecification(deviceId));
  const serializedCommands = commands.map((cmd) => ({
    code: String(cmd.code),
    value: coerceCommandValue(cmd.code, cmd.value, dpSchema),
  }));

  // Los dispositivos demo_* se ejecutan localmente para pruebas de UI y WebSockets sin requerir claves Tuya
  if (!String(deviceId).startsWith('demo_')) {
    const client = getClient();
    const useV2 = dpSchema?.source === 'thing_model_v2';

    const sendV2 = async () => {
      const propsObj = {};
      for (const cmd of serializedCommands) propsObj[cmd.code] = cmd.value;
      return client.request({
        path: `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`,
        method: 'POST',
        body: { properties: JSON.stringify(propsObj) },
      });
    };

    const sendV1 = async () =>
      client.request({
        path: `/v1.0/iot-03/devices/${deviceId}/commands`,
        method: 'POST',
        body: { commands: serializedCommands },
      });

    let res = useV2 ? await sendV2() : await sendV1();
    if (!res.success) {
      // Fallback cruzado v1 <-> v2 si el dispositivo cambió de modo de instrucciones
      const retryRes = useV2 ? await sendV1() : await sendV2();
      if (retryRes.success) res = retryRes;
    }

    if (!res.success) {
      const err = new Error(`Tuya rechazó el comando (${res.code}): ${res.msg}`);
      err.statusCode = 502;
      throw err;
    }
  }

  // Actualización optimista inmediata en caché y MySQL para feedback instantáneo
  const updatedStatus = { ...device.status };
  for (const cmd of serializedCommands) {
    updatedStatus[cmd.code] = cmd.value;
  }
  device.status = updatedStatus;
  device.updatedAt = new Date().toISOString();
  deviceCache.set(deviceId, device);

  await query('UPDATE devices SET last_status = ? WHERE id = ?', [JSON.stringify(updatedStatus), deviceId]);

  return {
    deviceId,
    commands: serializedCommands,
    device,
  };
}

/**
 * Actualiza metadatos locales de un dispositivo (alias, habitación, alertas offline).
 */
export async function updateDeviceMetadata(deviceId, { customName, room, notifyOnOffline, offlineCooldownMinutes }) {
  const fields = [];
  const params = [];

  if (customName !== undefined) {
    fields.push('custom_name = ?');
    params.push(customName ? String(customName).trim() : null);
  }
  if (room !== undefined) {
    fields.push('room = ?');
    params.push(room ? String(room).trim() : null);
  }
  if (notifyOnOffline !== undefined) {
    fields.push('notify_on_offline = ?');
    params.push(notifyOnOffline ? 1 : 0);
  }
  if (offlineCooldownMinutes !== undefined) {
    fields.push('offline_cooldown_minutes = ?');
    params.push(Math.max(1, Number.parseInt(offlineCooldownMinutes, 10) || 60));
  }

  if (fields.length === 0) {
    return getDeviceById(deviceId);
  }

  params.push(deviceId);
  await query(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`, params);

  const rows = await query('SELECT * FROM devices WHERE id = ? LIMIT 1', [deviceId]);
  if (rows.length === 0) return null;

  const updated = formatDbDevice(rows[0]);
  deviceCache.set(deviceId, updated);
  return updated;
}

export function getCacheStats() {
  return {
    configured: isTuyaConfigured(),
    cachedDevices: deviceCache.size,
    cachedSpecs: specCache.size,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
  };
}

/**
 * Inserta dispositivos Tuya simulados (demo_*) para probar controles dinámicos y Socket.io.
 */
export async function seedDemoDevices() {
  const demoDevices = [
    {
      id: 'demo_thermostat_01',
      name: 'Termostato Inteligente Sala',
      category: 'wk',
      product_id: 'demo_prod_wk',
      product_name: 'Smart Thermostat Pro',
      room: 'Sala',
      is_online: 1,
      dp_schema: {
        category: 'wk',
        functions: [
          { code: 'switch', name: 'Encendido', type: 'Boolean', values: '{}', parsedValues: {} },
          { code: 'temp_set', name: 'Temperatura Objetivo', type: 'Integer', values: '{"min":160,"max":300,"scale":1,"step":5,"unit":"°C"}', parsedValues: { min: 160, max: 300, scale: 1, step: 5, unit: '°C' } },
          { code: 'mode', name: 'Modo', type: 'Enum', values: '{"range":["auto","cool","heat","eco"]}', parsedValues: { range: ['auto', 'cool', 'heat', 'eco'] } },
        ],
        status: [
          { code: 'switch', name: 'Encendido', type: 'Boolean', parsedValues: {} },
          { code: 'temp_current', name: 'Temperatura Actual', type: 'Integer', parsedValues: { min: 0, max: 500, scale: 1, unit: '°C' } },
          { code: 'humidity_value', name: 'Humedad', type: 'Integer', parsedValues: { min: 0, max: 100, scale: 0, unit: '%' } },
          { code: 'temp_set', name: 'Temperatura Objetivo', type: 'Integer', parsedValues: { min: 160, max: 300, scale: 1, step: 5, unit: '°C' } },
          { code: 'mode', name: 'Modo', type: 'Enum', parsedValues: { range: ['auto', 'cool', 'heat', 'eco'] } },
        ],
      },
      last_status: { switch: true, temp_current: 234, humidity_value: 48, temp_set: 220, mode: 'cool' },
    },
    {
      id: 'demo_light_02',
      name: 'Lámpara Ambiental Estudio',
      category: 'dj',
      product_id: 'demo_prod_dj',
      product_name: 'Smart LED Bulb CCT',
      room: 'Estudio',
      is_online: 1,
      dp_schema: {
        category: 'dj',
        functions: [
          { code: 'switch_led', name: 'Luz', type: 'Boolean', values: '{}', parsedValues: {} },
          { code: 'bright_value', name: 'Brillo', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":10,"unit":"lm"}', parsedValues: { min: 10, max: 1000, scale: 0, step: 10, unit: 'lm' } },
          { code: 'temp_value', name: 'Temperatura Color', type: 'Integer', values: '{"min":0,"max":1000,"scale":0,"step":20,"unit":"K"}', parsedValues: { min: 0, max: 1000, scale: 0, step: 20, unit: 'K' } },
          { code: 'work_mode', name: 'Escena', type: 'Enum', values: '{"range":["white","colour","scene","music"]}', parsedValues: { range: ['white', 'colour', 'scene', 'music'] } },
        ],
        status: [
          { code: 'switch_led', name: 'Luz', type: 'Boolean', parsedValues: {} },
          { code: 'bright_value', name: 'Brillo', type: 'Integer', parsedValues: { min: 10, max: 1000, scale: 0, unit: 'lm' } },
          { code: 'temp_value', name: 'Temperatura Color', type: 'Integer', parsedValues: { min: 0, max: 1000, scale: 0, unit: 'K' } },
          { code: 'work_mode', name: 'Escena', type: 'Enum', parsedValues: { range: ['white', 'colour', 'scene', 'music'] } },
        ],
      },
      last_status: { switch_led: true, bright_value: 720, temp_value: 450, work_mode: 'white' },
    },
    {
      id: 'demo_plug_03',
      name: 'Enchufe Monitor Consumo',
      category: 'cz',
      product_id: 'demo_prod_cz',
      product_name: 'WiFi Smart Plug 16A',
      room: 'Oficina',
      is_online: 1,
      dp_schema: {
        category: 'cz',
        functions: [
          { code: 'switch_1', name: 'Interruptor', type: 'Boolean', values: '{}', parsedValues: {} },
          { code: 'relay_status', name: 'Estado tras corte', type: 'Enum', values: '{"range":["off","on","memory"]}', parsedValues: { range: ['off', 'on', 'memory'] } },
        ],
        status: [
          { code: 'switch_1', name: 'Interruptor', type: 'Boolean', parsedValues: {} },
          { code: 'cur_power', name: 'Potencia', type: 'Integer', parsedValues: { min: 0, max: 35000, scale: 1, unit: 'W' } },
          { code: 'cur_voltage', name: 'Voltaje', type: 'Integer', parsedValues: { min: 0, max: 2600, scale: 1, unit: 'V' } },
          { code: 'cur_current', name: 'Corriente', type: 'Integer', parsedValues: { min: 0, max: 16000, scale: 0, unit: 'mA' } },
          { code: 'relay_status', name: 'Estado tras corte', type: 'Enum', parsedValues: { range: ['off', 'on', 'memory'] } },
        ],
      },
      last_status: { switch_1: true, cur_power: 1425, cur_voltage: 1214, cur_current: 1170, relay_status: 'memory' },
    },
    {
      id: 'demo_sensor_04',
      name: 'Sensor Exterior Jardín',
      category: 'wsdcg',
      product_id: 'demo_prod_wsdcg',
      product_name: 'Temp & Humidity Sensor',
      room: 'Exterior',
      is_online: 0,
      dp_schema: {
        category: 'wsdcg',
        functions: [],
        status: [
          { code: 'va_temperature', name: 'Temperatura', type: 'Integer', parsedValues: { min: -200, max: 600, scale: 1, unit: '°C' } },
          { code: 'va_humidity', name: 'Humedad', type: 'Integer', parsedValues: { min: 0, max: 100, scale: 0, unit: '%' } },
          { code: 'battery_percentage', name: 'Batería', type: 'Integer', parsedValues: { min: 0, max: 100, scale: 0, unit: '%' } },
        ],
      },
      last_status: { va_temperature: 186, va_humidity: 64, battery_percentage: 22 },
    },
  ];

  for (const d of demoDevices) {
    await query(
      `INSERT INTO devices (id, name, category, product_id, product_name, room, is_online, last_online_at, dp_schema, last_status, notify_on_offline)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         dp_schema = VALUES(dp_schema),
         last_status = VALUES(last_status),
         is_online = VALUES(is_online),
         updated_at = CURRENT_TIMESTAMP`,
      [
        d.id,
        d.name,
        d.category,
        d.product_id,
        d.product_name,
        d.room,
        d.is_online,
        JSON.stringify(d.dp_schema),
        JSON.stringify(d.last_status),
      ]
    );
  }

  return loadDevicesFromDb();
}

export async function clearDemoDevices() {
  await query("DELETE FROM devices WHERE id LIKE 'demo_%'");
  return loadDevicesFromDb();
}

export default {
  isTuyaConfigured,
  getDevices,
  getDeviceById,
  getDeviceSpecification,
  syncDevices,
  sendDeviceCommands,
  updateDeviceMetadata,
  loadDevicesFromDb,
  getCacheStats,
  seedDemoDevices,
  clearDemoDevices,
};
