# 纯 Docker 部署（不用装 Node.js）

适合已经熟悉 Docker 的人。服务器只需要 **Docker（含 Compose v2）** 和 **Git**，不用另外安装 Node.js。所有命令都是普通的 `docker` / `docker compose`，日常维护和其他 Docker 项目一样。

![纯 Docker 部署的流程](/illustrations/docker.svg)

## 选哪种部署方式？

| 方式 | 服务器需要 | 适合谁 |
| --- | --- | --- |
| [Linux 命令行搭建](/linux.html) | Docker + Node.js + Git | 新手。升级时工具会先检查新版本，失败自动切回旧版本 |
| **纯 Docker 部署（本页）** | Docker + Git | 熟悉 Docker、不想多装 Node.js 的人 |
| [1Panel 图文搭建](/panel.html) | 1Panel 面板 | 习惯用面板操作的人 |

三种方式装出来的程序完全一样：都是一个 **MySQL 8 数据库容器** 加一个 **网站容器**（网页和收信都在里面）。数据库和邮件附件存放在 Docker 数据卷里，升级和重启都不会丢。

::: warning 选定一种就别混用
“Linux 命令行搭建”用 `node manage.mjs` 管理，会单独记录当前使用的镜像；本页直接修改 `.env`。在同一个安装目录里混用两种方式，可能导致重启后回到旧版本。
:::

本页的所有命令都会在 GitHub 的自动检查里**原样执行一遍**（安装、创建管理员、启动、备份、升级），确保照着做能成功。

## 0. 先准备

- 一台 Linux 服务器，能以 root 或 docker 组用户执行命令；
- 检查 Docker：

```bash
docker info
docker compose version
git --version
```

`docker info` 没有报错、`docker compose version` 显示 v2 就可以。还没安装的话，按 [Docker 官方安装说明](https://docs.docker.com/engine/install/) 安装。

- 准备好域名，并按 [准备服务器与域名](/preparation.html) 设置解析。

下文示例请替换成你自己的信息：

| 示例 | 换成 |
| --- | --- |
| `https://mail.example.com` | 用户访问网站的地址 |
| `admin@example.com` | 你的联系邮箱，也是管理员登录邮箱 |
| `mx.example.com` | 收信服务器的域名 |

## 1. 下载源码并构建镜像

```bash
git clone https://github.com/Aoliao-aoliao/caocong-tempmail.git
cd caocong-tempmail
docker build -t nodemail-local:0.0.2 .
cd installer
```

第一次构建要下载依赖，需要几分钟。后面的命令都在 `installer` 目录里执行。

## 2. 生成配置文件

借用刚构建好的镜像里的 Node.js 来生成配置，服务器本身不用装：

<!-- docker-ci:configure -->
```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" -w /work --entrypoint node nodemail-local:0.0.2 \
  manage.mjs configure --image nodemail-local:0.0.2 --site https://mail.example.com --contact admin@example.com --mx mx.example.com
```

这会在当前目录生成 `.env`，里面有随机生成的数据库密码和主密钥。

::: danger 一定要保存好 .env
`.env` 丢了或被改了，数据库和已加密的配置就再也打不开。不要删除、不要重新生成、不要发给别人。按 [备份说明](/backup.html) 和数据库一起备份。重复执行这一步不会覆盖已有的 `.env`。
:::

## 3. 初始化数据库

<!-- docker-ci:init -->
```bash
docker compose up -d --wait db
docker compose run --rm --no-deps -T app node distribution/runtime/setup.mjs init
```

第一行启动数据库并等它就绪，第二行建表。初始化只接受全新的空数据库，不会清空已有数据。

## 4. 创建管理员

密码至少 12 位，输入时屏幕上不显示：

<!-- docker-ci:admin -->
```bash
read -r -s -p '请输入管理员密码（至少12位）: ' NODEMAIL_ADMIN_PASSWORD; printf '\n'
printf '%s' "$NODEMAIL_ADMIN_PASSWORD" | docker compose run --rm --no-deps -T app node distribution/runtime/bootstrap.mjs admin@example.com
unset NODEMAIL_ADMIN_PASSWORD
```

管理员只能在账户为空时创建一次，这不是“忘记密码”的工具。忘记密码请用登录页的“忘记密码”，见 [找回密码](/password-mail.html)。

## 5. 启动网站

<!-- docker-ci:start -->
```bash
docker compose up -d --wait app
curl --fail http://127.0.0.1:4321/api/health
```

看到 `{"ok":true}` 就说明启动成功。网站默认只监听本机的 `127.0.0.1:4321`，收信监听服务器的 25 端口。

接下来按 [Linux 命令行搭建 · 绑定域名并配置 HTTPS](/linux.html#_4-绑定域名并配置-https) 配置反向代理和证书，再按 [域名与收信](/mail.html) 配置 MX，然后用管理员账号登录 `https://你的域名/admin/`。

## 日常维护

都在 `installer` 目录执行：

| 想做的事 | 命令 |
| --- | --- |
| 看运行状态 | `docker compose ps` |
| 看网站日志 | `docker compose logs -f --tail=200 app` |
| 看数据库日志 | `docker compose logs --tail=200 db` |
| 重启网站 | `docker compose restart app` |
| 停止全部 | `docker compose stop` |
| 重新启动全部 | `docker compose up -d --wait` |

::: danger 这两条命令会删数据
`docker compose down -v` 和 `docker system prune --volumes` 会**删除数据库和附件数据卷**。平时停止服务用 `docker compose stop`，不要带 `-v`。
:::

## 备份

<!-- docker-ci:backup -->
```bash
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -unodemail --single-transaction --no-tablespaces nodemail' > nodemail-db.sql
docker compose run --rm --no-deps -T --entrypoint tar app czf - -C /app/data mail-attachments > nodemail-attachments.tar.gz
```

把生成的 `nodemail-db.sql`、`nodemail-attachments.tar.gz` 连同 `.env` 和 `tls` 目录，一起复制到**另一台机器**保存。备份文件里有用户数据和邮件，要妥善保管。更多说明见 [备份自己的数据](/backup.html)。

## 升级到新版本

1. 先阅读新版本的更新说明，确认没有特殊升级要求，并**先做一次备份**；
2. 拉取新源码，用**新的版本号**构建镜像（下面以 `0.0.3` 为例，不要覆盖正在使用的标签）：

```bash
cd ..
git pull
docker build -t nodemail-local:0.0.3 .
cd installer
```

3. 先用新镜像检查数据库是否兼容，成功后再切换：

<!-- docker-ci:upgrade -->
```bash
NODEMAIL_IMAGE=nodemail-local:0.0.3 docker compose run --rm --no-deps -T app node distribution/runtime/setup.mjs check
sed -i 's/^NODEMAIL_IMAGE=.*/NODEMAIL_IMAGE=nodemail-local:0.0.3/' .env
docker compose up -d --wait app
curl --fail http://127.0.0.1:4321/api/health
```

第一条检查失败时，**不要继续**：说明这个版本需要专门的升级步骤，请先看更新说明，必要时到 GitHub 反馈。

### 升级后出问题，怎么回退？

把 `.env` 里的镜像改回旧版本号，再启动：

```bash
sed -i 's/^NODEMAIL_IMAGE=.*/NODEMAIL_IMAGE=nodemail-local:0.0.2/' .env
docker compose up -d --wait app
```

旧镜像要先保留着，确认新版本稳定后再用 `docker image rm nodemail-local:0.0.2` 删除。

## 常见问题

::: details 构建或启动时提示权限错误
当前用户没有 Docker 权限。用 root 执行，或把用户加入 `docker` 组后重新登录。不要把项目目录权限改成 777。
:::

::: details 启动后 curl 返回失败
先看 `docker compose ps` 两个容器是否都是 healthy，再看 `docker compose logs --tail=200 app`。日志里提示 `Standalone startup refused`，通常是 `.env` 被换过，或者跳过了初始化。不要删数据卷重来。
:::

::: details 25 端口被占用
服务器上已有别的邮件程序占用了 25。只用中继收信的话，可以在 `.env` 里把 `SMTP_BIND` 改成 `127.0.0.1`、`SMTP_PORT` 改成 `12525`，再执行 `docker compose up -d --wait app`。详见 [安装参数与网络](/installation.html)。
:::

::: details 之前用 node manage.mjs 装的，能改用本页方式吗？
可以。先查看安装目录里有没有 `.active-image` 文件：如果有，把 `.env` 里的 `NODEMAIL_IMAGE` 改成这个文件里记录的镜像，再删除 `.active-image`。之后只用本页的命令。
:::

相关页面：[安装参数与网络](/installation.html) · [更新与恢复](/upgrading.html) · [问题排查](/troubleshooting.html)
