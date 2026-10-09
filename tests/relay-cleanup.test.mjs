import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAccount } from '../server/relay/cleanup.mjs';

function syntheticCleanup({ protectedReference = true, validity = 1, found = [42], search } = {}) {
  const events = [];
  let protectedNow = protectedReference;
  const job = { id: 7, relay_account_id: 2, uid_validity: 1, imap_uid: 42, attempts: 0 };
  const client = {
    mailbox: { uidValidity: validity },
    async connect() { events.push('connect'); },
    async list() { return [{ specialUse: '\\Trash', path: 'Trash' }]; },
    async getMailboxLock() { return { release() { events.push('release'); } }; },
    async search() {
      events.push('search');
      if (search) protectedNow = await search();
      return found;
    },
    async messageMove(uid, path, options) {
      events.push(['move', uid, path, options]);
      return true;
    },
    async logout() { events.push('logout'); },
  };
  const dependencies = {
    createClient: async () => client,
    hasProtectedReference: async (candidate) => {
      assert.deepEqual(candidate, job);
      events.push('reference-check');
      return protectedNow;
    },
    deferProtectedJob: async (id) => { events.push(['defer', id]); },
    finishJob: async (id, status) => { events.push(['finish', id, status]); },
    retryJob: async (id, attempts) => { events.push(['retry', id, attempts]); },
  };
  return {
    events,
    dependencies,
    run: () => cleanupAccount({ id: 2 }, [job], dependencies),
    setProtected(value) { protectedNow = value; },
  };
}

test('queued cleanup defers protected references and moves only after expiry', async () => {
  const fixture = syntheticCleanup();
  await fixture.run();
  assert.ok(fixture.events.some(event => Array.isArray(event) && event[0] === 'defer'));
  assert.equal(fixture.events.some(event => Array.isArray(event) && ['move', 'finish'].includes(event[0])), false);
  assert.ok(fixture.events.indexOf('reference-check') > fixture.events.indexOf('search'));

  fixture.setProtected(false);
  fixture.events.length = 0;
  await fixture.run();
  assert.deepEqual(fixture.events.filter(Array.isArray), [
    ['move', '42', 'Trash', { uid: true }],
    ['finish', 7, 'DONE'],
  ]);
});

test('cleanup observes a reference restored during the IMAP lookup', async () => {
  const fixture = syntheticCleanup({ protectedReference: false, search: async () => true });
  await fixture.run();
  assert.deepEqual(fixture.events.filter(Array.isArray), [['defer', 7]]);
});

test('reference lookup failure fails closed and preserves the upstream message', async () => {
  const fixture = syntheticCleanup({ protectedReference: false });
  fixture.dependencies.hasProtectedReference = async () => { throw new Error('synthetic database unavailable'); };
  await fixture.run();
  assert.deepEqual(fixture.events.filter(Array.isArray), [['retry', 7, 0]]);
  assert.ok(fixture.events.includes('release'));
  assert.ok(fixture.events.includes('logout'));
});

test('cleanup still skips changed UID namespaces and completes missing sources safely', async () => {
  const changed = syntheticCleanup({ validity: 2 });
  await changed.run();
  assert.deepEqual(changed.events.filter(Array.isArray), [['finish', 7, 'SKIPPED']]);
  assert.equal(changed.events.includes('search'), false);

  const missing = syntheticCleanup({ found: [] });
  await missing.run();
  assert.deepEqual(missing.events.filter(Array.isArray), [['finish', 7, 'DONE']]);
  assert.equal(missing.events.includes('reference-check'), false);
});
