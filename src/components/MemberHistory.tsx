import {useTranslator} from '../lib/useTranslator';
import { useEffect, useRef, useState, type FormEvent } from 'react';

export type HistoryPagination = { page:number; pages:number; total:number; pageSize:number };
type HistorySection = 'transactions' | 'domains' | 'orders';

export function useMemberHistory(section:HistorySection,initialItems:any[],initialPagination?:HistoryPagination,status?:'PENDING') {
  const t=useTranslator();
  const [items,setItems] = useState(initialItems);
  const [pagination,setPagination] = useState(initialPagination ?? { page:1,pages:1,total:initialItems.length,pageSize:10 });
  const [query,setQuery] = useState('');
  const [appliedQuery,setAppliedQuery] = useState('');
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const request = useRef<{ controller:AbortController|null; sequence:number; page:number; query:string }>({ controller:null,sequence:0,page:1,query:'' });
  useEffect(() => () => { request.current.sequence++;request.current.controller?.abort(); },[]);

  async function load(page:number,q=appliedQuery) {
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = request.current.sequence+1;
    request.current = { controller,sequence,page,query:q };
    setLoading(true);setError('');
    try {
      const params = new URLSearchParams({ section,page:String(page),q:q.trim() });
      if(status)params.set('status',status);
      const response = await fetch(`/api/user/history?${params}`,{ cache:'no-store',headers:{ accept:'application/json' },signal:controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || t("历史记录读取失败。"));
      if (sequence !== request.current.sequence) return;
      setItems(payload.items);setPagination(payload.pagination);setAppliedQuery(q.trim());
    } catch (cause) {
      if (sequence === request.current.sequence && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("历史记录读取失败。"));
    } finally { if (sequence === request.current.sequence) setLoading(false); }
  }
  function search(event:FormEvent) { event.preventDefault();void load(1,query); }
  async function reset() { setQuery('');await load(1,''); }
  return { items,pagination,query,setQuery,loading,error,load,search,reset,retry:() => load(request.current.page,request.current.query) };
}

type HistoryState = ReturnType<typeof useMemberHistory>;
export function MemberHistorySearch({ history,placeholder="搜索历史记录" }:{ history:HistoryState;placeholder?:string }) {
  const t=useTranslator();
  return <>
    <div className="list-tools"><form className="list-search" onSubmit={history.search}>
      <div className="list-search-control"><div className="list-search-field">
        <input type="search" aria-label={t(placeholder)} placeholder={t(placeholder)} value={history.query} maxLength={100} onChange={event => history.setQuery(event.target.value)} />
        <button type="submit" disabled={history.loading}>{t("搜索")}</button>
      </div></div>
    </form></div>
    {history.loading && <p role="status">{t("正在读取历史记录…")}</p>}
    {history.error && <p role="alert">{history.error} <button type="button" onClick={() => void history.retry()} disabled={history.loading}>{t("重试")}</button></p>}
  </>;
}

export function MemberHistoryPagination({ history }:{ history:HistoryState }) {
  const t=useTranslator();
  const { pagination,loading } = history;
  return <nav className="list-pagination" aria-label={t("历史记录分页")}>
    <div className="list-page-summary">{t("共")}{pagination.total}{t("条，每页")}{pagination.pageSize}{t("条")}</div>
    <button type="button" disabled={loading || pagination.page<=1} onClick={() => void history.load(pagination.page-1)}>{t("上一页")}</button>
    <span>{t("第")}{pagination.page} / {pagination.pages}{t("页")}</span>
    <button type="button" disabled={loading || pagination.page>=pagination.pages} onClick={() => void history.load(pagination.page+1)}>{t("下一页")}</button>
  </nav>;
}

const orderState = (value:string) => ({ PENDING:'待支付',PAID:'已支付',CANCELLED:'已取消',EXPIRED:'已过期',FAILED:'支付失败' } as Record<string,string>)[value] || value;
const date = (value:string) => new Date(value).toLocaleString('zh-CN',{ hour12:false });
export default function MemberOrderHistory({ orders,pagination,revision=0,paymentEnabled=false,gmpayEnabled=false,paymentBusy=false,actionMessage="",onPaymentAction }:{ orders:any[];pagination:HistoryPagination;revision?:number;paymentEnabled?:boolean;gmpayEnabled?:boolean;paymentBusy?:boolean;actionMessage?:string;onPaymentAction?:(action:'query'|'continue',id:string,type?:string)=>void }) {
  const t=useTranslator();
  const history = useMemberHistory('orders',orders,pagination);
  const lastRevision=useRef(revision);
  useEffect(()=>{if(lastRevision.current!==revision){lastRevision.current=revision;void history.load(history.pagination.page);}},[revision]);
  return <section className="panel page-panel" aria-busy={history.loading}>
    <div className="panel-header"><div><h2>{t("充值订单记录")}</h2><p>{t("每页 10 笔，使用下方按钮翻页；可搜索订单和状态。")}</p></div></div>
    {actionMessage&&<p className="recharge-history-feedback" role="status" aria-live="polite">{actionMessage}</p>}
    <MemberHistorySearch history={history} placeholder={t("搜索订单编号、渠道、状态或积分")} />
    {history.items.length ? <div className="table-wrap"><table>
      <thead><tr><th>{t("订单编号")}</th><th>{t("积分")}</th><th>{t("金额")}</th><th>{t("渠道")}</th><th>{t("状态")}</th><th>{t("创建时间")}</th>{onPaymentAction&&<th>{t("操作")}</th>}</tr></thead>
      <tbody>{history.items.map(order => <tr key={order.id}><td data-label={t("订单编号")}>{order.id}</td><td data-label={t("积分")}>{order.points}</td><td data-label={t("金额")}>{order.order_type==='NODELOC'?`${order.energy} NodeLoc 能量`:order.order_type==='GMPAY'&&order.actual_amount?`${order.actual_amount} USDT（$${(order.amount_usd_cents/100).toFixed(2)}）`:`$${(order.amount_usd_cents/100).toFixed(2)}`}</td><td data-label={t("渠道")}>{order.channel}</td><td data-label={t("状态")}>{t(orderState(order.status))}</td><td data-label={t("创建时间")}>{date(order.created_at)}</td>{onPaymentAction&&<td data-label={t("操作")}><div className="recharge-history-actions">{['NODELOC','GMPAY'].includes(order.order_type)&&order.status!=='PAID'?<>{order.status==='PENDING'&&(order.order_type==='GMPAY'?gmpayEnabled:paymentEnabled)&&<button type="button" disabled={paymentBusy} onClick={()=>onPaymentAction('continue',order.id,order.order_type)}>继续付款</button>}<button type="button" disabled={paymentBusy} onClick={()=>onPaymentAction('query',order.id,order.order_type)}>查询到账</button></>:<span>{order.status==='PAID'?'已到账':'—'}</span>}</div></td>}</tr>)}</tbody>
    </table></div> : !history.loading && !history.error && <div className="empty-state"><strong>{t("暂无匹配的订单")}</strong></div>}
    <MemberHistoryPagination history={history} />
  </section>;
}


// Query pending orders independently so completed history cannot hide payable orders.
export function PendingRechargeOrders({orders,revision,paymentEnabled,gmpayEnabled,paymentBusy,actionMessage,onPaymentAction}:{orders:any[];revision:number;paymentEnabled:boolean;gmpayEnabled:boolean;paymentBusy:boolean;actionMessage:string;onPaymentAction:(action:'query'|'continue',id:string,type?:string)=>void}) {
 const [now,setNow]=useState(0);
 useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const history=useMemberHistory('orders',orders.filter(o=>o.status==='PENDING'),undefined,'PENDING');
 useEffect(()=>{void history.load(1);},[revision]);
 const pending=history.items.filter(o=>o.status==='PENDING'&&new Date(o.expires_at).getTime()>now);
 const remaining=(value:string)=>{if(!now)return '正在核对有效期…';const seconds=Math.max(0,Math.ceil((Date.parse(value)-now)/1000));return `剩余 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;};
 const cards=(items:any[])=>items.map(order=><article className="pending-order-item" key={order.id}><div className="pending-order-main"><small>{order.channel}</small><strong>{order.points} 积分</strong><span>{order.order_type==='NODELOC'?`${order.energy} 能量`:order.actual_amount?`${order.actual_amount} USDT`:`${(order.amount_usd_cents/100).toFixed(2)} USD`}</span></div><div className="recharge-history-actions pending-order-actions">{['NODELOC','GMPAY'].includes(order.order_type)&&<>{(order.order_type==='GMPAY'?gmpayEnabled:paymentEnabled)&&<button type="button" disabled={paymentBusy} onClick={()=>onPaymentAction('continue',order.id,order.order_type)} className="continue-order">继续付款</button>}<button type="button" disabled={paymentBusy} onClick={()=>onPaymentAction('query',order.id,order.order_type)} className="pending-query">查询到账</button></>}</div><div className="pending-order-meta"><small title={order.id}>{order.id}</small><span title={`创建于 ${date(order.created_at)}`}>{remaining(order.expires_at)}</span></div></article>);
 return <section className="pending-orders" aria-busy={history.loading}><div className="pending-orders-heading"><div><h2>待支付订单</h2><p>可继续未完成的订单，优先显示最近 3 笔。</p></div><span>{history.pagination.total} 笔</span></div>
 {actionMessage&&<p className="recharge-history-feedback" role="status">{actionMessage}</p>}
 {history.loading&&<p role="status">正在读取订单…</p>}{history.error&&<p role="alert">{history.error} <button type="button" onClick={()=>void history.retry()}>重试</button></p>}
 {pending.length?<><div className="pending-order-list">{cards(pending.slice(0,3))}</div>{pending.length>3&&<details className="pending-order-more"><summary>展开本页其他 {pending.length-3} 笔待支付订单</summary><div className="pending-order-list">{cards(pending.slice(3))}</div></details>}</>:!history.loading&&!history.error&&<div className="pending-order-empty">暂无待支付订单</div>}
 {history.pagination.pages>1&&<MemberHistoryPagination history={history}/>}
 </section>;
}
