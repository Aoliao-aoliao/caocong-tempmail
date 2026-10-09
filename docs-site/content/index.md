---
layout: home
hero:
  name: 草丛临时邮箱
  text: 搭建与使用文档
  tagline: 安装、收信、支付与维护，从这里开始。
  actions:
    - theme: brand
      text: 开始搭建
      link: /panel
    - theme: alt
      text: 访问演示站 ↗
      link: https://nodemail.513399.xyz/
features:
  - title: 01 / 安装网站
    details: 准备域名和服务器，用 1Panel 启动程序、配置 HTTPS，再创建自己的管理员。
    link: /panel
    linkText: 1Panel 图文教程
  - title: 02 / 配置收信
    details: 配置自己的收信域名，或接入已有邮箱。先收到第一封测试邮件。
    link: /mail
    linkText: 域名与中继收信
  - title: 03 / 接入支付
    details: NodeLoc 能量与 USDT 分开配置，说明商户、密钥、回调地址和到账检查。
    link: /payments
    linkText: 支付对接教程
  - title: 04 / 日常维护
    details: 保存数据库、附件与安装密钥，按版本说明更新，遇到问题对照日志排查。
    link: /backup
    linkText: 备份与更新
---

<div class="home-reading">
<div class="reading-heading"><span>常用文档</span><p>已经装好？直接找到下一步。</p></div>
<div class="reading-links">

[第一次进入后台 →](/admin)

[不装 Node.js，纯 Docker 部署 →](/docker)

[Gmail / Outlook 怎么接 →](/relay-setup)

[人机验证怎么配 →](/turnstile)

[用户找回密码收不到验证码 →](/password-mail)

[后台每个菜单是干什么的 →](/admin-guide)

[给用户看的使用说明 →](/user-guide)

[NodeLoc 支付怎么填 →](/payment-nodeloc)

[USDT 网关怎么接 →](/payment-usdt)

[已付款却没到账 →](/payments#已付款但没到账)

[网页正常但收不到信 →](/troubleshooting#网站正常-但收不到邮件)

[更新前需要备份什么 →](/backup)

</div>
<div class="home-note">

**当前发布状态** · 完整前后端与文档统一公开，采用 AGPL-3.0。安装者使用自己的数据库、域名和密钥。[查看发布说明](/license)。

演示站：[nodemail.513399.xyz](https://nodemail.513399.xyz/)。这是实际运行的站点，请使用自己的账户体验。

</div>
</div>
