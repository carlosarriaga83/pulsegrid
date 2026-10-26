(function (root) {
  'use strict';

  function mountTenstarCalibrationWizard(context) {
    const { $, apiRequest, loadDevices, waitForCalibrationCommand, showToast, renderIcons } = context;
    const layout = $('.command-calibration-layout');
    if (!layout) return;
    let wizard = $('#calibration-wizard');
    if (wizard?.dataset.calibrationModel === 'tenstar') { wizard._tenstarUpdate(); return; }
    if (wizard?._tenstarRefreshTimer) root.clearInterval(wizard._tenstarRefreshTimer);
    if (wizard?._tenstarDeviceChange) $('#command-device')?.removeEventListener('change', wizard._tenstarDeviceChange);
    wizard?.remove();
    layout.insertAdjacentHTML('beforeend', `
      <section class="panel calibration-wizard" id="calibration-wizard" data-calibration-model="tenstar">
        <div class="panel-heading"><div><h2>Calibrar Tenstar desde abierto</h2><p>Abierto → probar sentido → bajar por vueltas → confirmar cerrado.</p></div><span class="secure-badge">Encoder</span></div>
        <p class="calibration-safety-note">Coloca manualmente la cortina completamente abierta, sin forzar el tope. Despeja el mecanismo y mantén accesible el corte de alimentación. Los pasos requieren supervisión; no se buscan topes automáticamente.</p>
        <div class="blind-calibration-readout"><span>Estado</span><strong id="tenstar-calibration-state"></strong><span id="tenstar-calibration-detail" class="calibration-progress"></span></div>
        <p id="calibration-status" class="form-status" role="status" aria-live="polite"></p>
        <div class="calibration-actions">
          <button class="primary-button full-width" id="tenstar-calibration-begin" type="button">1. Estoy en abierto · iniciar / resetear calibración</button>
          <button class="secondary-button full-width" id="tenstar-test-direction" type="button">2. Probar un paso pequeño (0,05 vueltas)</button>
          <div class="calibration-jog-controls"><button class="secondary-button" id="tenstar-test-up" type="button">El paso subió ↑</button><button class="secondary-button" id="tenstar-test-down" type="button">El paso bajó ↓</button></div>
          <label>3. Vueltas por movimiento<input id="tenstar-calibration-turns" type="number" min="0.01" max="20" step="0.01" value="0.25" inputmode="decimal"></label>
          <div class="calibration-jog-controls"><button class="secondary-button" id="tenstar-step-up" type="button">Subir ↑</button><button class="secondary-button" id="tenstar-step-down" type="button">Bajar ↓</button></div>
          <button class="secondary-button full-width" id="tenstar-stop" type="button">Detener motor</button>
          <button class="primary-button full-width" id="tenstar-mark-closed" type="button">4. Está completamente cerrada · guardar recorrido</button>
          <button class="secondary-button full-width" id="tenstar-reference-open" type="button">Después de reiniciar: estoy en abierto · recuperar referencia</button>
        </div>
        <p class="calibration-safety-note">Abierto = 100%; cerrado = 0%. El encoder mide cambios, no una posición absoluta después de apagar. La calibración se conserva, pero tras reiniciar coloca manualmente la cortina en abierto y recupera la referencia, sin volver a calibrar.</p>
      </section>`);
    wizard = $('#calibration-wizard');
    const get = (selector) => $(selector, wizard);
    const status = get('#calibration-status');
    let pending = 0;
    let message = '';
    const selected = () => {
      const device = context.devices().find((item) => item.id === $('#command-device')?.value);
      return { device, telemetry: context.parseTelemetry(device?.telemetry) || {} };
    };
    async function command(name, payload = {}) {
      const { device } = selected();
      if (!device || device.status !== 'online') throw new Error('Selecciona un Tenstar en línea.');
      pending += 1;
      message = 'Esperando confirmación del dispositivo…';
      update();
      try {
        const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId: device.id, command: name, payload }) });
        await waitForCalibrationCommand(result.commandId);
        await loadDevices();
        message = 'Comando confirmado. La posición se actualizará con la telemetría.';
        showToast('Calibración Tenstar actualizada');
      } finally {
        pending -= 1;
        update();
      }
    }
    function update() {
      const { device, telemetry } = selected();
      const state = telemetry.calibration || {};
      const online = device?.status === 'online' && telemetry.firmwareTarget === 'tenstar';
      const supported = telemetry.calibrationMode === 'open-first-v1';
      const remoteStop = telemetry.remoteStopDuringMotion !== false;
      const moving = telemetry.moving === true;
      const idle = online && supported && !pending && !moving;
      const active = state.active === true && telemetry.positionValid === true && !state.calibrated;
      const confirmed = state.direction_confirmed === true;
      get('#tenstar-calibration-state').textContent = !online ? 'Tenstar fuera de línea' : !supported ? 'Actualiza el firmware a Tenstar r5 o posterior' : state.calibrated ? (telemetry.positionValid ? 'Recorrido guardado: abierto 100% · cerrado 0%' : 'Recorrido guardado; recupera la referencia en abierto') : active ? (confirmed ? 'Sentido confirmado. Avanza por vueltas hasta cerrar.' : state.test_started ? 'Observa el paso: ¿subió o bajó?' : 'Abierto fijado como origen. Prueba el sentido.') : 'Coloca la cortina en abierto para empezar';
      const relative = Number(telemetry.positionTurns);
      const span = Number(state.open_span_pulses) || 0;
      get('#tenstar-calibration-detail').textContent = state.calibrated ? `Recorrido: ${(span / (Number(telemetry.pulsesPerRevolution) || 1980)).toFixed(3)} vueltas · ${span} pulsos` : `Desde abierto: ${Number.isFinite(relative) ? relative.toFixed(3) : '—'} vueltas · ${Number(telemetry.positionPulses) || 0} pulsos`;
      const safety = remoteStop ? '' : ' HTTPS y portal se pausan al girar. No hay parada remota durante el movimiento: mantén accesible el corte físico de alimentación.';
      status.textContent = (message || 'Sigue los cuatro pasos. El motor no se mueve al iniciar ni al guardar los extremos.') + safety;
      get('#tenstar-calibration-begin').disabled = !idle;
      get('#tenstar-test-direction').disabled = !idle || !active || state.test_started === true;
      for (const selector of ['#tenstar-test-up', '#tenstar-test-down']) get(selector).disabled = !idle || !active || !state.test_started || confirmed;
      for (const selector of ['#tenstar-step-up', '#tenstar-step-down', '#tenstar-calibration-turns', '#tenstar-mark-closed']) get(selector).disabled = !idle || !active || !confirmed;
      get('#tenstar-reference-open').disabled = !idle || !state.calibrated;
      get('#tenstar-stop').disabled = !online || !remoteStop;
      get('#tenstar-stop').textContent = remoteStop ? 'Detener motor' : 'Parada remota no disponible · usa corte físico';
    }
    function bind(selector, name, payload = () => ({}), prompt = '') {
      get(selector).addEventListener('click', async () => {
        if (prompt && !root.confirm(prompt)) return;
        try { await command(name, payload()); }
        catch (error) { message = error.message; status.textContent = message; update(); }
      });
    }
    bind('#tenstar-calibration-begin', 'tenstar.calibration.begin', () => ({ atOpen: true }), 'Confirma que la cortina está completamente abierta. Se borra el recorrido anterior y se fija este origen sin mover el motor.');
    bind('#tenstar-test-direction', 'tenstar.calibration.testDirection', () => ({}), 'Se moverá 0,05 vueltas para comprobar el sentido. Vigila el mecanismo y mantén accesible el corte físico de alimentación.');
    bind('#tenstar-test-up', 'tenstar.calibration.confirmDirection', () => ({ movement: 'up' }));
    bind('#tenstar-test-down', 'tenstar.calibration.confirmDirection', () => ({ movement: 'down' }));
    for (const [selector, direction] of [['#tenstar-step-up', 'up'], ['#tenstar-step-down', 'down']]) {
      bind(selector, 'tenstar.calibration.step', () => {
        const turns = Number(get('#tenstar-calibration-turns').value);
        if (!Number.isFinite(turns) || turns <= 0 || turns > 20) throw new Error('Introduce vueltas mayores que 0 y hasta 20.');
        return { direction, turns };
      });
    }
    bind('#tenstar-mark-closed', 'tenstar.calibration.setClosed', () => ({}), 'Confirma que está completamente cerrada y detenida, sin forzar el tope. Se guardará el recorrido medido.');
    bind('#tenstar-reference-open', 'tenstar.calibration.referenceOpen', () => ({}), 'Confirma que la has colocado manualmente completamente abierta. Recupera la referencia sin mover ni borrar la calibración.');
    bind('#tenstar-stop', 'curtain.stop');
    wizard._tenstarUpdate = update;
    wizard._tenstarDeviceChange = () => { message = ''; update(); };
    $('#command-device')?.addEventListener('change', wizard._tenstarDeviceChange);
    wizard._tenstarRefreshTimer = root.setInterval(() => {
      if (!wizard.isConnected) { root.clearInterval(wizard._tenstarRefreshTimer); return; }
      update();
    }, 1000);
    update();
    renderIcons();
  }
  root.mountTenstarCalibrationWizard = mountTenstarCalibrationWizard;
})(typeof window !== 'undefined' ? window : globalThis);
