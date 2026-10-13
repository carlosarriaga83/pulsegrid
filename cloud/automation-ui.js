/* Classic script: called by app.js after its DOM helpers have initialized. */
const AutomationUI = (() => {
  const model = AutomationModel;
  const esc = (value) => escapeTelemetryHtml(String(value ?? ''));
  const device = (id) => devices.find((item) => item.id === id);
  const textValue = (value) => typeof value === 'boolean' ? value ? 'True' : 'False' : typeof value === 'string' ? JSON.stringify(value) : String(value);
  const operators = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const weatherDevice = { id: 'weather_openmeteo', name: 'Clima / Sol (Open-Meteo)', provider: 'open-meteo' };
  const solarEvents = new Set(['sunrise', 'sunset']);
  const weatherCodeLabels = { 0: 'Despejado', 1: 'Principalmente despejado', 2: 'Parcialmente nublado', 3: 'Nublado', 45: 'Niebla', 48: 'Niebla escarchada', 51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna intensa', 61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia intensa', 71: 'Nieve ligera', 73: 'Nieve moderada', 75: 'Nieve intensa', 80: 'Chubascos ligeros', 81: 'Chubascos moderados', 82: 'Chubascos intensos', 95: 'Tormenta' };
  const sourceDevice = (id) => id === weatherDevice.id ? weatherDevice : device(id);
  const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  function requestWeatherLocation(row, force = false) {
    const latitude = row.querySelector('.automation-weather-latitude');
    const longitude = row.querySelector('.automation-weather-longitude');
    const timezone = row.querySelector('.automation-weather-timezone');
    const status = row.querySelector('.automation-weather-status');
    if (!latitude || !longitude || !timezone || row.dataset.weatherLocationRequest === 'pending') return;
    if (!force && (latitude.value || longitude.value)) return;
    timezone.value = timezone.value || browserTimezone();
    if (!navigator.geolocation) { status.textContent = 'Ubicacion no disponible; introduce las coordenadas.'; return; }
    row.dataset.weatherLocationRequest = 'pending';
    status.textContent = 'Detectando ubicacion...';
    navigator.geolocation.getCurrentPosition((position) => { latitude.value = position.coords.latitude.toFixed(4); longitude.value = position.coords.longitude.toFixed(4); timezone.value = timezone.value || browserTimezone(); status.textContent = 'Ubicacion detectada; puedes editarla.'; row.dataset.weatherLocationRequest = 'done'; describe(); }, () => { status.textContent = 'No se pudo detectar; usa el boton o introduce las coordenadas.'; row.dataset.weatherLocationRequest = 'failed'; }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 });
  }
  function fill(select, options, empty, selected = select.value) {
    const html = options.length ? options.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('') : `<option value="">${esc(empty)}</option>`;
    if (select.innerHTML !== html) select.innerHTML = html;
    select.value = options.some((item) => item.value === selected) ? selected : options[0]?.value || '';
    select._automationOptions = options;
  }
  const selectedOption = (select) => select?._automationOptions?.find((item) => item.value === select.value);
  function valueField(container, option, value) {
    const old = container.querySelector('input, select');
    const signature = JSON.stringify(option ? [option.type, option.range, option.min, option.max, option.step] : null);
    if (old && old.dataset.signature === signature && value === undefined) return;
    const raw = value !== undefined ? String(value) : old?.value ?? '';
    const range = option?.type === 'boolean' ? [true, false] : option?.range;
    container.innerHTML = range ? `<select class="automation-typed-value">${range.map((item) => `<option value="${esc(item)}">${esc(option.rangeLabels?.[item] || (option.type === 'boolean' ? textValue(item) : item))}</option>`).join('')}</select>` : `<input class="automation-typed-value" type="${option?.type === 'number' ? 'number' : 'text'}" maxlength="1000" placeholder="${esc(option?.placeholder || '')}">`;
    const input = container.firstElementChild;
    input.dataset.signature = signature;
    input.disabled = !option;
    if (option?.type === 'number') { input.step = option.step ?? (option.integer ? 1 : 'any'); if (option.min != null) input.min = option.min; if (option.max != null) input.max = option.max; }
    if (!range || range.some((item) => String(item) === raw)) input.value = raw;
  }
  function sourceOptions(row) {
    const item = sourceDevice(row.querySelector('.automation-condition-device').value);
    if (item?.id === weatherDevice.id) return model.weatherParameters ? model.weatherParameters() : [
      { value: 'temperature', label: 'Temperatura exterior', type: 'number', step: 0.1, placeholder: '24 °C' },
      { value: 'weather_code', label: 'Codigo meteorologico', type: 'number', integer: true, range: Object.keys(weatherCodeLabels).map(Number), rangeLabels: weatherCodeLabels },
      { value: 'wind_speed', label: 'Viento (km/h)', type: 'number', step: 0.1, placeholder: '15 km/h' },
      { value: 'sunrise', label: 'Amanecer (sunrise)', type: 'string', event: true },
      { value: 'sunset', label: 'Atardecer (sunset)', type: 'string', event: true }
    ];
    return row.querySelector('.automation-condition-kind').value === 'command' ? model.commands(item, true) : model.parameters(item);
  }
  function syncSolarSchedule(event, previous) {
    const solar = $('#automation-solar-event');
    const anytime = $('#automation-anytime');
    const time = $('#automation-time');
    const help = $('#automation-anytime-help');
    if (!solar || !time) return;
    if (event) { solar.value = event; if (anytime) anytime.checked = false; time.disabled = true; time.required = false; if (help) help.hidden = true; return; }
    if (previous && solar.value === previous) { solar.value = ''; time.disabled = false; time.required = true; }
  }
  function refreshRow(row, condition) {
    const item = sourceDevice(row.querySelector('.automation-condition-device').value);
    const select = row.querySelector('.automation-condition-path');
    const options = sourceOptions(row);
    const kind = row.querySelector('.automation-condition-kind').value;
    const source = JSON.stringify([row.querySelector('.automation-condition-device').value, kind]);
    const previous = select.dataset.source === source ? selectedOption(select) : null;
    const selected = condition ? condition.kind === 'command' ? condition.commandCode || condition.commandName : condition.path : select.value;
    // Retain legacy readings temporarily absent from the latest telemetry, with their original type.
    if (condition && kind === 'parameter' && selected && !options.some((item) => item.value === selected) && model.safePath(selected)) options.push({ value: selected, label: `${selected} (guardado; sin lectura actual)`, type: typeof condition.value });
    else if (!condition && kind === 'parameter' && previous && !options.some((item) => item.value === selected)) options.push({ ...previous, label: `${selected} (guardado; sin lectura actual)` });
    fill(select, options, kind === 'command' ? 'Sin comandos compatibles' : 'Sin parametros de telemetria', selected);
    select.dataset.source = source;
    const option = selectedOption(select);
    const solarEvent = kind === 'parameter' && item?.id === weatherDevice.id && solarEvents.has(option?.value);
    valueField(row.querySelector('.automation-condition-value-wrap'), solarEvent ? null : option, solarEvent ? true : condition?.value);
    const operator = row.querySelector('.automation-condition-operator');
    const current = solarEvent ? 'eq' : condition?.operator || operator.value || 'eq';
    fill(operator, Object.entries(operators).filter(([key]) => kind !== 'command' || option?.commandCode || ['eq', 'neq'].includes(key)).map(([value, label]) => ({ value, label })), '', current);
    operator.disabled = solarEvent;
    operator.closest('label').hidden = solarEvent;
    row.querySelector('.automation-condition-value-wrap').closest('label').hidden = solarEvent;
    row.dataset.solarEvent = solarEvent ? option.value : '';
    if (solarEvent) syncSolarSchedule(option.value, row.dataset.previousSolarEvent);
    else if (row.dataset.previousSolarEvent) syncSolarSchedule('', row.dataset.previousSolarEvent);
    row.dataset.previousSolarEvent = solarEvent ? option.value : '';
    row.querySelector('.automation-source-help').textContent = solarEvent ? `Evento solar: ${option.label}. Se usa el horario solar y no requiere operador ni valor.` : item?.id === weatherDevice.id ? 'Consulta Open-Meteo con cache: temperatura, viento, codigo meteorologico y eventos solares.' : kind === 'command' ? device(row.querySelector('.automation-condition-device').value)?.provider === 'tuya' ? 'Compara payload.value del ultimo comando de este codigo, incluso si fallo; no envia comandos ni confirma telemetria.' : 'Compara el estado registrado del ultimo comando seleccionado; no envia comandos.' : 'Compara la ultima lectura recibida, conservando su tipo.';
    if (item?.id === weatherDevice.id) { const config = row.querySelector('.automation-weather-config') || document.createElement('div'); config.className = 'automation-weather-config'; config.innerHTML = '<label>Latitud<input class="automation-weather-latitude" type="number" min="-90" max="90" step="any" required></label><label>Longitud<input class="automation-weather-longitude" type="number" min="-180" max="180" step="any" required></label><label>Zona horaria<input class="automation-weather-timezone" maxlength="64" placeholder="America/New_York" required></label><button type="button" class="secondary-button automation-weather-locate">Usar mi ubicacion actual</button><small class="automation-weather-status" role="status"></small>'; if (!config.parentElement) row.append(config); const saved = condition || {}; config.querySelector('.automation-weather-latitude').value = saved.latitude ?? ''; config.querySelector('.automation-weather-longitude').value = saved.longitude ?? ''; config.querySelector('.automation-weather-timezone').value = saved.timezone ?? browserTimezone(); const locate = config.querySelector('.automation-weather-locate'); if (!locate.dataset.bound) { locate.dataset.bound = 'true'; locate.addEventListener('click', () => requestWeatherLocation(row, true)); } if (!condition || (!saved.latitude && !saved.longitude)) requestWeatherLocation(row); } else row.querySelector('.automation-weather-config')?.remove();
  }
  function refreshConditions() {
    if ($('#automation-form')?.contains(document.activeElement)) return;
    $$('.automation-condition-row').forEach((row) => { fill(row.querySelector('.automation-condition-device'), [{ value: '', label: 'Selecciona un dispositivo' }, { value: weatherDevice.id, label: `🌤️ ${weatherDevice.name}` }, ...devices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))], 'Sin dispositivos'); refreshRow(row); });
  }
  function addCondition(condition = {}) {
    $('#automation-condition-rows').insertAdjacentHTML('beforeend', '<div class="automation-condition-row"><label>Dispositivo fuente<select class="automation-condition-device"></select></label><label>Comparar<select class="automation-condition-kind"><option value="parameter">Parametro (telemetria)</option><option value="command">Comando registrado</option></select></label><div class="automation-fields"><label>Parametro / comando<select class="automation-condition-path"></select></label><label>Operador<select class="automation-condition-operator"></select></label></div><label>Valor<span class="automation-condition-value-wrap"></span></label><small class="automation-source-help"></small><button type="button" class="icon-button danger-icon automation-remove-condition" title="Eliminar condicion"><i data-lucide="x"></i></button></div>');
    const row = $$('.automation-condition-row').at(-1);
    fill(row.querySelector('.automation-condition-device'), [{ value: '', label: 'Selecciona un dispositivo' }, { value: weatherDevice.id, label: `🌤️ ${weatherDevice.name}` }, ...devices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))], 'Sin dispositivos', condition.deviceId || '');
    row.querySelector('.automation-condition-kind').value = condition.kind || 'parameter';
    refreshRow(row, condition);
    describe(); renderIcons();
  }
  function readConditions() {
    return $$('.automation-condition-row').filter((row) => row.querySelector('.automation-condition-device').value).map((row) => {
      const option = selectedOption(row.querySelector('.automation-condition-path'));
      const kind = row.querySelector('.automation-condition-kind').value;
      const solarEvent = kind === 'parameter' && row.dataset.solarEvent;
      const result = { kind, deviceId: row.querySelector('.automation-condition-device').value, operator: solarEvent ? 'eq' : row.querySelector('.automation-condition-operator').value, value: solarEvent ? true : model.typedValue(row.querySelector('.automation-typed-value').value, option) };
      if (kind === 'parameter') result.path = option.value;
      else { result.commandName = option.commandName; result.commandField = option.commandCode ? 'value' : 'status'; if (option.commandCode) result.commandCode = option.commandCode; }
      if (result.deviceId === weatherDevice.id) { result.latitude = Number(row.querySelector('.automation-weather-latitude').value); result.longitude = Number(row.querySelector('.automation-weather-longitude').value); result.timezone = row.querySelector('.automation-weather-timezone').value.trim(); if (!Number.isFinite(result.latitude) || result.latitude < -90 || result.latitude > 90) throw new Error('La latitud debe estar entre -90 y 90.'); if (!Number.isFinite(result.longitude) || result.longitude < -180 || result.longitude > 180) throw new Error('La longitud debe estar entre -180 y 180.'); if (!result.timezone) throw new Error('La zona horaria es obligatoria.'); }
      return result;
    });
  }
  function populateActions(force = false) {
    const form = $('#automation-form');
    if (!form || !$('#automation-target-value-wrap')) return;
    if (!force && form?.contains(document.activeElement)) return;
    const mode = $('#automation-target-kind')?.value || 'command';
    const item = device($('#automation-device')?.value);
    const options = mode === 'parameter' ? model.writable(item) : model.commands(item);
    const action = $('#automation-action');
    fill(action, options, mode === 'parameter' ? 'Sin parametros escribibles con protocolo compatible' : 'Sin comandos compatibles');
    action.disabled = !options.length;
    updateActionFields();
  }
  function updateActionFields(value) {
    const option = selectedOption($('#automation-action'));
    const tuya = Boolean(option?.commandCode || $('#automation-target-kind')?.value === 'parameter' && option);
    const dynamic = Boolean(option && (tuya || option.value === 'position'));
    const sourceSelected = Boolean($('#automation-value-source-device')?.value || $('#automation-value-source-parameter')?.value);
    $('#automation-position-field').hidden = !option || tuya || option.value !== 'position' || sourceSelected;
    $('#automation-position-source-field').hidden = !dynamic;
    $('#automation-motion-fields').hidden = !option || tuya;
    $('#automation-target-value-field').hidden = !tuya || sourceSelected;
    valueField($('#automation-target-value-wrap'), tuya ? option : null, value);
    if (dynamic) populateValueSource();
    $('#automation-target-help').textContent = !option ? 'Este dispositivo no declara acciones compatibles. La telemetria de solo lectura no puede asignarse.' : tuya ? 'Asigna el parametro con un valor literal o replica el valor de otro dispositivo.' : 'Comando compatible con el protocolo de cortina.';
    $('#automation-submit').disabled = !option;
    describe();
  }
  function populateValueSource(source) {
    const deviceSelect = $('#automation-value-source-device');
    const parameterSelect = $('#automation-value-source-parameter');
    const transformSelect = $('#automation-value-source-transform');
    const divisorInput = $('#automation-value-source-divisor');
    if (!deviceSelect || !parameterSelect) return;
    const selectedDevice = source?.deviceId || deviceSelect.value;
    fill(deviceSelect, [{ value: '', label: 'Selecciona un dispositivo fuente' }, ...devices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))], 'Sin dispositivos');
    deviceSelect.value = devices.some((item) => item.id === selectedDevice) ? selectedDevice : '';
    const position = selectedOption($('#automation-action'))?.value === 'position';
    const options = model.parameters(sourceDevice(deviceSelect.value)).filter((option) => !position || option.type === 'number');
    fill(parameterSelect, options, position ? 'Sin parametros numericos para calcular la posicion' : 'Sin parametros de telemetria');
    const selectedPath = source?.path || parameterSelect.value;
    parameterSelect.value = options.some((item) => item.value === selectedPath) ? selectedPath : '';
    parameterSelect.disabled = !deviceSelect.value || !options.length;
    const defaultTransform = position ? 'divide' : 'copy';
    const defaultDivisor = position ? 100 : 1;
    if (transformSelect) transformSelect.value = source?.transform || (transformSelect.dataset.userSelected ? transformSelect.value : defaultTransform);
    if (divisorInput) divisorInput.value = source?.divisor ?? (divisorInput.dataset.userSelected ? divisorInput.value : defaultDivisor);
    const sourceHeading = $('#automation-position-source-field .automation-source-heading');
    const sourceExample = $('#automation-position-source-field > small');
    if (sourceHeading) sourceHeading.innerHTML = position ? '<strong>Calculo de posicion</strong><small>Convierte una lectura numerica en porcentaje para la cortina.</small>' : '<strong>Fuente de valor</strong><small>Replica un parametro de otro dispositivo o transformalo antes de enviarlo al destino.</small>';
    if (sourceExample) sourceExample.textContent = position ? 'Ejemplo: brightness 500 / 100 mueve la cortina a 5%.' : 'Ejemplo: brightness de Bedroom 1 se envia como brightness de Sala.';
  }
  function target() {
    const option = selectedOption($('#automation-action'));
    if (!option) throw new Error('Selecciona una accion compatible para el dispositivo destino.');
    const tuya = device($('#automation-device').value)?.provider === 'tuya';
    const result = tuya ? { action: 'open', commandName: 'tuya.set', commandPayload: { code: option.commandCode || option.value } } : { action: option.value, commandName: null, commandPayload: null };
    const sourceDeviceId = $('#automation-value-source-device')?.value;
    const sourcePath = $('#automation-value-source-parameter')?.value;
    const dynamic = sourceDeviceId || sourcePath;
    if (tuya && !dynamic) result.commandPayload.value = model.typedValue($('#automation-target-value-wrap .automation-typed-value').value, option);
    if (dynamic) { if (!sourceDeviceId || !sourcePath) throw new Error('Selecciona el dispositivo y el parametro fuente.'); const transform = $('#automation-value-source-transform')?.value || 'copy'; const divisor = Number($('#automation-value-source-divisor')?.value || 1); if (!['copy', 'divide'].includes(transform) || !Number.isFinite(divisor) || divisor <= 0) throw new Error('La transformacion requiere una operacion y un divisor validos.'); result.valueSource = { deviceId: sourceDeviceId, path: sourcePath, transform, divisor }; }
    return result;
  }
  function conditionLabel(condition) {
    const item = sourceDevice(condition.deviceId);
    const options = condition.kind === 'command' ? model.commands(item, true) : model.parameters(item);
    const key = condition.path || condition.commandCode || condition.commandName;
    const option = options.find((item) => item.value === key);
    const weatherLabel = { sunrise: 'Amanecer (sunrise)', sunset: 'Atardecer (sunset)', temperature: 'Temperatura exterior', weather_code: 'Codigo meteorologico', wind_speed: 'Viento (km/h)' }[key];
    if (condition.deviceId === weatherDevice.id && solarEvents.has(key)) return `es ${weatherLabel || option?.label || key} (Open-Meteo)`;
    if (condition.deviceId === weatherDevice.id) return `Clima · ${weatherLabel || option?.label || key} ${operators[condition.operator] || condition.operator} ${textValue(condition.value)}`;
    return `${item?.name || condition.deviceId} · ${option?.label || key} ${operators[condition.operator] || condition.operator} ${textValue(condition.value)}`;
  }
  function describe() {
    const description = $('#automation-condition-description');
    if (!description) return;
    let conditions; try { conditions = readConditions(); } catch { description.textContent = 'Completa las condiciones con valores validos.'; return; }
    const option = selectedOption($('#automation-action'));
    const item = device($('#automation-device')?.value);
    let value = ''; try { const result = target(); value = result.valueSource ? result.action === 'position' ? ` = (${sourceDevice(result.valueSource.deviceId)?.name || result.valueSource.deviceId} · ${result.valueSource.path}) / ${result.valueSource.divisor}%` : ` = ${sourceDevice(result.valueSource.deviceId)?.name || result.valueSource.deviceId} · ${result.valueSource.path}` : result.commandPayload ? ` = ${textValue(result.commandPayload.value)}` : result.action === 'position' ? ` a ${$('#automation-position').value}%` : ''; } catch { /* Unselected target. */ }
    description.textContent = `${conditions.length ? `SI ${conditions.map(conditionLabel).join(' Y ')}` : 'Sin condiciones: solo horario'}; ENTONCES ${item?.name || 'selecciona destino'} · ${option?.label || 'selecciona accion'}${value}.`;
  }
  function enhanceForm(form, thenStep, scheduleStep) {
    scheduleStep.before(thenStep); // SI -> ENTONCES -> horario -> botones.
    const timeField = $('#automation-time')?.closest('.automation-fields');
    timeField?.insertAdjacentHTML('afterend', '<label>Evento solar<select id="automation-solar-event"><option value="">Hora fija</option><option value="sunrise">Amanecer (sunrise)</option><option value="sunset">Atardecer (sunset)</option></select></label><label class="automation-anytime"><input id="automation-anytime" type="checkbox"> Cualquier hora del dia</label><label>Revisar cada<select id="automation-check-interval"><option value="5">5 segundos</option><option value="15">15 segundos</option><option value="30" selected>30 segundos</option><option value="60">1 minuto</option><option value="300">5 minutos</option></select></label><small id="automation-anytime-help">La accion se envia en cada revision mientras se cumplan las condiciones.</small>');
    const syncSchedule = () => { const anytime = $('#automation-anytime'); const solar = $('#automation-solar-event'); const time = $('#automation-time'); if (!anytime || !solar || !time) return; const dynamic = anytime.checked || Boolean(solar.value); time.disabled = dynamic; time.required = !dynamic; $('#automation-anytime-help').hidden = !anytime.checked; };
    $('#automation-anytime')?.addEventListener('change', syncSchedule);
    $('#automation-solar-event')?.addEventListener('change', () => { if ($('#automation-solar-event').value) $('#automation-anytime').checked = false; syncSchedule(); });
    syncSchedule();
    $('#automation-action').closest('label').insertAdjacentHTML('beforebegin', '<label>Tipo de accion<select id="automation-target-kind"><option value="command">Comando</option><option value="parameter">Asignar parametro</option></select></label>');
    thenStep.insertAdjacentHTML('beforeend', '<div class="automation-target-heading"><strong>Dispositivo destino</strong><small>Este dispositivo recibira la accion.</small></div><label id="automation-target-value-field" hidden>Valor literal<span id="automation-target-value-wrap"></span></label><div id="automation-position-source-field" class="automation-position-source" hidden><div class="automation-source-heading"><strong>Fuente de valor</strong><small>Replica un parametro de otro dispositivo o transformalo antes de enviarlo al destino.</small></div><label>Dispositivo fuente<select id="automation-value-source-device"><option value="">Selecciona el dispositivo fuente</option></select></label><label>Parametro fuente<select id="automation-value-source-parameter"><option value="">Selecciona el parametro</option></select></label><div class="automation-fields"><label>Transformacion<select id="automation-value-source-transform"><option value="copy">Replicar valor</option><option value="divide">Dividir</option></select></label><label>Divisor<input id="automation-value-source-divisor" type="number" min="0.000001" step="any" value="1"></label></div><small>Ejemplo: brightness de Bedroom 1 se envia como brightness de Sala.</small></div><small id="automation-target-help"></small>');
    form.addEventListener('change', (event) => {
      const row = event.target.closest('.automation-condition-row');
      if (row && event.target.matches('.automation-condition-device, .automation-condition-kind, .automation-condition-path')) {
        if (!event.target.matches('.automation-condition-path')) row.querySelector('.automation-condition-path').value = '';
        // A user-selected source starts a new comparison; background refresh and edit restoration do not.
        row.querySelector('.automation-condition-operator').value = 'eq';
        row.querySelector('.automation-condition-value-wrap').innerHTML = '';
        refreshRow(row);
      }
      if (event.target.id === 'automation-target-kind') populateActions(true);
      if (event.target.id === 'automation-value-source-device') { populateValueSource(); updateActionFields(); }
      if (event.target.id === 'automation-value-source-parameter' && event.target.value) { $('#automation-anytime').checked = true; $('#automation-anytime').dispatchEvent(new Event('change')); updateActionFields(); }
      if (event.target.id === 'automation-value-source-transform' || event.target.id === 'automation-value-source-divisor') event.target.dataset.userSelected = 'true';
      describe();
    });
    form.addEventListener('input', describe);
  }
  function editTarget(rule) {
    $('#automation-target-kind').value = rule.commandName === 'tuya.set' ? 'parameter' : 'command';
    populateActions(true);
    $('#automation-action').value = rule.commandName === 'tuya.set' ? rule.commandPayload?.code : rule.action;
    updateActionFields(rule.commandPayload?.value);
    if (rule.valueSource) { populateValueSource(rule.valueSource); updateActionFields(); }
  }
  function setSchedule(triggerTime, checkIntervalSeconds = 30) {
    const anytime = triggerTime === 'anytime';
    $('#automation-anytime').checked = anytime;
    $('#automation-solar-event').value = ['sunrise', 'sunset'].includes(triggerTime) ? triggerTime : '';
    $('#automation-time').value = anytime ? '' : triggerTime;
    $('#automation-check-interval').value = String(checkIntervalSeconds || 30);
    $('#automation-solar-event').dispatchEvent(new Event('change'));
    $('#automation-anytime').dispatchEvent(new Event('change'));
  }
  function triggerTime() {
    return $('#automation-anytime')?.checked ? 'anytime' : $('#automation-solar-event')?.value || $('#automation-time').value;
  }
  return { addCondition, readConditions, refreshConditions, populateActions, updateActionFields, target, conditionLabel, describe, enhanceForm, editTarget, setSchedule, triggerTime };
})();