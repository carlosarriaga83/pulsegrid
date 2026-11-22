import api from '../api.js';
import { showToast } from './toast.js';
import { formatDateTime } from '../utils/formatters.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRecipients(recipients = []) {
  const list = document.getElementById('alert-recipients-list');
  if (!list) return;

  if (recipients.length === 0) {
    list.innerHTML = '<p class="text-xs text-slate-500 italic">No hay destinatarios registrados todavía.</p>';
    return;
  }

  list.innerHTML = recipients
    .map(
      (r) => `
      <div class="rounded-xl bg-slate-950/70 border border-slate-800 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full ${r.isActive ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
            <span class="text-xs font-semibold text-slate-100">${esc(r.name || r.email)}</span>
            <span class="text-[11px] font-mono text-slate-400">${esc(r.email)}</span>
          </div>
          <div class="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
            <label class="inline-flex items-center gap-1 cursor-pointer">
              <input type="checkbox" data-rec-flag="receiveAutomationAlerts" data-rec-id="${r.id}" ${r.receiveAutomationAlerts ? 'checked' : ''} class="accent-sky-500" />
              <span>Reglas</span>
            </label>
            <label class="inline-flex items-center gap-1 cursor-pointer">
              <input type="checkbox" data-rec-flag="receiveOfflineAlerts" data-rec-id="${r.id}" ${r.receiveOfflineAlerts ? 'checked' : ''} class="accent-rose-500" />
              <span>Offline</span>
            </label>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" data-rec-toggle="${r.id}" data-rec-active="${r.isActive ? '1' : '0'}" class="px-2.5 py-1 rounded-lg text-[11px] border ${
            r.isActive
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
              : 'bg-slate-900 text-slate-400 border-slate-700'
          }">${r.isActive ? 'Activo' : 'Pausado'}</button>
          <button type="button" data-rec-delete="${r.id}" class="px-2 py-1 rounded-lg text-[11px] text-rose-400 hover:bg-rose-950/60 border border-slate-800">Eliminar</button>
        </div>
      </div>
    `
    )
    .join('');

  list.querySelectorAll('[data-rec-flag]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        const res = await api.updateAlertRecipient(cb.dataset.recId, {
          [cb.dataset.recFlag]: cb.checked,
        });
        renderRecipients(res.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  list.querySelectorAll('[data-rec-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const next = btn.dataset.recActive !== '1';
        const res = await api.updateAlertRecipient(btn.dataset.recToggle, { isActive: next });
        renderRecipients(res.data);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  list.querySelectorAll('[data-rec-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api.deleteAlertRecipient(btn.dataset.recDelete);
        renderRecipients(res.data);
        showToast('Destinatario eliminado', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function renderLogs(logs = []) {
  const tbody = document.getElementById('alert-logs-tbody');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-xs text-slate-500 italic">Sin alertas registradas aún.</td></tr>';
    return;
  }

  tbody.innerHTML = logs
    .map((l) => {
      const badge =
        l.deliveryStatus === 'sent'
          ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Enviado</span>'
          : l.deliveryStatus === 'suppressed_cooldown'
            ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">Cooldown</span>'
            : '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">Error</span>';

      return `
        <tr class="border-t border-slate-800/80 text-xs">
          <td class="py-2.5 pr-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">${formatDateTime(l.sentAt)}</td>
          <td class="py-2.5 pr-3">${badge}</td>
          <td class="py-2.5 pr-3 text-slate-200">
            <div class="font-medium">${esc(l.subject)}</div>
            ${l.errorMessage ? `<div class="text-[11px] text-rose-400 mt-0.5">${esc(l.errorMessage)}</div>` : ''}
          </td>
          <td class="py-2.5 text-[11px] text-slate-400">${esc((l.recipients || []).join(', ') || '—')}</td>
        </tr>
      `;
    })
    .join('');
}

export async function loadAlertsData() {
  try {
    const [cfgRes, logsRes] = await Promise.all([api.getAlertConfig(), api.getAlertLogs(40)]);
    const { smtp, recipients } = cfgRes.data || {};

    if (smtp) {
      document.getElementById('smtp-host').value = smtp.host || '';
      document.getElementById('smtp-port').value = String(smtp.port || 465);
      document.getElementById('smtp-secure').checked = Boolean(smtp.secure);
      document.getElementById('smtp-user').value = smtp.user || '';
      document.getElementById('smtp-pass').value = '';
      document.getElementById('smtp-pass').placeholder = smtp.hasPassword ? '•••••••• (guardada)' : 'Contraseña SMTP';
      document.getElementById('smtp-from-name').value = smtp.fromName || 'PulseGrid Alertas';
      document.getElementById('smtp-from-email').value = smtp.fromEmail || '';

      const badge = document.getElementById('smtp-status-badge');
      if (badge) {
        badge.textContent = smtp.configured ? 'SMTP Configurado' : 'SMTP Pendiente';
        badge.className = smtp.configured
          ? 'text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
          : 'text-[11px] px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30';
      }
    }

    renderRecipients(recipients || []);
    renderLogs(logsRes.data || []);
  } catch (err) {
    showToast(`Error cargando alertas: ${err.message}`, 'error');
  }
}

export function initAlertsModule() {
  document.getElementById('smtp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.saveSmtpConfig({
        host: document.getElementById('smtp-host').value,
        port: Number(document.getElementById('smtp-port').value || 465),
        secure: document.getElementById('smtp-secure').checked,
        user: document.getElementById('smtp-user').value,
        pass: document.getElementById('smtp-pass').value,
        fromName: document.getElementById('smtp-from-name').value,
        fromEmail: document.getElementById('smtp-from-email').value,
      });
      showToast('Configuración SMTP guardada', 'success');
      await loadAlertsData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-test-smtp')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Enviando...';
    try {
      const res = await api.sendTestAlert();
      showToast(`Correo de prueba enviado a ${(res.recipients || []).join(', ')}`, 'success');
      await loadAlertsData();
    } catch (err) {
      showToast(err.message, 'error');
      await loadAlertsData();
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  document.getElementById('recipient-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('rec-name');
    const emailInput = document.getElementById('rec-email');
    try {
      const res = await api.addAlertRecipient({
        name: nameInput.value,
        email: emailInput.value,
        receiveAutomationAlerts: true,
        receiveOfflineAlerts: true,
      });
      nameInput.value = '';
      emailInput.value = '';
      renderRecipients(res.data);
      showToast('Destinatario agregado', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-refresh-alert-logs')?.addEventListener('click', loadAlertsData);

  loadAlertsData();
}

export default { initAlertsModule, loadAlertsData };
