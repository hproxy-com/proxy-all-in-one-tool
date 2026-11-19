// HProxy's public API (https://hproxy.com/docs, OpenAPI at https://hproxy.com/openapi.json): the key goes in the
// X-API-Key header; the free tools (proxy list, proxy checker, IP lookup) take no key, so it is only sent where needed.
const BASE = 'https://hproxy.com';

const KEYLESS = ['/api/proxy-list', '/api/proxy-check', '/api/ip/'];

const addApiKey = (request, z, bundle) => {
  const url = String(request.url || '');
  request.headers = request.headers || {};
  if (url.startsWith(BASE)) {
    request.headers.Accept = 'application/json';
    const path = url.slice(BASE.length);
    const keyless = KEYLESS.some((p) => path.startsWith(p));
    if (!keyless && bundle.authData && bundle.authData.api_key) {
      request.headers['X-API-Key'] = bundle.authData.api_key;
    }
  }
  return request;
};

const bodyOf = (response) => {
  if (response.data !== undefined) return response.data;
  try {
    return JSON.parse(response.content);
  } catch (e) {
    return {};
  }
};

// HProxy explains a refusal in { error } or { message }: show that text instead of a bare status code.
const explainErrors = (response, z) => {
  if (response.status >= 400) {
    const body = bodyOf(response) || {};
    const said = typeof body === 'object' ? body.error || body.message || '' : String(body);
    if (response.status === 401 || response.status === 403) {
      throw new z.errors.Error(
        `HProxy refused the API key${said ? `: ${said}` : ''}. Check the key under Settings > API keys in your HProxy dashboard.`,
        'AuthenticationError',
        response.status,
      );
    }
    throw new z.errors.Error(`HProxy answered ${response.status}${said ? `: ${said}` : ''}`, 'ApiError', response.status);
  }
  return response;
};

// A product id such as residential-premium, written the way people read it.
const productName = (id) =>
  String(id || 'Plan')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const gigabytes = (value) => String(Math.round((Number.isFinite(value) ? value : 0) * 100) / 100);

// One plan as a dropdown shows it, such as "Residential Premium, 3.2 of 10 GB left (shop-1)".
const planName = (plan) => {
  const parts = [productName(plan.productId)];
  if (typeof plan.dataGbTotal === 'number') parts.push(`${gigabytes(plan.dataGbRemaining)} of ${gigabytes(plan.dataGbTotal)} GB left`);
  const words = { used_up: 'used up', inactive: 'switched off' };
  if (words[plan.status]) parts.push(words[plan.status]);
  const name = parts.join(', ');
  return plan.label ? `${name} (${plan.label})` : name;
};

const list = (value) =>
  (Array.isArray(value) ? value : String(value || '').split(/[\n,]+/))
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);

module.exports = { BASE, addApiKey, explainErrors, bodyOf, planName, list };
