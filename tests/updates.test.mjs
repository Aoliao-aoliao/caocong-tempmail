import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkedFeed, createReleaseChecker, STABLE_FEED_URL } from '../server/updates/checker.mjs';
const published = JSON.parse(await readFile('docs-site/content/public/releases/stable.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const feed = {...published, version:pkg.version};
const config = { feed: STABLE_FEED_URL, repository: '', currentVersion: pkg.version };
test('published metadata matches installer; remote URLs cannot become update links', () => {
  assert.equal(checkedFeed(feed, pkg.version).comparison, 0);
  assert.equal(checkedFeed({...feed, url:'https://evil.invalid', download:'file:///etc/passwd'},pkg.version).url,`https://github.com/Aoliao-aoliao/caocong-tempmail/releases/tag/v${pkg.version}`);
  assert.throws(() => checkedFeed({...feed, product:'Other'},pkg.version));
  assert.throws(() => checkedFeed({...feed, version:'0.0.2-beta'},pkg.version));
});
test('update checks use fixed origin, cache results and retain last success during outage', async () => {
  let time=0, calls=0, fail=false;
  const check=createReleaseChecker({config,now:()=>time,fetcher:async(url,opts)=>{
    calls++; assert.equal(url,STABLE_FEED_URL);assert.equal(opts.redirect,'error');
    if(fail)throw new Error('offline');
    return new Response(JSON.stringify(feed));
  }});
  assert.equal((await check()).status,'current');
  assert.equal((await check({force:true})).cached,true);assert.equal(calls,1);
  time=61000;fail=true;
  const result=await check({force:true});
  assert.equal(result.status,'unavailable');assert.equal(result.latest.version,pkg.version);
  assert.ok(result.lastSuccessAt);assert.equal(calls,2);
});
test('untrusted update endpoint is rejected before any request',async()=>{
  const check=createReleaseChecker({config:{...config,feed:'http://127.0.0.1/'},fetcher:()=>{throw new Error('must not fetch')}});
  assert.equal((await check()).status,'invalid-config');
});
