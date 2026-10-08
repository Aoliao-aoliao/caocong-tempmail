import {useMemo,useSyncExternalStore} from 'react';
import {normalizeLocale,translator} from './locale';
const subscribe=(notify:()=>void)=>{window.addEventListener('nodemail:locale',notify);return()=>window.removeEventListener('nodemail:locale',notify);};
const current=()=>normalizeLocale(document.documentElement.lang);
const initial=()=> 'zh-CN' as const;
/** Hydration starts with the server's Chinese component snapshot, then uses the requested page locale. */
export function useTranslator(){const locale=useSyncExternalStore(subscribe,current,initial);return useMemo(()=>translator(locale),[locale]);}
