import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '.vitepress/dist');
const files = (await readdir(root)).filter(x => x.endsWith('.html'));
assert.equal(files.length, 18, 'Expected 17 documentation pages and the 404 page');
let checked = 0;
for (const file of files) {
  const html = await readFile(resolve(root, file), 'utf8');
  assert.match(html, /noindex/, `${file}: preview indexing policy`);
  for (const [, url] of html.matchAll(/(?:href|src)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    const decoded = decodeURIComponent(url);
    const target = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    assert.ok(target.startsWith(root), 'Link escapes build output');
    assert.ok((await stat(target)).isFile(), `${file}: missing asset ${url}`);
    checked++;
  }
  assert.doesNotMatch(html, /BEGIN (?:RSA )?PRIVATE KEY|MYSQL_ROOT_PASSWORD=[^\s<]+/, 'No deployment secrets in output');
}
assert.ok(files.includes('panel.html') && files.includes('troubleshooting.html'));
console.log(`PASS: ${files.length} HTML files, ${checked} local references, preview indexing and secret markers`);
