import {useEffect,useRef} from 'react';
/** Shared keyboard behavior; calling code retains its in-flight request/close protection. */
export function useDialog(open:boolean,onClose:()=>void,selector:string) {
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement as HTMLElement|null;
    const card=document.querySelector<HTMLElement>(selector);if(!card)return;
    const controls=()=>Array.from(card.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(e=>e.getClientRects().length);
    const first=controls()[0];first?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close.current();}else if(event.key==='Tab'){const all=controls(),start=all[0],end=all.at(-1);if(!start){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===start||!card.contains(document.activeElement))){event.preventDefault();end?.focus();}else if(!event.shiftKey&&(document.activeElement===end||!card.contains(document.activeElement))){event.preventDefault();start.focus();}}};
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus({preventScroll:true});};
  },[open,selector]);
}
