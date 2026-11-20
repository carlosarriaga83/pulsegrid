/**
 * Sistema de notificaciones Toast (feedback inmediato, baja carga cognitiva)
 */

const STYLES = {
  success: 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200',
  error: 'bg-rose-950/90 border-rose-500/40 text-rose-200',
  warning: 'bg-amber-950/90 border-amber-500/40 text-amber-200',
  info: 'bg-slate-900/95 border-slate-700 text-slate-200',
};

const DOTS = {
  success: 'bg-emerald-400',
  error: 'bg-rose-400',
  warning: 'bg-amber-400',
  info: 'bg-sky-400',
};

export function showToast(message, type = 'info', durationMs = 3200) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `pg-toast flex items-center gap-2.5 px-4 py-2.5 rounded-xl border text-xs font-medium shadow-xl backdrop-blur-md ${STYLES[type] || STYLES.info}`;
  toast.innerHTML = `
    <span class="h-2 w-2 rounded-full flex-shrink-0 ${DOTS[type] || DOTS.info}"></span>
    <span class="leading-snug"></span>
  `;
  toast.querySelector('span:last-child').textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

export default { showToast };
