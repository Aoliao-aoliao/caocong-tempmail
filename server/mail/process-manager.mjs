import {startAuditRetention} from '../admin/audit-retention.mjs';
import {startApiLogRetention} from '../openapi/log-retention.mjs';
import { spawn } from 'node:child_process';
import { closeDatabasePool } from '../db/database.mjs';
import { startMailboxMaintenance } from './maintenance.mjs';
import { startSmtpServer } from './smtp-service.mjs';
import { startRelayPoller } from '../relay/poller.mjs';
import { startDomainDnsMonitor } from '../admin/domain-dns.mjs';

let stopping = false;
let smtpService;
let maintenance;
let relayPoller;
let domainDnsMonitor;
let webProcess;
let auditRetention;
let apiLogRetention;

function terminateWebProcess() {
  if (!webProcess || webProcess.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (webProcess.exitCode === null) webProcess.kill('SIGKILL');
      setTimeout(finish, 1000).unref();
    }, 10000);
    forceTimer.unref();
    webProcess.once('exit', finish);
    webProcess.kill('SIGTERM');
  });
}

async function stop(exitCode, reason) {
  if (stopping) return;
  stopping = true;
  console.info(`[service] stopping (${reason})`);

  await Promise.allSettled([apiLogRetention?.stop(), auditRetention?.stop(), domainDnsMonitor?.stop(), relayPoller?.stop(), maintenance?.stop(), smtpService?.close(), terminateWebProcess()]);
  await closeDatabasePool().catch((error) => console.error('[service] database close failed', error));
  process.exit(exitCode);
}

try {
  smtpService = await startSmtpServer({
    onFatalError(error) {
      console.error('[service] SMTP server failed', error);
      void stop(1, 'SMTP failure');
    },
  });
  maintenance = startMailboxMaintenance({
    config: smtpService.config,
    attachmentStore: smtpService.attachmentStore,
  });
  relayPoller = startRelayPoller({
    config:smtpService.config,
    attachmentStore:smtpService.attachmentStore,
    intervalMs:Number(process.env.RELAY_POLL_INTERVAL_MS || 30000),
  });
  domainDnsMonitor = startDomainDnsMonitor({
    intervalMs:Number(process.env.DOMAIN_DNS_CHECK_INTERVAL_MS || 900000),
  });

  auditRetention = startAuditRetention();
  apiLogRetention = startApiLogRetention();
  webProcess = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: process.env,
    stdio: 'inherit',
  });
  webProcess.once('error', (error) => {
    console.error('[service] web process failed to start', error);
    void stop(1, 'web start failure');
  });
  webProcess.once('exit', (code, signal) => {
    if (!stopping) void stop(code === 0 ? 0 : 1, `web exited (${signal || code})`);
  });
} catch (error) {
  console.error('[service] startup failed', error);
  await Promise.allSettled([smtpService?.close(), closeDatabasePool()]);
  process.exit(1);
}

process.once('SIGTERM', () => void stop(0, 'SIGTERM'));
process.once('SIGINT', () => void stop(0, 'SIGINT'));
process.once('uncaughtException', (error) => {
  console.error('[service] uncaught exception', error);
  void stop(1, 'uncaught exception');
});
process.once('unhandledRejection', (error) => {
  console.error('[service] unhandled rejection', error);
  void stop(1, 'unhandled rejection');
});
