# 二次开发与更新提示

本项目以 AGPL-3.0 开源，欢迎在它的基础上二次开发。这一页说明：原作者发布新版本后，你改过的版本会不会受影响，以及怎样关闭更新提示，或者换成你自己的更新提示。

## 原作者发新版，会影响我的代码吗？

**不会。** 后台的“检查更新”只做一件事：读取一份公开的版本公告，里面只有版本号、发布时间和更新说明，然后和你当前的版本号比较。

- 不会自动下载或安装任何东西，也不会覆盖你改过的代码；
- 不会修改你的数据库、`.env` 或任何配置；
- 不会上传你的用户、邮件、订单或站点信息；原作者也看不到谁在使用。

要不要升级、怎样把原作者的新代码合并进你的版本，完全由你决定。

## 更新提示从哪里来？

配置在 `server/updates/release-config.mjs`：

```js
export const releaseConfig = Object.freeze({
  currentVersion: packageInfo.version,
  repository: '',
  feed: 'https://aoliao-aoliao.github.io/caocong-tempmail/releases/stable.json',
});
```

| 字段 | 作用 |
| --- | --- |
| `currentVersion` | 当前版本号，自动读取 `package.json` 的 `version` |
| `feed` | 原作者文档站发布的公告地址 |
| `repository` | 另一种来源：直接读取某个 GitHub 仓库的正式 Release |

`feed` 和 `repository` **只能填一个**，两个都填会显示“发布配置无效”。

::: warning feed 只能是原作者的地址
出于安全考虑，`feed` 只接受上面这一个固定地址。把它改成你自己的网址会显示“发布配置无效”，**不会**生效。想推送你自己的更新，请用下面的“方式三”。
:::

## 三种做法，按需选择

### 方式一：保留原作者的提示（默认）

什么都不用改。原作者发布正式版本后，你的后台会提示“有新版本”。适合基本没改代码、想跟着原作者升级的人。

### 方式二：关闭更新提示

把两个字段都清空：

```js
  repository: '',
  feed: '',
```

后台“版本更新”会显示“发布源尚未配置”，**不会联网检查**，也不会报错。

### 方式三：改成你自己的更新提示

如果你的二次开发版本放在 GitHub，并且会自己发布版本，把 `feed` 清空，`repository` 填你的仓库：

```js
  repository: '你的GitHub用户名/你的仓库名',
  feed: '',
```

之后后台会读取你仓库的**最新正式 Release**：

- 草稿（Draft）和预发布（Pre-release）不会触发提示；
- Release 的标签用 `v版本号` 的格式，例如 `v1.2.0`，和 `package.json` 的 `version` 比较大小；
- 提示里的链接指向你自己仓库的 Release 页面，更新说明取自 Release 正文。

发版步骤：

1. 修改代码，把 `package.json` 和 `package-lock.json` 里的版本号改高，例如 `1.2.0`；
2. 合并到你的主分支；
3. 在 GitHub 上 **Releases → Draft a new release**，标签填 `v1.2.0`，写好更新说明，点 **Publish release**。

使用你版本的站点，后台就会收到提示。

## 版本号怎么定？

- 版本号比较时，只看“谁的数字大”。你把版本定成 `1.0.0`，原作者的 `0.0.x` 就不会再被当作新版本；
- 如果你还保留方式一（读原作者的公告），又想跟进原作者的更新，版本号就不要高于原作者已发布的版本，否则后台会一直显示“当前版本领先于正式发布版”，收不到原作者的新版本提示；
- 建议在 `package.json` 的 `name` 或文档里写明这是二次开发版本，避免用户混淆。

## 改了更新配置后，记得调整测试

仓库自带的自动测试默认按“方式一”检查。换成方式二或方式三后：

- `npm run test:offline` 不受影响，可以直接运行；
- `tests/container.py` 里有一段专门检查“安装后的程序只会请求原作者的公告地址”。请把这段改成检查你自己的设置（方式二：不发请求；方式三：只请求 `api.github.com/repos/你的仓库/releases/latest`），否则 GitHub 上的检查会失败。

## 怎样合并原作者的新版本？

假设你是从原仓库 Fork 出来的：

```bash
git remote add upstream https://github.com/Aoliao-aoliao/caocong-tempmail.git
git fetch upstream
git merge upstream/main
```

有冲突就逐个解决，然后跑一遍测试再部署。升级你自己的站点时，同样按 [更新与恢复](/upgrading.html) 或 [纯 Docker 部署 · 升级](/docker.html#升级到新版本) 操作，并保留原 `.env` 和数据卷。

::: tip 只合并需要的部分
不想要原作者的某些改动，也可以用 `git cherry-pick` 只挑选需要的提交。
:::

## AGPL-3.0 对二次开发的要求

- 可以自由修改、自用，也可以拿去运营；
- 如果你把**修改后的版本**放到网上给别人使用，需要向这些用户提供你修改后的完整源码，并继续使用 AGPL-3.0；
- 保留原有的版权与署名信息，见 [版权与署名](/copyright.html)。

以上是常见理解，不构成法律意见；具体以 [AGPL-3.0 原文](https://www.gnu.org/licenses/agpl-3.0.html) 为准。

相关页面：[更新与恢复](/upgrading.html) · [发布与许可状态](/license.html)
