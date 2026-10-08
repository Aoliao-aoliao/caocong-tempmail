/** Resolve only after the browser confirms a copy. Never report rejected writes as success. */
export async function copyText(value:string):Promise<boolean> {
  if(!value)return false;
  try {await navigator.clipboard.writeText(value);return true;}catch { /* Older browsers can still support a selection copy. */ }
  const previous=document.activeElement as HTMLElement|null;
  const selection=document.getSelection();const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
  const input=document.createElement('textarea');input.value=value;input.readOnly=true;input.style.cssText='position:fixed;left:-9999px;top:0;';document.body.append(input);
  try {input.select();return document.execCommand('copy');}catch{return false;}
  finally {input.remove();previous?.focus({preventScroll:true});if(selection){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range));}}
}
