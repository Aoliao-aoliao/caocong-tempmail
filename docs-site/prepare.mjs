// Only these reviewed Markdown files enter the documentation build.
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pages = {
  'docs/INTRODUCTION.md': 'introduction', 'docs/PREPARATION.md': 'preparation',
  'docs/1PANEL.md': 'panel', 'docs/BEGINNER.md': 'linux', 'installer/README.md': 'installation',
  'docs/ADMIN-GUIDE.md': 'admin', 'docs/MAIL-GUIDE.md': 'mail', 'docs/INTEGRATIONS.md': 'integrations',
  'docs/UPGRADING.md': 'upgrading', 'docs/BACKUP.md': 'backup', 'docs/TROUBLESHOOTING.md': 'troubleshooting',
  'docs/DATA-ISOLATION.md': 'data', 'docs/VALIDATION.md': 'validation',
  'COPYRIGHT.md': 'copyright', 'LICENSE-STATUS.md': 'license'
};
await mkdir(resolve(here, 'content/public'), { recursive: true });
for (const [source, route] of Object.entries(pages)) {
  let body = await readFile(resolve(root, source), 'utf8');
  body = body.replace(/\]\(([^)]+)\)/g, (match, url) => {
    if (/^(https?:|#)/.test(url)) return match;
    const [path, hash] = url.split('#');
    const relative = resolve(root, dirname(source), path).slice(root.length + 1).replaceAll('\\', '/');
    if (relative === 'README.md') return '](/)';
    if (pages[relative]) return `](/${pages[relative]}.html${hash ? '#' + hash : ''})`;
    if (relative.startsWith('docs/assets/')) return `](/illustrations/${relative.slice('docs/assets/'.length)})`;
    throw new Error(`Unmapped local link in ${source}: ${url}`);
  });
  await writeFile(resolve(here, 'content', route + '.md'), body);
}
await cp(resolve(here, 'home.md'), resolve(here, 'content/index.md'));
await cp(resolve(root, 'docs/assets'), resolve(here, 'content/public/illustrations'), { recursive: true });
await cp(resolve(root, 'public/assets/brand/nodemail-mark.jpg'), resolve(here, 'content/public/brand.jpg'));
console.log(`Prepared ${Object.keys(pages).length + 1} documentation pages from the explicit source list.`);
