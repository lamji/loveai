// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// Themed alert / confirm — never the native dialog, which ignores the theme
// ============================================================
const alertModal = document.getElementById('alert-modal');
let alertResolve = null;

function closeAlert(result) {
  alertModal.classList.add('hidden');
  const r = alertResolve;
  alertResolve = null;
  if (r) r(result);
}

// returns true if the user confirmed. Omit cancelText for a plain notice.
// work: async fn — run INSIDE the modal on OK: buttons lock, the OK button shows
// workingText until it finishes, then the modal closes resolving work's result.
let alertBusy = false;
function showAlert({ title, message, okText = 'OK', cancelText = null, kind = 'warn', work = null, workingText = '⏳ WORKING…' }) {
  const card = alertModal.querySelector('.modal-card');
  card.className = 'modal-card alert-card ' + kind;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-msg').textContent = message;

  const ok = document.getElementById('alert-ok');
  const cancel = document.getElementById('alert-cancel');
  ok.textContent = okText;
  ok.disabled = false; cancel.disabled = false;
  ok.className = 'btn ' + (kind === 'danger' ? 'btn-danger' : 'btn-launch');
  cancel.textContent = cancelText || 'CANCEL';
  cancel.classList.toggle('hidden', !cancelText);

  ok.onclick = async () => {
    if (!work) { closeAlert(true); return; }
    alertBusy = true;
    ok.disabled = true; cancel.disabled = true;
    ok.textContent = workingText;
    ok.classList.add('btn-working');
    let res;
    try { res = await work(); } catch (e) { res = { ok: false, error: String(e && e.message ? e.message : e) }; }
    alertBusy = false;
    ok.classList.remove('btn-working');
    closeAlert(res === undefined ? true : res);
  };
  cancel.onclick = () => { if (!alertBusy) closeAlert(false); };

  alertModal.classList.remove('hidden');
  ok.focus();
  return new Promise(res => { alertResolve = res; });
}

alertModal.addEventListener('click', e => { if (e.target === alertModal && !alertBusy) closeAlert(false); });

