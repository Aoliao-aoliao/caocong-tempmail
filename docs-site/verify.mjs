import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const site = dirname(fileURLToPath(import.meta.url));
const root = resolve(site, '.vitepress/dist');
const base = '/caocong-tempmail/';
const pages = (await readdir(resolve(site, 'content'))).filter(x => x.endsWith('.md'));
const files = (await readdir(root)).filter(x => x.endsWith('.html'));
assert.equal(files.length, pages.length + 1);
let checked = 0;
for (const file of files) {
  const html = await readFile(resolve(root, file), 'utf8');
  for (const [, url] of html.matchAll(/(?:href|src)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    assert.ok(url.startsWith(base), `${file}: wrong base ${url}`);
    let relative = decodeURIComponent(url.slice(base.length));
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const target = resolve(root, relative);
    assert.ok(target.startsWith(root + sep), 'Link escapes output');
    assert.ok((await stat(target)).isFile(), `${file}: missing asset ${url}`);
    checked++;
  }
  assert.doesNotMatch(html, /BEGIN (?:RSA )?PRIVATE KEY|MYSQL_ROOT_PASSWORD=[^\s<]+/);
}
assert.ok(files.includes('panel.html') && files.includes('payment-usdt.html'));
const home = await readFile(resolve(root, 'index.html'), 'utf8');
assert.ok(home.includes('https://nodemail.513399.xyz/'));
assert.ok(home.includes('https://github.com/Aoliao-aoliao/caocong-tempmail'));
console.log(`PASS: ${files.length} pages, ${checked} local references, demo and source links`);
