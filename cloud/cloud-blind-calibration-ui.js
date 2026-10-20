(function (root) {
  'use strict';

  function mountCloudBlindCalibrationWizard(context) {
    const { $, apiRequest, loadDevices, waitForCalibrationCommand, showToast, renderIcons } = context;
    const layout = $('.command-calibration-layout');
    if (!layout || $('#calibration-wizard')) return;
    layout.insertAdjacentHTML('beforeend', `<div class="panel calibration-wizard" id="calibration-wizard"><div class="panel-heading"><div><h2>Calibración geométrica</h2><p>El cloud calcula el recorrido y envía los límites estimados al servo.</p></div><span class="secure-badge">Cloud-first</span></div><div class="calibration-settings"><label>Alto de ventana (cm)<input id="calibration-height" type="number" min="20" max="1000" step="0.1" value="150"></label><label>Diámetro exterior del tubo (cm)<input id="calibration-diameter" type="number" min="1" max="30" step="0.1" value="5"></label><label>Grosor del paño (mm)<input id="calibration-thickness" type="number" min="0.01" max="5" step="0.01" value="0.5"></label><label>Vueltas motor por vuelta de tubo<input id="calibration-ratio" type="number" min="0.1" max="20" step="0.01" value="1"></label><label>Servo<select id="calibration-servo"><option value="1">Servo 1</option><option value="2">Servo 2</option></select></label></div><div class="blind-calibration-readout"><span>Recorrido geométrico estimado</span><strong id="calibration-estimate">Ingresa las medidas</strong><span id="calibration-limit" class="calibration-progress">Límites operativos: 80% del cálculo, centrados en la posición actual.</span></div><p class="calibration-safety-note"><strong>Antes de aplicar:</strong> coloca manualmente la cortina cerca de la mitad del recorrido y verifica visualmente las medidas. El cálculo no detecta topes, fuerza ni atascos; los límites son estimados y conservadores. Corrige el sentido desde el toggle del dispositivo si hace falta.</p><p id="calibration-status" class="form-status" aria-live="polite">Introduce las medidas para calcular el recorrido.</p><button class="primary-button full-width" id="calibration-apply" type="button">Aplicar calibración desde el cloud</button></div>`);
    $('#calibration-apply').insertAdjacentHTML('beforebegin', '<button class="secondary-button full-width" id="calibration-recover-reference" type="button" hidden>Establecer referencia del encoder aquí (cortina centrada)</button>');
    const get = (id) => $(`#${id}`);
    const status = get('calibration-status');
    const recover = get('calibration-recover-reference');
    const selectedState = () => {
      const deviceId = $('#command-device')?.value;
      const device = context.devices().find((item) => item.id === deviceId);
      const telemetry = context.parseTelemetry(device?.telemetry) || {};
      const servoId = Number(get('calibration-servo').value);
      const servo = telemetry.servos?.[String(servoId)] || telemetry.servos?.[servoId];
      return { device, telemetry, servoId, servo };
    };
    const supportsReferenceRecovery = (version) => {
      const match = String(version || '').match(/servo-r(\d+)$/i);
      return Boolean(match && Number(match[1]) >= 23);
    };
    const waitForReferenceTelemetry = async (deviceId, servoId) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await loadDevices();
        const device = context.devices().find((item) => item.id === deviceId);
        const telemetry = context.parseTelemetry(device?.telemetry) || {};
        const servo = telemetry.servos?.[String(servoId)] || telemetry.servos?.[servoId];
        if (servo?.position_recovery_required === false) return;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error('El dispositivo confirmó el comando, pero aún no publicó la referencia recuperada. Actualiza el estado e inténtalo de nuevo.');
    };
    const updateRecoveryAction = () => {
      const { device, telemetry, servo } = selectedState();
      const needsRecovery = telemetry.firmwareTarget === 'servo' && servo?.position_recovery_required === true;
      recover.hidden = !needsRecovery;
      recover.disabled = !needsRecovery || device?.status !== 'online' || !supportsReferenceRecovery(telemetry.firmwareVersion);
      if (needsRecovery && device?.status !== 'online') status.textContent = 'El dispositivo está fuera de línea; no se envió nada. Conéctalo al cloud para recuperar el encoder.';
      else if (needsRecovery && !supportsReferenceRecovery(telemetry.firmwareVersion)) status.textContent = 'El firmware actual no admite recuperar el encoder desde el cloud. Actualiza a Servo r23 o posterior.';
    };
    recover.addEventListener('click', async () => {
      const { device, telemetry, servoId } = selectedState();
      try {
        if (!device || device.status !== 'online') throw new Error('El dispositivo está fuera de línea; no se envió nada. Conéctalo al cloud primero.');
        if (!supportsReferenceRecovery(telemetry.firmwareVersion)) throw new Error('Actualiza el dispositivo a Servo r23 o posterior antes de recuperar el encoder.');
        recover.disabled = true;
        status.textContent = 'Estableciendo el punto actual como referencia; el motor no se moverá…';
        const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId: device.id, command: 'blind.encoderReferenceRecover', payload: { servoId, atMidpoint: true } }) });
        await waitForCalibrationCommand(result.commandId);
        await waitForReferenceTelemetry(device.id, servoId);
        updateRecoveryAction();
        status.textContent = 'Referencia guardada en la posición actual. Ahora puedes aplicar la calibración geométrica.';
      } catch (error) { status.textContent = error.message; }
      finally { updateRecoveryAction(); }
    });
    get('calibration-servo').addEventListener('change', updateRecoveryAction);
    const inputs = ['calibration-height', 'calibration-diameter', 'calibration-thickness', 'calibration-ratio'];
    const values = () => ({ height: Number(get('calibration-height').value), diameter: Number(get('calibration-diameter').value), thickness: Number(get('calibration-thickness').value), ratio: Number(get('calibration-ratio').value) });
    const calculate = () => {
      const value = values();
      const turns = root.BlindCalibrationModel.estimateTurns(value.height, value.diameter, value.thickness, value.ratio);
      get('calibration-estimate').textContent = `${turns.toFixed(2)} vueltas estimadas`;
      get('calibration-limit').textContent = `Rango operativo total limitado a ${(turns * 0.8).toFixed(2)} vueltas (± ${(turns * 0.4).toFixed(2)} desde la posición actual).`;
      return { ...value, turns };
    };
    const updateEstimate = () => {
      try { calculate(); status.textContent = 'Estimación lista; revisa el punto de partida y las medidas.'; }
      catch (error) { get('calibration-estimate').textContent = 'Medidas no válidas'; status.textContent = error.message; }
    };
    inputs.forEach((id) => get(id).addEventListener('input', updateEstimate));
    const apply = get('calibration-apply');
    apply.addEventListener('click', async () => {
      const deviceId = $('#command-device')?.value;
      const servoId = Number(get('calibration-servo').value);
      const device = context.devices().find((item) => item.id === deviceId);
      const telemetry = context.parseTelemetry(device?.telemetry) || {};
      const servo = telemetry.servos?.[String(servoId)] || telemetry.servos?.[servoId];
      try {
        if (!deviceId) throw new Error('Selecciona un dispositivo Servo.');
        if (device.status !== 'online') throw new Error('El dispositivo está fuera de línea; no se envió nada. Conéctalo al cloud primero.');
        if (String(telemetry.firmwareTarget || '').toLowerCase() !== 'servo') throw new Error('Selecciona un dispositivo con firmware Servo.');
        if (servo?.position_recovery_required !== false) throw new Error('El encoder requiere recuperar una referencia fiable antes de configurar límites. No se envió ningún movimiento.');
        const estimate = calculate();
        apply.disabled = true;
        status.textContent = 'Enviando cálculo y límites estimados al ESP32…';
        const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command: 'blind.cloudCalibrationConfigure', payload: { servoId, heightCm: estimate.height, tubeDiameterCm: estimate.diameter, fabricThicknessMm: estimate.thickness, motorTurnsPerTubeTurn: estimate.ratio, estimatedTurns: estimate.turns } }) });
        await waitForCalibrationCommand(result.commandId);
        await loadDevices();
        status.textContent = 'Configuración aplicada. No se inició movimiento; dirección ajustable desde el toggle del dispositivo.';
        showToast('Calibración geométrica aplicada');
      } catch (error) { status.textContent = error.message; }
      finally { apply.disabled = false; }
    });
    try { calculate(); } catch (error) { status.textContent = error.message; }
    updateRecoveryAction();
    renderIcons();
  }

  root.mountCloudBlindCalibrationWizard = mountCloudBlindCalibrationWizard;
})(typeof window !== 'undefined' ? window : globalThis);
