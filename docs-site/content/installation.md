# 草丛临时邮箱 独立部署指南（源码部署）

> 使用 1Panel 面板？优先看 [按页面操作的搭建教程](/panel.html)，包含填写示例与常见问题。

本目录用于一套全新的独立环境。安装者使用自己的域名、数据库、账号及服务商凭据；不包含发布者的网站数据、密码或 Git 历史。当前发布完整源码，需自行构建镜像，尚无预构建镜像下载地址。不要拿它覆盖已有 草丛临时邮箱 生产安装。

## 前提

- Linux、Docker Engine、Docker Compose v2（支持 `up --wait`），以及 Node.js 22.12 或更新版本。
- 已构建或取得可信的 草丛临时邮箱 独立发行镜像，使用明确版本标签或 `@sha256:...` 摘要。安装工具不接受 `latest`。
- HTTPS 反向代理把安装者域名转到本机 `127.0.0.1:4321`。默认 HTTP 不公开，MySQL 只有容器内部网络，没有宿主端口。
- 收取普通域名邮件需要服务器允许入站 TCP 25，并为自己的域名配置 MX。云厂商的出站/入站限制需要自行核实。中继邮箱、支付、OAuth 和 Telegram 都使用安装者自己的后台配置。

Nginx HTTPS 站点中的反向代理示例（证书和 `server_name` 使用自己的配置）：

```nginx
location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
}
```

`Host` 与 `X-Forwarded-Host` 都要保留安装域名，不能一个为 localhost、另一个为公网域名，否则可能收到 421。应用从受信任本机代理读取 `X-Real-IP`，因此该行必须由代理覆盖，不能透传客户端提供的同名头；否则可能把所有用户识别为代理 IP，或接受伪造 IP。上例同时覆盖 `X-Forwarded-For`，应用 HTTP 端口保持仅本机可访问。使用 Cloudflare 时，先在 Nginx 按官方公布的可信代理网段设置 real IP，再用 `$remote_addr`；不要直接信任任意客户端提交的 `X-Forwarded-For`、`X-Real-IP` 或 `CF-Connecting-IP`。

## 从完整源码构建

本仓库包含完整前后端源码，无需下载额外的闭源后端包。源码仓库公开，可直接克隆：

```bash
git clone https://github.com/Aoliao-aoliao/caocong-tempmail.git
cd caocong-tempmail
docker build -t nodemail-local:0.0.1 .
cd installer
```

首次构建需要下载基础镜像和 npm 依赖。当前没有公开镜像；安装工具会使用本机已有的明确版本标签。接着执行下方新装步骤，使用全新数据库，不能直接覆盖已有站点。

## 新装

在源码的 `installer/` 目录运行以下命令，把示例域名和邮箱换成自己的值。若已按上一节构建，保留该本地镜像标签：

```sh
node manage.mjs configure --image nodemail-local:0.0.1 --site https://mail.example.com --public https://www.example.com --contact admin@example.com --mx mx.example.com
node manage.mjs init
```

`configure` 只会新建 `.env`，随机生成独立数据库密码和应用主密钥，文件权限为 600；已有 `.env` 时拒绝覆盖。项目名随机生成，多套安装不会共用默认容器或数据卷。`init` 只启动数据库并初始化**完全空的数据库**，写入默认方案，不创建演示用户、邮件、钱包或中继账号。

初始化管理员密码通过标准输入传入，不写在命令参数或命令历史中：

```sh
read -r -s -p 'Administrator password (12–255 characters): ' NODEMAIL_ADMIN_PASSWORD
printf '\n'
printf '%s' "$NODEMAIL_ADMIN_PASSWORD" | node manage.mjs bootstrap --email admin@example.com
unset NODEMAIL_ADMIN_PASSWORD
node manage.mjs start
```

创建管理员仅允许一次，并要求账户表为空；并发运行只会有一个成功。没有通用默认账号或默认密码。此管理员初始积分为 0。

打开 `https://mail.example.com/user/login.cgi`，使用刚创建的管理员登录，进入 `/admin/`。先在安全配置中设置自己网站的 Turnstile，注册功能要求验证码。然后按需配置收信域名、MX、中继邮箱、价格和付款渠道；新装不自动授权第三方或发真实邮件。默认会员/充值档位是可修改的起始模板，不代表渠道已能付款。

SMTP 默认公开端口 25；可修改 `.env` 的 `SMTP_BIND`、`SMTP_PORT`。本机测试可设 `SMTP_BIND=127.0.0.1`、`SMTP_PORT=12525`。证书放入本目录 `tls/`，容器只读挂载；按需设置 `SMTP_TLS_KEY_FILE=/app/tls/key.pem` 和 `SMTP_TLS_CERT_FILE=/app/tls/cert.pem`，确保容器 UID 1000 可读。未配置 TLS 时不会提供 STARTTLS。

USDT 网关须在 `.env` 显式设置自己的 `NODEMAIL_GMPAY_ORIGIN`（HTTPS 根地址）；留空时不可启用，不会连接发布者收款平台。随后在管理员后台填写自己的商户凭据。绑定订单后不要更换网关地址；更换平台需要单独迁移旧订单，不能仅改域名。

如果初始化中断留下部分表，工具会拒绝继续，也不会清库。检查错误后使用新的空数据库/全新安装目录重试；不要对现有数据执行重新初始化。

## 更新

管理员的版本通知只提供更新提示，不自动安装。先保存自己的数据库、`.env`、附件卷和 TLS 的可恢复副本，再取得可信新镜像并执行：

```sh
node manage.mjs check
node manage.mjs upgrade --image registry.example.com/nodemail:NEXT_VERSION
```

候选镜像先对当前库做只读校验，核对迁移文件名、固定内容摘要、迁移登记和应用主密钥。仅数据库结构不变的版本可以自动替换；任何迁移变化均停止，等待该版本专门审核的升级指引，不自动运行 `db:init`。

健康检查成功后，只把使用的镜像写入 `.active-image`。`.env`、数据库和附件卷、TLS 不会覆盖或删除。激活失败会恢复原镜像；若恢复也失败，命令返回失败，需要检查 Docker 日志。更新期间应用会短暂重启。旧镜像保留供恢复，工具不清理别的项目。

**务必保留原 `GUEST_SESSION_SECRET`**：它还用于解密支付、OAuth、Telegram 和 API 密钥。主密钥不匹配时工具拒绝启动或升级，不能通过重新生成 `.env` 处理。

若安装工具异常退出，先确认没有仍在运行的安装/升级进程，再处理 `.operation.lock`。不要盲删锁重复执行。镜像更新成功但本地状态未写入时，核对实际容器镜像后再恢复状态。

## 范围与限制

- 此包不是旧生产环境迁入工具，不自动导入数据、复制账号或共用发布者数据库。
- 当前为完整源码发行，采用 AGPL-3.0-only。
- 当前只允许同 schema 的版本更新；未来新增迁移必须有独立经过测试的升级流程。
- 普通启动只校验并启动服务，不重复播种默认价格，不重设密码。
- 服务会执行正常的邮箱到期清理、中继轮询、DNS 检查及日志保留；启用真实中继前请阅读对应后台说明。
- 此仓库包含可阅读的完整前后端代码；项目原创内容采用 AGPL-3.0-only，第三方组件保留各自许可。
