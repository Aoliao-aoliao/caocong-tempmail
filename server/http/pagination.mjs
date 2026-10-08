export function normalizePage(value=1) {
  const raw=String(value);
  if(!/^[1-9]\d{0,5}$/.test(raw) || Number(raw)>100000) throw Object.assign(new Error('页码必须是 1–100000 的整数。'),{status:400});
  return Number(raw);
}
export function normalizeQuery(value='') {
  const query=String(value).trim();
  if(query.length>100 || /\p{Cc}/u.test(query)) throw Object.assign(new Error('搜索内容不合法或超过 100 个字符。'),{status:400});
  return query;
}
