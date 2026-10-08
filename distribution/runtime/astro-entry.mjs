import {createApp} from 'astro/app/entrypoint';
import {setGetEnv} from 'astro/env/setup';
import * as options from 'virtual:astro-node:config';
// These internals are locked by package-lock.json and tested against the actual build.
import standalone, {createStandaloneHandler} from '../../node_modules/@astrojs/node/dist/standalone.js';
import {httpsOrigin} from '../../server/config/deployment.mjs';

setGetEnv(key => process.env[key]);
const origins = [process.env.NODEMAIL_SITE_ORIGIN, process.env.NODEMAIL_PUBLIC_ORIGIN || process.env.NODEMAIL_SITE_ORIGIN];
if (!origins[0]) throw new Error('请先配置 NODEMAIL_SITE_ORIGIN。');
const urls = origins.map(origin => new URL(httpsOrigin(origin)));
const hosts = new Set(urls.map(url => url.host));
const app = createApp({streaming:true});
app.manifest.allowedDomains = urls.map(url => ({hostname:url.hostname, protocol:'https', ...(url.port ? {port:url.port} : {})}));
// Loopback only exists for the container's healthcheck, not a public domain wildcard.
app.manifest.allowedDomains.push({hostname:'127.0.0.1', protocol:'http'}, {hostname:'localhost', protocol:'http'});
const underlying = createStandaloneHandler(app, options);
function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (hosts.has(host)) {
    const forwarded = req.headers['x-forwarded-host'];
    return !forwarded || hosts.has(String(forwarded).split(',')[0].trim().toLowerCase());
  }
  return /^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/.test(host)
    && (req.url === '/api/health' || req.url === '/api/health/');
}
const handler = (req, res) => {
  if (!hostAllowed(req)) {res.writeHead(421);res.end('Misdirected Request');return;}
  underlying(req, res);
};
// The official standalone accepts an app, so retain its listener lifecycle and
// enforce the same host check before its handler sees a request.
const startServer = () => {
  const result = standalone(app, options);
  const listeners = result.server.server.listeners('request');
  result.server.server.removeAllListeners('request');
  result.server.server.on('request', (req, res) => {
    if (!hostAllowed(req)) {res.writeHead(421);res.end('Misdirected Request');return;}
    for (const listener of listeners) listener.call(result.server.server, req, res);
  });
  return result;
};
if (process.env.ASTRO_NODE_AUTOSTART !== 'disabled') startServer();
export {handler, options, startServer};
