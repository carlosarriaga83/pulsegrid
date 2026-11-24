import api from '../api.js';
import { showToast } from './toast.js';

const ROLE_LABELS = {
  owner: 'Propietario',
  admin: 'Administrador',
  member: 'Miembro',
  viewer: 'Solo lectura',
};

let onAuthSuccessCb = null;
let activeInviteToken = '';
let activeResetToken = '';

function setFeedback(message = '', type = 'error') {
  const box = document.getElementById('auth-feedback');
  if (!box) return;
  if (!message) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = message;
  box.className =
    type === 'success'
      ? 'rounded-xl bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 px-3.5 py-2.5 text-xs'
      : 'rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 px-3.5 py-2.5 text-xs';
}

export function switchAuthMode(mode) {
  setFeedback('');
  const panels = ['login', 'register', 'forgot', 'reset'];
  for (const p of panels) {
    document.getElementById(`auth-panel-${p}`)?.classList.toggle('hidden', p !== mode);
  }
}

export function showAuthScreen({ hasUsers = true } = {}) {
  document.getElementById('app-shell')?.classList.add('hidden');
  const screen = document.getElementById('auth-screen');
  screen?.classList.remove('hidden');
  screen?.classList.add('flex');

  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('resetToken');
  const inviteToken = params.get('inviteToken');

  if (resetToken) {
    activeResetToken = resetToken;
    switchAuthMode('reset');
    return;
  }

  if (inviteToken) {
    activeInviteToken = inviteToken;
    switchAuthMode('register');
    loadInvitePreview(inviteToken);
    return;
  }

  if (!hasUsers) {
    switchAuthMode('register');
    const banner = document.getElementById('auth-invite-banner');
    if (banner) {
      banner.textContent = 'Bienvenido a PulseGrid. Crea tu cuenta de propietario para comenzar a gestionar tus dispositivos.';
      banner.classList.remove('hidden');
    }
  } else {
    switchAuthMode('login');
  }
}

export function hideAuthScreen() {
  const screen = document.getElementById('auth-screen');
  screen?.classList.add('hidden');
  screen?.classList.remove('flex');
  document.getElementById('app-shell')?.classList.remove('hidden');
}

async function loadInvitePreview(token) {
  const banner = document.getElementById('auth-invite-banner');
  const emailInput = document.getElementById('reg-email');
  const accountWrap = document.getElementById('reg-account-wrap');

  try {
    const res = await api.previewInvitation(token);
    const inv = res.data;
    if (banner) {
      banner.textContent = `${inv.invitedByName} te invitó a unirte a "${inv.accountName}" como ${ROLE_LABELS[inv.role] || inv.role}.`;
      banner.classList.remove('hidden');
    }
    if (emailInput) {
      emailInput.value = inv.email;
      emailInput.readOnly = true;
    }
    accountWrap?.classList.add('hidden');
  } catch (err) {
    activeInviteToken = '';
    setFeedback(err.message || 'Invitación inválida o expirada', 'error');
  }
}

function clearUrlTokens() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('resetToken') || url.searchParams.has('inviteToken')) {
    url.searchParams.delete('resetToken');
    url.searchParams.delete('inviteToken');
    window.history.replaceState({}, '', url.pathname);
  }
}

export function initAuthView({ onAuthSuccess }) {
  onAuthSuccessCb = onAuthSuccess;

  document.querySelectorAll('[data-auth-switch]').forEach((btn) => {
    btn.addEventListener('click', () => switchAuthMode(btn.dataset.authSwitch));
  });

  // Login
  document.getElementById('auth-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const res = await api.login({
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      });
      clearUrlTokens();
      hideAuthScreen();
      showToast(`Bienvenido, ${res.data.user.name}`, 'success');
      if (onAuthSuccessCb) onAuthSuccessCb(res.data);
    } catch (err) {
      setFeedback(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Registro
  document.getElementById('auth-register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');
    const pwd = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-password-confirm').value;
    if (pwd !== confirm) {
      setFeedback('Las contraseñas no coinciden', 'error');
      return;
    }

    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const res = await api.register({
        name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        accountName: document.getElementById('reg-account-name').value,
        password: pwd,
        inviteToken: activeInviteToken,
      });
      activeInviteToken = '';
      clearUrlTokens();
      hideAuthScreen();
      showToast(`Cuenta creada. ¡Bienvenido, ${res.data.user.name}!`, 'success');
      if (onAuthSuccessCb) onAuthSuccessCb(res.data);
    } catch (err) {
      setFeedback(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Recuperar contraseña
  document.getElementById('auth-forgot-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const res = await api.forgotPassword(document.getElementById('forgot-email').value);
      setFeedback(res.message || 'Revisa tu correo para restablecer tu contraseña.', 'success');
    } catch (err) {
      setFeedback(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Restablecer contraseña
  document.getElementById('auth-reset-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');
    const pwd = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password-confirm').value;
    if (pwd !== confirm) {
      setFeedback('Las contraseñas no coinciden', 'error');
      return;
    }

    const btn = e.currentTarget.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const res = await api.resetPassword({ token: activeResetToken, newPassword: pwd });
      activeResetToken = '';
      clearUrlTokens();
      switchAuthMode('login');
      setFeedback(res.message || 'Contraseña actualizada. Ahora inicia sesión.', 'success');
    } catch (err) {
      setFeedback(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export default { initAuthView, showAuthScreen, hideAuthScreen, switchAuthMode };
