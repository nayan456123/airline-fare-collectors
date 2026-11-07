export function validateSearch(value) {
  const match = /^([A-Z]{3}):([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/.exec(value || '');
  if (!match || match[1] === match[2]) throw new Error('Use ORIGIN:DESTINATION:YYYY-MM-DD with different airport codes.');
  const date = new Date(`${match[3]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[3])
    throw new Error('Invalid travel date.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (match[3] < today) throw new Error('Travel date must not be in the past.');
  return { origin: match[1], destination: match[2], travelDate: match[3] };
}

export function classifyResponse(url, status) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== 'www.spicejet.com' || !parsed.pathname.startsWith('/api/')) return null;
  const code = ({ 401: 'SESSION_INVALID', 403: 'ACCESS_DENIED', 429: 'RATE_LIMITED' })[status];
  return code ? { code, detail: `SpiceJet returned HTTP ${status} from ${parsed.pathname}` } : null;
}

export function classifyFailure(error, network = []) {
  const detail = String(error.message).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 500);
  const denial = network.find(item => ['ACCESS_DENIED', 'SESSION_INVALID', 'RATE_LIMITED', 'CAPTCHA'].includes(item.code));
  if (denial) return { status: 'blocked', cause: denial };
  const code = /net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)\b/.test(detail)
    ? 'SITE_NETWORK_FAILURE' : error.code || 'SEARCH_UNVERIFIED';
  return { status: ['ACCESS_DENIED', 'SESSION_INVALID', 'RATE_LIMITED', 'CAPTCHA'].includes(code) ? 'blocked' : 'failed', cause: { code, detail } };
}
