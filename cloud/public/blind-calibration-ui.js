(function (root) {
  'use strict';

  function mountGa25CalibrationWizard(context) {
    const { $, apiRequest, loadDevices, waitForCalibrationCommand, showToast, getCalibrationDeviceModel, devices, parseTelemetry } = context;
    const layout = $('.command-calibration-layout') || $('.command-layout');
    if (!layout || $('#calibration-wizard')) return;
    layout.insertAdjacentHTML('beforeend', `<div class="panel calibration-wizard" id="calibration-wizard">
      <div class="panel-heading"><div><h2>Calibración de recorrido GA25</h2><p>Se mide el tiempo real entre extremos; la posición seguirá siendo una estimación temporizada, sin encoder.</p></div><span class="secure-badge">Supervisada</span></div>
      <label>Sentido para abrir<select id="ga25-open-direction"><option value="false">Normal</option><option value="true">Invertido</option></select></label>
      <p class="calibration-safety-note"><strong>Antes de iniciar:</strong> coloca manualmente la cortina completamente cerrada. La calibración GA25 mide el tiempo, pero no puede detectar qué sentido físico abre la cortina. Selecciona el sentido y observa el inicio: debe ir hacia abierta; si va hacia cerrada, cancela, invierte el sentido y vuelve a empezar. Pulsa Guardar y parar justo al llegar al extremo abierto. No dejes que el motor empuje contra topes mecánicos.</p>
      <p id="ga25-calibration-status" class="form-status" aria-live="polite">La calibración reemplazará el tiempo de recorrido guardado.</p>
      <div class="calibration-stage-actions"><button class="primary-button" id="ga25-calibration-start" type="button">Iniciar desde cerrado</button><button class="secondary-button calibration-stop" id="ga25-calibration-stop" type="button" disabled>Guardar tiempo y parar</button><button class="secondary-button" id="ga25-calibration-cancel" type="button" disabled>Cancelar sin guardar</button></div>
    </div>`);
    const status = $('#ga25-calibration-status');
    const startButton = $('#ga25-calibration-start');
    const stopButton = $('#ga25-calibration-stop');
    const cancelButton = $('#ga25-calibration-cancel');
    const directionSelect = $('#ga25-open-direction');
    const selectedDevice = () => devices?.().find((item) => item.id === $('#command-device')?.value);
    const currentDirectionReversed = () => parseTelemetry?.(selectedDevice()?.telemetry)?.directionReversed === true;
    directionSelect.value = String(currentDirectionReversed());
    let active = false;
    let busy = false;
    const send = async (command, payload = {}) => {
      const deviceId = $('#command-device')?.value;
      if (!deviceId || getCalibrationDeviceModel() !== 'ga25') throw new Error('Selecciona un dispositivo GA25.');
      const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command, payload }) });
      await waitForCalibrationCommand(result.commandId);
      await loadDevices();
    };
    const render = () => {
      startButton.disabled = busy || active;
      stopButton.disabled = busy || !active;
      cancelButton.disabled = busy || !active;
    };
    startButton.addEventListener('click', async () => {
      try {
        busy = true; render();
        const reversed = directionSelect.value === 'true';
        if (reversed !== currentDirectionReversed()) {
          status.textContent = 'Guardando el sentido de apertura seleccionado…';
          await send('direction.configure', { reversed });
        }
        status.textContent = 'Arrancando desde el extremo cerrado. Confirma que el movimiento vaya hacia abierta.';
        await send('blind.ga25CalibrationStart', { from: 'closed' });
        active = true;
        status.textContent = 'Motor en movimiento. Verifica el sentido ahora. Si se mueve hacia cerrada, pulsa Cancelar; si va hacia abierta, espera al extremo y pulsa Guardar tiempo y parar.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    stopButton.addEventListener('click', async () => {
      try {
        busy = true; render();
        await send('blind.ga25CalibrationStop');
        active = false;
        status.textContent = 'Tiempo completo guardado en el GA25. La posición se calcula por tiempo y puede requerir repetir la medición.';
        showToast('Tiempo de recorrido GA25 guardado');
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    cancelButton.addEventListener('click', async () => {
      try {
        busy = true; render();
        await send('blind.ga25CalibrationCancel');
        active = false;
        status.textContent = 'Calibración detenida sin guardar cambios.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    render();
  }

  function mountBlindCalibrationWizard(context) {
    if (context.getCalibrationDeviceModel?.() === 'ga25') mountGa25CalibrationWizard(context);
  }

  root.mountGa25CalibrationWizard = mountGa25CalibrationWizard;
  root.mountBlindCalibrationWizard = mountBlindCalibrationWizard;
})(typeof window !== 'undefined' ? window : globalThis);