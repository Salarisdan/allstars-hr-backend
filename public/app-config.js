(function () {
  const STORAGE_KEY = 'allstars_api_base';
  const TOKEN_KEY = 'allstars_token';
  const ME_KEY = 'allstars_me';
  const AUTH_BYPASS_FLAG_KEY = 'allstars_auth_bypass_enabled';
  const AUTH_BYPASS_TOKEN = 'allstars-bypass-token';

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

  function seedBypassSession() {
    try {
      localStorage.setItem(AUTH_BYPASS_FLAG_KEY, '1');
      if (!String(localStorage.getItem(TOKEN_KEY) || '').trim()) {
        localStorage.setItem(TOKEN_KEY, AUTH_BYPASS_TOKEN);
      }

      if (!String(localStorage.getItem(ME_KEY) || '').trim()) {
        localStorage.setItem(ME_KEY, JSON.stringify({
          id: -2,
          agency_id: 1,
          full_name: 'Bypass Access',
          email: 'bypass@allstars.local',
          role: 'owner',
          authMode: 'bypass'
        }));
      }
    } catch {
      // Ignore storage errors.
    }
  }

  function clearBypassSession() {
    try {
      localStorage.removeItem(AUTH_BYPASS_FLAG_KEY);
      if (String(localStorage.getItem(TOKEN_KEY) || '').trim() === AUTH_BYPASS_TOKEN) {
        localStorage.removeItem(TOKEN_KEY);
      }
      const rawMe = String(localStorage.getItem(ME_KEY) || '').trim();
      if (rawMe && rawMe.includes('"authMode":"bypass"')) {
        localStorage.removeItem(ME_KEY);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  const queryBase = normalizeBase(new URLSearchParams(window.location.search).get('apiBase'));
  const queryBypass = String(new URLSearchParams(window.location.search).get('bypassAuth') || '').trim().toLowerCase();
  if (queryBase) {
    setStoredBase(queryBase);
  }

  if (queryBypass === '1' || queryBypass === 'true' || queryBypass === 'on') {
    seedBypassSession();
  } else if (queryBypass === '0' || queryBypass === 'false' || queryBypass === 'off') {
    clearBypassSession();
  } else {
    try {
      const persisted = String(localStorage.getItem(AUTH_BYPASS_FLAG_KEY) || '').trim();
      if (persisted === '1') {
        seedBypassSession();
      }
    } catch {
      // Ignore storage errors.
    }
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
    resolveApiPath,
    enableAuthBypass: seedBypassSession,
    disableAuthBypass: clearBypassSession
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

/* ─── REALTIME UPDATES ────────────────────────────────────────── */
(function () {
  const tokenStorageKey = 'allstars_token';
  const listeners = new Set();
  let eventSource = null;
  let reconnectTimer = null;
  let lastNotifyAt = 0;

  function getRealtimeToken() {
    try {
      return String(localStorage.getItem(tokenStorageKey) || '').trim();
    } catch {
      return '';
    }
  }

  function disconnectRealtime() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function notifyRealtimeListeners(payload = {}) {
    const now = Date.now();
    if (now - lastNotifyAt < 250) return;
    lastNotifyAt = now;

    if (typeof window.clearCache === 'function') {
      window.clearCache();
    }

    listeners.forEach(listener => {
      try {
        listener(payload);
      } catch (err) {
        console.error('AllStarsRealtime listener error:', err);
      }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer || !listeners.size) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRealtime();
    }, 4000);
  }

  function connectRealtime() {
    if (eventSource || !listeners.size) return;

    const token = getRealtimeToken();
    if (!token) return;

    const streamPath = `/api/realtime/stream?token=${encodeURIComponent(token)}`;
    const streamUrl = window.AllStarsConfig?.resolveApiPath?.(streamPath) || streamPath;

    eventSource = new EventSource(streamUrl);
    eventSource.addEventListener('update', event => {
      let payload = {};
      try {
        payload = JSON.parse(event.data || '{}');
      } catch {}
      notifyRealtimeListeners(payload);
    });

    eventSource.onerror = () => {
      disconnectRealtime();
      scheduleReconnect();
    };
  }

  window.addEventListener('storage', event => {
    if (event.key === 'candidateStatusUpdated') {
      notifyRealtimeListeners({ source: 'storage' });
    }
  });

  window.AllStarsRealtime = {
    subscribe(listener) {
      if (typeof listener !== 'function') {

        return function () {};
      }

      listeners.add(listener);
      connectRealtime();

      return function unsubscribe() {
        listeners.delete(listener);
        if (!listeners.size) {
          disconnectRealtime();
        }
      };
    },
    reconnect: connectRealtime,
    disconnect: disconnectRealtime
  };
})();

window.logoutAllStars = function () {
  try { localStorage.removeItem('allstars_token'); } catch {}
  try { localStorage.removeItem('allstars_me'); } catch {}
  window.location.href = '/login.html';
};
