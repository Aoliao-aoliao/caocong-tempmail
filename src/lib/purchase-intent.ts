// Keep ambiguous (lost-response) purchases retryable across dialog/page reopen in
// the same tab. Only an opaque request UUID and non-secret parameters are stored.
const pending = new Map<string,string>();
const keyFor=(owner:string,kind:string,parameters:unknown)=>`nodemail-purchase:${JSON.stringify([owner,kind,parameters])}`;
export function purchaseIntent(owner:string,kind:string,parameters:unknown) {
  const key=keyFor(owner,kind,parameters);
  let saved:string|null=null;
  try{saved=sessionStorage.getItem(key);}catch{/* In-memory retry still works when storage is disabled. */}
  let id=pending.get(key)||saved;
  if(!id||!/^[0-9a-f-]{36}$/i.test(id))id=crypto.randomUUID();
  pending.set(key,id);
  try{sessionStorage.setItem(key,id);}catch{/* Storage restrictions do not block purchasing. */}
  return id;
}
export function completePurchaseIntent(owner:string,kind:string,parameters:unknown) {
  const key=keyFor(owner,kind,parameters);pending.delete(key);
  try{sessionStorage.removeItem(key);}catch{/* See above. */}
}
