<div align="center">
  <img src="public/assets/brand/nodemail-mark.jpg" width="80" height="80" alt="NodeMail 标志" />
  <h1>NodeMail</h1>
  <p><strong>把邮箱服务部署在自己的服务器上。</strong></p>
  <p>临时邮箱 · 中继收信 · 会员与积分 · OpenAPI</p>
  <p><a href="#功能一览">功能</a> · <a href="docs/1PANEL.md">1Panel 搭建教程</a> · <a href="docs/DATA-ISOLATION.md">数据隔离</a> · <a href="docs/UPGRADING.md">更新说明</a></p>
</div>

> **私有发布预览**：这是包含完整前后端源码的独立仓库，供维护者审核项目介绍与安装流程。尚未正式公开发布；开源许可证和首个正式版本待确认。

## 项目介绍

NodeMail 是一个可自行部署的网页邮箱平台。你可以接入自己的域名收取邮件，也可以配置上游邮箱，通过中继别名提供网页收信服务。用户在网页中申请邮箱、查看邮件和附件，管理员在同一套后台管理域名、账号、会员、积分与接入配置。

每个安装环境使用自己的数据库、管理员账户和服务商凭据。更新程序不会把维护者站点的用户、订单或邮件复制到你的站点，也不会把你的业务数据同步给维护者。

## 功能一览

| 模块 | 可以做什么 |
| --- | --- |
| 临时邮箱 | 创建有有效期的收件箱，网页查看邮件与附件，按配置清理到期数据 |
| 自有域名收信 | 配置域名与 MX，通过内置 SMTP 服务接收邮件 |
| 中继邮箱 | 接入支持的 IMAP 邮箱；包含 Gmail 与 Microsoft OAuth 相关流程，需自行配置账号或应用 |
| 账户与会员 | 用户中心、会员档位、积分余额及流水、邮箱管理 |
| 管理后台 | 用户、域名、中继账号、系统设置、订单、审计与运营配置 |
| 第三方接入 | NodeLoc 登录及账户绑定、Telegram 账户绑定；支付渠道需自行配置 |
| OpenAPI | API Key、权限与频率限制，配套接口文档 |
| 更新提示 | 后台查询公开版本公告；管理员决定何时更新程序 |
| 页面与语言 | 响应式布局，主要业务界面提供简体中文、繁体中文与英文 |

**功能边界**：Telegram 当前仅绑定账号，不推送邮件或通知，也不能用于登录。支付、中继与 OAuth 不附带可用的公共账号或密钥；各安装者需要完成自己的服务商配置。SMTP 收信不等于提供可任意对外发信的服务。

## 怎么搭建？新手从这里开始

**已经安装 1Panel？直接打开 [1Panel 面板搭建教程](docs/1PANEL.md)。**

教程按页面操作写清楚：点哪里、填什么、成功后看到什么。

1. 在面板上传并解压源码。
2. 在面板终端复制命令，创建自己的管理员。
3. 创建反向代理网站，绑定域名和 HTTPS。
4. 登录后台，配置自己的收信方式。

目前需要少量终端操作，还不是应用商店一键安装。所有数据都保存在安装者自己的服务器。

不用面板？看 [普通 Linux 服务器教程](docs/BEGINNER.md)，或展开下面的命令速查。

<details>
<summary>命令行安装速查（点击展开）</summary>

### 按这 5 步走

**所有命令都在自己的 Linux 服务器 SSH 终端里执行，不是在本地 Windows 命令行执行。**

先准备一个自己的域名，安装好 Git、Docker / Compose v2 和 Node.js 22.12+。还没准备好？先看 [从零搭建详细步骤](docs/BEGINNER.md)。

| 顺序 | 要做什么 | 完成后得到什么 |
| --- | --- | --- |
| ① 下载并构建 | 复制下面第一段命令 | 本机 NodeMail 程序镜像 |
| ② 填自己的信息 | 改域名、联系邮箱和 MX，再初始化 | 自己的配置和数据库 |
| ③ 创建管理员 | 设置登录邮箱与密码，再启动 | 可以运行的网站 |
| ④ 绑定 HTTPS 域名 | 反向代理到本机 4321 端口 | 浏览器可以打开的登录页 |
| ⑤ 配置收信 | 后台添加收信域名或中继账号 | 真正可以收到邮件的邮箱 |

### ① 下载并构建

```bash
git clone https://github.com/Aoliao-aoliao/nodemail.git
cd nodemail
docker build -t nodemail-local:0.0.1 .
cd installer
```

当前仓库私有，克隆需要访问权限。首次构建会下载依赖，请等成功结束后再继续。

### ② 换成自己的域名和邮箱

下面的示例域名和邮箱必须替换。新手可让 `--site` 和 `--public` 使用同一个域名：

```bash
node manage.mjs configure --image nodemail-local:0.0.1 --site https://mail.example.com --public https://mail.example.com --contact admin@example.com --mx mx.example.com
node manage.mjs init
```

`--site` / `--public` 是网站地址，`--contact` 是联系邮箱，`--mx` 是准备配置的邮件服务器名称。独立密码和主密钥会保存到 `installer/.env`，请妥善保留。只对全新环境初始化，不要用来覆盖旧站。

### ③ 创建管理员并启动

把下面的管理员邮箱换成自己的。密码至少 12 位；输入时不显示字符是正常现象：

```bash
read -r -s -p '请输入管理员密码（至少12位）: ' NODEMAIL_ADMIN_PASSWORD
printf '\n'
printf '%s' "$NODEMAIL_ADMIN_PASSWORD" | node manage.mjs bootstrap --email admin@example.com
unset NODEMAIL_ADMIN_PASSWORD
node manage.mjs start
```

没有默认管理员密码。此时程序只监听本机 `127.0.0.1:4321`，还需要下一步才能从外部访问。

### ④ 绑定域名，再登录

将网站域名解析到服务器，配置 HTTPS 反向代理，目标填写 **`http://127.0.0.1:4321`**。完整规则见 [第 4 步教程](docs/BEGINNER.md#4-绑定域名并配置-https)。

随后打开 **`https://你的域名/user/login.cgi`**，用刚创建的管理员登录，再访问 **`https://你的域名/admin/`**。

### ⑤ 配置收信后再使用

网站能打开不代表已经能收信。选择自有域名收信或中继邮箱，在后台完成相应配置；开放注册前还要配置 Turnstile 验证码。详见 [第 5 步教程](docs/BEGINNER.md#5-让网站真正收到邮件)。

遇到问题先看 [常见问题](docs/BEGINNER.md#常见问题)，不要删除数据库或重复初始化。

</details>

## 数据属于每个安装者

| 内容 | 随源码发布 | 安装后存放在哪里 |
| --- | --- | --- |
| 前端、后端与建表结构 | 是 | 项目与程序镜像 |
| 默认档位和初始配置模板 | 是 | 新装时写入自己的数据库，可自行调整 |
| 用户、积分、订单和邮件 | 否 | 各自的数据库 |
| 邮件附件 | 否 | 各自的附件数据卷 |
| 支付密钥、邮箱密码、OAuth 令牌 | 否 | 各自的配置与数据库；按模块进行加密保护 |
| 数据库密码和应用主密钥 | 否 | 安装者自己的 `.env` |

源码相同，运行数据独立。完整说明见 [数据隔离与配置边界](docs/DATA-ISOLATION.md)。

## 如何更新

后台的“检查更新”读取公开版本信息，不自动替换程序。维护者发布新版本后，安装者先查看变更说明、备份自己的数据，再构建或取得对应镜像并执行升级。

当前升级工具支持**数据库结构不变的版本**。涉及数据库迁移时会停止，必须按该版本的专门指引处理；不能用重新初始化代替升级。详见 [更新与恢复](docs/UPGRADING.md)。

## 技术与目录

Astro + React 构建界面，Node.js 提供后端、SMTP 与中继任务，MySQL 8 保存业务数据，Docker Compose 管理独立运行环境。

```text
src/             页面、组件、样式、API 路由与中间件
server/          完整后端源码：认证、邮件、中继、支付及管理逻辑
shared/          不含密钥的默认配置模板
installer/       Docker Compose、配置生成与安装升级工具
distribution/    独立部署的启动、初始化与域名适配代码
openapi-docs/    API 文档页面
tests/           安装与隔离容器回归测试
```

构建检查不需要生产数据库：

```bash
npm ci
npm run check
npm run test:installer
npm run build
npm audit
```

数据库与容器测试使用专用的隔离 CI 环境，不要连接真实业务数据库。验证范围见 [测试说明](docs/VALIDATION.md)。

## 当前发布状态

- 完整前端与后端源码均在此仓库，不需要额外的闭源后端包。
- 仓库保持私有，没有自动部署或公开镜像发布任务。
- 当前 `0.0.1` 为预览代码版本，不代表已正式发布。
- 项目许可证、第三方素材及字体的分发说明仍需在正式公开前确认，见 [许可状态](LICENSE-STATUS.md)。

欢迎先审阅项目介绍、功能范围与部署方式，再决定正式发行名称、许可和版本。

---

<div align="center">
  <p><strong>Copyright © 2026 草丛（Aoliao-aoliao） · NodeMail</strong></p>
  <p><a href="COPYRIGHT.md">版权与署名</a> · <a href="LICENSE-STATUS.md">许可状态</a></p>
</div>
