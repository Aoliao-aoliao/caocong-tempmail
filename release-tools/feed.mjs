import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedFeed } from '../server/updates/checker.mjs';
export const REPOSITORY = 'Aoliao-aoliao/caocong-tempmail';
export function releaseFeed(release, packageVersion) {
  if (!release || release.draft !== false || release.prerelease !== false
      || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name)
      || release.tag_name !== `v${packageVersion}` || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('Release must be a published stable tag matching package.json');
  }
  const feed = {schema:1, product:'NodeMail', channel:'stable', version:packageVersion,
    publishedAt:new Date(release.published_at).toISOString(),
    notes:typeof release.body === 'string' ? release.body.slice(0,8000) : ''};
  checkedFeed(feed, packageVersion);
  return feed;
}
export async function fetchReleaseFeed(fetcher = fetch, token = process.env.GH_TOKEN) {
  const headers = {Accept:'application/vnd.github+json', 'User-Agent':'Caocong-TempMail-Release'};
  if (token) headers.Authorization=`Bearer ${token}`;
  async function get(path) {
    const res=await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error(`Release metadata unavailable (${res.status})`);
    const text=await res.text();if(Buffer.byteLength(text)>1000000)throw new Error('Oversized release metadata');
    return JSON.parse(text);
  }
  const release=await get('releases/latest');
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name || '')) throw new Error('Invalid stable tag');
  const file=await get(`contents/package.json?ref=${encodeURIComponent(release.tag_name)}`);
  if(file.encoding!=='base64')throw new Error('Invalid package response');
  const pkg=JSON.parse(Buffer.from(file.content,'base64').toString('utf8'));
  return releaseFeed(release,pkg.version);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const feed=await fetchReleaseFeed();
  await writeFile(new URL('../docs-site/content/public/releases/stable.json',import.meta.url),JSON.stringify(feed,null,2)+'\n');
  console.log(`Published metadata prepared: ${feed.version}`);
}
