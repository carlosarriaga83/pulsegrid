/* Shared, side-effect-free automation capability and value model. */
(function (root) {
  const parse = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
  const safePath = (path) => typeof path === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path) && path.length <= 120 && !path.split('.').some((key) => ['__proto__', 'prototype', 'constructor'].includes(key));
  const capabilities = (device) => { const value = parse(device?.capabilities, []); return Array.isArray(value) ? value : []; };
  function metadata(capability = {}, value) {
    const limits = parse(capability.values, {});
    const type = String(capability.type || typeof value).toLowerCase();
    return { type: ['boolean', 'bool'].includes(type) ? 'boolean' : ['integer', 'number', 'float', 'double'].includes(type) ? 'number' : 'string', integer: type === 'integer', range: type === 'enum' && Array.isArray(limits.range) ? limits.range : null, min: limits.min, max: limits.max, step: limits.step };
  }
  function parameters(device) {
    const result = [];
    const caps = capabilities(device);
    const walk = (object, prefix = '') => {
      if (!object || typeof object !== 'object' || Array.isArray(object)) return;
      for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!safePath(path)) continue;
        if (value && typeof value === 'object') walk(value, path);
        else if (['number', 'string', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))) {
          const cap = caps.find((item) => item.code === key || item.code === path);
          result.push({ value: path, label: cap?.name || path, ...metadata(cap, value), type: typeof value, current: value });
        }
      }
    };
    walk(parse(device?.telemetry, {}));
    const telemetry = parse(device?.telemetry, {});
    if (Array.isArray(telemetry.status)) telemetry.status.filter((item) => item && typeof item.code === 'string' && ['number', 'string', 'boolean'].includes(typeof item.value)).forEach((item) => {
      if (!result.some((entry) => entry.value === item.code)) {
        const cap = caps.find((candidate) => candidate.code === item.code);
        result.push({ value: item.code, label: cap?.name || item.code, ...metadata(cap, item.value), type: typeof item.value, current: item.value });
      }
    });
    return result;
  }
  function curtain(device) {
    const telemetry = parse(device?.telemetry, {});
    return device?.provider !== 'tuya' && (telemetry.kind === 'curtain' || /^(servo|ga25)$/i.test(telemetry.firmwareTarget || '') || /^(curtain|cortina|persiana)$/i.test(device?.type || ''));
  }
  function writable(device) {
    // The only parameter assignment protocol currently implemented is tuya.set.
    if (device?.provider !== 'tuya') return [];
    return capabilities(device).filter((cap) => typeof cap.code === 'string' && safePath(cap.code) && ['boolean', 'bool', 'integer', 'number', 'float', 'double', 'enum', 'string'].includes(String(cap.type).toLowerCase())).map((cap) => ({ value: cap.code, label: cap.name || cap.code, ...metadata(cap) }));
  }
  function commands(device, source = false) {
    if (device?.provider === 'tuya') return writable(device).map((item) => ({ ...item, commandName: 'tuya.set', commandCode: item.value, label: source ? `${item.label} · ultimo valor enviado (no confirma lectura)` : item.label }));
    if (!curtain(device)) return [];
    return [{ value: 'open', commandName: 'curtain.open', label: 'Abrir cortina' }, { value: 'close', commandName: 'curtain.close', label: 'Cerrar cortina' }, { value: 'position', commandName: 'curtain.move', label: 'Mover cortina' }].map((item) => source ? { ...item, value: item.commandName, label: `${item.label} · estado del ultimo comando`, type: 'string', range: ['queued', 'running', 'succeeded', 'failed'] } : item);
  }
  function typedValue(raw, option) {
    if (!option) throw new Error('Selecciona un parametro o comando disponible.');
    let value = raw;
    if (option.type === 'boolean') {
      if (![true, false, 'true', 'false'].includes(raw)) throw new Error('Selecciona True o False.');
      value = raw === true || raw === 'true';
    } else if (option.type === 'number') {
      if (String(raw).trim() === '' || !Number.isFinite(Number(raw))) throw new Error('Introduce un numero valido.');
      value = Number(raw);
      if (option.integer && !Number.isInteger(value) || option.min != null && value < Number(option.min) || option.max != null && value > Number(option.max)) throw new Error('El numero esta fuera del rango permitido.');
      if (Number(option.step) > 0 && Math.abs((value - Number(option.min || 0)) / Number(option.step) - Math.round((value - Number(option.min || 0)) / Number(option.step))) > 1e-8) throw new Error('El numero no respeta el incremento permitido.');
    } else value = String(raw);
    if (option.range && !option.range.includes(value)) throw new Error('Selecciona un valor de la lista.');
    return value;
  }
  const model = { parse, safePath, capabilities, metadata, parameters, curtain, writable, commands, typedValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.AutomationModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this);