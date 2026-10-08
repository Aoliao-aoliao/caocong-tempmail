// Compact durable business receipts. Never removed by audit retention.
export const receiptActions=['用户购买会员','用户续期邮箱','用户创建中继邮箱'];
export async function readReceipt(c,publicId,userId,action){
  const [[receipt]]=await c.execute('SELECT detail_json FROM business_receipts WHERE public_id=? AND user_id=? AND action=?',[publicId,userId,action]);
  if(receipt)return receipt;
  // Migration/rollback overlap: old processes can still write audit receipts.
  const [[legacy]]=await c.execute("SELECT detail_json FROM audit_logs WHERE public_id=? AND actor_user_id=? AND action=? AND status='SUCCESS'",[publicId,userId,action]);
  return legacy||null;
}
export async function saveReceipt(c,{publicId,userId,action,entityType,entityId,detail}){
  await c.execute('INSERT INTO business_receipts(public_id,user_id,action,entity_type,entity_id,detail_json) VALUES (?,?,?,?,?,?)',[publicId,userId,action,entityType,entityId,JSON.stringify(detail)]);
}

// Copy only receipts in the selected, locked batch. Existing receipts must match
// before any audit row can be removed; corruption fails closed.
export async function preserveAuditDependencies(c,rows){
  for(const row of rows){
    if(receiptActions.includes(row.action)&&row.status==='SUCCESS'){
      if(!row.actor_user_id||!row.detail_json)throw Error('Invalid legacy business receipt');
      await c.execute('INSERT IGNORE INTO business_receipts(public_id,user_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)',[row.public_id,row.actor_user_id,row.action,row.entity_type,row.entity_id,typeof row.detail_json==='string'?row.detail_json:JSON.stringify(row.detail_json),row.created_at]);
      const [[same]]=await c.execute('SELECT 1 ok FROM business_receipts WHERE public_id=? AND user_id=? AND action=? AND entity_type=? AND entity_id <=> ? AND detail_json=CAST(? AS JSON)',[row.public_id,row.actor_user_id,row.action,row.entity_type,row.entity_id,typeof row.detail_json==='string'?row.detail_json:JSON.stringify(row.detail_json)]);
      if(!same)throw Error('Business receipt mismatch');
    }
    if(row.action==='更新 API 密钥'&&row.entity_type==='API_KEY'){
      // Lock the key to serialize with administrator updates. Copy the latest
      // legacy override, not merely the old row currently being pruned.
      const [[key]]=await c.execute('SELECT id FROM api_keys WHERE public_id=? FOR UPDATE',[row.entity_id]);
      if(key){
        const [[latest]]=await c.execute("SELECT id,JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.after.rateLimit')) rate_limit FROM audit_logs WHERE entity_type='API_KEY' AND entity_id=? AND action='更新 API 密钥' AND JSON_EXTRACT(detail_json,'$.after.rateLimit') IS NOT NULL ORDER BY id DESC LIMIT 1",[row.entity_id]);
        if(latest){const rate=Number(latest.rate_limit);if(!Number.isInteger(rate)||rate<1||rate>100000)throw Error('Invalid legacy rate override');await c.execute('INSERT INTO api_rate_overrides(api_key_id,rate_limit,source_audit_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE rate_limit=IF(VALUES(source_audit_id)>source_audit_id,VALUES(rate_limit),rate_limit),source_audit_id=GREATEST(source_audit_id,VALUES(source_audit_id))',[key.id,rate,latest.id]);}
      }
    }
  }
}
