import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {probeSmtp} from '../server/admin/service-health.mjs';

async function withListener(handler, check) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handler(socket); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await check(server.address().port); }
  finally { for(const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
test('admin SMTP probe accepts a fragmented 220 greeting and submits no mail', async () => {
  let submitted = '';
  await withListener(socket => { socket.on('data', data => submitted += data); socket.write('220-test\r\n22'); setTimeout(() => socket.write('0 ready\r\n'), 10); }, async port => {
    assert.equal(await probeSmtp({port}), true);
  });
  assert.equal(submitted, '');
});
test('admin SMTP probe rejects bad greetings, closed listeners, invalid targets and stalled peers', async () => {
  await withListener(socket => socket.end('500 no\r\n'), async port => assert.equal(await probeSmtp({port}), false));
  await withListener(socket => socket.end('220 incomplete'), async port => assert.equal(await probeSmtp({port}), false));
  await withListener(() => {}, async port => assert.equal(await probeSmtp({port, timeoutMs:30}), false));
  await withListener(socket => socket.write('x'.repeat(4097)), async port => assert.equal(await probeSmtp({port}), false));
  let closedPort;
  await withListener(() => {}, async port => {closedPort = port;});
  assert.equal(await probeSmtp({port:closedPort}), false);
  assert.equal(await probeSmtp({host:'example.com'}), false);
  assert.equal(await probeSmtp({port:NaN}), false);
});
