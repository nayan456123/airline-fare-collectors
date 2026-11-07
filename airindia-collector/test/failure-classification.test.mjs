import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/collect.mjs';

test('saved CAPTCHA cause keeps the local solver outcome', () => {
  const error = Object.assign(new Error('Access check remained open after local helper: audio_unrecognized (Audio challenge could not be transcribed)'),
    { code: 'CAPTCHA' });
  assert.deepEqual(classifyFailure(error, [], 'Please check the box below'), {
    code: 'CAPTCHA', detail: error.message
  });
});

test('a different visible access denial takes priority over an older solver error', () => {
  const error = Object.assign(new Error('Audio challenge could not be transcribed'),
    { code: 'CAPTCHA' });
  assert.equal(classifyFailure(error, [], 'Access Denied').code, 'ACCESS_DENIED');
});

test('HTTP access denials and CAPTCHA keep precedence over an HTTP/2 transport error', () => {
  const transportError = Object.assign(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'),
    { code: 'ERR_HTTP2_PROTOCOL_ERROR' });
  for (const [status, code] of [[401, 'SESSION_EXPIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']]) {
    assert.equal(classifyFailure(transportError, [{ path: '/', method: 'GET', status,
      navigationResponse: true }]).code, code);
  }
  assert.equal(classifyFailure(transportError, [], 'Please check the box below').code, 'CAPTCHA');
  assert.equal(classifyFailure(transportError, [], 'Access Denied').code, 'ACCESS_DENIED');
});

test('raw HTTP/2 protocol errors map to retryable site network failures only', () => {
  const error = Object.assign(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'),
    { code: 'ERR_HTTP2_PROTOCOL_ERROR' });
  assert.deepEqual(classifyFailure(error, []), {
    code: 'SITE_NETWORK_FAILURE', detail: 'net::ERR_HTTP2_PROTOCOL_ERROR'
  });
  assert.equal(classifyFailure(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), []).code,
    'ECONNRESET');
});
