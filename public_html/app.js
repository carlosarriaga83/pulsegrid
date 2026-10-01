const devices = [];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_URL = '/api';

async function apiRequest(action, options = {}) {
  const response = await fetch(`${API_URL}/${action}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud');
  return data;
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
  return `<div class="docs-section"><span class="step-number">04</span><div class="wiki-guide"><h2>Prueba la API antes del sensor</h2><p>Antes de conectar un sensor, practica una peticion HTTP. Reemplaza <code>ESP32_ID</code> por el ID del dispositivo y modifica el JSON para tus propias lecturas.</p><h3>JavaScript con fetch</h3><div class="code-block wiki-code"><pre><code>await fetch('/api/telemetry', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'ESP32_ID', temperature: 24.8 })
});</code></pre></div><h3>Python con requests</h3><div class="code-block wiki-code"><pre><code>import requests

response = requests.post(
    'https://pulsegrid.2api2.com/api/telemetry',
    json={ 'deviceId': 'ESP32_ID', 'temperature': 24.8 }
)
print(response.status_code)</code></pre></div><h3>Terminal con curl</h3><div class="code-block wiki-code"><pre><code>curl -X POST https://pulsegrid.2api2.com/api/telemetry \
  -H "Content-Type: application/json" \
  -d "{\\"deviceId\\":\\"ESP32_ID\\",\\"temperature\\":24.8}"</code></pre></div><div class="wiki-callout"><strong>Siguiente paso</strong><p>Cuando la prueba responda correctamente, sustituye el valor fijo por una lectura real. Puedes usar un DHT para temperatura y humedad o <code>analogRead()</code> para un sensor analogico.</p></div></div></div>`;
}

function languageExamplesMarkup() {
  const base = window.location.origin;
  const examples = {
    arduino: `#include <HTTPClient.h>\nconst char* API_KEY = "pg_live_TU_API_KEY";\n\nHTTPClient http;\nhttp.begin("${base}/api/telemetry");\nhttp.addHeader("Content-Type", "application/json");\nhttp.addHeader("X-API-Key", API_KEY);\nhttp.POST("{\\"deviceId\\":\\"ESP32_ID\\",\\"temperature\\":24.8}");\nhttp.end();`,
    micropython: `import urequests\n\nresponse = urequests.post(\n    "${base}/api/telemetry",\n    headers={"X-API-Key": "pg_live_TU_API_KEY"},\n    json={"deviceId": "ESP32_ID", "temperature": 24.8}\n)\nresponse.close()`,
    python: `import requests\n\nrequests.post(\n    "${base}/api/telemetry",\n    headers={"X-API-Key": "pg_live_TU_API_KEY"},\n    json={"deviceId": "ESP32_ID", "temperature": 24.8}\n).raise_for_status()`,
    javascript: `await fetch("${base}/api/telemetry", {\n  method: "POST",\n  headers: {"Content-Type":"application/json", "X-API-Key":"pg_live_TU_API_KEY"},\n  body: JSON.stringify({deviceId:"ESP32_ID", temperature:24.8})\n});`,
    curl: `curl -X POST "${base}/api/telemetry" \\\n+  -H "Content-Type: application/json" \\\n+  -H "X-API-Key: pg_live_TU_API_KEY" \\\n+  -d '{"deviceId":"ESP32_ID","temperature":24.8}'`
  };
  const tabs = [['arduino', 'Arduino C++'], ['micropython', 'MicroPython'], ['python', 'Python'], ['javascript', 'JavaScript'], ['curl', 'cURL']];
  queueMicrotask(() => bindWikiApiControls(examples));
  return `<div class="docs-section"><span class="step-number">04</span><div class="wiki-guide"><h2>Clave de API y ejemplos</h2><p>Crea una clave para tu cuenta. Se muestra completa solo al crearla o rotarla; guardala en tu firmware o en variables de entorno.</p><div class="api-key-panel"><div><strong>Clave de API</strong><p id="api-key-status">Inicia sesion para crear una clave.</p></div><button class="secondary-button" id="api-key-action">Crear clave</button></div><div class="api-key-secret" id="api-key-secret" hidden><code></code><button class="copy-button" id="copy-api-key">Copiar</button></div><p>Envia siempre la cabecera <code>X-API-Key</code> y reemplaza <code>ESP32_ID</code> por tu identificador registrado.</p><div class="code-tabs">${tabs.map(([id, label], index) => `<button class="code-tab${index ? '' : ' active'}" data-code-tab="${id}">${label}</button>`).join('')}</div><div class="code-block wiki-code"><div class="code-toolbar"><span id="code-language">Arduino C++</span><button class="copy-button" id="copy-code-example">Copiar</button></div><pre><code id="language-code-example"></code></pre></div><div class="wiki-callout"><strong>Rotacion</strong><p>Rotar una clave revoca la anterior de inmediato. Actualiza primero todos los dispositivos que la usan.</p></div></div></div>`;
}

function bindWikiApiControls(examples) {
  const code = $('#language-code-example');
  if (!code) return;
  const tabs = $$('.code-tab');
  const displayExample = (key) => { code.textContent = examples[key]; $('#code-language').textContent = tabs.find((tab) => tab.dataset.codeTab === key).textContent; tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.codeTab === key)); };
  tabs.forEach((tab) => tab.addEventListener('click', () => displayExample(tab.dataset.codeTab)));
  $('#copy-code-example').addEventListener('click', async () => { try { await navigator.clipboard.writeText(code.textContent); } catch { /* clipboard unavailable */ } showToast('Ejemplo copiado'); });
  const action = $('#api-key-action'); const status = $('#api-key-status'); const secret = $('#api-key-secret');
  apiRequest('api-key').then(({ apiKey }) => { if (apiKey) { status.textContent = `Activa: ${apiKey.hint}`; action.textContent = 'Rotar clave'; } else status.textContent = 'Aun no tienes una clave de API.'; }).catch(() => { action.textContent = 'Inicia sesion'; });
  action.addEventListener('click', async () => { try { const result = await apiRequest('api-key', { method: 'POST' }); status.textContent = `Activa: ${result.hint}`; action.textContent = 'Rotar clave'; $('code', secret).textContent = result.apiKey; secret.hidden = false; $('#copy-api-key').onclick = async () => { try { await navigator.clipboard.writeText(result.apiKey); } catch { /* clipboard unavailable */ } showToast('Clave copiada'); }; } catch (error) { if (error.message === 'Authentication required') showAuthModal('login'); else showToast(error.message); } });
  displayExample('arduino');
}

function renderWikiPage(key) {
  const page = wikiPages[key];
  const content = $('#wiki-content');
  if (!page || !content) return;
  content.innerHTML = key === 'intro' ? `${introGuideMarkup()}${languageExamplesMarkup()}` : `<div class="docs-section"><span class="step-number">${String(Object.keys(wikiPages).indexOf(key) + 1).padStart(2, '0')}</span><div><h2>${page[0]}</h2><p>${page[1]}</p><div class="endpoint"><span class="method ${page[2] === 'MQTT' ? 'mqtt' : 'post'}">${page[2]}</span><code>${page[3]}</code><button class="copy-button" data-copy="${page[3]}"><i data-lucide="copy"></i> Copiar</button></div><div class="code-block wiki-code"><pre><code>const endpoint = '${page[3]}';
fetch(endpoint, { method: '${page[2] === 'MQTT' ? 'SUBSCRIBE' : 'POST'}' });</code></pre></div></div></div>`;
  $$('.wiki-link').forEach((item) => item.classList.toggle('active', item.dataset.wiki === key));
  bindCopyButtons();
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

async function loadDevices() {
  try {
    const result = await apiRequest('devices');
    devices.splice(0, devices.length, ...result.devices.map((device) => ({ ...device, report: device.report ? new Date(device.report).toLocaleString('es-MX') : 'sin reporte', signal: device.status === 'online' ? 'good' : 'mid', icon: 'cpu', temp: '--', battery: '--' })));
  } catch {
    devices.splice(0, devices.length);
  }
  renderDeviceRows();
  renderDeviceCards();
  updateDeviceSummary();
  loadCommandHistory();
}

async function loadCommandHistory() {
  const history = $('.command-history');
  if (!history) return;
  try {
    const result = await apiRequest('commands');
    $$('.history-row, .empty-state', history).forEach((row) => row.remove());
    history.insertAdjacentHTML('beforeend', result.commands.length
      ? result.commands.map((command) => `<div class="history-row"><span class="history-status ${command.status === 'succeeded' ? 'success' : command.status === 'failed' ? 'failed' : 'pending'}"><i data-lucide="${command.status === 'succeeded' ? 'check' : command.status === 'failed' ? 'x' : 'clock-3'}"></i></span><div><strong>${command.command}</strong><small>${command.deviceName} · ${command.deviceId}</small></div><code>${command.status}</code><time>${new Date(command.createdAt).toLocaleString('es-MX')}</time></div>`).join('')
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
  rows.innerHTML = devices.map((device) => `<div class="device-row"><div class="device-name"><span class="device-icon"><i data-lucide="${device.icon}"></i></span><span><strong>${device.name}</strong><small>${device.id} · ${device.type}</small></span></div>${deviceStatus(device)}<span>${device.report}</span>${signalMarkup(device.signal)}<button class="row-menu" title="Opciones"><i data-lucide="more-horizontal"></i></button></div>`).join('');
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
  grid.innerHTML = filtered.length ? filtered.map((device) => `<article class="device-card"><div class="device-card-top"><span class="device-icon"><i data-lucide="${device.icon}"></i></span>${deviceStatus(device)}</div><h3>${device.name}</h3><span class="device-card-id">${device.id} · ${device.type}</span><div class="device-status ${device.status}"><i data-lucide="clock-3"></i> Ultimo reporte: ${device.report}</div><div class="device-meta"><span><i data-lucide="thermometer"></i> ${device.temp}</span><span><i data-lucide="battery-medium"></i> ${device.battery}</span></div></article>`).join('') : '<div class="panel" style="padding:30px;color:var(--muted)">No encontramos dispositivos con ese criterio.</div>';
  renderIcons();
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
    commandDevice.disabled = devices.length === 0;
    commandDevice.innerHTML = devices.length
      ? devices.map((device) => `<option value="${device.id}">${device.name} · ${device.id}</option>`).join('')
      : '<option value="">Agrega un dispositivo para enviar comandos</option>';
  }
  const activity = $('.activity-list');
  if (activity) activity.innerHTML = '<p class="empty-state">Los eventos de tus dispositivos apareceran aqui.</p>';
}

function navigate(viewName) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  const activeNav = $(`.nav-item[data-view="${viewName}"]`);
  $('#breadcrumb-title').textContent = activeNav ? activeNav.querySelector('span').textContent : viewName;
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => navigate(item.dataset.view)));
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
  commandSelect.id = 'command-name';
  commandSelect.innerHTML = '<option value="curtain.open">Abrir cortina</option><option value="curtain.close">Cerrar cortina</option><option value="curtain.stop">Detener cortina</option><option value="curtain.move">Mover cortina</option>';
  payload.id = 'command-payload';
  payload.value = '{}';
}

configureCurtainCommands();
$('#execute-command').addEventListener('click', async () => {
  const deviceId = $('#command-device').value;
  const command = $('#command-name').value;
  try {
    const payload = JSON.parse($('#command-payload').value || '{}');
    await apiRequest('commands', { method: 'POST', body: JSON.stringify({ deviceId, command, payload }) });
    loadCommandHistory();
    showToast('Comando en cola para el dispositivo');
  } catch (error) {
    showToast(error instanceof SyntaxError ? 'El payload debe ser JSON valido' : error.message);
  }
});
$('#send-command').addEventListener('click', () => navigate('commands'));

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

document.documentElement.dataset.theme = localStorage.getItem('pulsegrid-theme') || 'dark';
renderDeviceRows();
renderDeviceCards();
updateDeviceSummary();
renderIcons();
