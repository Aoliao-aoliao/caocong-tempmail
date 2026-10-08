import packageInfo from '../../package.json' with { type: 'json' };

// Public metadata only. Never configure the private source repository or a token.
// Future independent installations check the SAME publisher URL, not their own host.
export const releaseConfig = Object.freeze({
  currentVersion: packageInfo.version,
  repository: '',
  feed: 'https://aoliao-aoliao.github.io/caocong-tempmail/releases/stable.json',
});
