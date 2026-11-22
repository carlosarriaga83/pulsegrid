import weatherService from '../services/weatherService.js';

export async function getCurrentWeather(req, res, next) {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lon = req.query.lon !== undefined ? Number(req.query.lon) : undefined;
    const tz = req.query.tz ? String(req.query.tz) : undefined;
    const label = req.query.label ? String(req.query.label) : undefined;

    const override =
      lat !== undefined &&
      lon !== undefined &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
        ? { latitude: lat, longitude: lon, timezone: tz, label: label || 'Tu ubicación' }
        : null;

    const data = await weatherService.getWeather(forceRefresh, override);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getLocation(_req, res, next) {
  try {
    const data = await weatherService.getLocationSettings();
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

export async function saveLocation(req, res, next) {
  try {
    const { latitude, longitude, timezone, label } = req.body || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ ok: false, error: 'latitude y longitude son obligatorios' });
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ ok: false, error: 'Coordenadas fuera de rango válido' });
    }

    const updated = await weatherService.updateLocationSettings({ latitude: lat, longitude: lon, timezone, label });
    const weather = await weatherService.getWeather(true);
    res.json({ ok: true, location: updated, weather });
  } catch (err) {
    next(err);
  }
}

export default { getCurrentWeather, getLocation, saveLocation };
