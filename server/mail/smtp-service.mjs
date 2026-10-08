import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { AttachmentStore } from './attachment-store.mjs';
import { loadSmtpConfig, loadSmtpTlsOptions } from './config.mjs';
import {
  clip,
  isRiskyAttachment,
  normalizeMailboxAddress,
  smtpError,
} from './mail-utils.mjs';
import { assertMailSchema, findActiveRecipient, saveDelivery } from './repository.mjs';

function safeLogError(event, error) {
  console.error(`[smtp] ${event}`, {
    name: error?.name || 'Error',
    code: error?.code || undefined,
    message: error?.message || String(error),
  });
}

function smtpCallbackError(error, fallbackMessage = 'Temporary mail system failure') {
  if (error?.smtpSafe && Number.isInteger(error.responseCode)) return error;
  safeLogError('request failed', error);
  return smtpError(fallbackMessage, 451);
}

export async function parseLimitedMessage(stream, maximumBytes, {signal} = {}) {
  let byteLength = 0;
  const contentHash = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      byteLength += chunk.length;
      if(byteLength>maximumBytes)return callback(smtpError('Message exceeds the configured size limit',552));
      contentHash.update(chunk);
      callback(null,chunk);
    },
  });
  const sourceError=error=>limiter.destroy(error);
  const sourceClosed=()=>{if(!stream.readableEnded)limiter.destroy(smtpError('Message transfer interrupted',451));};
  const abort=()=>limiter.destroy(smtpError('Message transfer time limit exceeded',421));
  stream.once('error',sourceError);
  stream.once('close',sourceClosed);
  signal?.addEventListener('abort',abort,{once:true});
  // Register the parser error handler before piping or aborting.
  const parsing=simpleParser(limiter, {
    skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true,
    maxHtmlLengthToParse:Math.min(maximumBytes,2*1024*1024),
  });
  stream.pipe(limiter);
  if(signal?.aborted)abort();
  try {
    const parsed=await parsing;
    return {parsed,byteLength,rawSha256:contentHash.digest('hex')};
  } catch(error) {
    stream.unpipe(limiter);
    stream.destroy();
    if(error?.smtpSafe)throw error;
    throw smtpError('Malformed message content',554,error);
  } finally {
    stream.off('error',sourceError);stream.off('close',sourceClosed);
    signal?.removeEventListener('abort',abort);
  }
}

// Bound connection lifetime independently of activity (including greeting/TLS/DATA).
// Raw socket destruction also stops a peer which never finishes the SMTP DATA stream.
export function installSmtpConnectionGuards(server,config) {
  const sockets=new Map(),byIp=new Map();
  const key=(address,port)=>`${address}:${port}`;
  server.server.on('connection',socket=>{
    const ip=socket.remoteAddress||'unknown',id=key(ip,socket.remotePort);
    if((byIp.get(ip)||0)>=(config.maxConnectionsPerIp??10)){socket.end('421 Too many simultaneous connections; retry later\r\n');socket.destroySoon();return;}
    byIp.set(ip,(byIp.get(ip)||0)+1);
    const controller=new AbortController();
    const timer=setTimeout(()=>{controller.abort();socket.destroy();},config.connectionLifetimeMs??600000);
    timer.unref();
    const state={socket,controller};sockets.set(id,state);
    socket.once('close',()=>{clearTimeout(timer);controller.abort();sockets.delete(id);const count=(byIp.get(ip)||1)-1;if(count)byIp.set(ip,count);else byIp.delete(ip);});
  });
  return session=>sockets.get(key(session.remoteAddress,session.remotePort));
}

function parsedMessageData(parsed, session, byteLength, rawSha256) {
  const envelopeSender = normalizeMailboxAddress(session.envelope?.mailFrom?.address);
  const parsedSender = clip(parsed.from?.text, 320);
  const fromAddress = parsedSender || envelopeSender || 'mailer-daemon';
  const textContent = typeof parsed.text === 'string' ? parsed.text : '';
  const htmlContent = typeof parsed.html === 'string' ? parsed.html : '';
  return {
    messageId: clip(parsed.messageId, 998) || `sha256:${rawSha256}`,
    fromAddress,
    subject: clip(parsed.subject, 4096),
    textContent,
    htmlContent,
    sizeBytes: byteLength,
    riskStatus: parsed.attachments.some(isRiskyAttachment) ? 'REVIEW' : 'SAFE',
    receivedAt: new Date(),
  };
}

function validateAttachments(attachments, config) {
  if (attachments.length > config.maxAttachments) {
    throw smtpError('Too many attachments', 552);
  }
  for (const attachment of attachments) {
    const size = Number(attachment.size || attachment.content?.length || 0);
    if (!Number.isFinite(size) || size < 0 || size > config.maxAttachmentBytes) {
      throw smtpError('Attachment exceeds the configured size limit', 552);
    }
  }
}

function connectionRateLimiter(maximumPerMinute) {
  const buckets = new Map();
  const windowMs = 60000;
  return (remoteAddress) => {
    const now = Date.now();
    const key = String(remoteAddress || 'unknown');
    const recent = (buckets.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= maximumPerMinute) {
      buckets.set(key, recent);
      return false;
    }
    recent.push(now);
    buckets.set(key, recent);
    if (buckets.size > 5000) {
      for (const [address, times] of buckets) {
        if (!times.some((time) => now - time < windowMs)) buckets.delete(address);
      }
    }
    return true;
  };
}

export async function startSmtpServer({
  config = loadSmtpConfig(),
  onFatalError = (error) => safeLogError('server error', error),
} = {}) {
  const tlsOptions = await loadSmtpTlsOptions(config);
  const attachmentStore = new AttachmentStore(config.storageRoot);
  await attachmentStore.initialize();
  await assertMailSchema();
  const allowConnection = connectionRateLimiter(config.maxConnectionsPerMinute);

  let connectionState;
  const server = new SMTPServer({
    name: config.name,
    banner: 'NodeMail inbound mail service',
    secure: false,
    authOptional: true,
    disabledCommands: ['AUTH'],
    hideSMTPUTF8: true,
    disableReverseLookup: true,
    size: config.maxMessageBytes,
    maxClients: config.maxConnections,
    socketTimeout: config.socketTimeoutMs,
    closeTimeout: config.closeTimeoutMs,
    logger: false,
    ...tlsOptions,

    onConnect(session, callback) {
      if (!allowConnection(session.remoteAddress)) {
        callback(smtpError('Connection rate limit exceeded; please retry later', 421));
        return;
      }
      session.nodemailRecipients = new Map();
      callback();
    },

    onMailFrom(_address, session, callback) {
      if (Number(session.transaction || 1) > config.maxMessagesPerConnection) {
        callback(smtpError('Per-connection message limit reached; reconnect to continue', 421));
        return;
      }
      session.nodemailRecipients = new Map();
      callback();
    },

    onRcptTo(address, session, callback) {
      void (async () => {
        const normalized = normalizeMailboxAddress(address.address);
        if (!normalized) throw smtpError('Invalid recipient address', 553);
        const accepted = session.nodemailRecipients || new Map();
        session.nodemailRecipients = accepted;
        if (!accepted.has(normalized) && accepted.size >= config.maxRecipients) {
          throw smtpError('Too many recipients', 452);
        }
        if (accepted.has(normalized)) return;
        const recipient = await findActiveRecipient(normalized);
        if (!recipient) throw smtpError('Mailbox unavailable', 550);
        if (
          Number(recipient.message_count) >= config.mailboxMaxMessages
          || Number(recipient.message_bytes) >= config.mailboxMaxBytes
        ) {
          throw smtpError('Mailbox storage quota exceeded; please retry later', 452);
        }
        accepted.set(normalized, recipient);
      })().then(() => callback(), (error) => callback(smtpCallbackError(error)));
    },

    onData(stream, session, callback) {
      void (async () => {
        const recipients = [...(session.nodemailRecipients?.values() || [])];
        if (!recipients.length) throw smtpError('No valid recipients', 554);
        const state=connectionState(session);
        const controller=new AbortController();
        const abort=()=>controller.abort();
        state?.controller.signal.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(abort,config.dataTimeoutMs??180000);timer.unref();
        let parsedMessage;
        try {
          if(state?.controller.signal.aborted)abort();
          parsedMessage=await parseLimitedMessage(stream,config.maxMessageBytes,{signal:controller.signal});
        } catch(error) {
          state?.socket.destroy();
          throw error;
        } finally {
          clearTimeout(timer);state?.controller.signal.removeEventListener('abort',abort);
        }
        const { parsed, byteLength, rawSha256 } = parsedMessage;
        validateAttachments(parsed.attachments, config);
        const message = parsedMessageData(parsed, session, byteLength, rawSha256);
        const result = await saveDelivery({
          recipients,
          message,
          attachments: parsed.attachments,
          attachmentStore,
          mailboxQuota: {
            maxMessages: config.mailboxMaxMessages,
            maxBytes: config.mailboxMaxBytes,
          },
        });
        console.info('[smtp] delivery stored', {
          recipients: recipients.length,
          inserted: result.inserted,
          duplicates: result.duplicates,
          sizeBytes: byteLength,
          riskStatus: message.riskStatus,
        });
      })().then(
        () => callback(null, 'Message accepted for delivery'),
        (error) => callback(smtpCallbackError(error, 'Message could not be stored; please retry')),
      );
    },
  });

  connectionState=installSmtpConnectionGuards(server,config);

  await new Promise((resolve, reject) => {
    const onListenError = (error) => {
      reject(error);
    };
    const onListening = () => {
      server.off('error', onListenError);
      resolve();
    };
    server.once('error', onListenError);
    server.listen(config.port, config.host, onListening);
  });
  server.on('error', onFatalError);
  console.info(`[smtp] listening on ${config.host}:${config.port}`);

  return {
    server,
    config,
    attachmentStore,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
