# 报告安全问题

发现疑似漏洞，请使用 GitHub 的私密漏洞报告入口：
https://github.com/Aoliao-aoliao/caocong-tempmail/security/advisories/new

不要在公开 Issue、截图或提交中上传密码、私钥、OAuth 令牌、支付凭据、真实邮件或数据库导出。报告应包括受影响版本、最小复现步骤和脱敏证据。

安装时使用独立凭据，应用 HTTP 端口保持本机绑定；数据库不开放公网。更新保留原 .env、数据库与附件。详见 docs-site/content/data.md 与 docs-site/content/backup.md。

公开源码及通过测试不等于没有漏洞。真实第三方服务、部署环境和后续修改需要持续验证。
