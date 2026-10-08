import type { APIRoute } from "astro";
import { apiError, requireApiUser } from "../../../../../server/http/api.mjs";
import { sessionCookieName } from "../../../../../server/auth/service.mjs";
import { consumeAuthRateLimit } from "../../../../../server/auth/request-security.mjs";
import { microsoftOAuth } from "../../../../../server/relay/microsoft-oauth.mjs";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
// Same-origin, authenticated navigation; no token or client secret in the URL.
export const GET: APIRoute = async (context) => {
  try {
    const { user, ipAddress } = await requireApiUser(context, {
      admin: true,
      jsonBody: false,
    });
    if (context.url.searchParams.getAll("id").length !== 1)
      throw Object.assign(new Error("请求账号参数无效。"), { status: 400 });
    const rate = await consumeAuthRateLimit({
      action: "ADMIN_MICROSOFT_OAUTH",
      identifier: `${user.id}:${ipAddress}`,
      limit: 20,
      windowSeconds: 300,
    });
    if (!rate.allowed)
      throw Object.assign(
        new Error(`操作过于频繁，请 ${rate.retryAfter} 秒后重试。`),
        { status: 429 },
      );
    const authorization = await microsoftOAuth.begin({
      id: context.url.searchParams.get("id"),
      actor: user,
      session: context.cookies.get(sessionCookieName)?.value,
      origin: context.url.origin,
    });
    const url = new URL(authorization.url);
    if (
      url.origin !== "https://login.microsoftonline.com" ||
      url.pathname !== "/consumers/oauth2/v2.0/authorize"
    )
      throw new Error("Invalid authorization destination");
    return new Response(null, {
      status: 303,
      headers: {
        location: url.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    const safe = apiError(error, "微软授权暂时无法发起，请稍后重试。");
    const { message } = await safe.json();
    return new Response(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微软邮箱授权 | NodeMail</title><style>body{margin:0;padding:32px 16px;background:#f3faf8;font:16px/1.7 system-ui;color:#343a40}main{max-width:560px;margin:10vh auto;padding:28px;background:white;border:1px solid #dce8e4}h1{font-size:22px}p{overflow-wrap:anywhere}a{color:#008e6e}</style></head><body><main><h1>暂未进入微软授权</h1><p role="alert">${escapeHtml(String(message))}</p><a href="/admin/relays.cgi">返回中继邮箱配置</a></main></body></html>`,
      {
        status: safe.status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
};
