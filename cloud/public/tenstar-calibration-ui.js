(function (root) {
  'use strict';

  function mountTenstarCalibrationWizard(context) {
    const { $, apiRequest, loadDevices, waitForCalibrationCommand, showToast, renderIcons } = context;
    const layout = $('.command-calibration-layout');
    if (!layout) return;
    let wizard = $('#calibration-wizard');
    if (wizard?.dataset.calibrationModel === 'tenstar') {
      update();
      return;
    }
    if (wizard?._tenstarRefreshTimer) window.clearInterval(wizard._tenstarRefreshTimer);
    if (wizard?._tenstarDeviceChange) $('#command-device')?.removeEventListener('change', wizard._tenstarDeviceChange);
    wizard?.remove();
    layout.insertAdjacentHTML('beforeend', `<section class="panel calibration-wizard" id="calibration-wizard" data-calibration-model="tenstar">
      <div class="panel-heading"><div><h2>Calibración de recorrido Tenstar</h2><p>Marca los extremos reales con el encoder; no usa medidas geométricas estimadas ni busca topes automáticamente.</p></div><span class="secure-badge">Encoder</span></div>
      <p class="calibration-safety-note"><strong>Preparación:</strong> mantén una forma accesible de cortar alimentación. Despeja el mecanismo. Lleva la cortina manualmente al extremo cerrado sin forzar el tope. Luego marca ese punto y avanza al extremo abierto con pulsos breves, observando el mecanismo. No dejes que el motor golpee los topes.</p>
      <div class="blind-calibration-readout"><span>Estado de calibración</span><strong id="tenstar-calibration-state">Consultando dispositivo…</strong><span id="tenstar-calibration-detail" class="calibration-progress"></span></div>
      <p id="calibration-status" class="form-status" role="status" aria-live="polite">Selecciona un Tenstar conectado para comenzar.</p>
      <div class="calibration-actions">
        <button class="secondary-button full-width" id="tenstar-calibration-reset" type="button">Borrar calibración y empezar de nuevo</button>
        <button class="secondary-button full-width" id="tenstar-reference-closed" type="button">Estoy en cerrado · fijar referencia</button>
        <button class="primary-button full-width" id="tenstar-mark-closed" type="button">Marcar extremo cerrado</button>
        <div class="calibration-jog-controls"><button class="secondary-button" id="tenstar-jog-negative" type="button">Pulso −</button><span>Pulsos breves al 25% · observar dirección</span><button class="secondary-button" id="tenstar-jog-positive" type="button">Pulso +</button></div>
        <button class="secondary-button full-width" id="tenstar-stop" type="button">Detener motor</button>
        <button class="primary-button full-width" id="tenstar-mark-open" type="button">Marcar extremo abierto</button>
      </div>
      <p class="calibration-safety-note">Después de reiniciar la placa, la calibración guardada se conserva, pero vuelve a colocar manualmente la cortina en cerrado y pulsa “fijar referencia” antes de usar controles de posición.</p>
    </section>`);
    wizard = $('#calibration-wizard');
    const get = (selector) => $(selector, wizard);
    const status = get('#calibration-status');
    let busy = false;
    const selected = () => {
      const device = context.devices().find((item) => item.id === $('#command-device')?.value);
      return { device, telemetry: context.parseTelemetry(device?.telemetry) || {} };
    };
    const command = async (name, payload = {}) => {
      const { device } = selected();
      if (!device || device.status !== 'online') throw new Error('Selecciona un Tenstar en línea antes de enviar comandos.');
      busy = true;
      update();
      try {
        status.textContent = 'Esperando confirmación del dispositivo…';
        const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId: device.id, command: name, payload }) });
        await waitForCalibrationCommand(result.commandId);
        await loadDevices();
        status.textContent = 'Comando confirmado por el dispositivo.';
        showToast('Calibración Tenstar actualizada');
      } finally {
        busy = false;
        update();
      }
    };
    function update() {
      const { device, telemetry } = selected();
      const state = telemetry.calibration || {};
      const online = device?.status === 'online' && telemetry.firmwareTarget === 'tenstar';
      const moving = telemetry.moving === true;
      const closedMarked = state.closed_marked === true;
      const calibrated = state.calibrated === true;
      const referenced = telemetry.positionValid === true;
      get('#tenstar-calibration-state').textContent = !online ? 'Dispositivo Tenstar fuera de línea' : calibrated ? (referenced ? 'Calibración completa y referencia válida' : 'Calibrado; requiere re-referenciar cerrado') : closedMarked && referenced ? 'Extremo cerrado marcado; avanza al extremo abierto' : 'Sin calibración completa';
      const pulses = Number(state.open_span_pulses) || 0;
      get('#tenstar-calibration-detail').textContent = pulses ? `${pulses} pulsos · ${(pulses / (Number(telemetry.pulsesPerRevolution) || 1980)).toFixed(2)} vueltas · apertura en sentido ${state.open_direction > 0 ? '+' : '−'}` : 'El alcance se medirá entre las posiciones cerrada y abierta marcadas.';
      if (!busy) {
        if (!device) status.textContent = 'Selecciona un dispositivo Tenstar en el selector de comandos.';
        else if (device.status !== 'online') status.textContent = 'El dispositivo está fuera de línea; no se puede calibrar todavía.';
        else if (telemetry.firmwareTarget !== 'tenstar') status.textContent = 'El dispositivo seleccionado no reporta firmware Tenstar.';
        else if (calibrated && !referenced) status.textContent = 'La calibración se conservó. Coloca la cortina manualmente en cerrado y fija la referencia.';
        else if (calibrated) status.textContent = 'Recorrido aprendido. Los movimientos remotos quedan limitados entre los dos extremos guardados.';
      }
      get('#tenstar-calibration-reset').disabled = !online || busy || moving;
      get('#tenstar-reference-closed').disabled = !online || busy || moving || !calibrated;
      get('#tenstar-mark-closed').disabled = !online || busy || moving || calibrated;
      get('#tenstar-jog-negative').disabled = !online || busy || moving || calibrated || !closedMarked || !referenced;
      get('#tenstar-jog-positive').disabled = !online || busy || moving || calibrated || !closedMarked || !referenced;
      get('#tenstar-stop').disabled = !online || busy;
      get('#tenstar-mark-open').disabled = !online || busy || moving || calibrated || !closedMarked || !referenced;
    }
    get('#tenstar-calibration-reset').addEventListener('click', async () => {
      if (!window.confirm('Borra los extremos aprendidos. La cortina no se moverá. Después deberás marcar cerrado y abierto otra vez. ¿Continuar?')) return;
      try { await command('tenstar.calibration.reset'); } catch (error) { status.textContent = error.message; busy = false; update(); }
    });
    get('#tenstar-reference-closed').addEventListener('click', async () => {
      if (!window.confirm('Confirma que la cortina está físicamente en el extremo cerrado. El encoder se pondrá a cero sin mover el motor. ¿Continuar?')) return;
      try { await command('tenstar.calibration.referenceClosed'); } catch (error) { status.textContent = error.message; busy = false; update(); }
    });
    get('#tenstar-mark-closed').addEventListener('click', async () => {
      if (!window.confirm('Confirma que la cortina está físicamente cerrada, sin presionar el mecanismo contra el tope. El motor no se moverá. ¿Marcar cerrado?')) return;
      try { await command('tenstar.calibration.setClosed'); } catch (error) { status.textContent = error.message; busy = false; update(); }
    });
    for (const [selector, direction] of [['#tenstar-jog-negative', -1], ['#tenstar-jog-positive', 1]]) {
      get(selector).addEventListener('click', async () => {
        const { telemetry } = selected();
        const speedPct = Math.max(25, Number(telemetry.minimumSpeedPct) || 20);
        try { await command('tenstar.jog', { direction, speedPct, durationMs: 350 }); }
        catch (error) { status.textContent = error.message; busy = false; update(); }
      });
    }
    get('#tenstar-stop').addEventListener('click', async () => {
      try { await command('curtain.stop'); } catch (error) { status.textContent = error.message; busy = false; update(); }
    });
    get('#tenstar-mark-open').addEventListener('click', async () => {
      if (!window.confirm('Confirma que la cortina está en el extremo abierto y que no está haciendo fuerza contra el tope. El recorrido actual quedará guardado como 100%. ¿Marcar abierto?')) return;
      try { await command('tenstar.calibration.setOpen'); } catch (error) { status.textContent = error.message; busy = false; update(); }
    });
    wizard._tenstarDeviceChange = update;
    $('#command-device')?.addEventListener('change', wizard._tenstarDeviceChange);
    wizard._tenstarRefreshTimer = window.setInterval(() => {
      if (!wizard.isConnected) {
        window.clearInterval(wizard._tenstarRefreshTimer);
        $('#command-device')?.removeEventListener('change', wizard._tenstarDeviceChange);
        return;
      }
      update();
    }, 1500);
    update();
    renderIcons();
  }

  root.mountTenstarCalibrationWizard = mountTenstarCalibrationWizard;
})(typeof window !== 'undefined' ? window : globalThis);
