import {useTranslator} from '../lib/useTranslator';
import {useMemo,useState} from 'react';
import ChoicePicker from './ui/ChoicePicker';
function TokenIcon(){return <svg viewBox="0 0 32 32" focusable="false"><circle cx="16" cy="16" r="16" fill="#26a17b"/><path fill="#fff" d="M8 7h16v4h-6v14h-4V11H8z"/><ellipse cx="16" cy="16" rx="10" ry="2" fill="none" stroke="#fff" strokeWidth="1.2"/></svg>;}
function TronIcon(){return <svg viewBox="0 0 32 32" focusable="false"><circle cx="16" cy="16" r="16" fill="#eb322a"/><path d="M7 6l16 3 4 4-12 15z M7 6l10 9 6-6 M17 15l10-2 M17 15l-2 13" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round"/></svg>;}
type Channel={code:string;mode:string;label:string;token?:string;network?:string;description?:string};
export default function PaymentPicker({channels,selectedCode,onChange,disabled=false}:{channels:Channel[];selectedCode?:string;onChange?:(code:string)=>void;disabled?:boolean}) {
  const t=useTranslator();
  const [localCode,setLocalCode]=useState(channels[0]?.code||'');
  const code=selectedCode??localCode;
  const setCode=(value:string)=>{setLocalCode(value);onChange?.(value);};
  const selected=channels.find(item=>item.code===code)||channels[0];
  const modes=useMemo(()=>Array.from(new Set(channels.map(item=>item.mode))),[channels]);
  const tokens=Array.from(new Set(channels.filter(item=>item.mode===selected?.mode).map(item=>item.token).filter(Boolean))) as string[];
  const networks=channels.filter(item=>item.mode===selected?.mode&&item.token===selected?.token);
  const modeName=(mode:string)=>mode==='CRYPTO'?t("加密支付"):mode==='ALIPAY'?t("支付宝"):mode==='WXPAY'?t("微信支付"):mode==='GMPAY'?t("加密支付"):mode==='NODELOC'?'NodeLoc 能量':channels.find(item=>item.mode===mode)?.label||mode;
  return <div className="payment-selector payment-picker-grid">
    <input type="hidden" data-payment-channel value={selected?.code||''}/>
    <div className="payment-field"><span className="payment-field-label">{t("选择支付方式")}</span><ChoicePicker disabled={disabled} showDetails label={t("选择支付方式")} value={selected?.mode||''} options={modes.map(mode=>({value:mode,label:modeName(mode),icon:['CRYPTO','GMPAY'].includes(mode)?<TokenIcon/>:undefined,symbol:['CRYPTO','GMPAY'].includes(mode)?'₮':mode==='ALIPAY'?'支':mode==='NODELOC'?'N':'微',description:mode==='GMPAY'?'USDT / TRC20':channels.find(item=>item.mode===mode)?.description||(mode==='CRYPTO'?'USDT / USDC':t("支付通道"))}))} onChange={mode=>setCode(channels.find(item=>item.mode===mode)!.code)}/></div>
    {selected?.mode==='CRYPTO'&&<>
      <div className="payment-field"><span className="payment-field-label">{t("币种")}</span><ChoicePicker disabled={disabled} showDetails label={t("币种")} value={selected.token||''} options={tokens.map(token=>({value:token,label:token,symbol:token==='USDT'?'₮':'$'}))} onChange={token=>setCode(channels.find(item=>item.mode==='CRYPTO'&&item.token===token)!.code)}/></div>
      <div className="payment-field"><span className="payment-field-label">{t("网络")}</span><ChoicePicker disabled={disabled} showDetails label={t("网络")} value={selected.code} options={networks.map(item=>({value:item.code,label:item.network||item.label,symbol:(item.network||item.label).slice(0,1)}))} onChange={setCode}/></div>
    </>}
    {selected?.mode==='GMPAY'&&<>
      <div className="payment-field"><span className="payment-field-label">{t("加密支付")}</span><ChoicePicker disabled={disabled} showDetails label={t("币种")} value="USDT" options={[{value:'USDT',label:'USDT',icon:<TokenIcon/>}]} onChange={()=>{}}/></div>
      <div className="payment-field"><span className="payment-field-label">{t("支付通道")}</span><ChoicePicker disabled={disabled} showDetails label={t("网络")} value="TRC20" options={[{value:'TRC20',label:'Tron',icon:<TronIcon/>}]} onChange={()=>{}}/></div>
    </>}
    {!channels.length&&<p role="status">{t("暂无可用支付渠道")}</p>}
  </div>;
}
