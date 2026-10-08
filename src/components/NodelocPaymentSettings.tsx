import {useEffect,useRef,useState,type FormEvent} from 'react';
export default function NodelocPaymentSettings({plans}:{plans:any[]}){
 const [config,setConfig]=useState<any>(null),[privateKey,setPrivateKey]=useState(''),[message,setMessage]=useState('正在读取配置…'),[busy,setBusy]=useState(false),[savedPid,setSavedPid]=useState('');
 const saving=useRef(false),keyFields=useRef<HTMLDetailsElement>(null);
 const merchantChanged=Boolean(config)&&config.pid.trim()!==savedPid;
 useEffect(()=>{let alive=true;fetch('/api/admin/nodeloc-payment').then(r=>r.json()).then(r=>{if(alive){if(!r.ok)throw Error(r.message);setConfig(r.config);setSavedPid(r.config.pid);setMessage('');}}).catch(e=>{if(alive)setMessage(e.message||'读取失败。');});return()=>{alive=false;};},[]);
 async function save(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(saving.current||!config)return;
  const form=e.currentTarget;
  if(form.querySelector("textarea:invalid")&&keyFields.current)keyFields.current.open=true;
  if(!form.checkValidity()){setMessage('未保存：请补齐必填项，并检查网址和能量价格是否有效。');form.reportValidity();return;}
  if((merchantChanged||!config.keyConfigured)&&!privateKey.trim()){if(keyFields.current)keyFields.current.open=true;setMessage('未保存：更换商户 ID 必须重新填写该应用配套的商户 RSA 私钥。');return;}
  if(!config.unitRateConfirmed){setMessage('未保存：请先在 NodeLoc 设置汇率为 1，再勾选汇率确认。');return;}
  saving.current=true;setBusy(true);setMessage('正在保存支付配置…');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch('/api/admin/nodeloc-payment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...config,pid:config.pid.trim(),privateKey}),signal:controller.signal});
   let result;try{result=await response.json();}catch{throw Error('保存结果无法读取，请刷新页面核对配置；不要重复提交。');}
   if(!response.ok||!result.ok)throw Error(result.message||'保存失败。');
   setConfig(result.config);setSavedPid(result.config.pid);setPrivateKey('');setMessage('支付配置已保存。启用前请完成一笔小额真实付款验收。');
  }catch(e){setMessage(controller.signal.aborted?'保存请求超时，请刷新页面核对配置是否已保存；不要重复提交。':e instanceof Error?e.message:'保存失败，请检查网络后刷新页面核对配置。');}
  finally{clearTimeout(timer);saving.current=false;setBusy(false);}
 }
 return <section className="admin-panel nl-payment"><header><div><h2>NodeLoc 能量支付</h2><p>仅超级管理员可配置。用户支付 NodeLoc 能量，获得本站积分；不是人民币或 USDT。</p></div></header>
 {config&&<form noValidate onSubmit={save} aria-busy={busy}><fieldset className="nl-settings-fields" disabled={busy}><div className="nl-form-grid">
 <label>商户 ID（易支付 pid）<input required inputMode="numeric" pattern="[1-9][0-9]{0,17}" value={config.pid} onChange={e=>setConfig({...config,pid:e.target.value})}/></label>
 <label>本站 HTTPS 根地址<input required type="url" value={config.siteOrigin} onChange={e=>setConfig({...config,siteOrigin:e.target.value})}/></label>
 </div><details className="nl-key-settings" ref={keyFields} open={!config.keyConfigured}><summary>RSA 密钥配置 <span>{config.keyConfigured?"已配置 · 点击修改":"尚未配置"}</span></summary><div className="nl-form-grid">
 <label>商户 RSA 私钥<textarea autoComplete="off" spellCheck={false} rows={5} value={privateKey} placeholder={merchantChanged?'商户已变更，必须重新填写对应私钥':config.keyConfigured?'已加密保存；同一商户留空保留原私钥':'填写 NodeLoc 应用的商户私钥'} onChange={e=>setPrivateKey(e.target.value)}/><small>更换商户 ID 时必须重新填写对应私钥；商户公钥应保存在同一 NodeLoc 应用中。</small></label>
 <label>NodeLoc 平台 RSA 公钥<textarea required spellCheck={false} rows={5} value={config.platformKey} onChange={e=>setConfig({...config,platformKey:e.target.value})}/></label>
 </div><p>在 <a href="https://www.nodeloc.com/payment/applications" target="_blank" rel="noreferrer">NodeLoc 支付应用</a>获取以上信息；应用需审批通过。网关固定为 NodeLoc 官方地址。</p></details>
 <div className="nl-settings-switches"><label className="nl-check"><input type="checkbox" checked={config.enabled} onChange={e=>setConfig({...config,enabled:e.target.checked})}/>启用 NodeLoc 能量支付</label>
 <label className="nl-check"><input type="checkbox" checked={config.unitRateConfirmed} onChange={e=>setConfig({...config,unitRateConfirmed:e.target.checked})}/>我已在 NodeLoc 应用设置“1 单位货币 = 1 能量”（默认 100 必须改为 1）</label></div>
 <h3>能量价格</h3><p>每个档位单独设置，0 表示不出售。不改变原有美元价格；本站积分以充值档位配置为准。</p><div className="nl-price-grid">{plans.map(p=><label key={p.code}>{p.points} 本站积分<input aria-label={`${p.code} 能量价格`} type="number" min="0" max="100000000" step="1" value={config.prices[p.code]||0} onChange={e=>setConfig({...config,prices:{...config.prices,[p.code]:Number(e.target.value)}})}/><small>NodeLoc 能量</small></label>)}</div>
 <p className="nl-url">付款通知：{config.siteOrigin.replace(/\/$/,'')}/api/payment/nodeloc-notify</p>
 </fieldset>
 <div className="nl-settings-save"><p className="nl-settings-message" role="status" aria-live="polite">{message}</p><button className="nl-button" disabled={busy} type="submit">{busy?'正在保存…':'保存支付配置'}</button></div></form>}
 {!config&&<p role="status">{message}</p>}</section>;
}
