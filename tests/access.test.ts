import test from 'node:test';
import assert from 'node:assert/strict';
import { accessKey, hasTestAccess } from '../server/access';
import { hashKey, makeKey } from '../src/net/protocol';
import { stationMarkup } from '../src/ui/station';
import { createCampaign } from '../src/game/campaign';
import { makeExpedition } from '../src/game/storage';
import { parseInvitation } from '../src/net/client';

test('The Worker access gate fails closed and accepts only the current key over HTTP or WebSocket', async () => {
  const key = makeKey(), hash = await hashKey(key);
  assert.equal(await hasTestAccess(new Headers()), false);
  assert.equal(await hasTestAccess(new Headers({ 'X-Glush-Test-Key': key })), false);
  assert.equal(await hasTestAccess(new Headers(), hash), false);
  assert.equal(await hasTestAccess(new Headers({ 'X-Glush-Test-Key': makeKey() }), hash), false);
  assert.equal(await hasTestAccess(new Headers({ 'X-Glush-Test-Key': key }), hash), true);
  const websocket = new Headers({ 'Sec-WebSocket-Protocol': `glush, glush-test.${key}` });
  assert.equal(accessKey(websocket), key);
  assert.equal(await hasTestAccess(websocket, hash), true);
  assert.equal(await hasTestAccess(websocket, await hashKey(makeKey())), false, 'Rotating the key revokes old invitations');
  assert.equal(await hasTestAccess(new Headers(), undefined, false), true, 'A self-hosted Node server can opt out');
  assert.equal(await hasTestAccess(new Headers(), 'invalid', false), false);
});

test('Public station has no multiplayer entry; private station and invitations retain existing rooms', () => {
  const sim = makeExpedition(createCampaign());
  assert(!stationMarkup(sim, 'dispatch', 0).includes('base-coop'));
  assert(stationMarkup(sim, 'dispatch', 0, false, true).includes('base-coop'));
  const id = crypto.randomUUID(), key = makeKey(), invite = makeKey();
  const base = `https://glush.varantsov.ru/playtest/#room=${id}&server=https%3A%2F%2Fexample.com&invite=${invite}`;
  assert.deepEqual(parseInvitation(base + '&test=' + key), { id, server: 'https://example.com', invite, access: key });
  assert.equal(parseInvitation(base).id, id, 'Old room IDs can be resumed after entering the private playtest');
});
