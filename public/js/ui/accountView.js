import api from '../api.js';
import { showToast } from './toast.js';
import { formatDateTime } from '../utils/formatters.js';

const ROLE_LABELS = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
  viewer: 'Solo lectura',
};

const INVITE_STATUS_BADGES = {
  pending: '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">Pendiente</span>',
  accepted: '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Aceptada</span>',
  revoked: '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">Revocada</span>',
  expired: '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">Expirada</span>',
};

let currentOverview = null;
let onProfileUpdatedCb = null;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMembers(members = [], canManage = false, myUserId = null) {
  const tbody = document.getElementById('account-members-tbody');
  if (!tbody) return;

  if (members.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-xs text-slate-500">Sin miembros</td></tr>';
    return;
  }

  tbody.innerHTML = members
    .map((m) => {
      const isOwner = m.role === 'owner';
      const isMe = m.userId === myUserId;
      const roleCell =
        canManage && !isOwner && !isMe
          ? `<select data-member-role="${m.userId}" class="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1 text-xs text-slate-100">
               <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Administrador</option>
               <option value="member" ${m.role === 'member' ? 'selected' : ''}>Miembro</option>
               <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Solo lectura</option>
             </select>`
          : `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-500/10 text-sky-300 border border-sky-500/30">${esc(ROLE_LABELS[m.role] || m.role)}</span>`;

      const actionCell =
        canManage && !isOwner && !isMe
          ? `<button type="button" data-remove-member="${m.userId}" class="px-2.5 py-1 rounded-lg text-[11px] text-rose-400 hover:bg-rose-950/60 border border-slate-800">Remover</button>`
          : isMe
            ? '<span class="text-[11px] text-slate-500">Tú</span>'
            : '<span class="text-[11px] text-slate-500">—</span>';

      return `
        <tr class="border-t border-slate-800/80 text-xs">
          <td class="py-2.5 pr-3">
            <div class="font-medium text-slate-100">${esc(m.name)}</div>
            <div class="text-[11px] font-mono text-slate-400">${esc(m.email)}</div>
          </td>
          <td class="py-2.5 pr-3">${roleCell}</td>
          <td class="py-2.5 pr-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">${m.lastLoginAt ? formatDateTime(m.lastLoginAt) : '—'}</td>
          <td class="py-2.5 text-right">${actionCell}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('[data-member-role]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        const res = await api.updateMemberRole(sel.dataset.memberRole, sel.value);
        renderMembers(res.data, canManage, myUserId);
        showToast('Rol de usuario actualizado', 'success');
      } catch (err) {
        showToast(err.message, 'error');
        loadAccountData();
      }
    });
  });

  tbody.querySelectorAll('[data-remove-member]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('¿Remover a este usuario de la cuenta?')) return;
      try {
        const res = await api.removeMember(btn.dataset.removeMember);
        renderMembers(res.data, canManage, myUserId);
        showToast('Usuario removido de la cuenta', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function renderInvitations(invitations = []) {
  const tbody = document.getElementById('account-invitations-tbody');
  if (!tbody) return;

  if (invitations.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-xs text-slate-500 italic">No hay invitaciones enviadas todavía.</td></tr>';
    return;
  }

  tbody.innerHTML = invitations
    .map((inv) => {
      const badge = INVITE_STATUS_BADGES[inv.status] || inv.status;
      const action =
        inv.status === 'pending'
          ? `<button type="button" data-revoke-invite="${inv.id}" class="px-2.5 py-1 rounded-lg text-[11px] text-rose-400 hover:bg-rose-950/60 border border-slate-800">Revocar</button>`
          : '<span class="text-[11px] text-slate-500">—</span>';

      return `
        <tr class="border-t border-slate-800/80 text-xs">
          <td class="py-2.5 pr-3 font-mono text-[11px] text-slate-200">${esc(inv.email)}</td>
          <td class="py-2.5 pr-3 text-slate-300">${esc(ROLE_LABELS[inv.role] || inv.role)}</td>
          <td class="py-2.5 pr-3">${badge}</td>
          <td class="py-2.5 pr-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">${formatDateTime(inv.expiresAt)}</td>
          <td class="py-2.5 text-right">${action}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('[data-revoke-invite]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api.revokeInvitation(btn.dataset.revokeInvite);
        renderInvitations(res.data);
        showToast('Invitación revocada', 'info');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function renderTuyaCard(tuya) {
  const card = document.getElementById('acc-tuya-card');
  if (!card) return;
  if (!tuya) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('acc-tuya-baseurl').value = tuya.baseUrl || 'https://openapi.tuyaus.com';
  document.getElementById('acc-tuya-key').value = tuya.accessKey || '';
  document.getElementById('acc-tuya-uid').value = tuya.userUid || '';
  const secretInput = document.getElementById('acc-tuya-secret');
  if (secretInput) {
    secretInput.value = '';
    secretInput.placeholder = tuya.hasSecretKey ? '•••••••• (guardado)' : 'Tuya Access Secret';
  }

  const badge = document.getElementById('acc-tuya-status-badge');
  const meta = document.getElementById('acc-tuya-meta');
  const feedback = document.getElementById('acc-tuya-feedback');
  const st = tuya.status || {};

  if (!tuya.configured) {
    badge.textContent = 'Pendiente de configurar';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30';
    meta.textContent = 'Sin credenciales guardadas (puedes definirlas aquí o en .env)';
    feedback?.classList.add('hidden');
  } else if (st.lastSyncError) {
    badge.textContent = 'Error de conexión';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30';
    meta.textContent = `Origen: ${tuya.source === 'database' ? 'Cuenta web' : '.env'} · Último error: ${formatDateTime(st.lastSyncError.at)}`;
    if (feedback) {
      feedback.textContent = st.lastSyncError.message;
      feedback.className = 'rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 px-3.5 py-2.5 text-xs';
    }
  } else if (st.lastSyncAt) {
    badge.textContent = `Conectado (${st.tuyaDeviceCount || st.cachedDevices || 0} equipos)`;
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
    meta.textContent = `Origen: ${tuya.source === 'database' ? 'Cuenta web' : '.env'} · Último sync: ${formatDateTime(st.lastSyncAt)}`;
    feedback?.classList.add('hidden');
  } else {
    badge.textContent = 'Configurado (sin verificar)';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30';
    meta.textContent = `Origen: ${tuya.source === 'database' ? 'Cuenta web' : '.env'} · Haz clic en "Verificar conexión" para probar tus claves`;
    feedback?.classList.add('hidden');
  }
}

function renderMysaCard(mysa) {
  const card = document.getElementById('acc-mysa-card');
  if (!card) return;
  if (!mysa) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('acc-mysa-username').value = mysa.username || '';
  const passInput = document.getElementById('acc-mysa-password');
  if (passInput) {
    passInput.value = '';
    passInput.placeholder = mysa.hasPassword ? '•••••••• (guardada)' : 'Contraseña Mysa';
  }
  document.getElementById('acc-mysa-realtime').checked = Boolean(mysa.realtimeEnabled);

  const badge = document.getElementById('acc-mysa-status-badge');
  const meta = document.getElementById('acc-mysa-meta');
  const feedback = document.getElementById('acc-mysa-feedback');
  const st = mysa.status || {};

  if (!mysa.configured) {
    badge.textContent = 'Pendiente de configurar';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30';
    meta.textContent = 'Sin credenciales guardadas (puedes definirlas aquí o en .env)';
    feedback?.classList.add('hidden');
  } else if (st.lastSyncError) {
    badge.textContent = 'Error de conexión';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30';
    meta.textContent = `Origen: ${mysa.source === 'database' ? 'Cuenta web' : '.env'} · Último error: ${formatDateTime(st.lastSyncError.at)}`;
    if (feedback) {
      feedback.textContent = st.lastSyncError.message;
      feedback.className = 'rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 px-3.5 py-2.5 text-xs';
    }
  } else if (st.authenticated || st.lastSyncAt) {
    badge.textContent = `Conectado (${st.deviceCount || 0} termostato${st.deviceCount === 1 ? '' : 's'})`;
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
    meta.textContent = `Origen: ${mysa.source === 'database' ? 'Cuenta web' : '.env'} · MQTT activo: ${st.realtimeSubscriptions || 0} · Último sync: ${st.lastSyncAt ? formatDateTime(st.lastSyncAt) : '—'}`;
    feedback?.classList.add('hidden');
  } else {
    badge.textContent = 'Configurado (sin verificar)';
    badge.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30';
    meta.textContent = `Origen: ${mysa.source === 'database' ? 'Cuenta web' : '.env'} · Haz clic en "Verificar conexión" para probar tus credenciales`;
    feedback?.classList.add('hidden');
  }
}

export async function loadAccountData() {
  try {
    const res = await api.getAccount();
    currentOverview = res.data;
    const { user, account, role, members, invitations, mysa, tuya } = currentOverview;
    const canManage = role === 'owner' || role === 'admin';

    document.getElementById('acc-profile-name').value = user.name || '';
    document.getElementById('acc-profile-email').value = user.email || '';
    document.getElementById('acc-account-name').value = account.name || '';
    document.getElementById('acc-role-badge').textContent = ROLE_LABELS[role] || role;

    document.getElementById('acc-details-card')?.classList.toggle('hidden', !canManage);
    document.getElementById('acc-invite-card')?.classList.toggle('hidden', !canManage);
    document.getElementById('acc-invitations-card')?.classList.toggle('hidden', !canManage);
    renderTuyaCard(canManage ? tuya : null);
    renderMysaCard(canManage ? mysa : null);

    renderMembers(members, canManage, user.id);
    if (canManage) renderInvitations(invitations);
  } catch (err) {
    showToast(`Error cargando cuenta: ${err.message}`, 'error');
  }
}

export function initAccountModule({ onProfileUpdated }) {
  onProfileUpdatedCb = onProfileUpdated;

  // Actualizar perfil
  document.getElementById('acc-profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api.updateProfile({
        name: document.getElementById('acc-profile-name').value,
        email: document.getElementById('acc-profile-email').value,
      });
      showToast('Perfil actualizado', 'success');
      if (onProfileUpdatedCb) onProfileUpdatedCb({ user: res.data });
      loadAccountData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Cambiar contraseña
  document.getElementById('acc-password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('acc-current-password').value;
    const newPassword = document.getElementById('acc-new-password').value;
    const confirmPassword = document.getElementById('acc-confirm-password').value;
    if (newPassword !== confirmPassword) {
      showToast('Las contraseñas nuevas no coinciden', 'warning');
      return;
    }
    try {
      await api.changePassword({ currentPassword, newPassword });
      e.currentTarget.reset();
      showToast('Contraseña actualizada correctamente', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Actualizar nombre de cuenta
  document.getElementById('acc-details-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api.updateAccountDetails(document.getElementById('acc-account-name').value);
      showToast('Nombre de cuenta actualizado', 'success');
      if (onProfileUpdatedCb) onProfileUpdatedCb({ account: res.data });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Guardar credenciales Tuya
  document.getElementById('acc-tuya-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api.saveTuyaConfig({
        baseUrl: document.getElementById('acc-tuya-baseurl').value,
        accessKey: document.getElementById('acc-tuya-key').value,
        secretKey: document.getElementById('acc-tuya-secret').value,
        userUid: document.getElementById('acc-tuya-uid').value,
      });
      renderTuyaCard(res.data);
      showToast('Credenciales Tuya guardadas. Ahora pulsa "Verificar conexión".', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Verificar conexión con Tuya
  document.getElementById('btn-verify-tuya')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const feedback = document.getElementById('acc-tuya-feedback');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Verificando...';
    try {
      const res = await api.verifyTuya();
      if (res.config) renderTuyaCard(res.config);
      if (feedback) {
        feedback.textContent = res.message || 'Conexión con Tuya verificada correctamente';
        feedback.className = 'rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 px-3.5 py-2.5 text-xs';
      }
      showToast(res.message || 'Conexión Tuya verificada', 'success');
    } catch (err) {
      await loadAccountData();
      if (feedback) {
        feedback.textContent = err.message || 'Credenciales incorrectas o error de conexión con Tuya';
        feedback.className = 'rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 px-3.5 py-2.5 text-xs';
      }
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Guardar credenciales Mysa
  document.getElementById('acc-mysa-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api.saveMysaConfig({
        username: document.getElementById('acc-mysa-username').value,
        password: document.getElementById('acc-mysa-password').value,
        realtimeEnabled: document.getElementById('acc-mysa-realtime').checked,
      });
      renderMysaCard(res.data);
      showToast('Credenciales Mysa guardadas. Ahora pulsa "Verificar conexión".', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Verificar conexión con Mysa
  document.getElementById('btn-verify-mysa')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const feedback = document.getElementById('acc-mysa-feedback');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Verificando...';
    try {
      const res = await api.verifyMysa();
      if (res.config) renderMysaCard(res.config);
      if (feedback) {
        feedback.textContent = res.message || 'Conexión con Mysa verificada correctamente';
        feedback.className = 'rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 px-3.5 py-2.5 text-xs';
      }
      showToast(res.message || 'Conexión Mysa verificada', 'success');
    } catch (err) {
      await loadAccountData();
      if (feedback) {
        feedback.textContent = err.message || 'Credenciales incorrectas o error de conexión con Mysa';
        feedback.className = 'rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 px-3.5 py-2.5 text-xs';
      }
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // Invitar usuario
  document.getElementById('acc-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailEl = document.getElementById('acc-invite-email');
    const roleEl = document.getElementById('acc-invite-role');
    const linkBox = document.getElementById('acc-invite-link-box');
    const linkInput = document.getElementById('acc-invite-link-input');

    try {
      const res = await api.inviteUser({ email: emailEl.value, role: roleEl.value });
      const data = res.data;
      emailEl.value = '';

      if (data.addedDirectly) {
        linkBox?.classList.add('hidden');
        showToast(data.message, 'success');
      } else {
        if (linkBox && linkInput && data.inviteUrl) {
          linkInput.value = data.inviteUrl;
          linkBox.classList.remove('hidden');
        }
        showToast(
          data.emailSent
            ? 'Invitación enviada por correo electrónico'
            : 'Invitación creada (copia y comparte el enlace)',
          'success'
        );
      }

      const canManage = currentOverview?.role === 'owner' || currentOverview?.role === 'admin';
      renderMembers(data.members || [], canManage, currentOverview?.user?.id);
      renderInvitations(data.invitations || []);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Copiar enlace de invitación
  document.getElementById('btn-copy-invite-link')?.addEventListener('click', async () => {
    const val = document.getElementById('acc-invite-link-input')?.value;
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showToast('Enlace de invitación copiado al portapapeles', 'success');
    } catch {
      document.getElementById('acc-invite-link-input')?.select();
      document.execCommand('copy');
      showToast('Enlace copiado', 'success');
    }
  });
}

export default { initAccountModule, loadAccountData };
