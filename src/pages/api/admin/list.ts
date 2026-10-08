import type { APIRoute } from 'astro';
import { requireApiUser, json, apiError } from '../../../../server/http/api.mjs';
import { consumeAuthRateLimit } from '../../../../server/auth/request-security.mjs';
import { adminSections, getAdminData } from '../../../../server/admin/read-model.mjs';
export const prerender=false;
export const GET:APIRoute=async(context)=>{
  try {
    if(Buffer.byteLength(context.url.search,'utf8')>4096) throw Object.assign(new Error('请求内容过大。'),{status:413});
    const allowed=new Set(['section','page','q','status']);
    for(const key of context.url.searchParams.keys()) if(!allowed.has(key)||context.url.searchParams.getAll(key).length!==1) throw Object.assign(new Error('请求参数不正确。'),{status:400});
    const {user}=await requireApiUser(context,{admin:true,jsonBody:false});
    const rate=await consumeAuthRateLimit({action:'ADMIN_LIST',identifier:String(user.id),limit:120,windowSeconds:60});
    if(!rate.allowed) return json({ok:false,message:'刷新过于频繁。'},429);
    const section=context.url.searchParams.get('section')||'';
    if(!adminSections.includes(section)) throw Object.assign(new Error('列表类型不正确。'),{status:400});
    const data=await getAdminData({section,page:context.url.searchParams.get('page')??'1',query:context.url.searchParams.get('q')??'',status:context.url.searchParams.get('status')??'全部'});
    return json({ok:true,rows:(data as unknown as Record<string,unknown>)[section],pagination:data.pagination[section]});
  } catch(error){return apiError(error,'列表读取失败。');}
};
