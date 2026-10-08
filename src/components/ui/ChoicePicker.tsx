import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
export type Choice = {value:string;label:string;symbol?:string;icon?:ReactNode;description?:string;disabled?:boolean};
export default function ChoicePicker({value,options,onChange,label,disabled=false,className='',showDetails=false}:{value:string;options:Choice[];onChange:(value:string)=>void;label:string;disabled?:boolean;className?:string;showDetails?:boolean}) {
  const id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false),[active,setActive]=useState(0);
  const selected=options.find(item=>item.value===value);
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
  useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))close();};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(open)root.current?.querySelector<HTMLElement>(`[data-choice-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
  function move(direction:number){const enabled=options.map((item,index)=>item.disabled?-1:index).filter(i=>i>=0);if(!enabled.length)return;const position=enabled.indexOf(active);setActive(enabled[(position+direction+enabled.length)%enabled.length]);}
  return <div className={`choice-picker ${className}`} ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))close();}}>
    <button ref={trigger} className="choice-trigger" type="button" role="combobox" aria-label={label} aria-controls={id} aria-expanded={open} aria-haspopup="listbox" aria-activedescendant={open?`${id}-${active}`:undefined} disabled={disabled||!options.length}
      onClick={()=>{setActive(Math.max(0,options.findIndex(item=>item.value===value)));setOpen(!open);}}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!open){setOpen(true);setActive(Math.max(0,options.findIndex(item=>item.value===value)));}else if(event.key==='Home')setActive(Math.max(0,options.findIndex(item=>!item.disabled)));else if(event.key==='End')setActive(options.findLastIndex(item=>!item.disabled));else move(event.key==='ArrowDown'?1:-1);}
        else if(open&&(event.key==='Enter'||event.key===' ')){event.preventDefault();const item=options[active];if(item&&!item.disabled){onChange(item.value);close(true);}}
        else if(open&&event.key.length===1){const match=options.findIndex(item=>!item.disabled&&item.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));if(match>=0)setActive(match);}
      }}>{showDetails ? <span className="choice-selected-detail">{(selected?.icon||selected?.symbol) && <b className="choice-symbol" aria-hidden="true">{selected.icon||selected.symbol}</b>}<span><strong>{selected?.label||label}</strong>{selected?.description && <small>{selected.description}</small>}</span></span> : <span>{selected?.label||label}</span>}<i aria-hidden="true" /></button>
    {open&&<div id={id} className="choice-menu" role="listbox" aria-label={label}>{options.map((item,index)=><div id={`${id}-${index}`} key={item.value} role="option" aria-selected={item.value===value} aria-disabled={item.disabled||undefined} data-choice-index={index} className={`choice-option${active===index?' is-focused':''}`} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>{if(!item.disabled){onChange(item.value);close(true);}}}>
      {(item.icon||item.symbol)&&<b className="choice-symbol" aria-hidden="true">{item.icon||item.symbol}</b>}<span><strong>{item.label}</strong>{item.description&&<small>{item.description}</small>}</span><i aria-hidden="true">{item.value===value?'✓':''}</i>
    </div>)}</div>}
  </div>;
}
