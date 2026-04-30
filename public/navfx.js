(() => {
  function isLiteEnvironment() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    if (window.matchMedia('(pointer: coarse)').matches) return true;

    const lowHardware = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
      || (navigator.deviceMemory && navigator.deviceMemory <= 4);

    const forcedLite = new URLSearchParams(window.location.search).get('litefx') === '1'
      || localStorage.getItem('allstars_lite_fx') === '1';

    return lowHardware || forcedLite;
  }

  // SVG icon map keyed by href filename or label substring
  const NAV_SVG_ICONS = {
    'index.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
    'candidates.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    'referrals.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    'interviews.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    'dashboard.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    'team-dashboard.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
    'transaction-endings.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    'hr-needs.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    'team.html': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    '__logout__': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  };

  function getNavSvg(item) {
    const href = (item.getAttribute('href') || '').replace(/^\//, '');
    if (NAV_SVG_ICONS[href]) return NAV_SVG_ICONS[href];

    // Fallback: detect logout by text
    const text = (item.textContent || '').trim().toLowerCase();
    if (text.includes('выйти') || text.includes('logout') || text.includes('exit')) {
      return NAV_SVG_ICONS['__logout__'];
    }

    // Generic fallback: circle with dot
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>';
  }

  function ensureNavStructure(sidebar) {
    const items = Array.from(sidebar.querySelectorAll('.nav-item'));

    const isEmojiLikeToken = token => /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(token || '');

    items.forEach((item, idx) => {
      item.style.setProperty('--delay', `${0.03 + idx * 0.04}s`);

      const existingIcon = item.querySelector('.nav-icon');

      if (existingIcon) {
        // Replace emoji/old content with SVG
        existingIcon.innerHTML = getNavSvg(item);
        existingIcon.setAttribute('aria-hidden', 'true');
        // Ensure dot exists
        if (!item.querySelector('.nav-dot')) {
          const dot = document.createElement('span');
          dot.className = 'nav-dot';
          item.appendChild(dot);
        }
        return;
      }

      const raw = item.textContent || '';
      const text = raw.trim().replace(/\s+/g, ' ');
      if (!text) return;

      // Strip leading emoji token if present
      const firstSpace = text.indexOf(' ');
      const token = firstSpace > 0 ? text.slice(0, firstSpace) : text;
      const hasEmojiToken = firstSpace > 0 && isEmojiLikeToken(token);
      const labelText = hasEmojiToken ? text.slice(firstSpace + 1).trim() : text;

      const icon = document.createElement('span');
      icon.className = 'nav-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = getNavSvg(item);

      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = labelText;

      const dot = document.createElement('span');
      dot.className = 'nav-dot';

      item.textContent = '';
      item.appendChild(icon);
      item.appendChild(label);
      item.appendChild(dot);
    });
  }

  function bindInteractiveTilt(sidebar) {
    if (isLiteEnvironment()) return;

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
    if (brandMark && !brandMark.querySelector('.brand-svg-mark')) {
      brandMark.textContent = '';

      // Premium SVG logo mark: geometric 4-point star inside a circle ring
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.classList.add('brand-svg-mark');
      svg.setAttribute('viewBox', '0 0 32 32');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');

      const defs = document.createElementNS(svgNS, 'defs');

      const grad1 = document.createElementNS(svgNS, 'linearGradient');
      grad1.id = 'bm-g1';
      grad1.setAttribute('x1', '0'); grad1.setAttribute('y1', '0');
      grad1.setAttribute('x2', '1'); grad1.setAttribute('y2', '1');
      const s1a = document.createElementNS(svgNS, 'stop');
      s1a.setAttribute('offset', '0%'); s1a.setAttribute('stop-color', '#c4b5fd');
      const s1b = document.createElementNS(svgNS, 'stop');
      s1b.setAttribute('offset', '100%'); s1b.setAttribute('stop-color', '#38bdf8');
      grad1.appendChild(s1a); grad1.appendChild(s1b);

      const grad2 = document.createElementNS(svgNS, 'linearGradient');
      grad2.id = 'bm-g2';
      grad2.setAttribute('x1', '0'); grad2.setAttribute('y1', '0');
      grad2.setAttribute('x2', '1'); grad2.setAttribute('y2', '1');
      const s2a = document.createElementNS(svgNS, 'stop');
      s2a.setAttribute('offset', '0%'); s2a.setAttribute('stop-color', 'rgba(196,181,253,0.3)');
      const s2b = document.createElementNS(svgNS, 'stop');
      s2b.setAttribute('offset', '100%'); s2b.setAttribute('stop-color', 'rgba(56,189,248,0.15)');
      grad2.appendChild(s2a); grad2.appendChild(s2b);

      defs.appendChild(grad1); defs.appendChild(grad2);
      svg.appendChild(defs);

      // Outer circle ring
      const ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('cx', '16'); ring.setAttribute('cy', '16'); ring.setAttribute('r', '13');
      ring.setAttribute('stroke', 'url(#bm-g1)'); ring.setAttribute('stroke-width', '1.5');
      ring.setAttribute('fill', 'url(#bm-g2)');
      svg.appendChild(ring);

      // 4-point star path: elegant diamond star
      const star = document.createElementNS(svgNS, 'path');
      star.setAttribute('d', 'M16 5L17.6 14.4L27 16L17.6 17.6L16 27L14.4 17.6L5 16L14.4 14.4Z');
      star.setAttribute('fill', 'url(#bm-g1)');
      svg.appendChild(star);

      // Center dot
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', '16'); dot.setAttribute('cy', '16'); dot.setAttribute('r', '2');
      dot.setAttribute('fill', '#fff'); dot.setAttribute('opacity', '0.9');
      svg.appendChild(dot);

      brandMark.appendChild(svg);
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

    if (isLiteEnvironment()) return;

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

    if (isLiteEnvironment()) {
      sidebar.classList.add('navfx-lite');
    }

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
