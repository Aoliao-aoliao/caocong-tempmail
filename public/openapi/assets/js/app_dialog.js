(() => {
  if (window.NodeMailDialog) return;
  let active = null;

  const closeActive = (value) => {
    if (!active) return;
    const { root, resolve, previousFocus } = active;
    active = null;
    root.remove();
    document.body.classList.remove('nm-dialog-open');
    previousFocus?.focus?.();
    resolve(value);
  };

  const open = (message, options = {}, confirmMode = false) => {
    if (active) closeActive(false);
    const previousFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'nm-dialog';
    root.innerHTML = `
      <button class="nm-dialog-backdrop" type="button" aria-label="关闭"></button>
      <section class="nm-dialog-card" role="dialog" aria-modal="true" aria-labelledby="nmDialogTitle">
        <button class="nm-dialog-close" type="button" aria-label="关闭">×</button>
        <span class="nm-dialog-eyebrow">${options.eyebrow || 'NODEMAIL 提示'}</span>
        <h2 id="nmDialogTitle"></h2>
        <p class="nm-dialog-message"></p>
        <div class="nm-dialog-actions"></div>
      </section>`;
    root.querySelector('h2').textContent = options.title || (confirmMode ? '请确认操作' : '操作提示');
    root.querySelector('.nm-dialog-message').textContent = String(message || '');
    const actions = root.querySelector('.nm-dialog-actions');
    if (confirmMode) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'nm-dialog-cancel';
      cancel.textContent = options.cancelText || '取消';
      cancel.addEventListener('click', () => closeActive(false));
      actions.append(cancel);
    }
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = `nm-dialog-confirm${options.tone === 'danger' ? ' danger' : ''}`;
    confirm.textContent = options.confirmText || '确定';
    confirm.addEventListener('click', () => closeActive(true));
    actions.append(confirm);
    root.querySelectorAll('.nm-dialog-backdrop,.nm-dialog-close').forEach((el) => el.addEventListener('click', () => closeActive(false)));
    document.body.append(root);
    document.body.classList.add('nm-dialog-open');
    return new Promise((resolve) => {
      active = { root, resolve, previousFocus };
      confirm.focus();
    });
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) closeActive(false);
  });
  window.NodeMailDialog = {
    alert: (message, options) => open(message, options, false),
    confirm: (message, options) => open(message, options, true),
  };
})();
