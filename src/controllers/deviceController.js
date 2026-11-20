import tuyaService from '../services/tuyaService.js';
import { emitDeviceUpdate, emitDevicesSnapshot } from '../sockets/socketManager.js';

export async function listDevices(req, res, next) {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const devices = await tuyaService.getDevices(forceRefresh);
    res.json({
      ok: true,
      count: devices.length,
      tuyaConfigured: tuyaService.isTuyaConfigured(),
      data: devices,
    });
  } catch (err) {
    next(err);
  }
}

export async function syncDevices(_req, res, next) {
  try {
    const result = await tuyaService.syncDevices();
    emitDevicesSnapshot(result.devices);
    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDevice(req, res, next) {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const device = await tuyaService.getDeviceById(req.params.id, forceRefresh);
    if (!device) {
      return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' });
    }
    res.json({ ok: true, data: device });
  } catch (err) {
    next(err);
  }
}

export async function sendCommands(req, res, next) {
  try {
    const { commands, code, value } = req.body || {};
    const cmdList = Array.isArray(commands)
      ? commands
      : code !== undefined
        ? [{ code, value }]
        : [];

    if (cmdList.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Envía "commands": [{ code, value }] o bien "code" y "value"',
      });
    }

    const result = await tuyaService.sendDeviceCommands(req.params.id, cmdList);
    emitDeviceUpdate(result.device);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateDevice(req, res, next) {
  try {
    const updated = await tuyaService.updateDeviceMetadata(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' });
    }
    emitDeviceUpdate(updated);
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
}

export default {
  listDevices,
  syncDevices,
  getDevice,
  sendCommands,
  updateDevice,
};
