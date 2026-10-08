import type {APIRoute} from 'astro';
import {requireApiUser,readJsonBody,json,apiError} from '../../../../server/http/api.mjs';
import {auditRetentionStatus,configureAuditRetention} from '../../../../server/admin/audit-retention.mjs';
export const GET:APIRoute=async context=>{try{const {user}=await requireApiUser(context,{admin:true,jsonBody:false});return json({ok:true,canManage:user.role==='SUPER_ADMIN',...await auditRetentionStatus()});}catch(e){return apiError(e);}};
export const POST:APIRoute=async context=>{try{const {user}=await requireApiUser(context,{admin:true});const body=await readJsonBody(context.request,1024);return json(await configureAuditRetention({...body,actorUserId:user.id}));}catch(e){return apiError(e);}};
