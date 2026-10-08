import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export function validateImage(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-z0-9][a-z0-9._/-]*(?::[0-9]+\/[a-z0-9._/-]+)?(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/.test(value) || value.endsWith(':latest') || value.includes('..')) throw new Error('Use an explicit version tag or sha256 digest for the backend image; latest is not accepted.');
  return value;
}
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('Supply an HTTPS root origin without credentials, path, query or fragment.');
  return url.origin;
}
export async function configure(directory, options) {
  const image = validateImage(options.image), site = origin(options.site), publicOrigin = origin(options.public || options.site);
  const email = String(options.contact || ''), smtp = String(options.mx || '');
  if (!/^[A-Za-z0-9.!+_-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) throw new Error('Supply --contact with your support email.');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(smtp) || !smtp.includes('.') || smtp.includes('..')) throw new Error('Supply --mx with your SMTP hostname.');
  const content = [
    '# Keep this file private. Preserve it and the Docker volumes on every upgrade.',
    `COMPOSE_PROJECT_NAME=nodemail-${randomBytes(6).toString('hex')}`,
    `NODEMAIL_IMAGE=${image}`, `NODEMAIL_SITE_ORIGIN=${site}`, `NODEMAIL_PUBLIC_ORIGIN=${publicOrigin}`,
    `NODEMAIL_CONTACT_EMAIL=${email}`, 'NODEMAIL_GMPAY_ORIGIN=', `SMTP_NAME=${smtp}`,
    `MYSQL_PASSWORD=${randomBytes(32).toString('hex')}`, `MYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}`,
    `GUEST_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
    'HTTP_BIND=127.0.0.1', 'HTTP_PORT=4321', 'SMTP_BIND=0.0.0.0', 'SMTP_PORT=25',
    'SMTP_TLS_KEY_FILE=', 'SMTP_TLS_CERT_FILE=', '',
  ].join('\n');
  // wx is deliberate: rerunning configure must never rotate credentials or overwrite configuration.
  await writeFile(resolve(directory, '.env'), content, { flag: 'wx', mode: 0o600 });
  await mkdir(resolve(directory, 'tls'), { recursive: true, mode: 0o750 });
}

export function dockerRun(args, { cwd, env, input = 'ignore' }) {
  return new Promise((success, failure) => {
    const child = spawn('docker', args, { cwd, env, stdio: [input, 'inherit', 'inherit'], shell: false });
    child.once('error', () => failure(new Error('Docker could not be started. Install Docker Engine and Compose v2.')));
    child.once('exit', code => code === 0 ? success() : failure(new Error(`Docker operation failed (exit ${code}).`)));
  });
}

export async function operate(directory, action, options = {}, run = dockerRun) {
  const envPath = resolve(directory, '.env');
  const saved = parseEnv(await readFile(envPath, 'utf8'));
  if (!/^nodemail-[a-z0-9-]{1,40}$/.test(saved.COMPOSE_PROJECT_NAME || '')) throw new Error('Invalid installation project name.');
  let current = saved.NODEMAIL_IMAGE;
  try { current = (await readFile(resolve(directory, '.active-image'), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  validateImage(current);
  const next = action === 'upgrade' ? validateImage(options.image) : current;
  const lockPath = resolve(directory, '.operation.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another installer operation is running. If a previous process crashed, inspect it before removing .operation.lock.'); });
  try {
    await lock.writeFile(String(process.pid));
    const base = ['compose', '--env-file', envPath, '-f', resolve(directory, 'compose.yml'), '--project-name', saved.COMPOSE_PROJECT_NAME];
    const execute = (image, args, input = 'ignore') => run([...base, ...args], { cwd: directory, env: { ...process.env, ...saved, NODEMAIL_IMAGE: image }, input });
    const check = image => execute(image, ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'distribution/runtime/setup.mjs', 'check']);
    if (action === 'init') {
      await execute(current, ['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
      await execute(current, ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'distribution/runtime/setup.mjs', 'init']);
    } else if (action === 'bootstrap') {
      if (!options.email || options.email.startsWith('-') || /[\r\n\0]/.test(options.email)) throw new Error('Supply --email with your administrator email.');
      await execute(current, ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'distribution/runtime/bootstrap.mjs', options.email], 'inherit');
    } else if (action === 'check') await check(current);
    else if (action === 'start') {
      await check(current);
      await execute(current, ['up', '-d', '--wait', '--wait-timeout', '180', 'app']);
    } else if (action === 'upgrade') {
      // Candidate runs only read-only schema verification while the current application keeps serving.
      await check(next);
      try {
        await execute(next, ['up', '-d', '--wait', '--wait-timeout', '180', 'app']);
        const temporary = resolve(directory, `.active-image-${randomBytes(8).toString('hex')}.tmp`);
        try {
          await writeFile(temporary, next + '\n', { flag: 'wx', mode: 0o600 });
          await rename(temporary, resolve(directory, '.active-image'));
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      } catch {
        await execute(current, ['up', '-d', '--wait', '--wait-timeout', '180', 'app']);
        throw new Error('Candidate did not complete activation. Previous image restored; .env and data volumes were retained.');
      }
    } else throw new Error('Unknown operation. Use configure, init, bootstrap, check, start or upgrade.');
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2), options = {};
    if (args.length % 2 !== 0) throw new Error('Options require --name value pairs.');
    for (let i = 0; i < args.length; i += 2) {
      if (!['--image', '--site', '--public', '--contact', '--mx', '--email'].includes(args[i]) || args[i].slice(2) in options) throw new Error('Unknown or duplicate option.');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (action === 'configure') await configure(here, options);
    else await operate(here, action, options);
    console.info('Operation completed. No existing configuration or data volume was deleted.');
  } catch (error) {
    console.error(error?.code === 'EEXIST' ? '.env already exists; configure never overwrites it.' : error?.message || 'Installation operation failed.');
    process.exitCode = 1;
  }
}
