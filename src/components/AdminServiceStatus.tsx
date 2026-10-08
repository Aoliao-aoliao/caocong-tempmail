import { useEffect, useState } from 'react';

export default function AdminServiceStatus() {
  const [result, setResult] = useState<{smtp:boolean; checkedAt:string} | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/admin/health', { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || '服务状态检测失败。');
      setResult(data);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message || '服务状态检测失败。'); });
    return () => controller.abort();
  }, []);
  const unknown = error ? '检测失败' : '检测中';
  const rows = [
    ['网站应用', result ? '管理接口响应正常' : '等待本次检测结果', result ? '在线' : unknown, !result],
    ['MySQL 数据库', result ? '会话数据库查询成功' : '等待本次检测结果', result ? '在线' : unknown, !result],
    ['邮件接收服务（SMTP）', result ? result.smtp ? '本机 SMTP 220 响应正常' : '本机 SMTP 未响应，请检查服务' : '等待本次检测结果', result ? result.smtp ? '在线' : '未响应' : unknown, !result?.smtp],
  ] as const;
  return <>
    <div className="admin-health-list" aria-live="polite">
      {rows.map(([name, detail, status, warning]) => <div key={name}><i className={warning ? 'warn' : ''}/><span><strong>{name}</strong><small>{detail}</small></span><b>{status}</b></div>)}
    </div>
    <p className="admin-service-note">{error || (result ? `检测时间：${new Date(result.checkedAt).toLocaleString('zh-CN')}` : '正在检测服务…')}<br/>SMTP 检测不发送邮件，不代表外网投递或 Gmail 中继收信已验证。<a href="/openapi/docs.cgi">查看 OpenAPI 文档 →</a></p>
  </>;
}
