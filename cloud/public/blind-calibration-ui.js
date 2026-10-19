(function (root) {
  'use strict';

  function mountGa25CalibrationWizard(context) {
    const { $, apiRequest, loadDevices, waitForCalibrationCommand, showToast, getCalibrationDeviceModel } = context;
    const layout = $('.command-layout');
    if (!layout || $('#calibration-wizard')) return;
    layout.insertAdjacentHTML('beforeend', `<div class="panel calibration-wizard" id="calibration-wizard"><div class="panel-heading"><div><h2>Calibración de recorrido GA25</h2><p>Recorrido temporizado, sin encoder.</p></div><span class="secure-badge">Supervisada</span></div><p class="calibration-safety-note"><strong>Antes de iniciar:</strong> coloca manualmente la cortina cerrada. Observa todo el recorrido y pulsa Guardar tiempo y parar al llegar al extremo abierto. No dejes que el motor empuje contra topes mecánicos.</p><p id="ga25-calibration-status" class="form-status" aria-live="polite">La calibración reemplazará el tiempo guardado.</p><div class="calibration-stage-actions"><button class="primary-button" id="ga25-calibration-start" type="button">Iniciar desde cerrado</button><button class="secondary-button calibration-stop" id="ga25-calibration-stop" type="button" disabled>Guardar tiempo y parar</button><button class="secondary-button" id="ga25-calibration-cancel" type="button" disabled>Cancelar sin guardar</button></div></div>`);
    const status = $('#ga25-calibration-status'), startButton = $('#ga25-calibration-start'), stopButton = $('#ga25-calibration-stop'), cancelButton = $('#ga25-calibration-cancel');
    let active = false, busy = false;
    const send = async (command, payload = {}) => {
      const deviceId = $('#command-device')?.value;
      if (!deviceId || getCalibrationDeviceModel() !== 'ga25') throw new Error('Selecciona un dispositivo GA25.');
      const result = await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command, payload }) });
      await waitForCalibrationCommand(result.commandId); await loadDevices();
    };
    const render = () => { startButton.disabled = busy || active; stopButton.disabled = busy || !active; cancelButton.disabled = busy || !active; };
    startButton.addEventListener('click', async () => { try { busy = true; render(); status.textContent = 'Arrancando desde cerrado. Supervisa el movimiento y detenlo en el extremo abierto.'; await send('blind.ga25CalibrationStart', { from: 'closed' }); active = true; status.textContent = 'En movimiento. Pulsa Guardar tiempo y parar al llegar al extremo abierto.'; } catch (error) { status.textContent = error.message; } finally { busy = false; render(); } });
    stopButton.addEventListener('click', async () => { try { busy = true; render(); await send('blind.ga25CalibrationStop'); active = false; status.textContent = 'Tiempo guardado. La posición seguirá siendo una estimación por tiempo.'; showToast('Tiempo de recorrido GA25 guardado'); } catch (error) { status.textContent = error.message; } finally { busy = false; render(); } });
    cancelButton.addEventListener('click', async () => { try { busy = true; render(); await send('blind.ga25CalibrationCancel'); active = false; status.textContent = 'Detenida sin guardar cambios.'; } catch (error) { status.textContent = error.message; } finally { busy = false; render(); } });
    render();
  }

  function mountBlindCalibrationWizard(context) {
    const { $, $$, apiRequest, loadDevices, getCalibrationPosition, waitForCalibrationCommand, waitForCalibrationIdle, showToast, renderIcons } = context;
    const markup = `<div class="panel calibration-wizard" id="calibration-wizard">
      <div class="panel-heading"><div><h2>Calibración segura de persiana</h2><p>El cálculo orienta el recorrido; los extremos definitivos se guardan desde el encoder.</p></div><span class="secure-badge">Guiado</span></div>
      <div class="calibration-steps"><div class="calibration-step active" data-calibration-step="1"><b>1</b><span>Medidas</span></div><div class="calibration-step" data-calibration-step="2"><b>2</b><span>Sentido</span></div><div class="calibration-step" data-calibration-step="3"><b>3</b><span>Extremos</span></div><div class="calibration-step" data-calibration-step="4"><b>4</b><span>Guardado</span></div></div>
      <div class="calibration-settings">
        <label>Ancho de ventana (cm)<input id="calibration-width" type="number" min="20" max="1000" step="0.1" value="120"></label>
        <label>Alto de ventana (cm)<input id="calibration-height" type="number" min="20" max="1000" step="0.1" value="150"></label>
        <label>Diámetro exterior del tubo (cm)<input id="calibration-diameter" type="number" min="1" max="30" step="0.1" value="5"></label>
        <label>Grosor del paño (mm)<input id="calibration-thickness" type="number" min="0.01" max="5" step="0.01" value="0.5"></label>
        <label>Vueltas de motor por vuelta de tubo<input id="calibration-ratio" type="number" min="0.1" max="20" step="0.01" value="1"></label>
        <label>Servo<select id="calibration-servo"><option value="1">Servo 1</option><option value="2">Servo 2</option></select></label>
        <label class="calibration-midpoint-check"><input id="calibration-midpoint-confirm" type="checkbox"> Confirmo que la persiana está aproximadamente a mitad del recorrido.</label>
        <button class="secondary-button" id="calibration-calculate" type="button">Calcular vueltas estimadas</button>
        <button class="primary-button" id="calibration-start" type="button">Guardar medidas e iniciar desde la mitad</button>
      </div>
      <div class="blind-calibration-layout"><div class="blind-calibration-diagram"><svg viewBox="0 0 300 280" role="img" aria-label="Diagrama de ventana con persiana vertical">
        <rect x="57" y="38" width="186" height="220" rx="5" fill="none" stroke="currentColor" stroke-width="5" opacity=".72"/><rect x="69" y="50" width="162" height="196" fill="rgba(120,170,220,.10)"/><rect x="69" y="50" width="162" height="94" fill="rgba(200,247,107,.48)" id="calibration-shade"/><path d="M67 35h166" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><circle cx="232" cy="35" r="13" fill="none" stroke="currentColor" stroke-width="4"/><path d="M242 35c14 8 10 20 0 23" fill="none" stroke="currentColor" stroke-width="3"/><path d="M45 54v188m-6-8 6 8 6-8m-12-180 6-8 6 8" fill="none" stroke="currentColor" stroke-width="2" opacity=".65"/><text x="18" y="150" fill="currentColor" font-size="12" transform="rotate(-90 18 150)">alto</text>
      </svg></div><div class="blind-calibration-readout"><span>Estimación geométrica</span><strong id="calibration-estimate">Ingresa las medidas</strong><span id="calibration-limit" class="calibration-progress">Incluye el aumento del rollo por el grosor del paño.</span><span id="calibration-dimensions" class="calibration-progress">La persiana aparece inicialmente a mitad del recorrido.</span></div></div>
      <p class="calibration-safety-note"><strong>Movimiento supervisado:</strong> coloca la persiana a mitad del recorrido antes de iniciar. La prueba es una vuelta lenta; después los avances son de solo 1/8 de vuelta. Observa la persiana y usa Parar si algo no se ve bien. El encoder no detecta fuerza ni atascos.</p>
      <p id="calibration-status" class="form-status" aria-live="polite">Introduce las medidas y calcula el recorrido antes de mover el motor.</p>
      <div class="calibration-stage-actions">
        <button class="secondary-button" id="calibration-test-direction" type="button" disabled>Probar una vuelta lenta</button>
        <button class="secondary-button" id="calibration-positive-down" type="button" hidden>La prueba bajó la persiana</button>
        <button class="secondary-button" id="calibration-positive-up" type="button" hidden>La prueba subió la persiana</button>
        <label class="calibration-step-size-label">Avance por paso<select id="calibration-step-size"><option value="0.125">1/8 de vuelta</option><option value="0.25">1/4 de vuelta</option><option value="0.5" selected>1/2 vuelta</option><option value="1">1 vuelta</option></select></label>
        <button class="secondary-button" id="calibration-step-down" type="button" disabled>Desenrollar paso</button>
        <button class="secondary-button" id="calibration-step-up" type="button" disabled>Enrollar paso</button>
        <button class="secondary-button" id="calibration-mark-rolled" type="button" disabled>Guardar extremo abierto (enrollado)</button>
        <button class="secondary-button" id="calibration-mark-deployed" type="button" disabled>Guardar extremo cerrado (desplegado)</button>
        <button class="secondary-button calibration-stop" id="calibration-stop" type="button" disabled>Parar movimiento</button>
        <button class="secondary-button" id="calibration-cancel" type="button" disabled>Cancelar calibración</button>
      </div>
    </div>`;

    const layout = $('.command-layout');
    if (!layout || $('#calibration-wizard')) return; if (context.getCalibrationDeviceModel?.() === 'ga25') { mountGa25CalibrationWizard(context); return; }
    layout.insertAdjacentHTML('beforeend', markup);
    const status = $('#calibration-status');
    const get = (id) => $(`#${id}`);
    const servoId = () => Number(get('calibration-servo').value);
    const deviceId = () => $('#command-device')?.value;
    const setDisabled = (id, disabled) => { get(id).disabled = disabled; };
    let phase = 'measure';
    let estimate = null;
    let busy = false;
    const references = new Set();

    const render = () => {
      const stage = { measure: 1, direction: 2, directionConfirm: 2, travel: 3, done: 4 }[phase];
      $$('.calibration-step').forEach((node) => node.classList.toggle('active', Number(node.dataset.calibrationStep) === stage));
      setDisabled('calibration-test-direction', phase !== 'direction' || busy);
      get('calibration-positive-down').hidden = phase !== 'directionConfirm';
      get('calibration-positive-up').hidden = phase !== 'directionConfirm';
      setDisabled('calibration-step-down', phase !== 'travel' || references.has('deployed') || busy);
      setDisabled('calibration-step-up', phase !== 'travel' || references.has('rolled') || busy);
      setDisabled('calibration-step-size', phase !== 'travel' || busy);
      setDisabled('calibration-mark-rolled', phase !== 'travel' || references.has('rolled') || busy);
      setDisabled('calibration-mark-deployed', phase !== 'travel' || references.has('deployed') || busy);
      setDisabled('calibration-stop', phase === 'measure' || phase === 'done');
      setDisabled('calibration-cancel', phase === 'measure' || phase === 'done' || busy);
      ['calibration-width', 'calibration-height', 'calibration-diameter', 'calibration-thickness', 'calibration-ratio', 'calibration-servo', 'calibration-calculate'].forEach((id) => setDisabled(id, phase !== 'measure' || busy));
      get('calibration-midpoint-confirm').disabled = phase !== 'measure';
      get('calibration-start').disabled = phase !== 'measure' || busy || !get('calibration-midpoint-confirm').checked;
      get('calibration-shade').setAttribute('height', phase === 'done' ? '196' : phase === 'travel' ? '116' : '98');
    };

    const measureValues = () => {
      const width = Number(get('calibration-width').value);
      const height = Number(get('calibration-height').value);
      if (!Number.isFinite(width) || width < 20 || width > 1000) throw new Error('El ancho debe estar entre 20 y 1000 cm.');
      return { width, height, diameter: Number(get('calibration-diameter').value), thickness: Number(get('calibration-thickness').value), ratio: Number(get('calibration-ratio').value) };
    };
    const calculate = () => {
      const values = measureValues();
      estimate = root.BlindCalibrationModel.estimateTurns(values.height, values.diameter, values.thickness, values.ratio);
      get('calibration-estimate').textContent = `≈ ${estimate.toFixed(2)} vueltas de recorrido`;
      get('calibration-limit').textContent = `Límite preventivo (80% de la mitad estimada): ${(estimate * 0.4).toFixed(2)} vueltas por lado desde la mitad.`;
      get('calibration-dimensions').textContent = `Ventana ${values.width} × ${values.height} cm · tubo Ø ${values.diameter} cm · paño ${values.thickness} mm · relación ${values.ratio}:1`;
      const ratio = Math.min(2.6, Math.max(.55, values.width / values.height));
      const rectWidth = Math.round(162 * Math.min(1.5, ratio));
      const rectX = Math.round(150 - rectWidth / 2);
      const frame = get('calibration-shade');
      frame.setAttribute('x', String(rectX)); frame.setAttribute('width', String(rectWidth));
      return values;
    };
    const queue = (command, payload) => {
      const id = deviceId();
      if (!id) throw new Error('Selecciona el dispositivo Servo.');
      return apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId: id, command, payload: { servoId: servoId(), ...payload } }) });
    };
    const sendAndWait = async (command, payload, movement = false) => {
      const selectedDevice = deviceId();
      let startPosition = null;
      if (movement) { await loadDevices(); startPosition = getCalibrationPosition(selectedDevice, servoId()); }
      const result = await queue(command, payload);
      await waitForCalibrationCommand(result.commandId);
      if (movement) await waitForCalibrationIdle(selectedDevice, servoId(), startPosition);
      await loadDevices();
    };

    get('calibration-calculate').addEventListener('click', () => {
      try { calculate(); status.textContent = 'Estimación lista. Comprueba las medidas antes de iniciar.'; }
      catch (error) { estimate = null; get('calibration-estimate').textContent = 'Medidas no válidas'; status.textContent = error.message; }
    });
    get('calibration-midpoint-confirm').addEventListener('change', render);
    get('calibration-start').addEventListener('click', async () => {
      try {
        busy = true; render();
        const values = calculate();
        status.textContent = 'Guardando medidas y registrando la posición actual como mitad…';
        await sendAndWait('blind.safeCalibrationBegin', { widthCm: values.width, heightCm: values.height, tubeDiameterCm: values.diameter, fabricThicknessMm: values.thickness, motorTurnsPerTubeTurn: values.ratio });
        references.clear(); phase = 'direction';
        status.textContent = 'Confirma que la persiana está aproximadamente a mitad del recorrido y prueba una vuelta lenta.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    get('calibration-test-direction').addEventListener('click', async () => {
      try {
        busy = true; render();
        status.textContent = 'Prueba en curso: una vuelta a velocidad reducida. Observa si la persiana sube o baja.';
        await sendAndWait('blind.safeCalibrationTest', {}, true);
        phase = 'directionConfirm';
        status.textContent = '¿La prueba hizo descender (desenrollar) o subir (enrollar) la persiana?';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    const confirmDirection = async (positiveIsDown) => {
      try {
        busy = true; render();
        await sendAndWait('blind.safeCalibrationDirection', { positiveIsDown });
        phase = 'travel';
        status.textContent = 'Sentido confirmado. Avanza de 1/8 de vuelta y guarda cada extremo cuando la persiana alcance visualmente su posición final; no la empujes contra el tope mecánico.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    };
    get('calibration-positive-down').addEventListener('click', () => confirmDirection(true));
    get('calibration-positive-up').addEventListener('click', () => confirmDirection(false));
    const step = async (direction) => {
      try {
        busy = true; render();
        const turns = Number(get('calibration-step-size').value);
        status.textContent = `Avance supervisado de ${turns} vuelta(s) hacia ${direction === 'down' ? 'abajo' : 'arriba'}…`;
        await sendAndWait('blind.safeCalibrationStep', { direction, turns }, true);
        status.textContent = 'Paso terminado. Observa la posición antes de ordenar el siguiente avance.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    };
    get('calibration-step-down').addEventListener('click', () => step('down'));
    get('calibration-step-up').addEventListener('click', () => step('up'));
    const mark = async (reference) => {
      try {
        busy = true; render();
        status.textContent = 'Guardando posición real del encoder…';
        await sendAndWait('blind.safeCalibrationMark', { reference });
        references.add(reference);
        if (references.size === 2) {
          phase = 'done';
          status.textContent = 'Calibración guardada permanentemente en el servo. Los movimientos normales usarán estos límites del encoder.';
          showToast('Calibración segura guardada');
        } else {
          status.textContent = `Extremo ${reference === 'rolled' ? 'abierto' : 'cerrado'} guardado. Continúa en pasos de 1/8 hacia el otro extremo y guárdalo cuando llegue a su posición visual.`;
        }
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    };
    get('calibration-mark-rolled').addEventListener('click', () => mark('rolled'));
    get('calibration-mark-deployed').addEventListener('click', () => mark('deployed'));
    get('calibration-stop').addEventListener('click', async () => {
      try {
        busy = true; render();
        status.textContent = 'Enviando parada…';
        await sendAndWait('blind.safeCalibrationStop', {}, false);
        status.textContent = 'Movimiento detenido. La calibración quedó bloqueada; cancélala y revisa el mecanismo antes de reiniciar.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    get('calibration-cancel').addEventListener('click', async () => {
      try {
        busy = true; render();
        status.textContent = 'Deteniendo y cancelando…';
        await sendAndWait('blind.safeCalibrationCancel', {});
        phase = 'measure'; references.clear();
        get('calibration-midpoint-confirm').checked = false;
        status.textContent = 'Calibración cancelada; no se guardaron límites nuevos.';
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    render();
    renderIcons();
  }

  root.mountBlindCalibrationWizard = mountBlindCalibrationWizard;
})(typeof window !== 'undefined' ? window : globalThis);
