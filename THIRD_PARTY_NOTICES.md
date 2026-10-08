# 第三方版权与许可

项目原创部分采用 AGPL-3.0-only，以下组件仍遵循各自许可证。

## 自托管字体

`public/assets/fonts/` 中的字体采用 SIL Open Font License 1.1。发布时随字体保留以下上游版权与完整许可：

- Marcellus：[许可](public/assets/fonts/LICENSE-Marcellus.txt)，来源 https://github.com/google/fonts/tree/main/ofl/marcellus
- Schibsted Grotesk：[许可](public/assets/fonts/LICENSE-Schibsted-Grotesk.txt)，来源 https://github.com/google/fonts/tree/main/ofl/schibstedgrotesk
- IBM Plex Mono：[许可](public/assets/fonts/LICENSE-IBM-Plex-Mono.txt)，来源 https://github.com/google/fonts/tree/main/ofl/ibmplexmono

字体许可证不会被项目 AGPL 取代。字体的保留名称和再分发条件以对应文件为准。

## 软件依赖

应用与文档站分别通过 `package-lock.json` 和 `docs-site/package-lock.json` 锁定依赖。Astro、React、VitePress、数据库驱动、邮件组件及它们的传递依赖保留各自许可证；使用 npm 安装的依赖包中的 LICENSE/NOTICE 文件属于分发内容，不应移除。Docker 基础镜像中的 Node.js、操作系统及 MySQL 也遵循各自许可。

品牌署名与项目维护者见 COPYRIGHT.md。文档操作示意图位于 docs-site/content/public/illustrations，为本项目编写，不代表 1Panel 的官方截图或背书。
