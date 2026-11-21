import telemetryService from '../services/telemetryService.js';

function resolveDateRange(range, fromStr, toStr) {
  const now = new Date();
  if (range === 'custom' && fromStr && toStr) {
    const f = new Date(fromStr);
    const t = new Date(toStr);
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime())) {
      return { fromDate: f, toDate: t };
    }
  }
  const hoursMap = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
  const hours = hoursMap[range] || 24;
  return {
    fromDate: new Date(now.getTime() - hours * 60 * 60 * 1000),
    toDate: now,
  };
}

export async function listSeries(_req, res, next) {
  try {
    const data = await telemetryService.getAvailableSeries();
    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req, res, next) {
  try {
    const { series = '', range = '24h', from, to, maxPoints } = req.query;
    const parsedSeries = String(series)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf(':');
        if (idx === -1) return null;
        return { deviceId: pair.slice(0, idx), dpCode: pair.slice(idx + 1) };
      })
      .filter(Boolean);

    if (parsedSeries.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Especifica al menos una serie en formato series=deviceId:dpCode',
      });
    }

    const { fromDate, toDate } = resolveDateRange(range, from, to);
    const data = await telemetryService.getTelemetryHistory({
      series: parsedSeries,
      fromDate,
      toDate,
      maxPoints: Math.min(5000, Math.max(100, Number(maxPoints) || 2500)),
    });

    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

export async function captureNow(_req, res, next) {
  try {
    const inserted = await telemetryService.captureAllDevicesTelemetry();
    res.json({ ok: true, inserted });
  } catch (err) {
    next(err);
  }
}

export async function seedDemo(req, res, next) {
  try {
    const hours = Math.min(168, Math.max(6, Number(req.body?.hours) || 48));
    const result = await telemetryService.seedDemoTelemetry(hours);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
}

export default { listSeries, getHistory, captureNow, seedDemo };
