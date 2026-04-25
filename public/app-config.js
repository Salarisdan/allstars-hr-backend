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

/* ─── DEBOUNCE UTILITY ─────────────────────────────────────────── */
function debounce(fn, ms = 300) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), ms);
  };
}

window.debounce = debounce;

/* ─── CACHE UTILITY ────────────────────────────────────────────── */
const apiCache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function getCacheKey(path, options = {}) {
  return `${path}:${JSON.stringify(options || {})}`;
}

function getFromCache(key) {
  const cached = apiCache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.time > CACHE_TTL) {
    apiCache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCache(key, data) {
  apiCache.set(key, { data, time: Date.now() });
}

function clearCache() {
  apiCache.clear();
}

window.getFromCache = getFromCache;
window.setCache = setCache;
window.clearCache = clearCache;
window.getCacheKey = getCacheKey;

/* ─── CACHED API WRAPPER ───────────────────────────────────────── */
window.cachedApi = async function(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  
  // Only cache GET requests without body
  if (method === 'GET' && !options.body) {
    const cacheKey = getCacheKey(path, options);
    const cached = getFromCache(cacheKey);
    
    if (cached) {
      // Return a Response-like object from cache
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Fetch and cache
    const response = await api(path, options);
    if (response.ok) {
      try {
        const data = await response.clone().json();
        setCache(cacheKey, data);
        return response;
      } catch {
        return response;
      }
    }
    return response;
  }
  
  // For non-GET or requests with body, just call api directly
  return api(path, options);
};
