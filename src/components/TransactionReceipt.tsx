import {useState} from 'react';
import '../styles/audit-retention.css';
type Receipt={requestId:string|null;referenceId:string|null;processedAt:string;protected:boolean};
export default function TransactionReceipt({id}:{id:string}){
 const [data,setData]=useState<Receipt|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function toggle(){if(open){setOpen(false);return;}setOpen(true);if(data||busy)return;setBusy(true);setError('');try{const r=await fetch('/api/admin/transaction-receipt?id='+encodeURIComponent(id),{signal:AbortSignal.timeout(10000)}),p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||'读取详情失败。');setData(p.receipt);}catch(e){setError(e instanceof Error?e.message:'读取详情失败。');}finally{setBusy(false);}}
 return <div className="transaction-receipt"><button className="admin-secondary" aria-expanded={open} onClick={()=>void toggle()}>处理详情</button>{open&&<div className="transaction-receipt-detail">{busy&&<p>正在读取…</p>}{error&&<p role="alert">{error}</p>}{data&&<><strong>已记账</strong><p>关联编号：<code>{data.referenceId||'无'}</code></p><p>请求编号：<code>{data.requestId||'无独立请求凭据'}</code></p><p>处理时间：{new Date(data.processedAt).toLocaleString()}</p><p>{data.protected?'重复提交将返回原结果，不会重复扣费或入账。':'此记录无可展示的独立凭据，不据此判断其业务防重复状态。'}</p></>}</div>}</div>;
}
