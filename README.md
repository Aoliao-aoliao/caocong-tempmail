<div align="center">
  <img src="public/assets/brand/nodemail-mark.jpg" width="72" height="72" alt="草丛临时邮箱" />
  <h1>草丛临时邮箱</h1>
  <p>Caocong TempMail · 自行部署的临时邮箱与中继收信平台</p>
  <p><a href="https://aoliao-aoliao.github.io/caocong-tempmail/">在线文档</a> · <a href="https://nodemail.513399.xyz/">演示站</a> · <a href="docs-site/content/panel.md">1Panel 安装</a> · <a href="docs-site/content/payments.md">支付对接</a></p>
</div>

## 这个项目能做什么？

用户可以申请有有效期的邮箱，在网页中查看邮件和附件。管理员可以配置收信域名、中继账号、会员和积分。支持 NodeLoc 登录、NodeLoc 能量支付及 GM Pay / EPUSDT v2 的 USDT/TRC20 支付；这些功能需要安装者提供自己的应用和商户资料。

前端、后端和文档都在本仓库，采用 **AGPL-3.0-only**。新安装没有作者的用户、邮件、订单、数据库或密钥，也没有默认管理员密码。它与「草丛 Mail」企业邮箱项目分开维护。

## 开始安装

已有 1Panel，直接看 [1Panel 图文教程](docs-site/content/panel.md)。习惯 SSH 命令行，可以看 [Linux 安装教程](docs-site/content/linux.md)。

准备 Linux、Docker / Compose v2、Node.js 22.12+ 和自己的域名。在服务器终端下载并构建：

```bash
git clone https://github.com/Aoliao-aoliao/caocong-tempmail.git
cd caocong-tempmail
docker build -t nodemail-local:0.0.2 .
```

然后按教程生成自己的配置、初始化空数据库、创建管理员并设置 HTTPS。镜像中的 `nodemail` 是内部技术名称，不用自行改名。当前提供源码构建方式，不提供预构建镜像。

## 文档入口

| 要做什么 | 去哪里看 |
| --- | --- |
| 第一次进入后台 | [后台配置](docs-site/content/admin.md) |
| 配域名和中继收信 | [收信教程](docs-site/content/mail.md) |
| 配 NodeLoc 支付 | [密钥、汇率与回调](docs-site/content/payment-nodeloc.md) |
| 配 USDT 收款 | [网关、商户与到账核验](docs-site/content/payment-usdt.md) |
| 备份、更新、排错 | [备份](docs-site/content/backup.md) · [更新](docs-site/content/upgrading.md) · [排查](docs-site/content/troubleshooting.md) |
| API 接入 | 安装后登录 `/openapi/docs.cgi`；接口定义在 `public/openapi/nodemail-openapi.json` |

## 当前功能边界

- Telegram 仅绑定账号，不推送邮件或通知，也不能用于登录。
- 自动付款接入为 NodeLoc 能量和 USDT/TRC20；其他渠道的展示开关不代表已接通支付。
- 更新检查只读取同一仓库发布的版本公告，不自动安装，不上传业务数据。
- 当前升级工具只处理数据库结构不变的版本。涉及迁移时会拒绝，需按该版本专门的迁移说明操作。
- 1Panel 文档经过代码与官方资料核对，但未完成真实面板的逐屏实装验收；真实第三方收信、付款和授权需各安装者验收。

## 仓库目录说明

| 目录 | 用途 |
| --- | --- |
| `src`、`server`、`shared`、`public` | 网站页面、后端、共享配置和静态资源 |
| `installer`、`distribution` | 独立安装、初始化与容器启动 |
| `docs-site`、`openapi-docs` | 在线教程与登录后的 API 文档模板 |
| `release-tools`、`scripts` | 版本公告生成、部署、回滚与旧产物清理 |
| `tests`、`.github/workflows` | 安装、升级和安全边界的自动检查；测试代码不进入运行镜像 |

这里的 `tests` 是维护项目所需的检查代码，不包含真实用户或邮件，也不会在网站运行时执行。临时日志、测试数据库、构建缓存和本地安装配置不提交到仓库。

## 开发与验证

```bash
npm ci
npm run check
npm run test:offline
npm run build
npm audit --omit=dev
```

数据库和容器回归由 Actions 在隔离环境执行，仅使用回环地址上的 `nodemail_ci`。不要拿生产数据库做测试。文档源码位于 `docs-site/content/`，维护和本机预览见 [文档说明](docs-site/README.md)。

## 版权和许可

Copyright © 2026 草丛（Aoliao-aoliao） · Caocong TempMail。

项目原创内容采用 [AGPL-3.0-only](LICENSE)。第三方字体、依赖及基础软件保留各自的版权与许可，见 [第三方说明](legal/THIRD_PARTY_NOTICES.md)。安全问题请使用 [安全报告说明](.github/SECURITY.md) 中的渠道。
