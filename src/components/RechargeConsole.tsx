import {useRef,useState} from 'react';
import GmpayCheckout,{type CheckoutOrder} from './GmpayCheckout';
import PaymentPicker from './PaymentPicker';
import MemberOrderHistory,{PendingRechargeOrders,type HistoryPagination} from './MemberHistory';
type Plan={code:string;points:number;amount_usd_cents:number};
type PaymentView={enabled:boolean;plans:{code:string;points:number;energy:number}[]};
type Channel={code:string;mode:string;label:string;token?:string;network?:string;description?:string};
export default function RechargeConsole({plans,initialView,initialGmpay={enabled:false,origin:""},orders,pagination}:{plans:Plan[];channels:Channel[];initialView:PaymentView;initialGmpay?:{enabled:boolean;origin:string};orders:any[];pagination:HistoryPagination}){
 const [view,setView]=useState(initialView),[planCode,setPlanCode]=useState(''),[channelCode,setChannelCode]=useState(initialView.enabled?'NODELOC_ENERGY':initialGmpay.enabled?'GMPAY_USDT':''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[revision,setRevision]=useState(0),[historyMessage,setHistoryMessage]=useState(''),[checkout,setCheckout]=useState<CheckoutOrder|null>(null);
 const lock=useRef(false),request=useRef<{id:string;code:string;energy:number;points:number}|null>(null);
 const gmpayRequest=useRef<{id:string;code:string;amount:number;points:number;orderId?:string;order?:CheckoutOrder;replacesOrderId?:string}|null>(null);
 const [checkoutMessage,setCheckoutMessage]=useState('');
 const choices:Channel[]=[...(view.enabled?[{code:'NODELOC_ENERGY',mode:'NODELOC',label:'NodeLoc 能量',description:'账户能量 · 自动到账'}]:[]),...(initialGmpay.enabled?[{code:'GMPAY_USDT',mode:'GMPAY',label:'USDT / TRC20',description:'TRON 主网 · 自动到账'}]:[])];
 const selected=choices.find(c=>c.code===channelCode)||choices[0];
 const isNodeLoc=selected?.mode==='NODELOC',isGmpay=selected?.mode==='GMPAY';
 const plan=plans.find(p=>p.code===planCode),energyPlan=view.plans.find(p=>p.code===planCode);
 const canCreate=!!plan&&!!selected&&(!isNodeLoc||!!energyPlan)&&!busy;
 async function act(action:'create'|'continue'|'query',id?:string,type?:string){
  if(lock.current)return;if(action==='create'&&!canCreate)return;
  const remembered=gmpayRequest.current;
  if(action==='create'&&!id&&isGmpay&&remembered&&plan&&remembered.code===plan.code&&remembered.amount===plan.amount_usd_cents&&remembered.points===plan.points&&remembered.order&&!remembered.replacesOrderId&&Date.parse(remembered.order.expiresAt)<=Date.now()){
   setCheckoutMessage('');setCheckout(remembered.order);return;
  }
  const feedback=action==='create'?(id?setCheckoutMessage:setMessage):setHistoryMessage;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  lock.current=true;setBusy(true);feedback(action==='query'?'正在核实付款…':'正在创建订单…');
  try{
   const gmpayAction=action==='create'?isGmpay:type==='GMPAY';
   const nodeAction=!gmpayAction&&(action!=='create'||isNodeLoc);
   let body:any={action,id};
   if(action==='create'&&gmpayAction&&plan){
    if(!gmpayRequest.current||gmpayRequest.current.code!==plan.code||gmpayRequest.current.amount!==plan.amount_usd_cents||gmpayRequest.current.points!==plan.points||(id&&gmpayRequest.current.replacesOrderId!==id))gmpayRequest.current={id:crypto.randomUUID(),code:plan.code,amount:plan.amount_usd_cents,points:plan.points,...(id?{replacesOrderId:id}:{})};
    body={action,planCode:plan.code,expectedAmountUsdCents:plan.amount_usd_cents,expectedPoints:plan.points,requestId:gmpayRequest.current.id,...(gmpayRequest.current.replacesOrderId?{replacesOrderId:gmpayRequest.current.replacesOrderId}:{})};
   }else if(action==='create'&&nodeAction&&energyPlan){
    if(!request.current||request.current.code!==energyPlan.code||request.current.energy!==energyPlan.energy||request.current.points!==energyPlan.points)request.current={id:crypto.randomUUID(),...energyPlan};
    body={action,planCode:energyPlan.code,expectedEnergy:energyPlan.energy,expectedPoints:energyPlan.points,requestId:request.current.id};
   }else if(action==='create')throw Error('请选择已接入的在线支付渠道。');
   const response=await fetch(gmpayAction?'/api/user/recharge/gmpay':nodeAction?'/api/user/recharge/nodeloc':'/api/user/recharge/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
   const data=await response.json().catch(()=>{throw Error('处理结果无法读取，请查询原订单；请勿重复支付。');});if(!response.ok||!data.ok)throw Error(data.message||'订单处理失败。');
   if(!nodeAction&&!gmpayAction)feedback('待支付订单已创建。该渠道尚未接入在线付款，不会自动扣款或到账。');
   else if(data.result.status==='PAID'){feedback('支付已核实，积分已到账。刷新页面可更新顶部余额。');if(action==='create'){if(gmpayAction){gmpayRequest.current=null;setCheckout(null);setMessage('支付已核实，积分已到账。刷新页面可更新顶部余额。');}else request.current=null;}}
   else if(data.result.paymentUrl){const target=new URL(data.result.paymentUrl);if((gmpayAction?(target.protocol!=='https:'||target.origin!==initialGmpay.origin||!/^\/pay\/checkout-counter\/[\w-]{1,128}$/.test(target.pathname)):(target.origin!=='https://www.nodeloc.com'||!target.pathname.startsWith('/payment/')))||target.username||target.password||target.search||target.hash)throw Error('支付链接无效。');if(gmpayAction){if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.result.qrCodeDataUrl||'')||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(data.result.receiveAddress||'')||!/^\d+(?:\.\d{1,6})?$/.test(String(data.result.actualAmount))||!Number.isFinite(Date.parse(data.result.expiresAt)))throw Error('付款信息不完整，请查询原订单，不要转账。');if(action==='create'&&gmpayRequest.current){gmpayRequest.current.orderId=data.result.id;gmpayRequest.current.order=data.result;delete gmpayRequest.current.replacesOrderId;}setCheckoutMessage('');setChannelCode('GMPAY_USDT');const matchedPlan=plans.find(p=>p.points===data.result.points&&p.amount_usd_cents===data.result.amountUsdCents);setPlanCode(matchedPlan?.code||'');setCheckout(data.result);if(!id)feedback('付款信息已生成，请按精确数量转账。');}else window.location.assign(target.href);return;}
   else feedback(gmpayAction?data.result.message||'请等待已验签到账回调；不要重复转账。':'暂未确认付款，请稍后再次查询；请勿重复支付。');
  }catch(e){feedback(controller.signal.aborted?'请求超时，请查询原订单核实结果；请勿重复支付。':e instanceof Error?e.message:'订单处理失败，请查询原订单。');}
  finally{
   clearTimeout(timer);
   const refreshController=new AbortController(),refreshTimer=setTimeout(()=>refreshController.abort(),5000);
   try{const r=await fetch('/api/user/recharge/nodeloc',{signal:refreshController.signal});const p=await r.json();if(r.ok&&p.ok)setView(p);}catch{}finally{clearTimeout(refreshTimer);}
   setRevision(n=>n+1);lock.current=false;setBusy(false);
  }
 }
 return <div className="unified-recharge">
  <div className="recharge-shell">
   <div className="recharge-left-column"><section className="recharge-main">
    <div className="section-heading"><span>选择充值档位</span><small>请选择固定充值档位，充值金额不可自定义。</small></div>
    <div className="plan-grid">{plans.map(p=>{
     const energy=view.plans.find(x=>x.code===p.code);const unavailable=isNodeLoc&&!energy;
     return <label className={`plan-option${unavailable?' unavailable':''}`} key={p.code}><input type="radio" name="recharge-plan" value={p.code} checked={planCode===p.code} disabled={busy||unavailable} onChange={()=>{setCheckout(null);setPlanCode(p.code);setMessage('');}}/><span><strong>{isNodeLoc&&energy?energy.points:p.points} 积分</strong><small>{isNodeLoc?(energy?`${energy.energy} NodeLoc 能量`:'该渠道不出售此档位'):`${String(p.amount_usd_cents/100)} USD`}</small></span></label>;
    })}</div>
    <div className="section-heading payment-heading"><span>选择支付方式</span><small>请选择本次订单使用的支付方式。</small></div>
    <PaymentPicker channels={choices} selectedCode={channelCode} disabled={busy} onChange={code=>{setCheckout(null);setChannelCode(code);setMessage('');}}/>
   </section>
   <PendingRechargeOrders orders={orders} revision={revision} paymentEnabled={view.enabled} gmpayEnabled={initialGmpay.enabled} paymentBusy={busy} actionMessage={historyMessage} onPaymentAction={(action,id,type)=>void act(action,id,type)}/>

   </div>
   <aside className="order-panel">
    <span className="order-label">本次充值</span><strong className="order-score">{checkout?.points||(isNodeLoc?energyPlan?.points:plan?.points)||0} 积分</strong>
    <p className="order-payable">应付 {checkout?`${String(checkout.amountUsdCents/100)} USD`:!plan?'—':isNodeLoc?(energyPlan?`${energyPlan.energy} NodeLoc 能量`:'—'):`${String(plan.amount_usd_cents/100)} USD`}</p>
    {checkout?<GmpayCheckout key={checkout.id} order={checkout} actionBusy={busy} actionMessage={checkoutMessage} onRestart={initialGmpay.enabled&&plan&&plan.points===checkout.points&&plan.amount_usd_cents===checkout.amountUsdCents?()=>void act('create',checkout.id,'GMPAY'):undefined} onClose={()=>{setCheckout(null);setCheckoutMessage('');}} onPaid={id=>{if(gmpayRequest.current?.orderId===id)gmpayRequest.current=null;setMessage('付款已核实，积分已到账。刷新页面可更新顶部余额。');setRevision(n=>n+1);}}/>:<>
    <div className="qr-stage recharge-code-placeholder" aria-label="付款码尚未生成"><span aria-hidden="true">{isNodeLoc?'N':'₮'}</span><small>{isNodeLoc?'使用 NodeLoc 账户能量完成支付':'选择档位后生成 USDT / TRC20 付款码'}</small></div>
    <button className="create-order" type="button" disabled={!canCreate} onClick={()=>void act('create')}>{busy?'正在处理…':isNodeLoc?'前往 NodeLoc 支付':isGmpay?'生成 USDT 付款码':'暂无可用支付方式'}</button>
    <p className="order-status" role="status" aria-live="polite">{message||(!selected?'暂无已启用的在线支付方式，请稍后再试。':!plan?'请选择充值档位。':isNodeLoc&&!energyPlan?'请选择此渠道可用的档位。':'核对金额与支付方式后继续。')}</p>
    </>}
   </aside>
  </div>
   <details className="recharge-history"><summary>全部充值订单 · 搜索与翻页</summary><MemberOrderHistory orders={orders} pagination={pagination} revision={revision} paymentEnabled={view.enabled} gmpayEnabled={initialGmpay.enabled} paymentBusy={busy} actionMessage={historyMessage} onPaymentAction={(action,id,type)=>void act(action,id,type)}/></details>
  {!initialGmpay.enabled&&<p className="recharge-history-feedback">USDT 在线支付尚未启用，请管理员在充值配置中填写 GMPay 凭证并启用。</p>}

 </div>;
}
