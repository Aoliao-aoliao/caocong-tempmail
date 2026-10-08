# 第一次搭建 NodeMail

这份教程只用于一套全新的环境。你安装的是自己的网站，所有账户和数据由自己的服务器保存。

## 0. 先准备这几样

| 准备项 | 怎么确认 |
| --- | --- |
| Linux 服务器 | 能用 SSH 登录，具有运行 Docker 的权限 |
| 域名 | 能修改 DNS 解析，能为网站配置 HTTPS 证书 |
| Git | `git --version` 能显示版本 |
| Docker | `docker info` 正常返回，没有连接或权限错误 |
| Compose v2 | `docker compose version` 返回版本；需支持 `up --wait` |
| Node.js | `node --version` 为 22.12 或更新版本 |

没安装 Docker？打开 [Docker 官方安装指南](https://docs.docker.com/engine/install/)，选择服务器的 Linux 系统。Node.js 使用 [官方下载页](https://nodejs.org/en/download)，选择满足要求的 LTS 版本。Git 使用系统软件源安装。

本文使用 **Bash**，在服务器 SSH 终端依次执行。不要直接复制到 Windows PowerShell。某一步报错时先处理该错误，不继续执行后续步骤。

初次搭建只用一个网站域名，例如 `mail.example.com`；`example.com` 是示例，必须换成自己控制的域名。

## 1. 下载源码并构建

```bash
git clone https://github.com/Aoliao-aoliao/nodemail.git
cd nodemail
docker build -t nodemail-local:0.0.1 .
cd installer
```

私有预览需要仓库访问权限，不能匿名克隆；正式公开后才可公开下载。不要把 GitHub token 写进克隆网址或截图。第一次构建会下载基础镜像和依赖，耗时取决于网络和服务器。

## 2. 填写自己的信息

```bash
node manage.mjs configure --image nodemail-local:0.0.1 --site https://mail.example.com --public https://mail.example.com --contact admin@example.com --mx mx.example.com
node manage.mjs init
```

| 参数 | 填什么 |
| --- | --- |
| `--image` | 与刚构建的 `nodemail-local:0.0.1` 一致 |
| `--site` | 自己的 HTTPS 网站地址，不带登录路径 |
| `--public` | 新手填与 `--site` 相同即可 |
| `--contact` | 自己用于联系用户的邮箱 |
| `--mx` | 邮件服务器名称，例如自己的 `mx.example.com` |

配置生成到当前目录的 `.env`，其中包含独立生成的密码和主密钥。保留这个文件，不发给其他人。首次初始化只创建自己的数据库及默认模板，不带其他网站的用户、订单或邮件。

## 3. 创建管理员并启动

把 `admin@example.com` 换成自己的管理员登录邮箱。密码至少 12 位，输入时终端不显示字符：

```bash
read -r -s -p '请输入管理员密码（至少12位）: ' NODEMAIL_ADMIN_PASSWORD
printf '\n'
printf '%s' "$NODEMAIL_ADMIN_PASSWORD" | node manage.mjs bootstrap --email admin@example.com
unset NODEMAIL_ADMIN_PASSWORD
node manage.mjs start
```

看到操作成功后，可在服务器检查：

```bash
curl --fail http://127.0.0.1:4321/api/health
```

正常返回包含 `"ok":true` 的结果。服务器需要保持运行；自己的电脑和 SSH 窗口可以关闭，Docker 服务仍在服务器运行。

## 4. 绑定域名并配置 HTTPS

1. 在 DNS 管理处添加网站域名的 A 记录，指向服务器公网 IPv4。
2. 在自己的反向代理或网站管理面板中创建站点，绑定该域名和有效的 HTTPS 证书。
3. 代理目标填 `http://127.0.0.1:4321`。这要求 Nginx 与应用在同一宿主机可互通；如果代理在独立容器里，容器的 `127.0.0.1` 不是宿主机，需要先配置专用网络。
4. 在该 HTTPS 站点中设置以下规则：

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

这是站点内部的代理规则，不是完整 Nginx 配置；证书和站点名称由自己的网站配置提供。域名必须与第 2 步一致。使用 Cloudflare 时先配置可信代理范围，详见 [完整部署指南](../installer/README.md)。

浏览器打开：

- 登录：`https://你的域名/user/login.cgi`
- 管理后台：`https://你的域名/admin/`

使用第 3 步创建的账户。不要寻找“默认账号密码”，项目没有提供。

## 5. 让网站真正收到邮件

两种方式按需选择。

**方式 A：自己的域名收信**

- 在后台添加和配置自己的收信域名。
- 为邮件服务器名称添加 A 记录，例如 `mx.example.com` 指向服务器。
- 为收信域名设置 MX，目标填写邮件服务器名称，不能填写 `http://` URL。例如收信域名 `example.com` 的 MX 指向 `mx.example.com`。
- 邮件服务器记录需要 DNS 直接解析，不能走普通网页代理；确认云厂商、防火墙和安全组允许入站 TCP 25。
- 然后在网页申请邮箱，从自己控制的邮箱发一封测试邮件确认收信。

**方式 B：中继邮箱收信**

在后台添加自己有权使用的上游邮箱，按服务商要求填写服务器及认证信息，检测连接后启用。Microsoft OAuth 等流程还需要自己配置应用。项目不附带可共用的 Gmail、Outlook 账户或令牌。

开放注册前先在后台配置 Turnstile 验证码。会员价格、支付商户、NodeLoc 和 Telegram 均按需配置；网站启动不代表这些服务已经接通。

## 端口对照

| 端口 | 用途 | 默认可见范围 |
| --- | --- | --- |
| 80 / 443 | 网站 HTTP / HTTPS | 由反向代理配置决定 |
| 4321 | NodeMail 应用 | 仅服务器本机，不要直接公开 |
| 25 | SMTP 收信 | 默认公开，需要云网络允许 |
| MySQL 3306 | 数据库 | 仅 Compose 内部网络 |

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| GitHub 提示没有权限 | 当前是私有预览，登录有仓库权限的账户 |
| `node: command not found` | 尚未安装 Node.js，或 SSH 环境找不到它 |
| Docker 无法连接 | Docker 服务是否运行、当前用户是否有权限 |
| `.env already exists` | 已生成配置，不要反复 configure；保留原文件，核对后续步骤 |
| 初始化提示数据库非空 | 这是防止覆盖数据的保护；确认是否误用了已有安装，不要删库绕过 |
| 健康检查成功，域名打不开 | DNS、证书、反向代理、80/443 与域名配置 |
| 页面返回 421 | 请求域名是否与配置一致；代理是否覆盖 Host 和 X-Forwarded-Host |
| 网页正常但收不到邮件 | MX、入站 TCP 25、后台域名状态或中继连接状态 |
| 多个用户一起被限流 | 检查代理是否正确覆盖 X-Real-IP |
| 忘记更新方法 | 看 [更新与恢复](UPGRADING.md)，不要重新初始化 |

提供错误信息前去除敏感内容，不要分享 `.env`、私钥或真实邮件。

---
Copyright © 2026 草丛（Aoliao-aoliao） · NodeMail
