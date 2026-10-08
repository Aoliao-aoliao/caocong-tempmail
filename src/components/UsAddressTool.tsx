import {useTranslator} from '../lib/useTranslator';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import ChoicePicker from './ui/ChoicePicker';
import {copyText} from '../lib/clipboard';
import {useDialog} from './ui/useDialog';
import TurnstileWidget from './TurnstileWidget';

type StateRow = [code: string, name: string, city: string, zip: string, area: string, lat: string, lng: string];
type AddressResult = {
  firstName:string;
  lastName:string;
  gender:string;
  phone:string;
  email:string;
  streetAddress:string;
  city:string;
  stateName:string;
  stateCode:string;
  zipCode:string;
  latitude?:number;
  longitude?:number;
  coordinates:string;
  fullAddress:string;
  mailboxDomainId?:number;
  mailboxDomain?:string;
  mailboxClaim?:string;
};

const STATES: StateRow[] = [
  ['AL','Alabama','Montgomery','36104','334','32.3777','-86.3006'], ['AK','Alaska','Anchorage','99501','907','61.2176','-149.8997'],
  ['AZ','Arizona','Phoenix','85004','602','33.4484','-112.0740'], ['AR','Arkansas','Little Rock','72201','501','34.7465','-92.2896'],
  ['CA','California','Sacramento','95814','916','38.5816','-121.4944'], ['CO','Colorado','Denver','80203','303','39.7392','-104.9903'],
  ['CT','Connecticut','Hartford','06103','860','41.7658','-72.6734'], ['DE','Delaware','Dover','19901','302','39.1582','-75.5244'],
  ['FL','Florida','Tallahassee','32301','850','30.4383','-84.2807'], ['GA','Georgia','Atlanta','30303','404','33.7490','-84.3880'],
  ['HI','Hawaii','Honolulu','96813','808','21.3069','-157.8583'], ['ID','Idaho','Boise','83702','208','43.6150','-116.2023'],
  ['IL','Illinois','Springfield','62701','217','39.7817','-89.6501'], ['IN','Indiana','Indianapolis','46204','317','39.7684','-86.1581'],
  ['IA','Iowa','Des Moines','50309','515','41.5868','-93.6250'], ['KS','Kansas','Topeka','66603','785','39.0473','-95.6752'],
  ['KY','Kentucky','Frankfort','40601','502','38.2009','-84.8777'], ['LA','Louisiana','Baton Rouge','70802','225','30.4515','-91.1871'],
  ['ME','Maine','Augusta','04330','207','44.3106','-69.7795'], ['MD','Maryland','Annapolis','21401','410','38.9784','-76.4922'],
  ['MA','Massachusetts','Boston','02108','617','42.3601','-71.0589'], ['MI','Michigan','Lansing','48933','517','42.7325','-84.5555'],
  ['MN','Minnesota','Saint Paul','55101','651','44.9537','-93.0900'], ['MS','Mississippi','Jackson','39201','601','32.2988','-90.1848'],
  ['MO','Missouri','Jefferson City','65101','573','38.5767','-92.1735'], ['MT','Montana','Helena','59601','406','46.5891','-112.0391'],
  ['NE','Nebraska','Lincoln','68508','402','40.8136','-96.7026'], ['NV','Nevada','Carson City','89701','775','39.1638','-119.7674'],
  ['NH','New Hampshire','Concord','03301','603','43.2081','-71.5376'], ['NJ','New Jersey','Trenton','08608','609','40.2171','-74.7429'],
  ['NM','New Mexico','Santa Fe','87501','505','35.6870','-105.9378'], ['NY','New York','Albany','12207','518','42.6526','-73.7562'],
  ['NC','North Carolina','Raleigh','27601','919','35.7796','-78.6382'], ['ND','North Dakota','Bismarck','58501','701','46.8083','-100.7837'],
  ['OH','Ohio','Columbus','43215','614','39.9612','-82.9988'], ['OK','Oklahoma','Oklahoma City','73102','405','35.4676','-97.5164'],
  ['OR','Oregon','Salem','97301','503','44.9429','-123.0351'], ['PA','Pennsylvania','Harrisburg','17101','717','40.2732','-76.8867'],
  ['RI','Rhode Island','Providence','02903','401','41.8240','-71.4128'], ['SC','South Carolina','Columbia','29201','803','34.0007','-81.0348'],
  ['SD','South Dakota','Pierre','57501','605','44.3683','-100.3510'], ['TN','Tennessee','Nashville','37219','615','36.1627','-86.7816'],
  ['TX','Texas','Austin','78701','512','30.2672','-97.7431'], ['UT','Utah','Salt Lake City','84111','801','40.7608','-111.8910'],
  ['VT','Vermont','Montpelier','05602','802','44.2601','-72.5754'], ['VA','Virginia','Richmond','23219','804','37.5407','-77.4360'],
  ['WA','Washington','Olympia','98501','360','47.0379','-122.9007'], ['WV','West Virginia','Charleston','25301','304','38.3498','-81.6326'],
  ['WI','Wisconsin','Madison','53703','608','43.0731','-89.4012'], ['WY','Wyoming','Cheyenne','82001','307','41.1400','-104.8202'],
  ['DC','District of Columbia','Washington','20001','202','38.9072','-77.0369'],
];

function CopyIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path fillRule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z" /></svg>;
}

export default function UsAddressTool({ isAuthenticated=false, turnstileSiteKey='', turnstileConfigured=false }: { isAuthenticated?:boolean; turnstileSiteKey?:string; turnstileConfigured?:boolean }) {
  const t=useTranslator();
  const [stateCode, setStateCode] = useState('');
  const [taxFreeOnly, setTaxFreeOnly] = useState(false);
  const taxFreeStates = ['AK','DE','MT','NH','OR'];
  const [result, setResult] = useState<AddressResult | null>(null);
  const [generatorStatus, setGeneratorStatus] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState('');
  const [mailGateOpen, setMailGateOpen] = useState(false);
  const [mailGateError, setMailGateError] = useState('');
  const [mailGateResetKey, setMailGateResetKey] = useState(0);
  const mailGateSubmissionRef = useRef(false);
  const mailGateRequestRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => [
    ['firstName',t("名 / First Name"),result?.firstName || '—'], ['lastName',t("姓 / Last Name"),result?.lastName || '—'], ['gender',t("性别 / Gender"),result?.gender || '—'],
    ['phone',t("电话 / Phone"),result?.phone || '—'], ['email',t("临时邮箱 / Email"),result?.email || '—'], ['streetAddress',t("街道 / Street"),result?.streetAddress || '—'],
    ['city',t("城市 / City"),result?.city || '—'], ['stateName',t("州 / State"),result ? `${result.stateName} (${result.stateCode})` : '—'], ['zipCode',t("邮编 / ZIP Code"),result?.zipCode || '—'],
    ['coordinates',t("坐标 / Coordinates"),result?.coordinates || '—'], ['fullAddress',t("完整地址 / Full Address"),result?.fullAddress || '—'],
  ], [result,t]);

  async function copy(key: string, value: string) {
    if (!await copyText(value)) {setGeneratorStatus(t("复制失败，请手动选择并复制。"));return;}
    setGeneratorStatus('');
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1200);
  }

  function copyAll() {
    if (!result) return;
    copy('all', rows.map(([, label, value]) => `${label}: ${value}`).join('\n'));
  }

  useEffect(() => {
    document.body.classList.toggle('recaptcha-dialog-open', mailGateOpen);
    return () => document.body.classList.remove('recaptcha-dialog-open');
  }, [mailGateOpen]);

  useEffect(() => () => mailGateRequestRef.current?.abort(), []);

  function closeMailGate() {
    mailGateRequestRef.current?.abort();
    mailGateRequestRef.current = null;
    mailGateSubmissionRef.current = false;
    setMailGateOpen(false);
    setMailGateError('');
  }

  useDialog(mailGateOpen, closeMailGate, '.recaptcha-dialog-card');

  function requestMailInbox() {
    if (!result) return;
    if (isAuthenticated) {
      window.location.assign(`/tools/mail.cgi?address=${encodeURIComponent(result.email)}`);
      return;
    }
    if (!result.mailboxClaim || !result.mailboxDomain) {
      setGeneratorStatus(t("临时邮箱凭证无效，请重新生成资料。"));
      return;
    }
    setMailGateError(turnstileConfigured ? '' : t("人机验证尚未配置，请联系管理员。"));
    if (turnstileConfigured) setMailGateResetKey((value) => value + 1);
    setMailGateOpen(true);
  }

  async function verifyAndOpenMail(turnstileToken: string) {
    if (mailGateSubmissionRef.current) return;
    if (!turnstileConfigured) {
      setMailGateError(t("人机验证尚未配置，请联系管理员。"));
      return;
    }
    const currentResult = result;
    if (!currentResult?.mailboxClaim || !currentResult.mailboxDomain) {
      setMailGateError(t("临时邮箱凭证无效，请重新生成资料。"));
      return;
    }
    mailGateSubmissionRef.current = true;
    mailGateRequestRef.current?.abort();
    const controller = new AbortController();
    mailGateRequestRef.current = controller;
    setMailGateError(t("正在启用临时邮箱…"));
    try {
      const response = await fetch('/api/guest/mailbox', {
        method:'POST',
        headers:{ 'content-type':'application/json', accept:'application/json' },
        credentials:'same-origin',
        body:JSON.stringify({ mailboxClaim:currentResult.mailboxClaim, turnstileToken }),
        signal:controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || t("临时邮箱启用失败。"));
      if (String(payload?.mailbox?.address || '').toLowerCase() !== currentResult.email.toLowerCase()) {
        throw new Error(t("临时邮箱启用结果不一致，请重新生成资料。"));
      }
      window.location.assign('/tools/mail.cgi');
    } catch (error) {
      if (controller.signal.aborted) return;
      setMailGateError(error instanceof Error ? error.message : t("临时邮箱启用失败。"));
      setMailGateResetKey((value) => value + 1);
    } finally {
      if (mailGateRequestRef.current === controller) {
        mailGateRequestRef.current = null;
        mailGateSubmissionRef.current = false;
      }
    }
  }

  async function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating) return;
    setGenerating(true);
    setGeneratorStatus('');
    try {
      let nextResult: AddressResult;
      {
        const response = await fetch('/api/tools/us_address/generate.cgi', {
          method:'POST',
          headers:{ 'content-type':'application/json', accept:'application/json' },
          credentials:'same-origin',
          body:JSON.stringify({ stateCode:stateCode || null, taxFreeOnly }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok || !payload.address) {
          throw new Error(payload?.message || t("地址资料生成失败。"));
        }
        nextResult = payload.address as AddressResult;
        if (!nextResult.email || !nextResult.mailboxDomain || (!isAuthenticated && !nextResult.mailboxClaim)) {
          throw new Error(t("地址资料生成结果不完整，请稍后重试。"));
        }
      }
      setResult(nextResult);
      window.requestAnimationFrame(() => {
        const results = resultsRef.current;
        const heading = results?.querySelector('.results-header');
        if (!results || !heading) return;
        // Keep the controls visible when the results heading is already on
        // screen. Otherwise reveal it below the fixed/sticky navigation.
        const bars = document.querySelectorAll('.workspace-topbar, .app-topbar, .workspace > .sidebar');
        let occupiedTop = 0;
        for (const bar of bars) {
          const position = getComputedStyle(bar).position;
          if (bar.classList.contains('sidebar') && position !== 'sticky') continue;
          if (position === 'fixed' || position === 'sticky') {
            const box = bar.getBoundingClientRect();
            if (box.top <= 1) occupiedTop = Math.max(occupiedTop, box.bottom);
          }
        }
        const box = heading.getBoundingClientRect();
        const offset = occupiedTop + 16;
        results.style.scrollMarginTop = `${offset}px`;
        if (box.top >= offset && box.bottom <= window.innerHeight) return;
        results.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
          block: 'start',
        });
      });
    } catch (error) {
      setGeneratorStatus(error instanceof Error ? error.message : t("地址资料生成失败。"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="us-address-content">
      <section className="generator-shell">
        <div className="generator-hero">
          <div className="hero-intro">
            <p className="eyebrow">{t("NODEMAIL 地址工具")}</p>
            <h1>{t("美国地址资料")}</h1>
            <p className="hero-copy">{t("随机组合美国格式的测试地址，并配套随机姓名、手机号与临时邮箱，适用于表单、地址格式和国际化流程。")}</p>
            <div className="hero-facts"><span><i></i>{t("美国格式样本")}</span><span><i></i>{t("覆盖 50 州与华盛顿特区")}</span><span><i></i>{t("无需注册")}</span></div>
          </div>
          <form className="generator-control" onSubmit={submitAddress}>
            <label htmlFor="us-state">{t("选择州")}</label>
            <ChoicePicker className="state-picker" value={stateCode} onChange={setStateCode} label={t("选择州")} options={[{value:"",label:t("随机 / Random"),symbol:"US"},...STATES.filter(([code])=>!taxFreeOnly||taxFreeStates.includes(code)).map(([code,name])=>({value:code,label:`${name} (${code})`,symbol:code}))]} />
            <label className="tax-free-filter"><input type="checkbox" checked={taxFreeOnly} onChange={event => {setTaxFreeOnly(event.target.checked);if(event.target.checked && !taxFreeStates.includes(stateCode))setStateCode('');}} /><span className="tax-free-check" aria-hidden="true"/><span>{t("仅免税州")}</span></label>
            <small className="tax-free-note">{t("无州销售税；部分地区仍可能收取地方税。")}</small>
            <button className="generate-button" type="submit" disabled={generating}>{generating ? t("生成中...") : t("生成资料")}</button>
            <p className="generator-note">{t("每次生成都会随机组合地址和身份信息")}</p>
            <p className="generator-status" role="status">{generatorStatus}</p>
          </form>
        </div>
      </section>
      <section className="results" aria-live="polite" ref={resultsRef}>
        <header className="results-header"><div><h2>{t("生成结果")}</h2><p>{t("身份资料与地址信息分区展示，便于核对和复制。")}</p></div><div className="result-actions"><button className="secondary-button" type="button" onClick={copyAll} disabled={!result}>{copied === 'all' ? t("已复制") : t("一键复制全部")}</button><a className={`secondary-button${result ? '' : ' disabled'}`} href={result ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(result.coordinates)}` : '#'} target="_blank" rel="noreferrer" aria-disabled={!result} onClick={(event) => { if (!result) event.preventDefault(); }}>{t("查看地图")}</a></div></header>
        <div className="results-grid">
          <article className="info-card"><header><h3>{t("身份资料")}</h3><span>{t("随机信息")}</span></header><dl className="field-list">{rows.slice(0,5).map(([key,label,value]) => <div className={`field-row${key === 'email' ? ' wide' : ''}`} key={key}><dt>{label}</dt>{key === 'email' ? <dd className="mail-value"><strong>{value}</strong>{result && <><button className="mail-inbox-button" type="button" onClick={requestMailInbox}>{isAuthenticated ? t("确认开通此邮箱") : t("验证后启用收信")}</button><small>{t("开通成功后才可收信")}</small></>}</dd> : <dd>{value}</dd>}<button className="copy-button" type="button" disabled={!result} onClick={() => copy(key,value)} aria-label={copied === key ? t("已复制") : t("复制")}>{copied === key ? <span className="copy-success-mark">✓</span> : <CopyIcon />}</button></div>)}</dl></article>
          <article className="info-card"><header><h3>{t("地址信息")}</h3><span>{t("格式样本")}</span></header><dl className="field-list">{rows.slice(5).map(([key,label,value]) => <div className={`field-row${key === 'fullAddress' ? ' wide' : ''}`} key={key}><dt>{label}</dt><dd>{value}</dd><button className="copy-button" type="button" disabled={!result} onClick={() => copy(key,value)} aria-label={copied === key ? t("已复制") : t("复制")}>{copied === key ? <span className="copy-success-mark">✓</span> : <CopyIcon />}</button></div>)}</dl></article>
        </div>
        <p className="disclaimer">{t("说明：地址来自格式样本；姓名和手机号均为随机生成，与地址及真实住户无关联。生成结果不承诺可收件，也不应用于居住或身份验证。")}</p>
      </section>
      {mailGateOpen && <div className="recaptcha-dialog" role="dialog" aria-modal="true" aria-labelledby="mailGateTitle">
        <button className="recaptcha-dialog-backdrop" type="button" aria-label={t("关闭")} onClick={closeMailGate}></button>
        <section className="recaptcha-dialog-card">
          <header><div><span>{t("人机验证")}</span><h2 id="mailGateTitle">{t("进入邮件收信")}</h2></div><button type="button" aria-label={t("关闭")} onClick={closeMailGate}>×</button></header>
          <p>{t("完成人机验证后将启用当前临时邮箱，并进入收信页面。")}</p>
          {turnstileConfigured && <div className="recaptcha-widget">
            <TurnstileWidget siteKey={turnstileSiteKey} action="guest_mailbox" theme="light" size="normal" responsive language="zh-cn" resetKey={mailGateResetKey} ariaLabel={t("进行人机身份验证")} onVerify={(token) => void verifyAndOpenMail(token)} onExpire={() => setMailGateError(t("验证已过期，请重新完成验证。"))} onError={() => setMailGateError(t("人机验证暂时不可用，请稍后重试。"))} />
          </div>}
          {mailGateError && <p className="turnstile-inline-error" role="status">{mailGateError}</p>}
          <button className="recaptcha-cancel" type="button" onClick={closeMailGate}>{t("取消")}</button>
        </section>
      </div>}
    </div>
  );
}
