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

  function ensureBrandStructure(sidebar) {
    const logo = sidebar.querySelector('.sidebar-logo');
    if (!logo) return null;

    const brandMark = logo.querySelector('.brand-mark');
    if (brandMark && !brandMark.querySelector('.brand-star')) {
      const raw = (brandMark.textContent || '').trim() || '✦';
      brandMark.textContent = '';
      const star = document.createElement('span');
      star.className = 'brand-star';
      star.textContent = raw;
      brandMark.appendChild(star);
    }

    if (!logo.querySelector('.brand-sparkles')) {
      const sparkles = document.createElement('div');
      sparkles.className = 'brand-sparkles';
      sparkles.setAttribute('aria-hidden', 'true');

      const dots = [
        { x: '12%', y: '23%', delay: '.1s', size: '2px' },
        { x: '28%', y: '14%', delay: '.62s', size: '2.4px' },
        { x: '48%', y: '30%', delay: '1.14s', size: '2px' },
        { x: '66%', y: '22%', delay: '1.66s', size: '2.8px' },
        { x: '82%', y: '18%', delay: '2.2s', size: '2px' }
      ];

      dots.forEach(dot => {
        const el = document.createElement('span');
        el.style.setProperty('--x', dot.x);
        el.style.setProperty('--y', dot.y);
        el.style.setProperty('--delay', dot.delay);
        el.style.setProperty('--size', dot.size);
        sparkles.appendChild(el);
      });

      const sub = logo.querySelector('.sub');
      if (sub) {
        logo.insertBefore(sparkles, sub);
      } else {
        logo.appendChild(sparkles);
      }
    }

    if (!logo.querySelector('.brand-shooting-star')) {
      const shootingStar = document.createElement('span');
      shootingStar.className = 'brand-shooting-star';
      logo.appendChild(shootingStar);
    }

    return logo;
  }

  function bindBrandEffects(sidebar) {
    const logo = ensureBrandStructure(sidebar);
    if (!logo || logo.dataset.navfxBrandReady === '1') return;
    logo.dataset.navfxBrandReady = '1';

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const brandMark = logo.querySelector('.brand-mark');
    const shootingStar = logo.querySelector('.brand-shooting-star');

    logo.addEventListener('pointermove', event => {
      if (window.matchMedia('(pointer: coarse)').matches) return;

      const rect = logo.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width;
      const py = (event.clientY - rect.top) / rect.height;
      const clampedX = Math.max(0, Math.min(1, px));
      const clampedY = Math.max(0, Math.min(1, py));

      logo.style.setProperty('--mx', `${(clampedX * 100).toFixed(2)}%`);
      logo.style.setProperty('--my', `${(clampedY * 100).toFixed(2)}%`);

      if (brandMark) {
        const tiltX = (0.5 - clampedY) * 5;
        const tiltY = (clampedX - 0.5) * 7;
        brandMark.style.transform = `translateZ(0) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;
      }
    });

    logo.addEventListener('pointerleave', () => {
      logo.style.setProperty('--mx', '50%');
      logo.style.setProperty('--my', '50%');
      if (brandMark) brandMark.style.transform = 'translateZ(0)';
    });

    const triggerComet = () => {
      if (!shootingStar) return;
      const nextTop = 14 + Math.random() * 28;
      shootingStar.style.top = `${nextTop.toFixed(1)}px`;
      shootingStar.classList.remove('is-active');
      void shootingStar.offsetWidth;
      shootingStar.classList.add('is-active');
    };

    setInterval(triggerComet, 4200);
  }

  function init() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    ensureNavStructure(sidebar);
    bindInteractiveTilt(sidebar);
    bindBrandEffects(sidebar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
