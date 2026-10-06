const devices = [];
const CLOUD_REFRESH_MS = 2000;
let cloudRefreshInFlight = false;
let cloudVersion;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_URL = '/api';

async function apiRequest(action, options = {}) {
  const response = await fetch(`${API_URL}/${action}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`El servidor respondio ${response.status}: ${text.slice(0, 160) || 'sin detalle'}`); }
  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('pulsegrid-user');
      clearUser();
      window.setTimeout(() => showAuthModal('login'), 0);
    }
    throw new Error(data.error || 'No fue posible completar la solicitud');
  }
  return data;
}

async function firmwareFilePayload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { name: file.name, content: btoa(binary), encoding: 'base64' };
}

function ensureSettingsViewInMain() {
  const settings = $('#view-settings');
  const container = $('.view-container');
  if (settings && container && !container.contains(settings)) container.append(settings);
}

const wikiPages = {
  intro: ['Introduccion', 'Guia para llevar tu primer ESP32 desde la placa hasta un dashboard con datos utiles.', 'GET', '/api/me'],
  auth: ['Autenticacion', 'Crea una cuenta desde el boton de usuario. La aplicacion conserva una sesion segura para que gestiones solo tus dispositivos.', 'POST', '/api/login'],
  devices: ['Dispositivos', 'Registra cada ESP32 con un identificador unico. El dashboard conserva su estado, tipo y ultima comunicacion.', 'POST', '/api/devices'],
  telemetry: ['Telemetria', 'Envia un JSON con tus lecturas. El backend guarda cada muestra asociada al dispositivo.', 'POST', '/api/telemetry'],
  commands: ['Comandos', 'Publica instrucciones desde el centro de comandos. El dispositivo debe responder con el estado de ejecucion.', 'MQTT', 'devices/{device_id}/commands'],
  webhooks: ['Webhooks', 'Recibe eventos de conexion, alertas y confirmaciones en tu servidor para automatizar tus flujos.', 'POST', '/api/webhooks']
};

function introGuideMarkup() {
  return '<div class="docs-section"><span class="step-number">01</span><div class="wiki-guide"><h2>Tu primer ESP32 en Pulsegrid</h2><p>El ESP32 es una placa con Wi-Fi integrado. Puede leer sensores, controlar luces o relevadores y enviar datos a este dashboard. Para empezar necesitas una placa ESP32, cable USB, Arduino IDE y una red Wi-Fi de 2.4 GHz.</p><div class="wiki-callout"><strong>Prepara Arduino IDE</strong><p>Instala el paquete <strong>esp32 by Espressif Systems</strong> desde el Gestor de placas. Después selecciona tu placa y el puerto USB en el menu Herramientas.</p></div><h3>1. Comprueba Wi-Fi</h3><p>Cambia las credenciales y sube el programa. El Monitor serie a 115200 baudios mostrara una IP al conectarse.</p><div class="code-block wiki-code"><pre><code>#include &lt;WiFi.h&gt;\nconst char* WIFI_SSID = "TU_RED";\nconst char* WIFI_PASSWORD = "TU_CONTRASENA";\nvoid setup() {\n  Serial.begin(115200);\n  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);\n  while (WiFi.status() != WL_CONNECTED) { delay(500); }\n  Serial.println(WiFi.localIP());\n}\nvoid loop() {}</code></pre></div><h3>2. Crea tu cuenta y registra el nodo</h3><p>Pulsa el usuario arriba a la derecha para crear tu cuenta. Después entra en Dispositivos y usa un ID unico como <code>esp32-terraza-01</code>.</p><div class="endpoint"><span class="method post">POST</span><code>/api/devices</code></div><h3>3. Envia datos del sensor</h3><p>La telemetria son lecturas como temperatura, humedad, voltaje o estado. Primero prueba Wi-Fi, después el sensor y por ultimo la peticion HTTP.</p><div class="code-block wiki-code"><pre><code>#include &lt;HTTPClient.h&gt;\nHTTPClient http;\nhttp.begin("https://pulsegrid.2api2.com/api/telemetry");\nhttp.addHeader("Content-Type", "application/json");\nhttp.POST("{\\"temperature\\":24.8,\\"humidity\\":58}");\nhttp.end();</code></pre></div><div class="wiki-callout"><strong>Consejo</strong><p>No publiques contraseñas Wi-Fi ni tokens. Guarda esos valores en un archivo local excluido de Git.</p></div></div></div>';
}

function languageExamplesMarkup() {
  const baseUrl = window.location.origin;
  const examples = {
    arduino: `#include <WiFi.h>\n#include <HTTPClient.h>\n\nconst char* API_KEY = "pg_live_TU_API_KEY";\nconst char* DEVICE_ID = "ESP32_ID";\n\nHTTPClient http;\nhttp.begin("${baseUrl}/api/telemetry");\nhttp.addHeader("Content-Type", "application/json");\nhttp.addHeader("X-API-Key", API_KEY);\nhttp.POST("{\\"deviceId\\":\\"" + String(DEVICE_ID) + "\\",\\"temperature\\":24.8}");\nhttp.end();`,
    micropython: `import urequests\n\nAPI_KEY = "pg_live_TU_API_KEY"\nDEVICE_ID = "ESP32_ID"\n\nresponse = urequests.post(\n    "${baseUrl}/api/telemetry",\n    headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},\n    json={"deviceId": DEVICE_ID, "temperature": 24.8, "humidity": 58}\n)\nprint(response.status_code)\nresponse.close()`,
    python: `import requests\n\nresponse = requests.post(\n    "${baseUrl}/api/telemetry",\n    headers={"X-API-Key": "pg_live_TU_API_KEY"},\n    json={"deviceId": "ESP32_ID", "temperature": 24.8, "humidity": 58}\n)\nresponse.raise_for_status()`,
    javascript: `await fetch("${baseUrl}/api/telemetry", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    "X-API-Key": "pg_live_TU_API_KEY"\n  },\n  body: JSON.stringify({ deviceId: "ESP32_ID", temperature: 24.8 })\n});`,
    curl: `curl -X POST "${baseUrl}/api/telemetry" \\\n+  -H "Content-Type: application/json" \\\n+  -H "X-API-Key: pg_live_TU_API_KEY" \\\n+  -d '{"deviceId":"ESP32_ID","temperature":24.8,"humidity":58}'`
  };
  const tabs = [['arduino', 'Arduino C++'], ['micropython', 'MicroPython'], ['python', 'Python'], ['javascript', 'JavaScript'], ['curl', 'cURL']];
  return `<div class="docs-section"><span class="step-number">04</span><div class="wiki-guide"><h2>Clave de API y ejemplos</h2><p>Genera una clave para tu cuenta y guárdala en el firmware o en variables de entorno. La clave se muestra completa solo al crearla o rotarla.</p><div class="api-key-panel" id="wiki-api-key"><div><strong>Clave de API</strong><p id="api-key-status">Inicia sesion para crear una clave.</p></div><button class="secondary-button" id="api-key-action"><i data-lucide="key-round"></i> Crear clave</button></div><div class="api-key-secret" id="api-key-secret" hidden><code></code><button class="copy-button" title="Copiar clave"><i data-lucide="copy"></i> Copiar</button></div><p>Incluye la cabecera <code>X-API-Key</code> en cada envio. Sustituye <code>ESP32_ID</code> por el identificador que registraste en Dispositivos.</p><div class="code-tabs" role="tablist">${tabs.map(([key, label], index) => `<button class="code-tab${index === 0 ? ' active' : ''}" data-code-tab="${key}" role="tab">${label}</button>`).join('')}</div><div class="code-block wiki-code"><div class="code-toolbar"><span id="code-language">Arduino C++</span><button class="copy-button" id="copy-code-example"><i data-lucide="copy"></i> Copiar</button></div><pre><code id="language-code-example"></code></pre></div><script type="application/json" id="language-examples">${JSON.stringify(examples).replace(/</g, '\\u003c')}</script><div class="wiki-callout"><strong>Rotacion</strong><p>Al rotar la clave, la anterior deja de funcionar de inmediato. Actualiza todos tus dispositivos antes de eliminar una clave en uso.</p></div></div></div>`;
}

function renderWikiPage(key) {
  const page = wikiPages[key];
  const content = $('#wiki-content');
  if (!page || !content) return;
  content.innerHTML = key === 'intro' ? introGuideMarkup() : `<div class="docs-section"><span class="step-number">${String(Object.keys(wikiPages).indexOf(key) + 1).padStart(2, '0')}</span><div><h2>${page[0]}</h2><p>${page[1]}</p><div class="endpoint"><span class="method ${page[2] === 'MQTT' ? 'mqtt' : 'post'}">${page[2]}</span><code>${page[3]}</code><button class="copy-button" data-copy="${page[3]}"><i data-lucide="copy"></i> Copiar</button></div><div class="code-block wiki-code"><pre><code>const endpoint = '${page[3]}';
fetch(endpoint, { method: '${page[2] === 'MQTT' ? 'SUBSCRIBE' : 'POST'}' });</code></pre></div></div></div>`;
  $$('.wiki-link').forEach((item) => item.classList.toggle('active', item.dataset.wiki === key));
  bindCopyButtons();
  bindWikiApiControls();
  renderIcons();
}

function bindCopyButtons() {
  $$('.copy-button').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); } catch { /* clipboard unavailable */ }
      showToast('Copiado al portapapeles');
    });
  });
}

function bindWikiApiControls() {
  const examplesNode = $('#language-examples');
  if (!examplesNode) return;
  const examples = JSON.parse(examplesNode.textContent);
  const code = $('#language-code-example');
  const language = $('#code-language');
  const tabs = $$('.code-tab');
  const showExample = (key) => {
    code.textContent = examples[key];
    language.textContent = tabs.find((tab) => tab.dataset.codeTab === key).textContent;
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.codeTab === key));
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => showExample(tab.dataset.codeTab)));
  $('#copy-code-example').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code.textContent); } catch { /* clipboard unavailable */ }
    showToast('Ejemplo copiado');
  });
  const action = $('#api-key-action');
  const status = $('#api-key-status');
  const secret = $('#api-key-secret');
  const secretValue = $('code', secret);
  const secretCopy = $('.copy-button', secret);
  const displayKey = (apiKey) => {
    secretValue.textContent = apiKey;
    secret.hidden = false;
    secretCopy.onclick = async () => {
      try { await navigator.clipboard.writeText(apiKey); } catch { /* clipboard unavailable */ }
      showToast('Clave copiada');
    };
  };
  apiRequest('api-key').then((result) => {
    if (result.apiKey) {
      status.textContent = `Activa: ${result.apiKey.hint}`;
      action.innerHTML = '<i data-lucide="refresh-cw"></i> Rotar clave';
    } else status.textContent = 'Aun no tienes una clave de API.';
    renderIcons();
  }).catch(() => { action.textContent = 'Inicia sesion'; });
  action.addEventListener('click', async () => {
    try {
      const result = await apiRequest('api-key', { method: 'POST' });
      status.textContent = `Activa: ${result.hint}`;
      action.innerHTML = '<i data-lucide="refresh-cw"></i> Rotar clave';
      displayKey(result.apiKey);
      renderIcons();
    } catch (error) {
      if (error.message === 'Authentication required') showAuthModal('login'); else showToast(error.message);
    }
  });
  showExample('arduino');
}

function bindFirmwareReleaseControls() {
  const form = $('#firmware-release-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = Array.from(form.querySelector('#firmware-release-files').files || []);
    if (!files.length) return showToast('Selecciona al menos un archivo .py');
    try {
      const payload = { version: form.querySelector('#firmware-release-version').value.trim(), whatsNew: form.querySelector('#firmware-release-whats-new').value.trim(), files: await Promise.all(files.map(firmwareFilePayload)) };
      const result = await apiRequest('firmware/releases', { method: 'POST', body: JSON.stringify(payload) });
      form.querySelector('#firmware-release-status').textContent = `Publicado ${result.release.version} con ${result.release.files.length} archivos.`;
      showToast('Firmware publicado');
    } catch (error) { form.querySelector('#firmware-release-status').textContent = error.message; }
  });
}

function firmwareViewMarkup() {
  return `<section class="view" id="view-firmware"><div class="page-heading"><div><p class="eyebrow">CICLO DE VIDA</p><h1>Firmware<span class="accent-dot">.</span></h1><p class="heading-copy">Publica, inspecciona y administra las versiones MicroPython de tus dispositivos.</p></div><button class="secondary-button" id="firmware-refresh"><i data-lucide="refresh-cw"></i> Actualizar</button></div><div class="panel firmware-publish-panel"><div class="panel-heading"><div><h2>Nueva publicacion</h2><p>Los archivos permitidos se almacenan y quedan disponibles para OTA.</p></div><span class="secure-badge"><i data-lucide="shield-check"></i> Verificado</span></div><form id="firmware-release-form" class="firmware-form"><label>Version<input id="firmware-release-version" required pattern="\d{4}\.\d{2}\.\d{2}\.[A-Za-z0-9_-]+" placeholder="2026.10.04.motion-guard"></label><label>What's new<input id="firmware-release-whats-new" required maxlength="280" placeholder="Protege los extremos y mejora la parada"></label><label>Archivos .py<input id="firmware-release-files" type="file" accept=".py,text/x-python" multiple required></label><button class="primary-button" type="submit"><i data-lucide="upload-cloud"></i> Publicar version</button></form><p id="firmware-release-status" class="form-status">Ninguna publicacion nueva en esta sesion.</p></div><div class="panel firmware-table-panel"><div class="panel-heading"><div><h2>Versiones publicadas</h2><p id="firmware-release-count">Consulta el historial de releases y sus archivos.</p></div></div><div class="firmware-table-wrap"><div class="firmware-table-head"><span>Version</span><span>Contenido</span><span>What's new</span><span>Fecha</span><span>Estado</span><span></span></div><div id="firmware-release-rows"><div class="empty-state">Cargando versiones...</div></div></div></div></section>`;
}

function automationsViewMarkup() {
  return `<section class="view" id="view-automations"><div class="page-heading"><div><p class="eyebrow">IF THIS, THEN THAT</p><h1>Automations<span class="accent-dot">.</span></h1><p class="heading-copy">Programa acciones repetibles para tus dispositivos desde la nube.</p></div></div><div class="automation-layout"><form class="panel automation-form" id="automation-form"><div class="panel-heading"><div><h2 id="automation-form-title">Nueva regla</h2><p id="automation-form-copy">Cuando llegue la hora, Pulsegrid pondra la accion en la cola del dispositivo.</p></div><span class="secure-badge"><i data-lucide="workflow"></i> IFTTT</span></div><label>Nombre<input id="automation-name" maxlength="120" required placeholder="Abrir persiana por la manana"></label><label>Dispositivo<select id="automation-device" required><option value="">Selecciona un dispositivo</option></select></label><div class="automation-fields"><label>Cuando<select id="automation-trigger"><option value="daily">Todos los dias a una hora</option></select></label><label>Hora<input id="automation-time" type="time" required></label></div><label>Entonces<select id="automation-action"><option value="open">Abrir cortina</option><option value="close">Cerrar cortina</option><option value="position">Mover cortina a una posicion</option></select></label><label id="automation-position-field" hidden>Posicion<input id="automation-position" type="number" min="0" max="100" value="50">%</label><div class="automation-form-actions"><button class="primary-button" id="automation-submit" type="submit"><i data-lucide="plus"></i> Crear automation</button><button class="secondary-button" id="automation-cancel-edit" type="button" hidden>Cancelar</button></div><p class="form-status" id="automation-status">Las reglas se ejecutan en tu zona horaria.</p></form><section class="panel automation-list"><div class="panel-heading"><div><h2>Reglas activas</h2><p id="automation-count">Cargando automations...</p></div><button class="icon-button" id="automation-refresh" title="Actualizar"><i data-lucide="refresh-cw"></i></button></div><div id="automation-rows" class="automation-rows"></div></section></div></section>`;
}

let automationRules = [];

function automationTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function automationActionLabel(rule) {
  if (rule.action === 'open') return 'Abrir cortina';
  if (rule.action === 'close') return 'Cerrar cortina';
  return `Mover cortina a ${Number(rule.position)}%`;
}

function populateAutomationDevices() {
  const select = $('#automation-device');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = `<option value="">Selecciona un dispositivo</option>${devices.map((device) => `<option value="${escapeTelemetryHtml(device.id)}">${escapeTelemetryHtml(device.name)} · ${escapeTelemetryHtml(device.id)}</option>`).join('')}`;
  select.value = selected;
}

function renderAutomations(rules) {
  const rows = $('#automation-rows');
  const count = $('#automation-count');
  if (!rows || !count) return;
  count.textContent = `${rules.length} regla${rules.length === 1 ? '' : 's'} configurada${rules.length === 1 ? '' : 's'}.`;
  if (!rules.length) { rows.innerHTML = '<div class="empty-state">Todavia no hay automations. Crea una regla para empezar.</div>'; return; }
  rows.innerHTML = rules.map((rule) => `<article class="automation-row ${rule.enabled ? '' : 'is-paused'}"><div class="automation-time"><strong>${escapeTelemetryHtml(rule.triggerTime)}</strong><small>cada dia</small></div><div class="automation-copy"><strong>${escapeTelemetryHtml(rule.name)}</strong><span>Si son las ${escapeTelemetryHtml(rule.triggerTime)}, entonces ${escapeTelemetryHtml(automationActionLabel(rule))} en ${escapeTelemetryHtml(rule.deviceName)}.</span><small>${escapeTelemetryHtml(rule.timezone || 'Zona pendiente')} · ${rule.lastRunAt ? `Ultima ejecucion: ${new Date(rule.lastRunAt).toLocaleString('es-MX')}` : 'Aun no se ha ejecutado'}</small></div><label class="switch-row automation-switch" title="Activar o pausar"><input type="checkbox" data-automation-toggle="${rule.id}"${rule.enabled ? ' checked' : ''}><i></i></label><div class="automation-row-actions"><button class="icon-button" data-automation-edit="${rule.id}" title="Editar automation"><i data-lucide="pencil"></i></button><button class="icon-button danger-icon" data-automation-delete="${rule.id}" title="Eliminar automation"><i data-lucide="trash-2"></i></button></div></article>`).join('');
  renderIcons();
}

async function loadAutomations() {
  const rows = $('#automation-rows');
  if (!rows) return;
  try { const result = await apiRequest(`automations?timezone=${encodeURIComponent(automationTimezone())}`); automationRules = result.automations || []; renderAutomations(automationRules); }
  catch (error) { rows.innerHTML = `<div class="empty-state">${escapeTelemetryHtml(error.message)}</div>`; }
}

function setupAutomationsView() {
  if (!$('#view-automations')) $('.view-container').insertAdjacentHTML('beforeend', automationsViewMarkup());
  const form = $('#automation-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  const action = $('#automation-action');
  const position = $('#automation-position-field');
  const cancelEdit = $('#automation-cancel-edit');
  const resetForm = () => {
    delete form.dataset.editingId;
    delete form.dataset.editingTimezone;
    form.reset();
    position.hidden = true;
    $('#automation-form-title').textContent = 'Nueva regla';
    $('#automation-form-copy').textContent = 'Cuando llegue la hora, Pulsegrid pondra la accion en la cola del dispositivo.';
    $('#automation-submit').innerHTML = '<i data-lucide="plus"></i> Crear automation';
    cancelEdit.hidden = true;
    renderIcons();
  };
  action.addEventListener('change', () => { position.hidden = action.value !== 'position'; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('#automation-status');
    const editingId = form.dataset.editingId;
    const body = { name: $('#automation-name').value.trim(), deviceId: $('#automation-device').value, triggerTime: $('#automation-time').value, action: action.value, position: Number($('#automation-position').value), timezone: form.dataset.editingTimezone || automationTimezone() };
    try { await apiRequest(editingId ? `automations/${editingId}` : 'automations', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(body) }); resetForm(); status.textContent = editingId ? 'Automation actualizada.' : 'Automation creada y lista para ejecutarse.'; await loadAutomations(); showToast(editingId ? 'Automation actualizada' : 'Automation creada'); }
    catch (error) { status.textContent = error.message; }
  });
  cancelEdit.addEventListener('click', resetForm);
  $('#automation-refresh').addEventListener('click', loadAutomations);
  $('#automation-rows').addEventListener('change', async (event) => {
    const id = event.target.dataset.automationToggle;
    if (!id) return;
    try { await apiRequest(`automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: event.target.checked }) }); await loadAutomations(); }
    catch (error) { showToast(error.message); await loadAutomations(); }
  });
  $('#automation-rows').addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-automation-edit]');
    if (editButton) {
      const rule = automationRules.find((item) => String(item.id) === editButton.dataset.automationEdit);
      if (!rule) return;
      form.dataset.editingId = rule.id;
      form.dataset.editingTimezone = rule.timezone || automationTimezone();
      $('#automation-name').value = rule.name;
      $('#automation-device').value = rule.deviceId;
      $('#automation-time').value = rule.triggerTime;
      action.value = rule.action;
      $('#automation-position').value = rule.position == null ? 50 : rule.position;
      position.hidden = rule.action !== 'position';
      $('#automation-form-title').textContent = 'Editar regla';
      $('#automation-form-copy').textContent = `Editando una regla en ${form.dataset.editingTimezone}.`;
      $('#automation-submit').innerHTML = '<i data-lucide="save"></i> Guardar cambios';
      cancelEdit.hidden = false;
      renderIcons();
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const button = event.target.closest('[data-automation-delete]');
    if (!button || !window.confirm('Eliminar esta automation?')) return;
    try { await apiRequest(`automations/${button.dataset.automationDelete}`, { method: 'DELETE' }); await loadAutomations(); showToast('Automation eliminada'); }
    catch (error) { showToast(error.message); }
  });
}

function renderFirmwareReleases(releases) {
  const rows = $('#firmware-release-rows');
  const count = $('#firmware-release-count');
  if (!rows || !count) return;
  count.textContent = `${releases.length} version${releases.length === 1 ? '' : 'es'} publicada${releases.length === 1 ? '' : 's'}.`;
  if (!releases.length) { rows.innerHTML = '<div class="empty-state">Todavia no hay versiones publicadas.</div>'; return; }
  rows.innerHTML = releases.map((release) => `<div class="firmware-release-row"><div class="firmware-version"><strong>${escapeTelemetryHtml(release.version)}</strong>${release.isActive ? '<span class="release-badge">Activa</span>' : ''}</div><details class="firmware-files"><summary>${release.files.length} archivo${release.files.length === 1 ? '' : 's'}</summary><div>${release.files.map((file) => `<span><code>${escapeTelemetryHtml(file.name)}</code><small>${Number(file.size || 0).toLocaleString('es-MX')} B</small></span>`).join('')}</div></details><span>${escapeTelemetryHtml(release.whatsNew || 'Sin notas')}</span><time>${new Date(release.createdAt).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}</time><span class="firmware-status ${release.isActive ? 'active' : ''}">${release.isActive ? 'Disponible para OTA' : 'Archivada'}</span><div class="firmware-release-actions"><button class="icon-button firmware-kebab" data-firmware-menu="${escapeTelemetryHtml(release.version)}" aria-label="Gestionar ${escapeTelemetryHtml(release.version)}" title="Gestionar version"><i data-lucide="more-vertical"></i></button><div class="firmware-menu" data-firmware-actions="${escapeTelemetryHtml(release.version)}" hidden><button data-firmware-action="content" data-firmware-version="${escapeTelemetryHtml(release.version)}"><i data-lucide="file-code-2"></i> Ver contenido</button>${release.isActive ? '' : `<button data-firmware-action="activate" data-firmware-version="${escapeTelemetryHtml(release.version)}"><i data-lucide="check-circle-2"></i> Activar version</button>`}<button class="danger-action" data-firmware-action="delete" data-firmware-version="${escapeTelemetryHtml(release.version)}"${release.isActive ? ' disabled title="Activa otra version antes de eliminar"' : ''}><i data-lucide="trash-2"></i> Eliminar</button></div></div></div>`).join('');
  renderIcons();
}

async function loadFirmwareReleases() {
  const rows = $('#firmware-release-rows');
  if (!rows) return;
  try { const result = await apiRequest('firmware/releases'); renderFirmwareReleases(result.releases || []); }
  catch (error) { rows.innerHTML = `<div class="empty-state">${escapeTelemetryHtml(error.message)}</div>`; }
}

function openFirmwareContent(version, releases) {
  const release = releases.find((item) => item.version === version);
  if (!release) return;
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop open';
  modal.innerHTML = `<div class="modal firmware-content-modal"><button class="modal-close" aria-label="Cerrar"><i data-lucide="x"></i></button><p class="eyebrow">CONTENIDO DE RELEASE</p><h2>${escapeTelemetryHtml(release.version)}</h2><p class="modal-copy">Archivos incluidos en esta publicacion OTA.</p><div class="firmware-content-list">${release.files.map((file) => `<div><i data-lucide="file-code-2"></i><span><strong>${escapeTelemetryHtml(file.name)}</strong><small>${Number(file.size || 0).toLocaleString('es-MX')} bytes · SHA-256 ${escapeTelemetryHtml(file.sha256)}</small></span></div>`).join('')}</div></div>`;
  document.body.append(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.remove(); });
  renderIcons();
}

function bindFirmwareViewControls() {
  const form = $('#view-firmware #firmware-release-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';
  const status = form.querySelector('#firmware-release-status') || $('#view-firmware #firmware-release-status');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = Array.from(form.querySelector('#firmware-release-files').files || []);
    if (!files.length) return showToast('Selecciona al menos un archivo .py');
    try {
      const payload = { version: form.querySelector('#firmware-release-version').value.trim(), whatsNew: form.querySelector('#firmware-release-whats-new').value.trim(), files: await Promise.all(files.map(firmwareFilePayload)) };
      const result = await apiRequest('firmware/releases', { method: 'POST', body: JSON.stringify(payload) });
      status.textContent = `Publicado ${result.release.version} con ${result.release.files.length} archivos.`;
      form.reset();
      await loadFirmwareReleases();
      showToast('Firmware publicado');
    } catch (error) { status.textContent = error.message; }
  });
  $('#firmware-refresh').addEventListener('click', loadFirmwareReleases);
  document.addEventListener('click', async (event) => {
    const menuButton = event.target.closest('[data-firmware-menu]');
    if (menuButton) {
      const menu = $(`[data-firmware-actions="${CSS.escape(menuButton.dataset.firmwareMenu)}"]`);
      $$('.firmware-menu').forEach((item) => { if (item !== menu) item.hidden = true; });
      if (menu) menu.hidden = !menu.hidden;
      return;
    }
    const action = event.target.closest('[data-firmware-action]');
    if (action) {
      const version = action.dataset.firmwareVersion;
      const result = await apiRequest('firmware/releases').catch((error) => ({ error }));
      if (result.error) return showToast(result.error.message);
      if (action.dataset.firmwareAction === 'content') return openFirmwareContent(version, result.releases || []);
      if (action.dataset.firmwareAction === 'activate') {
        try { await apiRequest(`firmware/releases/${encodeURIComponent(version)}/activate`, { method: 'POST' }); await loadFirmwareReleases(); showToast(`${version} ahora es la version activa`); } catch (error) { showToast(error.message); }
      }
      if (action.dataset.firmwareAction === 'delete' && !action.disabled && window.confirm(`Eliminar la version ${version}?`)) {
        try { await apiRequest(`firmware/releases/${encodeURIComponent(version)}`, { method: 'DELETE' }); await loadFirmwareReleases(); showToast('Version eliminada'); } catch (error) { showToast(error.message); }
      }
      return;
    }
    if (!event.target.closest('.firmware-release-actions')) $$('.firmware-menu').forEach((item) => { item.hidden = true; });
  });
}

function setupFirmwareView() {
  const mainNav = $('.main-nav');
  if (mainNav && !mainNav.querySelector('[data-view="firmware"]')) {
    const wikiButton = mainNav.querySelector('[data-view="wiki"]');
    const firmwareButton = document.createElement('button');
    firmwareButton.className = 'nav-item';
    firmwareButton.dataset.view = 'firmware';
    firmwareButton.innerHTML = '<i data-lucide="hard-drive-download"></i><span>Firmware</span>';
    mainNav.insertBefore(firmwareButton, wikiButton || null);
    firmwareButton.addEventListener('click', () => { navigate('firmware'); loadFirmwareReleases(); });
  }
  if (!$('#view-firmware')) $('.view-container').insertAdjacentHTML('beforeend', firmwareViewMarkup());
  bindFirmwareViewControls();
  renderIcons();
}

function setupWikiNavigation() {
  const keys = Object.keys(wikiPages);
  const article = $('.wiki-article');
  if (article && !$('#wiki-content')) {
    const content = document.createElement('div');
    content.id = 'wiki-content';
    $$('.docs-section', article).forEach((section) => content.append(section));
    article.append(content);
  }
  $$('.wiki-link').forEach((button, index) => {
    const key = keys[index];
    button.dataset.wiki = key;
    button.addEventListener('click', () => renderWikiPage(key));
  });
  if (!$('#view-api')) {
    const apiView = document.createElement('section');
    apiView.className = 'view';
    apiView.id = 'view-api';
    apiView.innerHTML = `<div class="page-heading"><div><p class="eyebrow">INTEGRACION</p><h1>API<span class="accent-dot">.</span></h1><p class="heading-copy">Credenciales, ejemplos y referencia para conectar tus dispositivos.</p></div></div><article class="wiki-article">${languageExamplesMarkup()}<div class="docs-section"><span class="step-number">05</span><div class="wiki-guide"><h2>Publicar firmware MicroPython</h2><p>Selecciona los archivos .py del dispositivo para crear una version OTA. El dispositivo verificara cada archivo antes de reiniciar.</p><form id="firmware-release-form" class="api-key-panel"><label>Version<input id="firmware-release-version" required pattern="\d{4}\.\d{2}\.\d{2}\.[A-Za-z0-9_-]+" placeholder="2026.10.04.motion-guard"></label><label>What's new<input id="firmware-release-whats-new" required maxlength="280" placeholder="Describe los cambios de esta OTA"></label><label>Archivos .py<input id="firmware-release-files" type="file" accept=".py,text/x-python" multiple required></label><button class="secondary-button" type="submit"><i data-lucide="upload-cloud"></i> Publicar version</button><p id="firmware-release-status">Ninguna version publicada desde esta sesion.</p></form></div></div></article>`;
    $('.view-container').append(apiView);
    bindWikiApiControls();
    bindFirmwareReleaseControls();
  }
  setupFirmwareView();
  setupAutomationsView();
  renderWikiPage('intro');
}

function showAuthModal(mode = 'login') {
  let currentMode = mode;
  let modal = $('#auth-modal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', '<div class="modal-backdrop" id="auth-modal"><div class="modal auth-modal"><button class="modal-close" id="auth-close" aria-label="Cerrar"><i data-lucide="x"></i></button><div class="modal-icon"><i data-lucide="shield-check"></i></div><p class="eyebrow">PULSEGRID ACCOUNT</p><h2 id="auth-title">Inicia sesion</h2><p class="modal-copy" id="auth-copy">Administra tus dispositivos desde cualquier lugar.</p><form id="auth-form"><div id="auth-name-field"><label>Nombre completo<input name="name" autocomplete="name" placeholder="Carlos Arriaga"></label></div><label>Correo electronico<input name="email" type="email" autocomplete="email" required placeholder="tu@correo.com"></label><label>Contrasena<input name="password" type="password" autocomplete="current-password" minlength="8" required placeholder="Minimo 8 caracteres"></label><p class="form-error" id="auth-error" hidden></p><div class="modal-actions"><button type="button" class="secondary-button" id="auth-switch">Crear cuenta</button><button class="primary-button" type="submit" id="auth-submit">Iniciar sesion</button></div></form><div class="account-actions" id="account-actions" hidden><button class="secondary-button" id="logout-button"><i data-lucide="log-out"></i> Cerrar sesion</button></div></div></div>');
    modal = $('#auth-modal');
    $('#auth-close').addEventListener('click', () => modal.classList.remove('open'));
    $('#auth-switch').addEventListener('click', () => showAuthModal(modal.dataset.mode === 'login' ? 'register' : 'login'));
    $('#auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const errorBox = $('#auth-error');
      errorBox.hidden = true;
      try { const result = await apiRequest(modal.dataset.mode, { method: 'POST', body: JSON.stringify(data) }); applyUser(result.user); modal.classList.remove('open'); showToast(modal.dataset.mode === 'register' ? 'Cuenta creada correctamente' : 'Sesion iniciada correctamente'); loadDevices(); }
      catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    });
    $('#logout-button').addEventListener('click', async () => { await apiRequest('logout', { method: 'POST' }); clearUser(); modal.classList.remove('open'); showToast('Sesion cerrada'); });
  }
  const activeUser = JSON.parse(localStorage.getItem('pulsegrid-user') || 'null');
  modal.dataset.mode = currentMode;
  $('#auth-title').textContent = activeUser ? 'Tu cuenta' : currentMode === 'login' ? 'Inicia sesion' : 'Crea tu cuenta';
  $('#auth-copy').textContent = activeUser ? `${activeUser.email || 'Sesion activa'} · ${activeUser.role || 'Administrador'}` : currentMode === 'login' ? 'Administra tus dispositivos desde cualquier lugar.' : 'Tu cuenta sera el administrador de este workspace.';
  $('#auth-name-field').style.display = !activeUser && currentMode === 'register' ? 'block' : 'none';
  $('#auth-form').style.display = activeUser ? 'none' : 'block';
  $('#account-actions').hidden = !activeUser;
  $('#auth-submit').textContent = currentMode === 'login' ? 'Iniciar sesion' : 'Crear cuenta';
  $('#auth-switch').textContent = currentMode === 'login' ? 'Crear cuenta' : 'Ya tengo cuenta';
  $('#auth-error').hidden = true;
  modal.classList.add('open');
  renderIcons();
}

function applyUser(user) {
  if (!user) return;
  const initials = (user.name || 'Usuario').split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  $('#account-name').textContent = user.name || 'Usuario';
  $('#account-role').textContent = user.role || 'Administrador';
  $('#topbar-account-name').textContent = user.name || 'Usuario';
  $('#topbar-account-role').textContent = user.role || 'Administrador';
  $('#topbar-avatar').textContent = initials;
  $('.user-profile .avatar').textContent = initials;
  localStorage.setItem('pulsegrid-user', JSON.stringify(user));
}

function clearUser() {
  localStorage.removeItem('pulsegrid-user');
  $('#account-name').textContent = 'Iniciar sesion';
  $('#account-role').textContent = 'Cuenta Pulsegrid';
  $('#topbar-account-name').textContent = 'Iniciar sesion';
  $('#topbar-account-role').textContent = 'Cuenta Pulsegrid';
  $('#topbar-avatar').textContent = 'PG';
  $('.user-profile .avatar').textContent = 'PG';
}

function parseTelemetry(telemetry) {
  if (!telemetry) return {};
  if (typeof telemetry === 'object') return telemetry;
  try { return JSON.parse(telemetry); } catch { return {}; }
}

function curtainMeta(telemetry) {
  const servos = Object.entries(telemetry.servos || {});
  const percentages = servos.map(([, servo]) => Number(servo.blind_percent)).filter(Number.isFinite);
  const opening = percentages.length ? `${Math.round(percentages.reduce((total, percent) => total + percent, 0) / percentages.length)}% abierta` : 'Posicion sin calibrar';
  const moving = servos.some(([, servo]) => servo.multiturn_active);
  const recoveryNeeded = servos.some(([, servo]) => servo.position_recovery_required);
  const servoState = recoveryNeeded ? 'Recalibracion requerida' : moving ? 'En movimiento' : servos.length ? `Servos ${servos.map(([id, servo]) => `${id}: ${Math.round(Number(servo.blind_percent) || 0)}%`).join(' · ')}` : 'Sin servos detectados';
  return { icon: 'blinds', meta: [{ icon: 'blinds', text: opening }, { icon: recoveryNeeded ? 'triangle-alert' : moving ? 'move-horizontal' : 'circle-pause', text: servoState }, { icon: 'cpu', text: telemetry.firmwareVersion ? `Firmware ${telemetry.firmwareVersion}` : 'Firmware sin confirmar' }] };
}

function devicePresentation(device) {
  const telemetry = parseTelemetry(device.telemetry);
  if (telemetry.kind === 'curtain') return curtainMeta(telemetry);
  return { icon: 'cpu', meta: [{ icon: 'radio', text: device.status === 'online' ? 'Telemetria activa' : 'Sin conexion' }, { icon: 'circle-dot', text: device.report ? 'Ultimo estado recibido' : 'Sin telemetria' }, { icon: 'cpu', text: telemetry.firmwareVersion ? `Firmware ${telemetry.firmwareVersion}` : 'Firmware sin confirmar' }] };
}

function updateSidebarFirmwareVersion() {
  const label = $('#sidebar-firmware-version');
  if (!label) return;
  const firmwareDevice = devices.map((device) => parseTelemetry(device.telemetry)).find((telemetry) => telemetry.firmwareVersion);
  label.textContent = firmwareDevice ? `Firmware ${firmwareDevice.firmwareVersion}` : 'Firmware sin datos';
}

async function updateSidebarCloudVersion() {
  const label = $('#sidebar-cloud-version');
  if (!label) return;
  if (!cloudVersion) {
    try { cloudVersion = (await apiRequest('version')).version; }
    catch { label.textContent = 'Cloud sin datos'; return; }
  }
  label.textContent = `Cloud v${cloudVersion}`;
}

async function loadDevices() {
  if (cloudRefreshInFlight) return;
  cloudRefreshInFlight = true;
  try {
    const result = await apiRequest('devices');
    devices.splice(0, devices.length, ...result.devices.map((device) => ({ ...device, ...devicePresentation(device), report: device.report ? new Date(device.report).toLocaleString('es-MX') : 'sin reporte', signal: device.status === 'online' ? 'good' : 'mid' })));
  } catch {
    devices.splice(0, devices.length);
  } finally {
    cloudRefreshInFlight = false;
  }
  renderDeviceRows();
  renderDeviceCards();
  renderCommandDeviceState();
  updateSidebarFirmwareVersion();
  void updateSidebarCloudVersion();
  updateDeviceSummary();
  populateAutomationDevices();
  await loadCommandHistory();
}

async function loadCommandHistory() {
  const history = $('.command-history');
  if (!history) return;
  try {
    const result = await apiRequest('commands');
    $$('.history-row, .empty-state', history).forEach((row) => row.remove());
    history.insertAdjacentHTML('beforeend', result.commands.length
      ? result.commands.map((command) => `<div class="history-row"><span class="history-status ${command.status === 'succeeded' ? 'success' : command.status === 'failed' ? 'failed' : 'pending'}"><i data-lucide="${command.status === 'succeeded' ? 'check' : command.status === 'failed' ? 'x' : 'clock-3'}"></i></span><div><strong>${command.command}</strong><small>${command.deviceName} · ${command.deviceId}${command.errorMessage ? ` · Error: ${escapeTelemetryHtml(command.errorMessage)}` : ''}</small></div><code>${command.status}</code><time>${new Date(command.createdAt).toLocaleString('es-MX')}</time></div>`).join('')
      : '<p class="empty-state">Aun no hay comandos enviados.</p>');
    renderIcons();
  } catch { /* The history remains unavailable until the user signs in. */ }
}

function renderIcons() {
  if (window.lucide) lucide.createIcons();
}

function deviceStatus(device) {
  return `<span class="device-status ${device.status}"><i class="status-dot"></i>${device.status === 'online' ? 'En linea' : 'Fuera de linea'}</span>`;
}

function signalMarkup(signal) {
  return `<span class="signal ${signal}"><i></i><i></i><i></i><i></i></span>`;
}

function renderDeviceRows() {
  const rows = $('#device-rows');
  if (!rows) return;
  rows.innerHTML = devices.map((device) => { const firmware = device.meta.find((item) => item.text.startsWith('Firmware'))?.text || 'Firmware sin confirmar'; return `<div class="device-row"><div class="device-name"><span class="device-icon"><i data-lucide="${device.icon}"></i></span><span><strong>${device.name}</strong><small>${device.id} · ${device.type} · ${firmware}</small></span></div>${deviceStatus(device)}<span>${device.report}</span>${signalMarkup(device.signal)}<button class="row-menu" data-device-menu="${device.id}" title="Gestionar ${device.name}" aria-label="Gestionar ${device.name}"><i data-lucide="more-vertical"></i></button></div>`; }).join('');
  renderIcons();
}

function renderDeviceCards(filter = '', status = 'all') {
  const grid = $('#device-card-grid');
  if (!grid) return;
  const filtered = devices.filter((device) => {
    const matchesSearch = `${device.name} ${device.id}`.toLowerCase().includes(filter.toLowerCase());
    const matchesStatus = status === 'all' || device.status === status;
    return matchesSearch && matchesStatus;
  });
  grid.innerHTML = filtered.length ? filtered.map((device) => `<article class="device-card"><div class="device-card-top"><span class="device-icon"><i data-lucide="${device.icon}"></i></span><div style="display:flex;align-items:center;gap:8px">${deviceStatus(device)}<button class="row-menu" data-device-menu="${device.id}" title="Gestionar ${device.name}" aria-label="Gestionar ${device.name}"><i data-lucide="more-vertical"></i></button></div></div><h3>${device.name}</h3><span class="device-card-id">${device.id} · ${device.type}</span><div class="device-status ${device.status}"><i data-lucide="clock-3"></i> Ultimo reporte: ${device.report}</div><div class="device-meta">${device.meta.map((item) => `<span><i data-lucide="${item.icon}"></i> ${item.text}</span>`).join('')}</div></article>`).join('') : '<div class="panel" style="padding:30px;color:var(--muted)">No encontramos dispositivos con ese criterio.</div>';
  renderIcons();
}

function closeDeviceMenu() { $('#device-actions-menu')?.remove(); }

async function queueFirmwareUpdate(device) {
  const result = await apiRequest('firmware/releases');
  const release = result.releases?.find((item) => item.isActive) || result.releases?.[0];
  if (!release) throw new Error('No hay una version de firmware publicada');
  if (!window.confirm(`Actualizar ${device.name} a ${release.version}? El dispositivo se reiniciara.`)) return;
  await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId: device.id, command: 'firmware.update', payload: { version: release.version } }) });
  await loadCommandHistory();
  showToast(`Actualizacion ${release.version} enviada`);
}

function openDeviceMenu(button, device) {
  if (!device) return;
  closeDeviceMenu();
  const bounds = button.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'device-actions-menu';
  menu.className = 'panel';
  menu.style.cssText = `position:fixed;z-index:30;top:${bounds.bottom + 6}px;left:${Math.max(12, bounds.right - 180)}px;padding:6px;min-width:180px;box-shadow:var(--shadow)`;
  menu.innerHTML = '<button class="secondary-button" data-device-action="command" style="width:100%;border:0;justify-content:flex-start"><i data-lucide="send"></i> Enviar comando</button><button class="secondary-button" data-device-action="firmware" style="width:100%;border:0;justify-content:flex-start"><i data-lucide="download-cloud"></i> Actualizar firmware</button><button class="secondary-button" data-device-action="refresh" style="width:100%;border:0;justify-content:flex-start"><i data-lucide="refresh-cw"></i> Actualizar estado</button><button class="secondary-button" data-device-action="delete" style="width:100%;border:0;justify-content:flex-start;color:var(--red)"><i data-lucide="trash-2"></i> Eliminar dispositivo</button>';
  document.body.append(menu);
  menu.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-device-action]')?.dataset.deviceAction;
    if (!action) return;
    closeDeviceMenu();
    if (action === 'command') {
      navigate('commands');
      $('#command-device').value = device.id;
      renderCommandDeviceState();
      $('#command-name').focus();
    } else if (action === 'firmware') {
      try { await queueFirmwareUpdate(device); }
      catch (error) { showToast(error.message); }
    } else if (action === 'refresh') {
      await loadDevices();
      showToast('Estado actualizado');
    } else if (action === 'delete' && window.confirm(`Eliminar ${device.name}? Esta accion eliminara su historial.`)) {
      try { await apiRequest(`devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await loadDevices(); showToast('Dispositivo eliminado'); }
      catch (error) { showToast(error.message); }
    }
  });
  renderIcons();
}

function telemetrySummary(payload) {
  if (payload.kind === 'curtain') {
    const servos = Object.entries(payload.servos || {});
    const values = servos.map(([, servo]) => Number(servo.blind_percent)).filter(Number.isFinite);
    return values.length ? `Apertura ${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}% · ${servos.map(([id, servo]) => `S${id}: ${Math.round(Number(servo.blind_percent) || 0)}%`).join(' · ')}` : 'Cortina sin posicion calibrada';
  }
  return Object.entries(payload).filter(([key]) => key !== 'online').slice(0, 4).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ') || 'Sin valores legibles';
}

function escapeTelemetryHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function prettyTelemetryJson(payload) {
  return escapeTelemetryHtml(JSON.stringify(payload, null, 2));
}

function formatTelemetryPayloadBlocks() {
  $$('#view-telemetry .activity-item p').forEach((payloadNode) => {
    try {
      const payload = JSON.parse(payloadNode.textContent);
      const details = document.createElement('details');
      details.style.marginTop = '8px';
      details.innerHTML = `<summary style="cursor:pointer;color:var(--muted);font-size:12px">Ver JSON formateado</summary><pre style="margin:8px 0 0;padding:12px;overflow:auto;max-height:280px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap">${prettyTelemetryJson(payload)}</pre>`;
      payloadNode.replaceWith(details);
    } catch {}
  });
}

async function loadTelemetry(deviceId = $('#telemetry-device')?.value || devices[0]?.id) {
  const view = $('#view-telemetry');
  if (!view) return;
  if (!deviceId) { view.innerHTML = '<div class="panel" style="padding:30px;color:var(--muted)">Agrega un dispositivo para consultar telemetria.</div>'; return; }
  try {
    const result = await apiRequest(`telemetry?deviceId=${encodeURIComponent(deviceId)}&limit=30`);
    const samples = result.telemetry;
    const latest = samples[0];
    const device = devices.find((item) => item.id === deviceId);
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">DATOS EN TIEMPO REAL</p><h1>Telemetria<span class="accent-dot">.</span></h1><p class="heading-copy">Lecturas almacenadas por tus dispositivos.</p></div><button class="secondary-button" id="telemetry-refresh"><i data-lucide="refresh-cw"></i> Actualizar</button></div><div class="panel" style="padding:18px;margin-bottom:14px"><label class="metric-label">Dispositivo<select id="telemetry-device" style="margin-left:10px">${devices.map((item) => `<option value="${item.id}"${item.id === deviceId ? ' selected' : ''}>${item.name} · ${item.id}</option>`).join('')}</select></label></div><div class="telemetry-overview"><article class="metric-card"><span class="metric-label"><i data-lucide="database"></i> Muestras recientes</span><strong>${samples.length}</strong><span class="trend stable">Ultimas 30 lecturas</span></article><article class="metric-card"><span class="metric-label"><i data-lucide="clock-3"></i> Ultima lectura</span><strong style="font-size:18px">${latest ? new Date(latest.createdAt).toLocaleTimeString('es-MX') : '--'}</strong><span class="trend stable">${device?.status === 'online' ? 'Dispositivo en linea' : 'Sin conexion reciente'}</span></article><article class="metric-card"><span class="metric-label"><i data-lucide="activity"></i> Estado reportado</span><strong style="font-size:18px">${latest ? telemetrySummary(latest.payload) : 'Sin muestras'}</strong></article></div><article class="panel" style="padding:21px"><div class="panel-heading"><div><h2>Historial de lecturas</h2><p>${device ? `${device.name} · ${device.id}` : deviceId}</p></div></div><div class="activity-list">${samples.length ? samples.map((sample) => `<div class="activity-item" style="align-items:flex-start"><span class="activity-icon lime"><i data-lucide="radio"></i></span><div style="min-width:0;flex:1"><strong>${telemetrySummary(sample.payload)}</strong><details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">Ver JSON formateado</summary><pre style="margin:8px 0 0;padding:12px;overflow:auto;max-height:280px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap">${prettyTelemetryJson(sample.payload)}</pre></details></div><time>${new Date(sample.createdAt).toLocaleString('es-MX')}</time></div>`).join('') : '<p class="empty-state">Aun no hay telemetria para este dispositivo.</p>'}</div></article>`;
    $('#telemetry-device').addEventListener('change', (event) => loadTelemetry(event.target.value));
    $('#telemetry-refresh').addEventListener('click', () => loadTelemetry(deviceId));
    renderIcons();
    formatTelemetryPayloadBlocks();
  } catch (error) { view.innerHTML = `<div class="panel" style="padding:30px;color:var(--muted)">${error.message}</div>`; }
}

function showToast(message) {
  const toast = $('#toast');
  $('span', toast).textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2800);
}

async function openModal() {
  try {
    const result = await apiRequest('me');
    if (!result.user) return showAuthModal('login');
    applyUser(result.user);
    $('#device-modal').classList.add('open');
  } catch {
    showAuthModal('login');
  }
}
function closeModal() { $('#device-modal').classList.remove('open'); }

function updateDeviceSummary() {
  const online = devices.filter((device) => device.status === 'online').length;
  const offline = devices.length - online;
  $('#active-count').textContent = online;
  const overviewBadge = $('.nav-item[data-view="overview"] b');
  if (overviewBadge) overviewBadge.textContent = devices.length;
  const counts = $$('.filter-button b');
  if (counts.length === 3) [devices.length, online, offline].forEach((count, index) => { counts[index].textContent = count; });
  const commandDevice = $('#command-device');
  if (commandDevice) {
    const selectedDeviceId = commandDevice.value;
    commandDevice.disabled = devices.length === 0;
    commandDevice.innerHTML = devices.length
      ? devices.map((device) => `<option value="${device.id}">${device.name} · ${device.id}</option>`).join('')
      : '<option value="">Agrega un dispositivo para enviar comandos</option>';
    commandDevice.value = devices.some((device) => device.id === selectedDeviceId) ? selectedDeviceId : devices[0]?.id || '';
    renderCommandDeviceState();
  }
  renderCalibrationWizard();
  const activity = $('.activity-list');
  if (activity) activity.innerHTML = '<p class="empty-state">Los eventos de tus dispositivos apareceran aqui.</p>';
}

function renderCommandDeviceState() {
  const commandDevice = $('#command-device');
  if (!commandDevice) return;
  const device = devices.find((item) => item.id === commandDevice.value);
  let reference = $('#command-device-state');
  if (!reference) {
    reference = document.createElement('div');
    reference.id = 'command-device-state';
    reference.className = 'device-meta';
    commandDevice.closest('label').insertAdjacentElement('afterend', reference);
  }
  reference.innerHTML = device
    ? `<span><i data-lucide="${device.icon}"></i> Estado actual: ${device.status === 'online' ? 'En linea' : 'Fuera de linea'}</span>${device.meta.map((item) => `<span><i data-lucide="${item.icon}"></i> ${item.text}</span>`).join('')}`
    : '<span><i data-lucide="circle-off"></i> Sin estado disponible</span>';
  renderIcons();
}

function calibrationWizardMarkup() {
  return `<div class="panel calibration-wizard" id="calibration-wizard"><div class="panel-heading"><div><h2>Calibrar persiana</h2><p>Define el lado del motor, guarda cerrada/desplegada y abierta/enrollada, y verifica las posiciones.</p></div><span class="secure-badge"><i data-lucide="wand-sparkles"></i> Guiado</span></div><div class="calibration-steps"><div class="calibration-step active" data-calibration-step="1"><b>1</b><span>Motor</span></div><div class="calibration-step" data-calibration-step="2"><b>2</b><span>Extremo inicial</span></div><div class="calibration-step" data-calibration-step="3"><b>3</b><span>Recorrido</span></div><div class="calibration-step" data-calibration-step="4"><b>4</b><span>Prueba</span></div></div><div class="calibration-settings"><label>Servo<select id="calibration-servo"><option value="1">Servo 1</option><option value="2">Servo 2</option></select></label><label>Lado del motor<select id="calibration-motor-side"><option value="left">Izquierdo</option><option value="right">Derecho</option></select></label><button class="primary-button" id="calibration-start"><i data-lucide="rotate-ccw"></i> Reiniciar calibracion</button></div><p id="calibration-status" class="form-status">Elige el lado del motor e inicia. Desplegada significa cerrada; enrollada significa abierta.</p><div class="calibration-actions"><button class="secondary-button" id="calibration-deployed" disabled><i data-lucide="flag"></i> Guardar cerrada (desplegada)</button><button class="secondary-button" id="calibration-rolled" disabled><i data-lucide="flag"></i> Guardar abierta (enrollada)</button><button class="secondary-button" id="calibration-jog-deployed" disabled><i data-lucide="arrow-down"></i> Mover hacia cerrada</button><button class="secondary-button" id="calibration-jog-rolled" disabled><i data-lucide="arrow-up"></i> Mover hacia abierta</button><button class="secondary-button" id="calibration-jog-clockwise" disabled><i data-lucide="rotate-cw"></i> Una vuelta horario (frente del pinon)</button><button class="secondary-button" id="calibration-jog-counterclockwise" disabled><i data-lucide="rotate-ccw"></i> Una vuelta antihorario (frente del pinon)</button><button class="primary-button" id="calibration-test-open" data-percent="100" disabled><i data-lucide="arrow-up"></i> Probar abierta</button><button class="secondary-button" id="calibration-test-closed" data-percent="0" disabled><i data-lucide="arrow-down"></i> Probar cerrada</button><button class="secondary-button" id="calibration-test-half" data-percent="50" disabled><i data-lucide="circle-half"></i> Probar 50%</button></div></div>`;
}

function queueCalibrationCommand(command, payload) {
  const deviceId = $('#command-device')?.value;
  if (!deviceId) throw new Error('Selecciona un dispositivo');
  return apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command, payload }) });
}

async function waitForCalibrationIdle(deviceId, servoId, timeout = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    await loadDevices();
    const device = devices.find((item) => item.id === deviceId);
    const telemetry = parseTelemetry(device?.telemetry);
    const servo = telemetry.servos?.[String(servoId)] || telemetry.servos?.[servoId];
    if (servo && !servo.multiturn_active) return;
  }
  throw new Error('No se confirmo el fin del movimiento');
}

async function waitForCalibrationCommand(commandId, timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await apiRequest('commands');
    const command = result.commands.find((item) => Number(item.id) === Number(commandId));
    if (command?.status === 'succeeded') return;
    if (command?.status === 'failed') throw new Error(command.errorMessage || 'El dispositivo rechazo el comando');
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error('El dispositivo no confirmo el comando');
}

function renderCalibrationWizard() {
  const layout = $('.command-layout');
  if (!layout || $('#calibration-wizard')) return;
  layout.insertAdjacentHTML('beforeend', calibrationWizardMarkup());
  const status = $('#calibration-status');
  const servo = $('#calibration-servo');
  const motorSide = $('#calibration-motor-side');
  const start = $('#calibration-start');
  const deployed = $('#calibration-deployed');
  const jogDeployed = $('#calibration-jog-deployed');
  const jogRolled = $('#calibration-jog-rolled');
  const jogClockwise = $('#calibration-jog-clockwise');
  const jogCounterclockwise = $('#calibration-jog-counterclockwise');
  const rolled = $('#calibration-rolled');
  const testButtons = [$('#calibration-test-open'), $('#calibration-test-closed'), $('#calibration-test-half')];
  const deviceId = () => $('#command-device')?.value;
  let phase = 'setup';
  let firstReference = null;
  const setStep = (step) => $$('.calibration-step').forEach((item) => item.classList.toggle('active', Number(item.dataset.calibrationStep) === step));
  const setEnabled = (button, enabled) => { if (!button) return; button.disabled = !enabled; button.classList.toggle('is-ready', enabled); };
  const renderState = () => {
    const first = phase === 'first-reference';
    const travel = phase === 'travel';
    const tests = phase === 'tests';
    servo.disabled = phase !== 'setup';
    motorSide.disabled = phase !== 'setup';
    setEnabled(start, true);
    setEnabled(deployed, first || (travel && firstReference !== 'deployed'));
    setEnabled(rolled, first || (travel && firstReference !== 'rolled'));
    setEnabled(jogDeployed, travel);
    setEnabled(jogRolled, travel);
    setEnabled(jogClockwise, travel);
    setEnabled(jogCounterclockwise, travel);
    testButtons.forEach((button) => setEnabled(button, tests));
    setStep(phase === 'setup' ? 1 : first ? 2 : travel ? 3 : 4);
  };
  start.addEventListener('click', async () => {
    const selectedServoId = Number(servo.value);
    try {
      setEnabled(start, false);
      status.textContent = 'Guardando lado del motor...';
      let result = await queueCalibrationCommand('blind.setMotorSide', { servoId: selectedServoId, side: motorSide.value });
      await waitForCalibrationCommand(result.commandId);
      result = await queueCalibrationCommand('blind.beginCalibration', { servoId: selectedServoId });
      await waitForCalibrationCommand(result.commandId);
      firstReference = null;
      phase = 'first-reference';
      status.textContent = 'Coloca la persiana en cerrada/desplegada o abierta/enrollada y guarda ese extremo.';
      renderState();
    } catch (error) { status.textContent = error.message; renderState(); }
  });
  const captureReference = async (reference) => {
    const isFirstReference = !firstReference;
    const selectedServoId = Number(servo.value);
    try {
      setEnabled(deployed, false);
      setEnabled(rolled, false);
      const result = await queueCalibrationCommand(reference === 'deployed' ? 'blind.markDeployed' : 'blind.markRolled', { servoId: selectedServoId });
      await waitForCalibrationCommand(result.commandId);
      if (isFirstReference) {
        firstReference = reference;
        phase = 'travel';
        status.textContent = `Extremo ${reference === 'deployed' ? 'cerrada/desplegada' : 'abierta/enrollada'} guardado. Mueve hacia el extremo opuesto y guardalo.`;
      } else {
        phase = 'tests';
        status.textContent = 'Limites guardados. Elige una prueba de posicion.';
      }
      renderState();
      showToast(`Extremo ${reference === 'deployed' ? 'desplegado' : 'enrollado'} guardado`);
    } catch (error) {
      status.textContent = error.message;
      renderState();
    }
  };
  deployed.addEventListener('click', () => captureReference('deployed'));
  rolled.addEventListener('click', () => captureReference('rolled'));
  const jog = async (direction) => {
    try {
      setEnabled(jogDeployed, false); setEnabled(jogRolled, false); setEnabled(jogClockwise, false); setEnabled(jogCounterclockwise, false);
      const selectedDeviceId = deviceId(); const selectedServoId = Number(servo.value);
      const labels = { deployed: 'cerrada/desplegada', rolled: 'abierta/enrollada', clockwise: 'horario', counterclockwise: 'antihorario' };
      status.textContent = `Moviendo una vuelta en sentido ${labels[direction]}...`;
      const result = await queueCalibrationCommand('blind.jog', { servoId: selectedServoId, direction });
      await waitForCalibrationCommand(result.commandId); await waitForCalibrationIdle(selectedDeviceId, selectedServoId);
      status.textContent = 'Vuelta terminada. Continua hacia el extremo opuesto o guardalo.';
    } catch (error) { status.textContent = error.message; }
    finally { renderState(); }
  };
  jogDeployed.addEventListener('click', () => jog('deployed'));
  jogRolled.addEventListener('click', () => jog('rolled'));
  jogClockwise.addEventListener('click', () => jog('clockwise'));
  jogCounterclockwise.addEventListener('click', () => jog('counterclockwise'));
  testButtons.forEach((button) => button.addEventListener('click', async () => {
    const percent = Number(button.dataset.percent);
    try { testButtons.forEach((item) => { item.disabled = true; }); const selectedDeviceId = deviceId(); const selectedServoId = Number(servo.value); status.textContent = `Probando ${percent}%...`; const result = await queueCalibrationCommand('curtain.move', { servoId: selectedServoId, percent, speed: 800, acceleration: 50 }); await waitForCalibrationCommand(result.commandId); await waitForCalibrationIdle(selectedDeviceId, selectedServoId); status.textContent = `Prueba completada: ${percent}%.`; showToast(`Posicion ${percent}% probada`); }
    catch (error) { status.textContent = error.message; }
    finally { renderState(); }
  }));
  renderState();
  renderIcons();
}

function navigate(viewName) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  const activeNav = $(`.nav-item[data-view="${viewName}"]`);
  $('#breadcrumb-title').textContent = activeNav ? activeNav.querySelector('span').textContent : viewName;
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => { navigate(item.dataset.view); if (item.dataset.view === 'telemetry') loadTelemetry(); if (item.dataset.view === 'firmware') loadFirmwareReleases(); if (item.dataset.view === 'automations') loadDevices().then(loadAutomations); }));
$$('[data-view-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.viewTarget)));
$$('[data-open-modal="add-device"], #add-device').forEach((button) => button.addEventListener('click', openModal));
$('.modal-close').addEventListener('click', closeModal);
$('.modal-cancel').addEventListener('click', closeModal);
$('#device-modal').addEventListener('click', (event) => { if (event.target.id === 'device-modal') closeModal(); });
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

$('#device-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const newDevice = { name: formData.get('name'), id: formData.get('id'), type: formData.get('type'), status: 'online', report: 'ahora', signal: 'good', icon: 'cpu', temp: '--', battery: '--' };
  try { await apiRequest('devices', { method: 'POST', body: JSON.stringify(newDevice) }); } catch (error) { if (error.message === 'Authentication required') showAuthModal('login'); else showToast(error.message); return; }
  devices.unshift(newDevice);
  renderDeviceRows();
  renderDeviceCards();
  updateDeviceSummary();
  event.currentTarget.reset();
  closeModal();
  showToast('Dispositivo creado correctamente');
});

$('#device-search').addEventListener('input', (event) => renderDeviceCards(event.target.value));
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-device-menu]');
  if (button) return openDeviceMenu(button, devices.find((device) => device.id === button.dataset.deviceMenu));
  if (!event.target.closest('#device-actions-menu')) closeDeviceMenu();
});
$$('.filter-button').forEach((button) => button.addEventListener('click', () => {
  $$('.filter-button').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const label = button.textContent.toLowerCase();
  const status = label.includes('en linea') ? 'online' : label.includes('fuera') ? 'offline' : 'all';
  renderDeviceCards($('#device-search').value, status);
}));

$('#theme-toggle').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme === 'light';
  document.documentElement.dataset.theme = light ? 'dark' : 'light';
  localStorage.setItem('pulsegrid-theme', light ? 'dark' : 'light');
  showToast(light ? 'Tema oscuro activado' : 'Tema claro activado');
});

$$('.copy-button').forEach((button) => button.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(button.dataset.copy); } catch { /* clipboard is optional in local previews */ }
  showToast('Copiado al portapapeles');
}));

function configureCurtainCommands() {
  const commandSelect = $('#command-name') || $$('.command-compose select')[1];
  const payload = $('#command-payload') || $('.command-compose textarea');
  if (!commandSelect || !payload) return;
  const commands = {
    'curtain.open': { payload: {}, help: 'No requiere payload. Abre ambos servos de la cortina.' },
    'curtain.close': { payload: {}, help: 'No requiere payload. Cierra ambos servos de la cortina.' },
    'curtain.stop': { payload: {}, help: 'No requiere payload. Detiene el movimiento actual de ambos servos.' },
    'curtain.move': { payload: { servoId: 1, percent: 50, speed: 800, acceleration: 50 }, help: 'servoId: 1 o 2. percent: 0-100. speed: 0-3073. acceleration: 0-150.' },
    'servo.configure': { payload: { servoId: 1, min: 300, max: 3700, mode: 0, torqueLimit: 1000 }, help: 'servoId: 1 o 2. min/max: 0-4095. mode: 0 Servo, 1 Rueda, 3 Multivuelta. torqueLimit: 0-1000.' },
    'blind.configure': { payload: { servoId: 1, rolledTurns: 0, unrolledTurns: 10 }, help: 'servoId: 1 o 2. rolledTurns y unrolledTurns: -999.99 a 999.99; deben ser distintos.' },
    'blind.markRolled': { payload: { servoId: 1 }, help: 'Fija la posicion actual del servo como cortina completamente enrollada.' },
    'blind.markDeployed': { payload: { servoId: 1 }, help: 'Fija la posicion actual del servo como cortina completamente desplegada.' },
    'blind.jog': { payload: { servoId: 1, turns: -1, speed: 800, acceleration: 50 }, help: 'Avanza exactamente una vuelta. Usa -1 para enrollar y 1 para desenrollar.' },
    'motion.configure': { payload: { speed: 800, acceleration: 50 }, help: 'speed: 0-3073. acceleration: 0-150.' },
    'servo.torque': { payload: { servoId: 1, enabled: true }, help: 'servoId: 1 o 2. enabled: true o false.' },
    'servo.resetTurns': { payload: { servoId: 1 }, help: 'servoId: 1 o 2. Reinicia el contador absoluto si no hay movimiento.' }
  };
  commandSelect.id = 'command-name';
  commandSelect.innerHTML = '<option value="curtain.open">Abrir cortina</option><option value="curtain.close">Cerrar cortina</option><option value="curtain.stop">Detener cortina</option><option value="curtain.move">Mover cortina</option><option value="servo.configure">Configurar servo</option><option value="blind.configure">Configurar extremos</option><option value="blind.markRolled">Marcar completamente enrollada</option><option value="blind.markDeployed">Marcar completamente desplegada</option><option value="blind.jog">Avanzar una vuelta</option><option value="motion.configure">Configurar movimiento</option><option value="servo.torque">Configurar torque</option><option value="servo.resetTurns">Reiniciar vueltas</option>';
  payload.id = 'command-payload';
  let help = $('#command-payload-help');
  if (!help) {
    help = document.createElement('small');
    help.id = 'command-payload-help';
    help.className = 'command-payload-help';
    payload.insertAdjacentElement('afterend', help);
  }
  const applyCommandTemplate = () => {
    const definition = commands[commandSelect.value];
    payload.value = JSON.stringify(definition.payload, null, 2);
    help.textContent = definition.help;
  };
  commandSelect.addEventListener('change', applyCommandTemplate);
  applyCommandTemplate();
}

configureCurtainCommands();
$('#execute-command').addEventListener('click', async () => {
  const deviceId = $('#command-device').value;
  const command = $('#command-name').value;
  try {
    const payload = JSON.parse($('#command-payload').value || '{}');
    await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command, payload }) });
    loadDevices();
    showToast('Comando en cola para el dispositivo');
  } catch (error) {
    showToast(error instanceof SyntaxError ? 'El payload debe ser JSON valido' : error.message);
  }
});
$('#command-device').addEventListener('change', renderCommandDeviceState);
$('#send-command').addEventListener('click', () => {
  navigate('commands');
  const composer = $('.command-compose');
  composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('#command-name').focus(), 250);
});

ensureSettingsViewInMain();
setupWikiNavigation();
$$('.settings-tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.settings-tab').forEach((item) => item.classList.remove('active'));
  $$('.settings-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.settingsPane === tab.dataset.settingsTab));
  tab.classList.add('active');
}));
$('#save-settings').addEventListener('click', () => {
  const name = $('#settings-name').value.trim();
  if (name) { $('#account-name').textContent = name; localStorage.setItem('pulsegrid-settings-name', name); }
  showToast('Ajustes guardados');
});
$('#account-button').addEventListener('click', () => showAuthModal('login'));
$('#topbar-account-button').addEventListener('click', () => showAuthModal('login'));
const savedUser = localStorage.getItem('pulsegrid-user');
if (savedUser) applyUser(JSON.parse(savedUser));
apiRequest('me').then((result) => {
  if (result.user) { applyUser(result.user); loadDevices(); } else clearUser();
}).catch(() => clearUser());

window.setInterval(() => {
  if (!document.hidden && localStorage.getItem('pulsegrid-user')) loadDevices();
}, CLOUD_REFRESH_MS);

document.documentElement.dataset.theme = localStorage.getItem('pulsegrid-theme') || 'dark';
renderDeviceRows();
renderDeviceCards();
updateDeviceSummary();
renderIcons();
