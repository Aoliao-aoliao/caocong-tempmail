import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function healthSettings(env = process.env) {
  const port = (name, fallback) => {
    const value = String(env[name] ?? fallback);
    if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid ${name}.`);
    return Number(value);
  };
  return { webUrl: `http://127.0.0.1:${port('PORT', 4321)}/api/health`, smtpPort: port('SMTP_PORT', 2525) };
}

export async function checkHealth({ webUrl = 'http://127.0.0.1:4321/api/health', smtpPort = 2525, timeoutMs = 3000 } = {}) {
  const smtp = new Promise((success, failure) => {
    const socket = connect({ host: '127.0.0.1', port: smtpPort });
    let settled = false, received = '';
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? failure(error) : success();
    };
    const timer = setTimeout(() => finish(new Error('SMTP greeting timed out.')), timeoutMs);
    socket.on('data', chunk => {
      received += chunk.toString('ascii');
      if (received.includes('\n')) finish(/^220[ -]/.test(received) ? undefined : new Error('SMTP greeting was not 220.'));
      else if (received.length > 512) finish(new Error('Invalid SMTP greeting.'));
    });
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('SMTP closed before its greeting.')));
  });
  const web = fetch(webUrl, { signal: AbortSignal.timeout(timeoutMs) }).then(async response => {
    await response.body?.cancel();
    if (!response.ok) throw new Error('HTTP/database health check failed.');
  });
  await Promise.all([web, smtp]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkHealth(healthSettings()); }
  catch { console.error('NodeMail HTTP/database or SMTP health check failed.'); process.exitCode = 1; }
}
