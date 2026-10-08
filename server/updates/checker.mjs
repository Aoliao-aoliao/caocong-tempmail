import { readBoundedText } from '../http/request-body.mjs';
import { releaseConfig } from './release-config.mjs';

const SUCCESS_TTL = 6 * 60 * 60 * 1000;
const ERROR_TTL = 15 * 60 * 1000;
const MANUAL_COOLDOWN = 60 * 1000;
export const STABLE_FEED_URL = 'https://app.513399.xyz/releases/stable.json';

export function checkedFeed(data, currentVersion) {
  if (!data || data.schema !== 1 || data.product !== 'NodeMail' || data.channel !== 'stable'
    || typeof data.version !== 'string' || typeof data.notes !== 'string'
    || typeof data.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(data.publishedAt)
    || !Number.isFinite(Date.parse(data.publishedAt))) throw new Error('Invalid feed');
  return {
    version: data.version, comparison: compareStableRelease(data.version, currentVersion),
    publishedAt: data.publishedAt, notes: data.notes.slice(0, 8000),
    // No remote-supplied URLs, downloads, commands or HTML are accepted.
    url: null,
  };
}

export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
}

// Public updates are stable releases. A stable tag is newer than its own prerelease.
export function compareStableRelease(tag, current) {
  const next = parseVersion(tag), installed = parseVersion(current);
  if (!next || next.prerelease || !installed) throw new Error('Invalid release version');
  for (let i = 0; i < 3; i++) {
    if (next.parts[i] !== installed.parts[i]) return Math.sign(next.parts[i] - installed.parts[i]);
  }
  return installed.prerelease ? 1 : 0;
}

export function validRepository(value) {
  return typeof value === 'string' && value.length <= 140
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
    && !value.endsWith('.git');
}

export function checkedRelease(data, repository, currentVersion) {
  if (!validRepository(repository) || !data || data.draft !== false || data.prerelease !== false
    || typeof data.tag_name !== 'string') throw new Error('Invalid release');
  const comparison = compareStableRelease(data.tag_name, currentVersion);
  const published = Date.parse(data.published_at);
  if (!Number.isFinite(published)) throw new Error('Invalid publication date');
  return {
    version: data.tag_name,
    // Never use provider-supplied links, HTML or scripts.
    url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(data.tag_name)}`,
    notes: typeof data.body === 'string' ? data.body.slice(0, 8000) : '',
    publishedAt: new Date(published).toISOString(),
    comparison,
  };
}

export function createReleaseChecker({ config = releaseConfig, fetcher = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  let cached = null, inflight = null, expiresAt = 0, attemptedAt = -Infinity;
  const isFeed = Boolean(config.feed);
  const base = { currentVersion: config.currentVersion, repository: config.repository || null, source: isFeed ? STABLE_FEED_URL : config.repository || null };
  return async function check({ force = false } = {}) {
    if (!config.repository && !isFeed) return { ...base, status: 'unconfigured', checkedAt: null, lastSuccessAt: null, latest: null, retryAt: null };
    if ((isFeed ? config.feed !== STABLE_FEED_URL || Boolean(config.repository) : !validRepository(config.repository)) || !parseVersion(config.currentVersion)) {
      return { ...base, repository: null, source: null, status: 'invalid-config', checkedAt: null, lastSuccessAt: null, latest: null, retryAt: null };
    }
    if (inflight) return inflight;
    if (cached && (now() < attemptedAt + MANUAL_COOLDOWN || (!force && now() < expiresAt))) return { ...cached, cached: true };
    attemptedAt = now();
    inflight = (async () => {
      let response;
      try {
        response = await fetcher(isFeed ? STABLE_FEED_URL : `https://api.github.com/repos/${config.repository}/releases/latest`, {
          headers: isFeed ? { Accept: 'application/json', 'User-Agent': 'NodeMail-Update-Checker', 'Cache-Control': 'no-cache' }
            : { Accept: 'application/vnd.github+json', 'User-Agent': 'NodeMail-Update-Checker', 'X-GitHub-Api-Version': '2022-11-28' },
          redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('Release source unavailable');
        const data = JSON.parse(await readBoundedText(response, 65536));
        const latest = isFeed ? checkedFeed(data, config.currentVersion) : checkedRelease(data, config.repository, config.currentVersion);
        const checkedAt = new Date(now()).toISOString();
        cached = { ...base, status: latest.comparison > 0 ? 'available' : latest.comparison < 0 ? 'ahead' : 'current',
          checkedAt, lastSuccessAt: checkedAt, latest, retryAt: new Date(attemptedAt + MANUAL_COOLDOWN).toISOString() };
        expiresAt = now() + SUCCESS_TTL;
      } catch {
        // Keep the last validated release, but never mistake an outage/404 for "up to date".
        cached = { ...base, status: 'unavailable', checkedAt: new Date(now()).toISOString(),
          lastSuccessAt: cached?.lastSuccessAt || null, latest: cached?.latest || null,
          retryAt: new Date(attemptedAt + MANUAL_COOLDOWN).toISOString() };
        expiresAt = now() + ERROR_TTL;
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
      return { ...cached, cached: false };
    })();
    try { return await inflight; } finally { inflight = null; }
  };
}

export const checkForUpdates = createReleaseChecker();
