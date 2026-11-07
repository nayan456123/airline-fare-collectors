import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, validateSearch, classifyFailure } from '../src/diagnostics.mjs';

test('rejects malformed routes and impossible dates', () => {
  assert.throws(() => validateSearch('DEL:DEL:2099-11-10'));
  assert.throws(() => validateSearch('DEL:BOM:2099-02-30'));
  assert.throws(() => validateSearch('del:BOM:2099-11-10'));
  assert.deepEqual(validateSearch('DEL:BOM:2099-11-10'), { origin: 'DEL', destination: 'BOM', travelDate: '2099-11-10' });
});

test('recognizes temporary browser transport failures while preserving denial precedence', () => {
  const error = new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.spicejet.com/');
  assert.equal(classifyFailure(error).cause.code, 'SITE_NETWORK_FAILURE');
  const blocked = classifyFailure(error, [{ code:'ACCESS_DENIED', detail:'HTTP 403' }]);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.cause.code, 'ACCESS_DENIED');
  assert.equal(classifyFailure(new Error('Result fare mismatch')).cause.code, 'SEARCH_UNVERIFIED');
  assert.equal(classifyFailure(Object.assign(new Error('Homepage HTTP 403'), {code:'ACCESS_DENIED'})).status, 'blocked');
});

test('classifies SpiceJet API denials without recording URL secrets', () => {
  assert.deepEqual(classifyResponse('https://www.spicejet.com/api/v1/token?token=secret', 403),
    { code: 'ACCESS_DENIED', detail: 'SpiceJet returned HTTP 403 from /api/v1/token' });
  assert.equal(classifyResponse('https://other.example/api/token', 403), null);
  assert.equal(classifyResponse('https://www.spicejet.com/api/v1/token', 200), null);
  assert.equal(classifyResponse('https://www.spicejet.com/api/v1/token', 429).code, 'RATE_LIMITED');
});
