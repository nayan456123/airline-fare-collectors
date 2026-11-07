import test from 'node:test';
import assert from 'node:assert/strict';
import { airIndiaLocation, describeAirIndiaResponse } from '../src/collect.mjs';

function request(url, previous = null, method = 'GET') {
  return { url: () => url, method: () => method, redirectedFrom: () => previous };
}

function response(url, status = 200, headers = {}, prior = null, method = 'GET') {
  const current = request(url, prior, method);
  return { url: () => url, status: () => status, headers: () => headers,
    request: () => current, current };
}

test('Air India locations retain scheme and path while dropping credentials, port, query, and fragment', () => {
  const value = airIndiaLocation(
    'http://alice:super-secret@WWW.AIRINDIA.COM:8443/search/flow?token=private#seat');
  assert.deepEqual(value, { protocol: 'http:', host: 'www.airindia.com', path: '/search/flow' });
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.deepEqual(airIndiaLocation('https://airindia.com/'),
    { protocol: 'https:', host: 'airindia.com', path: '/' });
});

test('location metadata accepts only HTTP(S) Air India hosts and real subdomains', () => {
  for (const value of [
    'https://notairindia.com/path',
    'https://airindia.com.attacker.test/path',
    'https://fakeairindia.com/path',
    'ftp://airindia.com/path',
    'not a URL'
  ]) assert.equal(airIndiaLocation(value), null, value);
  assert.deepEqual(airIndiaLocation('https://booking.airindia.com/path'),
    { protocol: 'https:', host: 'booking.airindia.com', path: '/path' });
});

test('response metadata records sanitized Air India redirect chain and final redirect target', () => {
  const statuses = new WeakMap();
  const first = response('http://user:pass@airindia.com:80/start?sid=one#secret', 301);
  const second = response('https://airindia.com/middle?sid=two', 302, {}, first.current);
  const final = response('https://www.airindia.com/continue?sid=three#private', 302,
    { location: 'https://name:password@booking.airindia.com:443/final?token=hidden#fragment' },
    second.current, 'POST');

  assert.equal(describeAirIndiaResponse(first, statuses).protocol, 'http:');
  assert.equal(describeAirIndiaResponse(second, statuses).status, 302);
  const metadata = describeAirIndiaResponse(final, statuses);
  assert.deepEqual(metadata, {
    protocol: 'https:', host: 'www.airindia.com', path: '/continue', method: 'POST', status: 302,
    redirects: [
      { protocol: 'http:', host: 'airindia.com', path: '/start', status: 301 },
      { protocol: 'https:', host: 'airindia.com', path: '/middle', status: 302 }
    ],
    redirectTo: { protocol: 'https:', host: 'booking.airindia.com', path: '/final' }
  });
  const serialized = JSON.stringify(metadata);
  for (const secret of ['user', 'pass', 'sid=', 'secret', 'token=', 'hidden', 'password', 'fragment'])
    assert.equal(serialized.includes(secret), false, `metadata leaked ${secret}`);
});

test('response metadata omits non-Air-India or malformed redirect targets safely', () => {
  for (const location of [
    'https://airindia.com.attacker.test/capture?token=no',
    'https://elsewhere.example/capture?token=no',
    'http://['
  ]) {
    const item = response('https://airindia.com/redirect?session=private', 302, { location });
    const metadata = describeAirIndiaResponse(item);
    assert.equal(metadata.redirectTo, undefined);
    assert.equal(JSON.stringify(metadata).includes('private'), false);
    assert.equal(JSON.stringify(metadata).includes('token='), false);
  }
  const withoutLocation = response('https://airindia.com/redirect', 302, {});
  assert.equal(describeAirIndiaResponse(withoutLocation).redirectTo, undefined);
  assert.equal(describeAirIndiaResponse(response('https://example.test/path')), null);
});

test('same-site redirect chain reports null when an earlier response status was not observed', () => {
  const hiddenEarlier = request('https://airindia.com/earlier?session=secret');
  const current = response('https://booking.airindia.com/current', 200, {}, hiddenEarlier);
  assert.deepEqual(describeAirIndiaResponse(current), {
    protocol: 'https:', host: 'booking.airindia.com', path: '/current', method: 'GET', status: 200,
    redirects: [{ protocol: 'https:', host: 'airindia.com', path: '/earlier', status: null }]
  });
});
