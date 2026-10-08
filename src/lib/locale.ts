import catalog from './ui-translations.json';
export type Locale='zh-CN'|'zh-TW'|'en-US';
export const normalizeLocale=(value:unknown):Locale=>value==='en-US'||value==='zh-TW'?value:'zh-CN';
export function requestLocale(context:{url:URL;cookies:{get:(name:string)=>{value:string}|undefined}}):Locale {
  return normalizeLocale(context.url.searchParams.get('lang')||context.cookies.get('nodemail_locale')?.value);
}
export function translate(text:string,locale:Locale,...values:unknown[]):string {
  const entry=(catalog as Record<string,{en:string;tw:string}>)[text];
  const result=locale==='en-US'?entry?.en||text:locale==='zh-TW'?entry?.tw||text:text;
  return result.replace(/\{(\d+)\}/g,(_,index)=>String(values[Number(index)]??`{${index}}`));
}
export const translator=(locale:Locale)=>(text:string,...values:unknown[])=>translate(text,locale,...values);
