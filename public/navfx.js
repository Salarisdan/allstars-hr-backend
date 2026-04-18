(() => {
  function ensureNavStructure(sidebar) {
    const items = Array.from(sidebar.querySelectorAll('.nav-item'));

    const isEmojiLikeToken = token => /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(token || '');

    items.forEach((item, idx) => {
      item.style.setProperty('--delay', `${0.03 + idx * 0.04}s`);
      if (item.querySelector('.nav-icon')) return;

      const raw = item.textContent || '';
      const text = raw.trim().replace(/\s+/g, ' ');
      if (!text) return;

      const firstSpace = text.indexOf(' ');
      const token = firstSpace > 0 ? text.slice(0, firstSpace) : text;
      const hasEmojiToken = firstSpace > 0 && isEmojiLikeToken(token);

      if (!hasEmojiToken) {
        const label = document.createElement('span');
        label.className = 'nav-label';
        label.textContent = text;
        item.textContent = '';
        item.appendChild(label);
        return;
      }

      const icon = document.createElement('span');
      icon.className = 'nav-icon';
      icon.textContent = token;

      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = text.slice(firstSpace + 1).trim();

      const dot = document.createElement('span');
      dot.className = 'nav-dot';

      item.textContent = '';
      item.appendChild(icon);
      item.appendChild(label);
      item.appendChild(dot);
    });
  }

  function bindInteractiveTilt(sidebar) {
    const items = Array.from(sidebar.querySelectorAll('.nav-item'));

    items.forEach(item => {
      item.addEventListener('mousemove', event => {
        if (window.matchMedia('(pointer: coarse)').matches) return;

        const rect = item.getBoundingClientRect();
        const px = ((event.clientX - rect.left) / rect.width) - 0.5;
        const py = ((event.clientY - rect.top) / rect.height) - 0.5;

        item.style.setProperty('--tilt-x', `${(-py * 4).toFixed(2)}deg`);
        item.style.setProperty('--tilt-y', `${(px * 5).toFixed(2)}deg`);
      });

      item.addEventListener('mouseleave', () => {
        item.style.setProperty('--tilt-x', '0deg');
        item.style.setProperty('--tilt-y', '0deg');
      });
    });
  }

  function init() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    ensureNavStructure(sidebar);
    bindInteractiveTilt(sidebar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
