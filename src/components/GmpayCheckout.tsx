import {useEffect,useRef,useState} from 'react';
import {useTranslator} from '../lib/useTranslator';
export type CheckoutOrder={id:string;status:string;points:number;amountUsdCents:number;actualAmount:string|number;receiveAddress:string;qrCodeDataUrl:string;paymentUrl:string;expiresAt:string};
export default function GmpayCheckout({order,onClose,onPaid,onRestart,actionBusy=false,actionMessage=''}:{order:CheckoutOrder;onClose:()=>void;onPaid:(id:string)=>void;onRestart?:()=>void;actionBusy?:boolean;actionMessage?:string}){
 const t=useTranslator();
 const [now,setNow]=useState(Date.now()),[message,setMessage]=useState('等待链上确认，请勿重复转账。'),[busy,setBusy]=useState(false),[paid,setPaid]=useState(false);const lock=useRef(false),paidOnce=useRef(false),callback=useRef(onPaid),query=useRef<()=>Promise<void>>(async()=>{});callback.current=onPaid;
 const expired=Date.parse(order.expiresAt)<=now;
 useEffect(()=>{let alive=true,controller:AbortController|undefined;const tick=setInterval(()=>setNow(Date.now()),1000);
  query.current=async()=>{if(lock.current||paidOnce.current||!alive)return;lock.current=true;setBusy(true);controller=new AbortController();const timer=setTimeout(()=>controller?.abort(),12000);try{const r=await fetch('/api/user/recharge/gmpay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'query',id:order.id}),signal:controller.signal});const p=await r.json();if(!r.ok||!p.ok)throw Error(p.message||'查询失败，请勿重复转账。');if(!alive)return;if(p.result.status==='PAID'){paidOnce.current=true;setPaid(true);setMessage('付款已核实，积分已到账。');callback.current(order.id);}else setMessage(p.result.message||'等待已验签到账通知；请勿重复转账。');}catch(e){if(alive)setMessage(e instanceof Error&&e.name!=='AbortError'?e.message:'查询超时，请稍后再查；不要重复转账。');}finally{clearTimeout(timer);lock.current=false;if(alive)setBusy(false);}};
  const poll=setInterval(()=>void query.current(),15000);return()=>{alive=false;clearInterval(tick);clearInterval(poll);controller?.abort();};
 },[order.id]);
 async function copy(value:string){try{await navigator.clipboard.writeText(value);setMessage('已复制。转账前请再次核对网络、地址和精确数量。');}catch{setMessage('复制失败，请手动复制并核对。');}}
 const seconds=Math.max(0,Math.floor((Date.parse(order.expiresAt)-now)/1000));
 return <section className="gmpay-inline" aria-label="USDT 付款信息">
 {!paid&&!expired?<>
  <div className="qr-stage"><img src={order.qrCodeDataUrl} alt="TRON 收款地址二维码" width={240} height={240}/><small>使用所选方式完成支付</small><div className="gmpay-exact-amount"><span>精确数量</span><strong>{String(order.actualAmount)} USDT</strong><button type="button" aria-label="复制精确付款数量" onClick={()=>void copy(String(order.actualAmount))}>复制</button></div></div>
  <details className="gmpay-payment-details"><summary>收款地址 · 剩余 {Math.floor(seconds/60)} 分 {seconds%60} 秒</summary><div className="gmpay-address-row"><span className="gmpay-address">{order.receiveAddress}</span><button type="button" aria-label="复制收款地址" onClick={()=>void copy(order.receiveAddress)}>复制</button></div><p>仅限 TRON 主网 USDT（TRC20），不要发送 TRX 或使用其他网络。二维码仅包含地址；请填写上方精确数量，不要取整，手续费另计。</p><p className="gmpay-order-id">订单：{order.id}</p><a href={order.paymentUrl} target="_blank" rel="noopener noreferrer">打开 GMPay 官方收银台 ↗</a></details>
 </>:<p>{paid?'付款已确认，积分已到账。':'付款时限已过，请勿再向此订单转账。已转账仍可查询到账。'}</p>}
 <button className="gmpay-payment-state" type="button" disabled>{paid?'积分已到账':expired?'支付时限已过':'等待支付'}</button>
 <p className="gmpay-query-message" role="status">{t(actionMessage||message)}</p>
 {expired&&!paid&&onRestart&&<p className="gmpay-query-message">{t('仅未转账时重新生成；已转账请继续查询原订单。')}</p>}
 <div className="gmpay-inline-actions"><button type="button" disabled={busy||paid||actionBusy} onClick={()=>void query.current()}>{t(busy?'正在查询…':'查询到账')}</button><button type="button" disabled={actionBusy} onClick={onClose}>{t('返回选择')}</button>{expired&&!paid&&onRestart&&<button type="button" disabled={busy||actionBusy} onClick={onRestart}>{t(actionBusy?'正在核实付款…':'未转账，重新生成')}</button>}</div>
 </section>;
}
