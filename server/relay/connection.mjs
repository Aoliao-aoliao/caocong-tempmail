import { ImapFlow } from 'imapflow';
import { isIP } from 'node:net';
import { decryptRelayCredential } from '../security/secret-box.mjs';
import { microsoftOAuth } from './microsoft-oauth.mjs';
import { resolvePublicImapHost } from './network-policy.mjs';

// Every relay operation shares the same transport rules. A non-TLS port means
// mandatory STARTTLS, never permission to send credentials over plaintext.
export function relayImapOptions(account, target, credential) {
  const secure = Boolean(account.imap_secure);
  return {
    host: target.address,
    port: Number(account.imap_port),
    secure,
    ...(secure ? {} : { doSTARTTLS: true }),
    tls: { rejectUnauthorized: true, ...(!isIP(target.hostname) ? { servername: target.hostname } : {}) },
    auth: typeof credential==='object' ? {user:account.username,accessToken:credential.accessToken} : { user: account.username, pass: credential },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };
}

export async function createRelayClient(account, {
  resolveTarget = resolvePublicImapHost,
  decryptCredential = decryptRelayCredential,
  Client = ImapFlow,
  getAccessToken = account => microsoftOAuth.accessToken(account),
} = {}) {
  const target = await resolveTarget(account.imap_host);
  const credential = account.provider==='OUTLOOK' ? {accessToken:await getAccessToken(account)} : decryptCredential({
    ciphertext: account.credential_ciphertext,
    kdfSalt: account.credential_kdf_salt,
    iv: account.credential_iv,
    authTag: account.credential_auth_tag,
  });
  const client = new Client(relayImapOptions(account, target, credential));
  // ImapFlow closes failed sockets and rejects pending operations itself.
  // Consume its separate asynchronous error event so it cannot terminate the
  // shared mail process; callers report only their sanitized operation errors.
  client.on('error', () => {});
  return client;
}
