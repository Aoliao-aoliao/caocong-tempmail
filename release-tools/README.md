# 发布与部署

应用的唯一维护源是本仓库。`package.json` 表示安装版本；GitHub 正式 Release 表示对外稳定版本，文档工作流自动生成公开公告。更新提示不传送业务数据。

`Deploy owner website` 只部署作者已有站点。GitHub `production` 环境保存五个 DEPLOY_* Secrets，部署开关默认关闭。服务器侧 `/opt/nodemail/.deploy/site-profile.json` 保存原有域名等公开设置，文件不进入发行仓库。部署保留原 .env、数据库及数据挂载；迁移摘要变化即拒绝，失败恢复旧镜像。

安装者使用 installer/，不需要这些作者部署脚本。源码与运行镜像不包含 production Secrets 或服务器 profile。测试保留于仓库，运行镜像不包含部署或测试工具。
