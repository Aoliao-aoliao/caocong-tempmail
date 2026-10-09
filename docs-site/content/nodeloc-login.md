# NodeLoc 登录与绑定

接入后，用户可以用 NodeLoc 论坛账号一键登录网站，已有账户也可以绑定 NodeLoc。

::: info 和 NodeLoc 支付是两回事
这一页讲**登录**。用 NodeLoc 能量充值请看 [NodeLoc 能量支付](/payment-nodeloc.html)，两者分别申请、分别配置。
:::

![NodeLoc 登录配置步骤](/illustrations/nodeloc-login.svg)

## 三种使用方式

| 用户情况 | 会发生什么 |
| --- | --- |
| 先用邮箱注册本站，之后想用 NodeLoc | 登录本站后，在用户中心点 **绑定 NodeLoc**，原有积分和邮箱都保留 |
| 只有 NodeLoc 账号，本站没有账户 | 登录页点 **使用 NodeLoc 登录**，自动新建本站账户并发放注册赠送积分 |
| NodeLoc 返回的邮箱已在本站注册 | 不会自动登进那个账户，提示先用原方式登录，再到用户中心绑定 |

同一个邮箱**不会**自动合并两个账户，这是为了防止别人冒用你的邮箱登录。

## 1. 在 NodeLoc 创建 OAuth 应用

需要一个 **TL2 及以上**的 NodeLoc 账号。

1. 打开 [NodeLoc 应用管理](https://www.nodeloc.com/oauth-provider/applications)，新建应用；
2. 按下表填写：

| NodeLoc 字段 | 填什么 |
| --- | --- |
| 名称 / 描述 | 你的网站名称和简介 |
| 重定向 URI | `https://你的网站域名/api/auth/nodeloc/callback`（后台会显示完整地址，直接复制） |
| 权限范围 | `openid`、`profile`、`email` 三个都要 |
| 最低信任等级 | 可选，见下方说明 |

3. 保存后记下 **Client ID** 和 **Client Secret**。

::: warning email 权限需要审核
申请了 `email` 权限的应用，要等 NodeLoc 管理员审核。状态变成 **已批准** 之前，登录会失败，登录页会提示“NodeLoc 暂不可用，请确认应用审核和后台配置”。
:::

### 最低信任等级要不要设？

NodeLoc 自动建号**不经过人机验证**，也会发放注册赠送积分。如果担心有人用一批新注册的小号来刷积分，可以在 NodeLoc 应用里把 **最低信任等级** 设为 **TL1**：

- 低于这个等级的 NodeLoc 账号在授权这一步就会被 NodeLoc 拒绝；
- 它对**登录、绑定、刷新等级**都生效。等级不够的用户也绑定不了；
- 已经绑定、但等级不够的用户，以后不能用 NodeLoc 登录。用邮箱注册的可以继续用密码登录，通过 NodeLoc 自动注册的需要先走一次 [找回密码](/password-mail.html) 设置本站密码。

NodeLoc 官方文档没有写明这个设置的具体执行细节，设置后建议用一个 TL0 账号实测一次。

## 2. 在后台填写

打开 **管理后台 → 系统配置 → NodeLoc 登录**（只有超级管理员能修改）：

| 后台字段 | 填什么 |
| --- | --- |
| Client ID | NodeLoc 应用的 Client ID |
| Client Secret | NodeLoc 应用的 Client Secret。保存后不再显示；更换 Client ID 时必须同时填新的 Secret |
| 用户端网站地址 | 网站的 HTTPS 根地址，例如 `https://mail.example.com`。登录按钮只在这个域名下显示 |
| 授权回调地址 | 自动生成，必须和 NodeLoc 应用里的重定向 URI **完全一致** |
| 启用 NodeLoc 登录 | **等审核通过后**再勾选 |

点击 **保存 NodeLoc 登录配置**。

## 3. 自己测一遍

1. 无痕窗口打开登录页，看到 **使用 NodeLoc 登录** 按钮；
2. 用一个本站还没注册过的 NodeLoc 账号登录，确认自动建号成功；
3. 另用一个邮箱注册的账户，在用户中心绑定 NodeLoc，退出后再用 NodeLoc 登录，确认进的是同一个账户。

## 用户需要知道的规则

- **社区等级**来自最近一次 NodeLoc 授权，只用于显示，不影响本站任何权限；用户可以在用户中心手动刷新；
- **解绑**需要输入本站密码，解绑后该账户的所有登录状态都会退出。没有本站密码的用户，先通过“忘记密码”设置；
- 用户**找回密码**成功后，NodeLoc 绑定会**自动解除**，需要的话重新绑定；
- 本站会员和 NodeLoc 社区等级是两回事；
- 后台关闭 NodeLoc 登录入口，不会删除已有用户或绑定关系。

## 常见问题

::: details 登录后回到登录页，提示“NodeLoc 授权未完成”
- 用户在 NodeLoc 页面点了取消，或者等级低于你设置的最低信任等级；
- 重定向 URI 和后台回调地址不完全一致（多了斜杠、域名不同、http/https 不同）。
:::

::: details 提示“该邮箱已有本站账户”
这个 NodeLoc 账号的邮箱已经在本站注册过。让用户先用邮箱密码登录，再到用户中心绑定 NodeLoc。
:::

相关页面：[第三方账号接入](/integrations.html) · [NodeLoc 能量支付](/payment-nodeloc.html)
