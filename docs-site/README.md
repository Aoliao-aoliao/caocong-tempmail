# 文档维护

源码、安装工具、文档统一在 caocong-tempmail 仓库维护。正文只编辑 `content/`，不再生成或同步另一份 Markdown。导航在 `.vitepress/config.mjs`，图片在 `content/public/`。

```bash
npm ci
npm run build
npm test
npm run preview -- --port 4178
```

预览地址是 http://127.0.0.1:4178/caocong-tempmail/ ，仅本机可访问。线上文档是 https://aoliao-aoliao.github.io/caocong-tempmail/ 。演示站 https://nodemail.513399.xyz/ 。

推送文档修改后，Pages 工作流会构建、检查并发布静态页面。它不连接邮箱数据库，不部署邮箱服务。更新公告在 `content/public/releases/stable.json`，只在实际发行版本时更新；保持内部 product 字段 NodeMail 与代码兼容。

文档框架锁定 VitePress 2.0.0-alpha.20，升级它后需重新核对搜索、导航和移动端。当前支持独立 GitHub Pages 项目路径。
