(() => {
  const INTENSITY_KEY = 'allstars_visual_intensity';
  const MODES = new Set(['low', 'medium', 'ultra']);

  function resolveInitialMode() {
    const urlMode = new URLSearchParams(window.location.search).get('vi');
    if (urlMode && MODES.has(urlMode)) return urlMode;

    const stored = localStorage.getItem(INTENSITY_KEY);
    if (stored && MODES.has(stored)) return stored;

    const lowHardware = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
      || (navigator.deviceMemory && navigator.deviceMemory <= 4);

    return lowHardware ? 'low' : 'medium';
  }

  function setVisualIntensity(mode, persist = true) {
    const nextMode = MODES.has(mode) ? mode : 'medium';
    document.body.dataset.visualIntensity = nextMode;

    if (persist) {
      localStorage.setItem(INTENSITY_KEY, nextMode);
    }

    return nextMode;
  }

  function initVisualV2() {
    const main = document.querySelector('.main');
    if (!main) return;

    document.body.classList.add('v2-enabled');
    setVisualIntensity(resolveInitialMode(), false);

    window.setVisualIntensity = mode => setVisualIntensity(mode, true);
    window.getVisualIntensity = () => document.body.dataset.visualIntensity || 'medium';

    const currentMode = document.body.dataset.visualIntensity || 'medium';
    if (currentMode === 'low') return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const revealCandidates = Array.from(main.children).filter(node => {
      if (!(node instanceof HTMLElement)) return false;
      if (!node.offsetParent && getComputedStyle(node).position !== 'fixed') return false;
      return true;
    });

    const step = parseFloat(getComputedStyle(document.body).getPropertyValue('--v2-reveal-step')) || 0.06;

    revealCandidates.forEach((node, idx) => {
      node.classList.add('v2-reveal');
      node.style.setProperty('--v2-delay', `${(idx * step).toFixed(2)}s`);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVisualV2);
  } else {
    initVisualV2();
  }
})();
