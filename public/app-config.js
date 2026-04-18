(function () {
  const STORAGE_KEY = 'allstars_api_base';

  function normalizeBase(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function getStoredBase() {
    try {
      return normalizeBase(localStorage.getItem(STORAGE_KEY));
    } catch {
      return '';
    }
  }

  function setStoredBase(value) {
    const next = normalizeBase(value);

    try {
      if (next) {
        localStorage.setItem(STORAGE_KEY, next);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors (private mode or disabled storage).
    }

    return next;
  }

  const queryBase = normalizeBase(new URLSearchParams(window.location.search).get('apiBase'));
  if (queryBase) {
    setStoredBase(queryBase);
  }

  function getApiBase() {
    const fromWindow = normalizeBase(window.ALLSTARS_API_BASE);
    if (fromWindow) return fromWindow;

    return getStoredBase();
  }

  function resolveApiPath(path) {
    const source = String(path || '');

    if (!source) return source;
    if (/^https?:\/\//i.test(source)) return source;

    const base = getApiBase();
    if (!base) return source;

    if (source.startsWith('/')) {
      return base + source;
    }

    return base + '/' + source;
  }

  window.AllStarsConfig = {
    getApiBase,
    setApiBase: setStoredBase,
    clearApiBase: function () {
      return setStoredBase('');
    },
    resolveApiPath
  };
})();
