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
        <ol class="tenstar-calibration-steps">
          <li data-tenstar-step="1"><h3>1. Fijar abierto <span class="tenstar-step-check" role="status"></span></h3>
            <p>Coloca manualmente la cortina completamente abierta. No se mueve al fijar el origen.</p>
            <button class="primary-button full-width" id="tenstar-calibration-begin" type="button">Estoy en abierto · iniciar / resetear calibración</button>
          </li>
          <li data-tenstar-step="2"><h3>2. Comprobar el sentido <span class="tenstar-step-check" role="status"></span></h3>
            <button class="secondary-button full-width" id="tenstar-test-direction" type="button">Probar un paso pequeño (0,05 vueltas)</button>
            <div class="calibration-jog-controls"><button class="secondary-button" id="tenstar-test-up" type="button">El paso subió ↑</button><button class="secondary-button" id="tenstar-test-down" type="button">El paso bajó ↓</button></div>
          </li>
          <li data-tenstar-step="3"><h3>3. Llevar hasta cerrado <span class="tenstar-step-check" role="status"></span></h3>
            <p id="tenstar-step-help" role="status"></p>
            <label>Vueltas por movimiento<input id="tenstar-calibration-turns" type="number" min="0.01" max="20" step="0.01" value="0.25" inputmode="decimal"></label>
            <div class="calibration-jog-controls"><button class="secondary-button" id="tenstar-step-up" type="button">Subir ↑</button><button class="secondary-button" id="tenstar-step-down" type="button">Bajar ↓</button></div>
          </li>
          <li data-tenstar-step="4"><h3>4. Confirmar y guardar <span class="tenstar-step-check" role="status"></span></h3>
            <button class="primary-button full-width" id="tenstar-mark-closed" type="button">Está completamente cerrada · guardar recorrido</button>
            <p id="tenstar-completed" hidden>✓ Calibración completada. La cortina queda completamente cerrada (0%). Ya puedes abrir o mover a otra posición.</p>
          </li>
        </ol>
        <div class="tenstar-calibration-extras">
          <button class="secondary-button full-width" id="tenstar-stop" type="button">Detener motor</button>
          <div id="tenstar-reference-recovery" hidden>
            <p>El recorrido está guardado, pero la posición no es segura. Confirma un extremo físico sin volver a calibrar.</p>
            <button class="secondary-button full-width" id="tenstar-reference-open" type="button">Estoy en abierto · recuperar referencia</button>
            <button class="secondary-button full-width" id="tenstar-reference-closed" type="button">Estoy en cerrado · recuperar referencia</button>
          </div>
          <div id="tenstar-calibrated-controls" hidden>
            <button class="primary-button full-width" id="tenstar-open" type="button">Abrir cortina</button>
            <label>Porcentaje de apertura<input id="tenstar-position" type="number" min="1" max="100" step="1" value="50"></label>
            <button class="secondary-button full-width" id="tenstar-move" type="button">Mover a esta posición</button>
          </div>
        </div>
        <p class="calibration-safety-note">Abierto = 100%; cerrado = 0%. Recorrido y última posición detenida se conservan al reiniciar. Si se corta la energía durante un movimiento, confirma manualmente abierto o cerrado. No muevas el eje sin alimentación: el encoder incremental no puede registrarlo.</p>
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
        await waitForCalibrationCommand(result.commandId, 75000);
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
      const calibrated = state.calibrated === true;
      get('#tenstar-step-help').textContent = pending ? 'Orden enviada: esperando fin del movimiento y confirmación del ESP. No pulses de nuevo.' : !online ? 'Conecta el Tenstar para mover.' : !supported ? 'Actualiza el firmware Tenstar para calibrar desde abierto.' : calibrated ? (telemetry.positionValid === true ? 'Recorrido guardado; usa Abrir o Mover.' : 'Recorrido guardado; recupera la referencia con los botones de abajo.') : !active ? 'Completa primero el paso 1 para fijar el origen abierto.' : !confirmed ? 'Completa el paso 2 e indica si la prueba subió o bajó.' : moving ? 'Movimiento en curso; espera a que termine.' : 'Introduce las vueltas y pulsa Subir o Bajar. La posición se publica al terminar.';
      const ready = calibrated && telemetry.positionValid === true;
      const done = [state.open_marked === true, confirmed, calibrated, calibrated];
      for (let index = 0; index < done.length; index += 1) {
        const step = get(`[data-tenstar-step="${index + 1}"]`);
        step.dataset.complete = String(done[index]);
        step.querySelector('.tenstar-step-check').textContent = done[index] ? '✓ Completado' : 'Pendiente';
      }
      get('#tenstar-completed').hidden = !calibrated;
      get('#tenstar-reference-recovery').hidden = !calibrated || telemetry.positionValid === true;
      get('#tenstar-calibrated-controls').hidden = !ready;
      for (const selector of ['#tenstar-open', '#tenstar-move', '#tenstar-position']) get(selector).disabled = !idle || !ready;
      get('#tenstar-calibration-state').textContent = !online ? 'Tenstar fuera de línea' : !supported ? 'Actualiza el firmware a Tenstar r5 o posterior' : state.calibrated ? (telemetry.positionValid ? 'Recorrido guardado: abierto 100% · cerrado 0%' : 'Recorrido guardado; recupera la referencia en abierto') : active ? (confirmed ? 'Sentido confirmado. Avanza por vueltas hasta cerrar.' : state.test_started ? 'Observa el paso: ¿subió o bajó?' : 'Abierto fijado como origen. Prueba el sentido.') : 'Coloca la cortina en abierto para empezar';
      const relative = Number(telemetry.positionTurns);
      const span = Number(state.open_span_pulses) || 0;
      get('#tenstar-calibration-detail').textContent = state.calibrated ? `Recorrido: ${(span / (Number(telemetry.pulsesPerRevolution) || 11880)).toFixed(3)} vueltas · ${span} pulsos` : `Desde abierto: ${Number.isFinite(relative) ? relative.toFixed(3) : '—'} vueltas · ${Number(telemetry.positionPulses) || 0} pulsos`;
      const safety = remoteStop ? '' : ' HTTPS y portal se pausan al girar. No hay parada remota durante el movimiento: mantén accesible el corte físico de alimentación.';
      status.textContent = (message || 'Sigue los cuatro pasos. El motor no se mueve al iniciar ni al guardar los extremos.') + safety;
      get('#tenstar-calibration-begin').disabled = !idle;
      get('#tenstar-test-direction').disabled = !idle || !active || state.test_started === true;
      for (const selector of ['#tenstar-test-up', '#tenstar-test-down']) get(selector).disabled = !idle || !active || !state.test_started || confirmed;
      for (const selector of ['#tenstar-step-up', '#tenstar-step-down', '#tenstar-calibration-turns', '#tenstar-mark-closed']) get(selector).disabled = !idle || !active || !confirmed;
      for (const selector of ['#tenstar-reference-open', '#tenstar-reference-closed']) get(selector).disabled = !idle || !calibrated;
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
    bind('#tenstar-reference-closed', 'tenstar.calibration.referenceClosed', () => ({}), 'Confirma que está físicamente completamente cerrada. Recupera la referencia sin mover ni borrar el recorrido.');
    bind('#tenstar-open', 'curtain.open');
    bind('#tenstar-move', 'curtain.move', () => {
      const percent = Number(get('#tenstar-position').value);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('Indica una apertura mayor que 0 y hasta 100%.');
      return { percent };
    });
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
