import { useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { useTranslator } from '../../lib/useTranslator';
import '../../styles/verification-code.css';

export default function VerificationCode({ code }: { code?: string | null }) {
  return code ? <CopyCode key={code} code={code}/> : <span className="verification-code-empty">—</span>;
}

function CopyCode({ code }: { code: string }) {
  const t = useTranslator();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const label = t(status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : '复制验证码');
  return <span className="verification-code" onClick={event => event.stopPropagation()}>
    <span className="verification-code-value">{code}</span>
    <button type="button" className="verification-code-copy" title={label} aria-label={label}
      onClick={async event => { event.stopPropagation(); setStatus(await copyText(code) ? 'copied' : 'failed'); }}>
      {status === 'copied' ? <span aria-hidden="true">✓</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 17v4H4V7h4"/></svg>}
    </button>
    <span className="verification-code-feedback" role="status">{status !== 'idle' ? label : ''}</span>
  </span>;
}
