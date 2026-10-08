import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

test('tracked release excludes private installation state and operational history', async () => {
  const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  assert(files.length>300,'Must check the actual source repository');
  for(const path of files){
    assert(!/(^|\/)(?:data|tls|node_modules|\.deploy|\.git)(\/|$)/i.test(path),path);
    assert(!/(?:DEVELOPMENT_HANDOFF|PROJECT_CONVERSATION_HISTORY|CLAUDE_HANDOFF)/i.test(path),path);
    assert(!/(?:\.pem|\.key|\.sqlite3?|\.db|\.dump|\.bak|\.sql\.(?:gz|zip|zst))$/i.test(path),path);
    assert(!/(^|\/)\.env(?:\.|$)/.test(path)||path==='installer/.env.example',path);
    if(!/\.(?:mjs|js|ts|tsx|astro|json|md|yml|sql|example)$/.test(path)||path==='tests/release-boundary.test.mjs')continue;
    let text=await readFile(path,'utf8');
    if(['server/updates/checker.mjs','server/updates/release-config.mjs'].includes(path))text=text.replaceAll('https://aoliao-aoliao.github.io/caocong-tempmail/releases/stable.json','PUBLIC_UPDATE_METADATA');
    const forbiddenMarkers=JSON.parse(process.env.NODEMAIL_RELEASE_FORBIDDEN_MARKERS||'[]');
    for(const marker of forbiddenMarkers)assert(!text.includes(marker),`Private site reference: ${path}`);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),`Private key material: ${path}`);
    assert(!/(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}/.test(text),`Token-like material: ${path}`);
  }
});

test('full backend source and schema are included, installation defaults are independent', async () => {
  const defaults=JSON.parse(await readFile('shared/deployment-defaults.json','utf8'));
  assert.equal(defaults.gmpayOrigin,'');
  assert.equal(defaults.siteOrigin,'https://mail.example.invalid');
  assert((await readFile('server/relay/poller.mjs','utf8')).split('\n').length>100);
  assert.match(await readFile('src/pages/api/auth/login.ts','utf8'),/export const POST/);
  assert.match(await readFile('server/db/migrations/017_business_receipts.sql','utf8'),/CREATE TABLE/i);
});
