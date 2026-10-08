import {openDatabase} from '../db/database.mjs';
export async function transactionReceipt(id){
 if(typeof id!=='string'||id.length>64)throw Object.assign(new Error('流水编号无效。'),{status:400});
 const c=await openDatabase();try{
  const [[t]]=await c.execute('SELECT public_id,user_id,type,reference_type,reference_id,created_at FROM point_transactions WHERE public_id=?',[id]);
  if(!t)throw Object.assign(new Error('积分流水不存在。'),{status:404});
  let receipt;
  if(t.reference_type==='MEMBERSHIP'||t.reference_type==='MAILBOX_RENEW'){
   const [[r]]=await c.execute('SELECT public_id,created_at FROM business_receipts WHERE user_id=? AND '+(t.reference_type==='MEMBERSHIP'?"entity_type='MEMBERSHIP' AND entity_id=?":"public_id=?")+' LIMIT 1',[t.user_id,t.reference_id]);receipt=r;
  }else if(t.reference_type==='MAILBOX'){
   const [[r]]=await c.execute('SELECT request_id public_id,created_at FROM mailboxes WHERE id=? AND user_id=?',[t.reference_id,t.user_id]);if(r?.public_id)receipt=r;
  }else if(t.reference_type==='MAILBOX_RECALL'){
   const [[r]]=await c.execute('SELECT request_id public_id,created_at FROM mailbox_recall_requests WHERE public_id=? AND user_id=?',[t.reference_id,t.user_id]);receipt=r;
  }else if(['GMPAY_ORDER','NODELOC_ORDER','RECHARGE_ORDER'].includes(t.reference_type)){
   const table={GMPAY_ORDER:'gmpay_payment_orders',NODELOC_ORDER:'nodeloc_payment_orders',RECHARGE_ORDER:'recharge_orders'}[t.reference_type];
   const column=t.reference_type==='RECHARGE_ORDER'?'public_id':'id';
   const [[r]]=await c.execute(`SELECT ${column} public_id,created_at FROM ${table} WHERE ${column}=? AND user_id=? AND status='PAID'`,[t.reference_id,t.user_id]);receipt=r;
  }
  return {transactionId:t.public_id,referenceId:t.reference_id||null,requestId:receipt?String(receipt.public_id):null,processedAt:receipt?.created_at||t.created_at,protected:Boolean(receipt)};
 }finally{c.release();}
}
