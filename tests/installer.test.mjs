import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { configure, operate, validateImage } from '../installer/manage.mjs';
import { validateAdministrator } from '../distribution/runtime/bootstrap.mjs';
import { checkHealth, healthSettings } from '../distribution/runtime/healthcheck.mjs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const options = { image: 'example/nodemail:0.1.0', site: 'https://mail.example.com', contact: 'support@example.com', mx: 'mx.example.com' };
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nodemail-distribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await configure(directory, options);
  return directory;
}

test('configuration generates independent credentials and refuses to overwrite existing configuration', async t => {
  const directory = await temporary(t), original = await readFile(join(directory, '.env'), 'utf8'), config = parseEnv(original);
  assert.equal(config.HTTP_BIND, '127.0.0.1');
  assert.equal(config.NODEMAIL_SITE_ORIGIN, options.site);
  assert.equal(config.NODEMAIL_GMPAY_ORIGIN, '');
  assert.equal(config.GUEST_SESSION_SECRET.length, 96);
  assert.notEqual(config.MYSQL_PASSWORD, config.MYSQL_ROOT_PASSWORD);
  await assert.rejects(configure(directory, options), { code: 'EEXIST' });
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
  const other = await temporary(t), second = parseEnv(await readFile(join(other, '.env'), 'utf8'));
  for (const key of ['COMPOSE_PROJECT_NAME', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'GUEST_SESSION_SECRET']) assert.notEqual(config[key], second[key]);
});

test('installer rejects unsafe image, origin and administrator inputs', async t => {
  for (const image of ['image', 'image:latest', 'x;echo:1', 'image:1\nBAD=x', 'a/../b:1', '-x:1']) assert.throws(() => validateImage(image));
  for (const image of ['ghcr.io/example/mail:v1', 'localhost:5000/nodemail:test', `example/mail@sha256:${'a'.repeat(64)}`]) assert.equal(validateImage(image), image);
  const directory = await mkdtemp(join(tmpdir(), 'nodemail-distribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const site of ['http://mail.example.com', 'https://user:password@mail.example.com', 'https://mail.example.com/sub', 'https://mail.example.com/#x']) await assert.rejects(configure(directory, { ...options, site }));
  assert.equal(validateAdministrator(' ADMIN@example.com ', 'long-random-password'), 'admin@example.com');
  for (const password of ['short', 'x'.repeat(256), 'good-password\nbad']) assert.throws(() => validateAdministrator('admin@example.com', password));
});

test('successful upgrade verifies candidate before activation and preserves .env exactly', async t => {
  const directory = await temporary(t), original = await readFile(join(directory, '.env'), 'utf8'), calls = [];
  await operate(directory, 'upgrade', { image: 'example/nodemail:0.2.0' }, async (args, settings) => calls.push({ args, image: settings.env.NODEMAIL_IMAGE }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-8), ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'distribution/runtime/setup.mjs', 'check']);
  assert.equal(calls[0].args.at(-1), 'check');
  assert.ok(calls[0].args.includes('distribution/runtime/setup.mjs'));
  assert.ok(calls[1].args.includes('--wait'));
  assert.ok(calls.every(call => call.image === 'example/nodemail:0.2.0'));
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
  assert.equal((await readFile(join(directory, '.active-image'), 'utf8')).trim(), 'example/nodemail:0.2.0');
});

test('failed schema check never replaces running service; failed activation restores former image', async t => {
  const directory = await temporary(t), calls = [];
  await assert.rejects(operate(directory, 'upgrade', { image: 'example/nodemail:0.2.0' }, async args => { calls.push(args); throw Error('schema changed'); }), /schema changed/);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('up'));
  const images = [];
  await assert.rejects(operate(directory, 'upgrade', { image: 'example/nodemail:0.2.0' }, async (args, settings) => {
    images.push(settings.env.NODEMAIL_IMAGE);
    if (images.length === 2) throw Error('health failed');
  }), /Previous image restored/);
  assert.deepEqual(images, ['example/nodemail:0.2.0', 'example/nodemail:0.2.0', 'example/nodemail:0.1.0']);
  await assert.rejects(readFile(join(directory, '.active-image')), { code: 'ENOENT' });
});

test('installation operations are serialized and bootstrap password is not a command argument', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, '.operation.lock'), 'other process');
  await assert.rejects(operate(directory, 'start', {}, async () => assert.fail('must not execute Docker')), /Another installer/);
  await rm(join(directory, '.operation.lock'));
  await operate(directory, 'bootstrap', { email: 'admin@example.com' }, async (args, settings) => {
    assert.equal(args.at(-1), 'admin@example.com');
    assert.equal(settings.input, 'inherit');
    assert.ok(args.includes('-T'));
  });
});

test('compose uses isolated persistent services and startup does not initialize the database', async () => {
  const compose = await readFile(new URL('../installer/compose.yml', import.meta.url), 'utf8');
  const source = await readFile(new URL('../installer/manage.mjs', import.meta.url), 'utf8');
  const startup = await readFile(new URL('../distribution/runtime/start.mjs', import.meta.url), 'utf8');
  const database = compose.split('  app:')[0];
  assert.ok(!database.includes('ports:'));
  assert.match(compose, /internal: true/);
  assert.match(compose, /HTTP_BIND:-127\.0\.0\.1/);
  assert.ok(!compose.includes('1panel') && !compose.includes('container_name'));
  assert.ok(!/\bprune\b|down.{0,10}--volumes|down.{0,10}-v/.test(source));
  assert.ok(!startup.includes('db:init') && !startup.includes('migrateDatabase'));
  assert.match(startup, /checkInstallation/);
  assert.match(compose, /distribution\/runtime\/healthcheck\.mjs/);
});

test('health check requires both HTTP success and an actual SMTP 220 greeting', async t => {
  let httpStatus = 200, greeting = '220 test\r\n';
  const web = createHttpServer((_request, response) => { response.writeHead(httpStatus); response.end('{}'); });
  const smtp = createTcpServer(socket => {
    socket.on('error', () => {});
    if (greeting) { socket.write(greeting.slice(0, 2)); setTimeout(() => socket.end(greeting.slice(2)), 5); }
  });
  await Promise.all([new Promise(done => web.listen(0, '127.0.0.1', done)), new Promise(done => smtp.listen(0, '127.0.0.1', done))]);
  t.after(async () => { web.closeAllConnections(); await Promise.all([new Promise(done => web.close(done)), new Promise(done => smtp.close(done))]); });
  const settings = { webUrl: `http://127.0.0.1:${web.address().port}/api/health`, smtpPort: smtp.address().port, timeoutMs: 150 };
  await checkHealth(settings);
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../distribution/runtime/healthcheck.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(web.address().port), SMTP_PORT: String(smtp.address().port) }, timeout: 5000,
  });
  greeting = '421 unavailable\r\n';
  await assert.rejects(checkHealth(settings), /not 220/);
  greeting = '220 test\r\n'; httpStatus = 503;
  await assert.rejects(checkHealth(settings), /HTTP\/database/);
  httpStatus = 200; greeting = '';
  await assert.rejects(checkHealth(settings), /timed out/);
});

test('healthcheck CLI settings use only validated local application and SMTP ports', () => {
  assert.deepEqual(healthSettings({}), { webUrl: 'http://127.0.0.1:4321/api/health', smtpPort: 2525 });
  assert.deepEqual(healthSettings({ PORT: '14321', SMTP_PORT: '12525' }), { webUrl: 'http://127.0.0.1:14321/api/health', smtpPort: 12525 });
  for (const name of ['PORT', 'SMTP_PORT']) for (const value of ['', '0', '-1', '65536', '1.5', '1e3', '443/path', 'example.com:443']) assert.throws(() => healthSettings({ [name]: value }), /Invalid/);
});
