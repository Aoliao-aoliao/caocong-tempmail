import { getMailboxInbox } from './read-model.mjs';

const cookieName = kind => `nodemail_member_inbox_${kind}`;
const validId = value => /^MB-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// This is a preference, never an authorization token. Every read still checks
// the authenticated owner, mailbox type, status and expiry in the database.
export function rememberMemberInbox(context, userId, kind, mailboxId) {
  if (!['ordinary','relay'].includes(kind) || !validId(mailboxId)) return;
  context.cookies.set(cookieName(kind), `${userId}:${mailboxId}`, {
    httpOnly:true, sameSite:'lax', secure:context.url.protocol==='https:', path:'/',
  });
}

export async function getMemberToolInbox(context, userId, kind) {
  const value=context.cookies.get(cookieName(kind))?.value || '';
  const prefix=`${userId}:`;
  const mailboxId=value.startsWith(prefix) ? value.slice(prefix.length) : '';
  // A stale explicit selection must not silently show another mailbox's mail.
  return getMailboxInbox({userId,kind,mailboxId});
}

export async function selectMemberInbox(context, userId, mailboxId) {
  if (typeof mailboxId!=='string' || !validId(mailboxId)) {
    throw Object.assign(new Error('邮箱标识无效。'), {status:400});
  }
  const {mailbox}=await getMailboxInbox({userId,mailboxId});
  const kind=mailbox.isRelay?'relay':'ordinary';
  rememberMemberInbox(context,userId,kind,mailbox.id);
  return kind==='relay'?'/tools/real_mail.cgi':'/tools/mail.cgi';
}
