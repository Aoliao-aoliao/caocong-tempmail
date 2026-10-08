import net from 'node:net';

// Only probe this application's loopback SMTP listener; no message is submitted.
export function probeSmtp({ port = Number(process.env.SMTP_PORT || 2525), host = process.env.SMTP_HOST === '::1' ? '::1' : '127.0.0.1', timeoutMs = 1500 } = {}) {
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    let greeting = '';
    const socket = net.createConnection({ host, port });
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('data', data => {
      greeting += data.toString('ascii');
      if (greeting.length > 4096) return finish(false);
      const lines = greeting.split('\r\n');
      for (const line of lines.slice(0, -1)) {
        if (/^220 /.test(line)) return finish(true);
        if (!/^220-/.test(line)) return finish(false);
      }
    });
  });
}
