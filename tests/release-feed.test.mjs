import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseFeed,fetchReleaseFeed,REPOSITORY} from '../release-tools/feed.mjs';
import {checkedFeed,createReleaseChecker,STABLE_FEED_URL} from '../server/updates/checker.mjs';
const release={tag_name:'v0.0.2',draft:false,prerelease:false,published_at:'2026-10-09T00:00:00Z',body:'Update safely; preserve your database.'};
test('formal releases notify existing installations without any business data',async()=>{
 const feed=releaseFeed(release,'0.0.2');assert.deepEqual(Object.keys(feed).sort(),['schema','product','channel','version','publishedAt','notes'].sort());
 const check=createReleaseChecker({config:{currentVersion:'0.0.1',repository:'',feed:STABLE_FEED_URL},fetcher:async()=>new Response(JSON.stringify(feed))});
 const result=await check();assert.equal(result.status,'available');assert.equal(result.latest.version,'0.0.2');
 assert.equal(checkedFeed(feed,'0.0.2').comparison,0);
});
test('draft, prerelease, invalid tag and package mismatch never publish',()=>{
 for(const patch of [{draft:true},{prerelease:true},{tag_name:'v0.0.2-beta'},{tag_name:'../../secret'},{published_at:'bad'}])assert.throws(()=>releaseFeed({...release,...patch},'0.0.2'));
 assert.throws(()=>releaseFeed(release,'0.0.1'));
});
test('metadata fetch uses only fixed repository and verifies the tagged package',async()=>{
 const calls=[];const feed=await fetchReleaseFeed(async(url,options)=>{
 calls.push(url);assert.ok(url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`));assert.equal(options.redirect,'error');
 return new Response(JSON.stringify(calls.length===1?release:{encoding:'base64',content:Buffer.from('{"version":"0.0.2"}').toString('base64')}));
 },'synthetic-token');assert.equal(feed.version,'0.0.2');assert.equal(calls.length,2);
 await assert.rejects(fetchReleaseFeed(async()=>new Response('',{status:503}),''));
});
