// Text fallback, not an HTML sanitizer. Each scan moves forwards, including
// malformed input with many '<' characters and no closing '>'.
export function htmlToPlainText(value) {
  const source = String(value || '');
  const chunks = [];
  const closingTags = {script:/<\/script\s*>/gi,style:/<\/style\s*>/gi};
  let position = 0;
  while (position < source.length) {
    const start = source.indexOf('<', position);
    if (start < 0) { chunks.push(source.slice(position)); break; }
    chunks.push(source.slice(position, start));
    const end = source.indexOf('>', start + 1);
    if (end < 0) { chunks.push(source.slice(start)); break; }
    const tag = source.slice(start + 1, end).toLowerCase();
    position = end + 1;
    const raw = /^(script|style)\b/.exec(tag);
    if (raw) {
      const closing = closingTags[raw[1]];
      closing.lastIndex = position;
      if (!closing.exec(source)) break;
      position = closing.lastIndex;
    } else if (/^br\s*\/?$/.test(tag)) chunks.push('\n');
    else if (/^\/p\s*$/.test(tag)) chunks.push('\n\n');
  }
  return chunks.join('')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")
  .replace(/&amp;/gi, '&')
  .replace(/\r\n?/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
}
