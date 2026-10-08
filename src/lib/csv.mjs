export function csvCell(value) {
  let text=String(value ?? '');
  // Quotes alone do not stop spreadsheet formula execution. Preserve text
  // with an apostrophe, including leading whitespace/control characters.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function serializeCsv(rows) { return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'); }
