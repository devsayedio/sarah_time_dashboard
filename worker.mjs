import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

globalThis.__SARAH_CLOUDFLARE_WORKER__ = true;
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = env.FIREBASE_SERVICE_ACCOUNT_JSON;

const serverModule = await import('./server.js');
const serverExports = serverModule.default || serverModule;
const expressHandler = httpServerHandler({ port: 3000 });

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

export default {
  async fetch(request, bindings, context) {
    if (!isAuthorized(request, bindings)) return unauthorized();

    const { pathname } = new URL(request.url);
    if (isBackendRoute(pathname)) {
      serverExports.ensureFirebaseInitialized();
      return expressHandler.fetch(request, bindings, context);
    }

    return bindings.ASSETS.fetch(request);
  },

  async scheduled(_controller, _bindings, context) {
    serverExports.ensureFirebaseInitialized();
    context.waitUntil(serverExports.processDueScheduledNotifications());
  }
};
