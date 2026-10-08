import { useEffect, useRef, useState } from 'react';
import { useTranslator } from '../lib/useTranslator';
import '../styles/admin-updates.css';

export type UpdateStatus = {
  currentVersion: string;
  repository: string | null;
  source?: string | null;
  cached?: boolean;
  status: 'unconfigured' | 'invalid-config' | 'available' | 'current' | 'ahead' | 'unavailable';
  checkedAt: string | null;
  lastSuccessAt: string | null;
  retryAt: string | null;
  latest: { version: string; notes: string; url: string | null; publishedAt: string; comparison: number } | null;
};
const labels = {
  unconfigured: '发布源尚未配置',
  'invalid-config': '发布配置无效',
  available: '发现新版本',
  current: '已是最新正式版本',
  ahead: '当前版本领先于正式发布版',
  unavailable: '暂时无法检查更新',
};
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : '—';

export function UpdateView({ update, busy, error, feedback = '', compact = false, onCheck }: {
  update: UpdateStatus | null; busy: boolean; error: string; feedback?: string; compact?: boolean; onCheck: () => void;
}) {
  const t = useTranslator();
  const available = Boolean(update?.latest && update.latest.comparison > 0);
  if (compact) return <div className={`admin-update-notice${available ? ' has-update' : ''}`} aria-live="polite">
    <span>{t('当前版本')} <strong>{update?.currentVersion || '—'}</strong></span>
    <a href="/admin/settings.cgi#updates" onClick={() => window.dispatchEvent(new Event('nodemail:open-updates'))}>{t(available ? '发现新版本' : '版本信息')}{available ? ` ${update?.latest?.version}` : ''} <span aria-hidden="true">→</span></a>
  </div>;
  const label = busy ? '正在检查版本…' : error ? '版本检查失败，请稍后重试。' : update ? labels[update.status] : '正在检查版本…';
  return <section className="admin-panel admin-updates">
    <header><div><h2>{t('版本更新')}</h2><p>{t('接收正式版本通知，由你决定何时升级。')}</p></div><span className={`admin-badge ${available ? 'info' : ''}`}>{t('仅通知，不自动安装')}</span></header>
    <div className="admin-updates-body">
      <div className="admin-update-summary"><div><small>{t('当前版本')}</small><strong>{update?.currentVersion || '—'}</strong></div>
        <div><small>{t('最新正式版本')}</small><strong>{update?.latest?.version || '—'}</strong></div>
        <button type="button" className="admin-primary" disabled={busy} onClick={onCheck}>{t(busy ? '检查中…' : '检查更新')}</button>
      </div>
      <p className="admin-update-status" role="status">{t(label)}</p>
      {feedback && !busy && !error && <p role="status">{t(feedback)}</p>}
      {update?.status === 'unconfigured' && <p>{t('尚未配置版本信息源，请联系发布者接通；再次检查不会自动完成配置。')}</p>}
      {update?.status === 'invalid-config' && <p>{t('请联系发布者核对安装包的版本号与版本信息源。')}</p>}
      {(update?.status === 'unavailable' || error) && <p>{t('请稍后重试；网络异常、发布源不可访问或尚无正式版本都可能导致检查失败，不影响邮箱服务。')}</p>}
      {update?.latest && <div className="admin-update-release">
        <div className="admin-update-release-heading"><h3>{t('更新说明')}</h3>{update.latest.url && <a href={update.latest.url} target="_blank" rel="noopener noreferrer">{t('查看发布详情与更新指引')} ↗</a>}</div>
        {(update.status === 'unavailable' || error) && <p>{t('以下是上次成功检查的版本信息，可能已过时。')}</p>}
        <p className="admin-update-notes">{update.latest.notes || t('此版本未提供更新说明，请查看发布详情。')}</p>
      </div>}
      <dl className="admin-update-meta"><div><dt>{t('版本信息源')}</dt><dd>{update?.source || update?.repository || '—'}</dd></div>
        <div><dt>{t('最近成功检查')}</dt><dd>{formatTime(update?.lastSuccessAt || null)}</dd></div>
        <div><dt>{t('最近尝试时间')}</dt><dd>{formatTime(update?.checkedAt || null)}</dd></div></dl>
      <p className="admin-update-help">{t('后台打开期间定期检查，服务端缓存 6 小时；手动检查至少间隔 1 分钟。只读取公开版本信息，不上传账号、邮件或配置。')}</p>
      <p className="admin-update-help">{t('升级前请阅读对应版本的说明并备份配置和数据；此页面不会下载程序、修改数据库或执行更新命令。')}</p>
    </div>
  </section>;
}

export default function AdminUpdates({ compact = false }: { compact?: boolean }) {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const pending = useRef<AbortController | null>(null);
  async function check(force = false) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(''); setFeedback('');
    try {
      const response = await fetch('/api/admin/updates', {
        method: force ? 'POST' : 'GET',
        ...(force ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.update) throw new Error('Update check failed');
      if (!controller.signal.aborted) {
        setUpdate(data.update);
        if (force && !['unconfigured', 'invalid-config', 'unavailable'].includes(data.update.status)) {
          setFeedback(data.update.cached ? '已显示最近检查结果；手动联网检查至少间隔 1 分钟。' : '检查完成，版本信息已刷新。');
        }
      }
    } catch {
      if (!controller.signal.aborted) setError('版本检查失败，请稍后重试。');
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void check();
    const refresh = () => { if (document.visibilityState === 'visible') void check(); };
    const timer = window.setInterval(refresh, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); pending.current?.abort(); pending.current = null; };
  }, []);
  return <UpdateView update={update} busy={busy} error={error} feedback={feedback} compact={compact} onCheck={() => void check(true)} />;
}
