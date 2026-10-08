import { resolveMx } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/database.mjs';
import {smtpName} from '../config/deployment.mjs';

const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/\.$/, '');
const expectedMx = () => normalizeHost(smtpName());
const iso = (value) => value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;

function publicResult(row) {
  let records = row.mx_records_json;
  if (typeof records === 'string') {
    try { records = JSON.parse(records); } catch { records = []; }
  }
  return {
    domain:row.domain,
    kind:row.kind,
    status:row.status,
    mx_status:row.mx_status,
    mx_checked_at:iso(row.mx_checked_at),
    mx_records:Array.isArray(records) ? records : [],
    mx_error:row.mx_error || null,
    mailbox_count:Number(row.mailbox_count || 0),
    owner:row.owner || null,
  };
}

async function lookupMx(domain, timeoutMs=7000) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('DNS 查询超时'), { code:'ETIMEOUT' })), timeoutMs);
      timer.unref?.();
    });
    const resolved = await Promise.race([resolveMx(domain), timeout]);
    const records = resolved
      .map((item) => ({ exchange:normalizeHost(item.exchange), priority:Number(item.priority || 0) }))
      .sort((left, right) => left.priority - right.priority || left.exchange.localeCompare(right.exchange));
    if (!records.length) return { status:'NOT_FOUND', records:[], error:'未查询到 MX 记录。' };
    if (records.some((item) => item.exchange === expectedMx())) return { status:'ACTIVE', records, error:null };
    return { status:'MISMATCH', records, error:`MX 未指向 ${expectedMx()}。` };
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    if (['ENODATA','ENOTFOUND','ENONAME','NXDOMAIN'].includes(code)) {
      return { status:'NOT_FOUND', records:[], error:'未查询到 MX 记录。' };
    }
    return { status:'UNAVAILABLE', records:[], error:code === 'ETIMEOUT' ? 'DNS 查询超时，请稍后重试。' : 'DNS 暂时无法查询，本次不会改变服务状态。' };
  } finally {
    clearTimeout(timer);
  }
}

// DNS health and administrative approval are separate gates. In particular,
// a shared MX target proves routing, not ownership of a private domain.
export function domainDnsTransition(current, lookup) {
  const transient = lookup.status === 'UNAVAILABLE';
  return {
    status: current.status === 'PENDING' && current.kind !== 'PRIVATE' && lookup.status === 'ACTIVE'
      ? 'ACTIVE' : current.status,
    mxStatus: transient ? current.mx_status : lookup.status,
    records: transient ? current.mx_records_json ?? [] : lookup.records,
    error: lookup.error,
  };
}

async function writeAudit(connection, { actorUserId, domain, before, after, ipAddress, automatic }) {
  await connection.execute(`
    INSERT INTO audit_logs(public_id,actor_user_id,action,entity_type,entity_id,detail_json,ip_address)
    VALUES (?,?,?,'DOMAIN',?,?,?)
  `, [randomUUID(), actorUserId || null, automatic ? '自动检测域名 DNS' : '检测域名 DNS', domain,
    JSON.stringify({ before, after, expectedMx:expectedMx() }), ipAddress || null]);
}

export function getDomainDnsConfiguration() {
  const intervalMs = Math.max(60000, Number(process.env.DOMAIN_DNS_CHECK_INTERVAL_MS || 900000));
  return { expectedMx:expectedMx(), intervalMinutes:Math.round(intervalMs / 60000) };
}

/**
 * @param {{domain:string, actorUserId?:number|null, ipAddress?:string|null, automatic?:boolean}} options
 */
export async function verifyDomainDns({ domain, actorUserId=null, ipAddress=null, automatic=false }, dependencies = {}) {
  const value = normalizeHost(domain);
  const connection = await openDatabase();
  let initial;
  try {
    const [[row]] = await connection.execute(`
      SELECT d.id,d.domain,d.kind,d.status,d.mx_status,d.mx_records_json,d.mailbox_count,u.email AS owner
      FROM domains d LEFT JOIN users u ON u.id=d.owner_user_id WHERE d.domain=? LIMIT 1
    `, [value]);
    if (!row) throw Object.assign(new Error('域名不存在。'), { status:404 });
    if (row.kind === 'RELAY') return { ...publicResult(row), skipped:true, skip_reason:'中继域名由中继服务维护。' };
    initial = row;
  } finally {
    connection.release();
  }

  const lookup = await (dependencies.lookupMx || lookupMx)(value);
  const updateConnection = await openDatabase();
  try {
    await updateConnection.beginTransaction();
    const [[current]] = await updateConnection.execute(`
      SELECT d.id,d.domain,d.kind,d.status,d.mx_status,d.mx_records_json,d.mailbox_count,u.email AS owner
      FROM domains d LEFT JOIN users u ON u.id=d.owner_user_id WHERE d.id=? FOR UPDATE
    `, [initial.id]);
    if (!current) throw Object.assign(new Error('域名不存在。'), { status:404 });

    // The kind may have changed while the external lookup was in progress.
    if (current.kind === 'RELAY') {
      await updateConnection.commit();
      return { ...publicResult(current), skipped:true, skip_reason:'中继域名由中继服务维护。' };
    }
    const next = domainDnsTransition(current, lookup);
    const nextStatus = next.status;
    const records = typeof next.records === 'string' ? next.records : JSON.stringify(next.records);
    await updateConnection.execute(`
      UPDATE domains SET mx_status=?,mx_checked_at=UTC_TIMESTAMP(3),mx_records_json=?,mx_error=?,status=? WHERE id=?
    `, [next.mxStatus, records, next.error, nextStatus, current.id]);
    const [[updated]] = await updateConnection.execute(`
      SELECT d.domain,d.kind,d.status,d.mx_status,d.mx_checked_at,d.mx_records_json,d.mx_error,d.mailbox_count,u.email AS owner
      FROM domains d LEFT JOIN users u ON u.id=d.owner_user_id WHERE d.id=?
    `, [current.id]);
    if (!automatic || current.mx_status !== next.mxStatus || current.status !== nextStatus) {
      await writeAudit(updateConnection, {
        actorUserId, domain:value, ipAddress, automatic,
        before:{ mx_status:current.mx_status, status:current.status },
        after:{ mx_status:next.mxStatus, status:nextStatus, records:lookup.records, error:lookup.error },
      });
    }
    await updateConnection.commit();
    return publicResult(updated);
  } catch (error) {
    await updateConnection.rollback();
    throw error;
  } finally {
    updateConnection.release();
  }
}

export async function verifyAllDomainDns({ actorUserId=null, ipAddress=null, automatic=false } = {}) {
  const connection = await openDatabase();
  let domains;
  try {
    const [rows] = await connection.query("SELECT domain FROM domains WHERE kind<>'RELAY' ORDER BY id");
    domains = rows.map((row) => row.domain);
  } finally {
    connection.release();
  }
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length:Math.min(4, Math.max(1, domains.length)) }, async () => {
    while (cursor < domains.length) {
      const domain = domains[cursor++];
      try { results.push(await verifyDomainDns({ domain, actorUserId, ipAddress, automatic })); }
      catch (error) { results.push({ domain, mx_status:'UNAVAILABLE', error:'检测失败，请稍后重试。' }); }
    }
  });
  await Promise.all(workers);
  return { checked:results.length, expectedMx:expectedMx(), results };
}

export function startDomainDnsMonitor({ intervalMs=Number(process.env.DOMAIN_DNS_CHECK_INTERVAL_MS || 900000) } = {}) {
  const delay = Math.max(60000, Number(intervalMs) || 900000);
  let stopped = false;
  let running = false;
  let timer;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await verifyAllDomainDns({ automatic:true });
      console.info(`[domain-dns] checked ${result.checked} domain(s)`);
    } catch (error) {
      console.error('[domain-dns] automatic check failed', error);
    } finally {
      running = false;
    }
  };
  timer = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), delay);
    timer.unref?.();
  }, 5000);
  timer.unref?.();
  return { async stop() { stopped = true; clearTimeout(timer); clearInterval(timer); while (running) await new Promise((resolve) => setTimeout(resolve, 50)); } };
}
