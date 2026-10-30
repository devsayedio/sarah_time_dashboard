import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

globalThis.__SARAH_CLOUDFLARE_WORKER__ = true;
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = env.FIREBASE_SERVICE_ACCOUNT_JSON;

const serverModule = await import('./server.js');
const serverExports = serverModule.default || serverModule;
const expressHandler = httpServerHandler({ port: 3000 });

const DASHBOARD_CACHE_PREFIX = 'dashboard:v2:';
const OFFICE_POLICY_CACHE_KEY = 'settings:v2:office-policy';
const DATE_OVERRIDES_CACHE_KEY = 'settings:v2:date-overrides';
const OFFICE_POLICY_CACHE_TTL = 30 * 24 * 60 * 60;
const DATE_OVERRIDES_CACHE_TTL = 7 * 24 * 60 * 60;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="Sarah Time Dashboard", charset="UTF-8"'
    }
  });
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(request, bindings) {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Basic ')) return false;

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;

    return safeEqual(decoded.slice(0, separator), bindings.BASIC_AUTH_USERNAME) &&
      safeEqual(decoded.slice(separator + 1), bindings.BASIC_AUTH_PASSWORD);
  } catch {
    return false;
  }
}

function isBackendRoute(pathname) {
  return pathname.startsWith('/api/') ||
    pathname === '/healthz' ||
    pathname === '/version';
}

function getDhakaDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function dashboardCacheTtl(dateKey) {
  const today = getDhakaDateKey();
  if (dateKey === today) return 60;
  return dateKey < today ? 86400 : 900;
}

function dashboardCacheKey(dateKey) {
  return `${DASHBOARD_CACHE_PREFIX}${dateKey}`;
}

function cacheResponse(body, cacheStatus, ttlSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Dashboard-Cache': cacheStatus,
      'X-Dashboard-Cache-Ttl': String(ttlSeconds)
    }
  });
}

function addCacheHeaders(response, cacheStatus, ttlSeconds) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Dashboard-Cache', cacheStatus);
  headers.set('X-Dashboard-Cache-Ttl', String(ttlSeconds));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readKv(bindings, key) {
  if (!bindings.DASHBOARD_CACHE) return null;
  try {
    return await bindings.DASHBOARD_CACHE.get(key);
  } catch (error) {
    console.warn(`Dashboard cache read failed for ${key}:`, error);
    return null;
  }
}

function storeKv(bindings, context, key, body, expirationTtl) {
  if (!bindings.DASHBOARD_CACHE) return;
  context.waitUntil(
    bindings.DASHBOARD_CACHE
      .put(key, body, { expirationTtl })
      .catch(error => console.warn(`Dashboard cache write failed for ${key}:`, error))
  );
}

async function putKv(bindings, key, body, expirationTtl) {
  if (!bindings.DASHBOARD_CACHE) return true;
  try {
    await bindings.DASHBOARD_CACHE.put(key, body, { expirationTtl });
    return true;
  } catch (error) {
    console.warn(`Dashboard cache write failed for ${key}:`, error);
    return false;
  }
}

async function replaceKv(bindings, key, body, expirationTtl) {
  const written = await putKv(bindings, key, body, expirationTtl);
  if (written || !bindings.DASHBOARD_CACHE) return;
  try {
    await bindings.DASHBOARD_CACHE.delete(key);
  } catch (error) {
    console.warn(`Dashboard cache cleanup failed for ${key}:`, error);
  }
}

async function readJsonKv(bindings, key) {
  const cached = await readKv(bindings, key);
  if (cached === null) return { found: false, value: null };
  try {
    return { found: true, value: JSON.parse(cached) };
  } catch (error) {
    console.warn(`Dashboard cache JSON was invalid for ${key}:`, error);
    return { found: false, value: null };
  }
}

async function handleJsonCache(request, bindings, context, key, ttlSeconds) {
  const url = new URL(request.url);
  const bypass = url.searchParams.get('refresh') === '1';

  if (!bypass) {
    const cached = await readKv(bindings, key);
    if (cached !== null) return cacheResponse(cached, 'HIT', ttlSeconds);
  }

  serverExports.ensureFirebaseInitialized();
  const response = await expressHandler.fetch(request, bindings, context);
  if (response.ok) {
    const body = await response.clone().text();
    storeKv(bindings, context, key, body, ttlSeconds);
  }

  return addCacheHeaders(response, bypass ? 'BYPASS' : 'MISS', ttlSeconds);
}

async function handleDashboardRequest(request, bindings, context) {
  const url = new URL(request.url);
  const dateKey = url.searchParams.get('date') || getDhakaDateKey();
  if (!DATE_KEY_PATTERN.test(dateKey)) {
    serverExports.ensureFirebaseInitialized();
    return expressHandler.fetch(request, bindings, context);
  }

  const ttlSeconds = dashboardCacheTtl(dateKey);
  return handleJsonCache(
    request,
    bindings,
    context,
    dashboardCacheKey(dateKey),
    ttlSeconds
  );
}

function settingsResponse(settings, dateOverrides, cacheStatus) {
  return new Response(JSON.stringify({ success: true, settings, dateOverrides }), {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Dashboard-Cache': cacheStatus,
      'X-Office-Policy-Cache-Ttl': String(OFFICE_POLICY_CACHE_TTL),
      'X-Date-Overrides-Cache-Ttl': String(DATE_OVERRIDES_CACHE_TTL)
    }
  });
}

async function handleSettingsRequest(request, bindings) {
  const bypass = new URL(request.url).searchParams.get('refresh') === '1';
  const [rawPolicyCache, rawOverridesCache] = bypass
    ? [{ found: false, value: null }, { found: false, value: null }]
    : await Promise.all([
        readJsonKv(bindings, OFFICE_POLICY_CACHE_KEY),
        readJsonKv(bindings, DATE_OVERRIDES_CACHE_KEY)
      ]);
  const policyCache = {
    ...rawPolicyCache,
    found: rawPolicyCache.found &&
      (rawPolicyCache.value === null ||
        (typeof rawPolicyCache.value === 'object' && !Array.isArray(rawPolicyCache.value)))
  };
  const overridesCache = {
    ...rawOverridesCache,
    found: rawOverridesCache.found &&
      Array.isArray(rawOverridesCache.value) &&
      rawOverridesCache.value.every(item =>
        item && DATE_KEY_PATTERN.test(item.dateKey || '')
      )
  };

  if (!policyCache.found || !overridesCache.found) {
    serverExports.ensureFirebaseInitialized();
  }

  const [settings, dateOverrides] = await Promise.all([
    policyCache.found ? policyCache.value : serverExports.loadOfficePolicy(),
    overridesCache.found ? overridesCache.value : serverExports.loadDateOverrides()
  ]);

  await Promise.all([
    !policyCache.found
      ? replaceKv(
          bindings,
          OFFICE_POLICY_CACHE_KEY,
          JSON.stringify(settings),
          OFFICE_POLICY_CACHE_TTL
        )
      : null,
    !overridesCache.found
      ? replaceKv(
          bindings,
          DATE_OVERRIDES_CACHE_KEY,
          JSON.stringify(dateOverrides),
          DATE_OVERRIDES_CACHE_TTL
        )
      : null
  ]);

  const cacheStatus = bypass
    ? 'BYPASS'
    : policyCache.found && overridesCache.found
      ? 'HIT'
      : 'MISS';
  return settingsResponse(settings, dateOverrides, cacheStatus);
}

async function requestJson(request) {
  try {
    return await request.clone().json();
  } catch {
    return {};
  }
}

async function cacheInvalidationFor(request, pathname) {
  const method = request.method.toUpperCase();

  if (pathname === '/api/attendance/edit' && method === 'PUT') {
    return { dates: [(await requestJson(request)).dateKey].filter(Boolean) };
  }
  if (pathname === '/api/attendance/delete' && method === 'DELETE') {
    return { dates: [(await requestJson(request)).dateKey].filter(Boolean) };
  }
  if (pathname === '/api/settings/date-override' && method === 'POST') {
    return {
      dates: [(await requestJson(request)).dateKey].filter(Boolean),
      settingsMutation: 'override-upsert'
    };
  }
  if (pathname.startsWith('/api/settings/date-override/') && method === 'DELETE') {
    return {
      dates: [decodeURIComponent(pathname.slice('/api/settings/date-override/'.length))],
      settingsMutation: 'override-delete'
    };
  }
  if (pathname === '/api/settings/office' && method === 'POST') {
    return { allDates: true, settingsMutation: 'policy' };
  }
  if (pathname === '/api/employees' && method === 'POST') {
    return { allDates: true };
  }
  if (pathname.startsWith('/api/employees/') && ['POST', 'PUT', 'DELETE'].includes(method)) {
    return { allDates: true };
  }

  return null;
}

async function deleteKvKeys(bindings, keys) {
  if (!bindings.DASHBOARD_CACHE || keys.length === 0) return;
  for (let offset = 0; offset < keys.length; offset += 20) {
    await Promise.all(
      keys.slice(offset, offset + 20).map(key => bindings.DASHBOARD_CACHE.delete(key))
    );
  }
}

async function invalidateAllDashboardDates(bindings) {
  if (!bindings.DASHBOARD_CACHE) return;
  let cursor;
  do {
    const page = await bindings.DASHBOARD_CACHE.list({
      prefix: DASHBOARD_CACHE_PREFIX,
      ...(cursor ? { cursor } : {})
    });
    await deleteKvKeys(bindings, page.keys.map(key => key.name));
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (cursor);
}

async function applySettingsWriteThrough(bindings, invalidation, responseData) {
  if (!invalidation.settingsMutation || !responseData?.success) return;

  if (invalidation.settingsMutation === 'policy') {
    await replaceKv(
      bindings,
      OFFICE_POLICY_CACHE_KEY,
      JSON.stringify(responseData.settings ?? null),
      OFFICE_POLICY_CACHE_TTL
    );
    return;
  }

  const dateKey = responseData.dateKey;
  if (!DATE_KEY_PATTERN.test(dateKey || '')) return;

  const cached = await readJsonKv(bindings, DATE_OVERRIDES_CACHE_KEY);
  if (!cached.found || !Array.isArray(cached.value)) return;

  const dateOverrides = cached.value.filter(item => item?.dateKey !== dateKey);
  if (invalidation.settingsMutation === 'override-upsert') {
    dateOverrides.push({ dateKey, ...(responseData.override || {}) });
  }
  dateOverrides.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  await replaceKv(
    bindings,
    DATE_OVERRIDES_CACHE_KEY,
    JSON.stringify(dateOverrides),
    DATE_OVERRIDES_CACHE_TTL
  );
}

async function applyCacheInvalidation(bindings, invalidation, responseData) {
  if (!bindings.DASHBOARD_CACHE || !invalidation) return;
  try {
    if (invalidation.allDates) {
      await invalidateAllDashboardDates(bindings);
    } else {
      await deleteKvKeys(
        bindings,
        (invalidation.dates || [])
          .filter(dateKey => DATE_KEY_PATTERN.test(dateKey))
          .map(dashboardCacheKey)
      );
    }
    await applySettingsWriteThrough(bindings, invalidation, responseData);
  } catch (error) {
    console.warn('Dashboard cache invalidation failed:', error);
  }
}

export default {
  async fetch(request, bindings, context) {
    if (!isAuthorized(request, bindings)) return unauthorized();

    const { pathname } = new URL(request.url);
    if (isBackendRoute(pathname)) {
      if (request.method === 'GET' && pathname === '/api/dashboard') {
        return handleDashboardRequest(request, bindings, context);
      }
      if (request.method === 'GET' && pathname === '/api/settings/office') {
        return handleSettingsRequest(request, bindings);
      }

      const invalidation = await cacheInvalidationFor(request, pathname);
      serverExports.ensureFirebaseInitialized();
      const response = await expressHandler.fetch(request, bindings, context);
      if (response.ok && invalidation) {
        let responseData = null;
        if (invalidation.settingsMutation) {
          try {
            responseData = await response.clone().json();
          } catch (error) {
            console.warn('Could not parse settings mutation response:', error);
          }
        }
        await applyCacheInvalidation(bindings, invalidation, responseData);
      }
      return response;
    }

    return bindings.ASSETS.fetch(request);
  },

  async scheduled(_controller, _bindings, context) {
    serverExports.ensureFirebaseInitialized();
    context.waitUntil(serverExports.processDueScheduledNotifications());
  }
};
