# magpie-plugin-msmoli

一个 [magpie](https://github.com/yetone/magpie) 插件，替你领取 ModelScope（魔搭）的每日**魔粒**——一个请求代替人工打开网页——并在账号卡片上显示余额与今日消耗。

## 魔粒是什么

ModelScope 的 API-Inference 是免费的，用魔粒结算：

| 发放项 | 额度 | 有效期 |
|---|---|---|
| 每日登录 | 200 | 24 小时 |
| 绑定阿里云账号，每日 | 50 | 24 小时 |
| 邮箱验证 / 个人介绍 / 主页 | 各 50 | 90 天，一次性 |

**每日发放的魔粒只有 24 小时。** 不累积，当天不用就作废。旗舰模型 2 魔粒一次（主流 1、轻量 0.5），所以每天 250 大约相当于 125 次调用。

## 安装

```bash
git clone https://github.com/<you>/magpie-plugin-msmoli.git
cd magpie-plugin-msmoli
magpie plugin add "$PWD"
printf 'ms-你的令牌\n' | magpie plugin login msmoli
```

然后在 `~/.config/magpie/settings.json` 里把签到打开：

```json
"pluginCheckins": {
  "msmoli": true
}
```

令牌在 <https://modelscope.cn/my/myaccesstoken> 创建。同一把 `ms-` 令牌既是推理的 `Authorization: Bearer`，也是网页站的会话 Cookie，不需要另外配置。

之后 magpie 每天（北京日）每账号领取一次，失败当天稍后重试，结果直接显示在账号卡片上：

```
● msmoli  API key …a1b2 · 魔搭社区  魔粒 1% (今日用 2 / 领 250 · 余额 249.5)
  ↻14h24m tomorrow 00:00  249.5 魔粒可用 left
```

## 签到是怎么做的

ModelScope 没有公开的签到端点。它有的是一个副作用：`GET /api/v1/users/login/info` 会被服务端记成一次登录，当天第一次调用就发放 `daily_active` 200 与 `aliyun_bindlogin` 50。同一天重复调用不再发放。

只调一次无法区分「本次领取」和「几小时前就领过了」，所以这个钩子在它前后读账单：

1. 先读今天的 `EARN` 记录——`daily_active` 在不在？
2. 触达 `login/info`
3. 再读一次账单

于是有三种结果：

| 结果 | 含义 |
|---|---|
| `done` | 今天已经领过，带上当日合计 |
| `claimed` | 这次领到了，带上金额 |
| `inactive` | 登录通了，但没有到账 |

用到的接口都在 `modelscope.cn`，请求头 `Cookie: m_session_id=ms-…`，外加浏览器 UA 和 `Referer` 即可，不需要 CSRF 令牌：

| 用途 | 路径 |
|---|---|
| 登录 / 签到触发 | `GET /api/v1/users/login/info` |
| 余额 | `GET /openapi/v1/magicubes/balance` |
| 账单 | `GET /openapi/v1/magicubes/transactions?page=1&page_size=50` |

账单里的 `type` 只有 `EARN`、`SPEND_CONFIRM`、`EXPIRE` 三种。

## 为什么是独立的 provider，且不注册模型

插件注册的是 `msmoli`，而不是接管内置的 `modelscope` 预设，原因有三个：

1. 插件的 `config` 钩子写的是 `config.provider[id]`，接管 `modelscope` 会覆盖预设的模型列表与名称。
2. 与预设撞名的插件 id 会被 magpie 命名空间化成 `<id>-plugin`，本来也就不是同一个 provider 了。
3. **安全。** 用量窗口读到「已用尽」时，magpie 网关会跳过该账号。如果签到插件挂在推理实际路由的那个 provider 上，一旦报 100% 就会把整条聊天链路从 magpie 里摘掉。

所以聊天继续走 `providers.json` 里带 API key 的 `modelscope` 预设，本插件只承载签到所需的登录态。

## 隐私

`login/info` 的响应里有 `Email`、`GitlabAccessToken` 等字段。本插件只读 `NickName` / `Name`，其余在解析后即丢弃。令牌只存在 magpie 自己的 `plugin-auth.json` 里——插件不落盘、不输出、不发给 `modelscope.cn` 以外的任何地方。

## 范围与边界

- 只领你自己账号的每日额度：每账号每天一个请求，幂等，不并发、不轮询。
- 每天另外 170 魔粒来自「喜欢 10 次（20）+ 发 AIGC 作品（100）+ 发 AIGC 模型（50）」。这些都没有 API，自动化等于驱动网页界面，本插件不碰。

## 排障

| 症状 | 处理 |
|---|---|
| `not signed in` | `printf 'ms-令牌\n' \| magpie plugin login msmoli` |
| 卡片上没有魔粒窗口，或签到没跑 | 重启 magpie（插件宿主有缓存） |
| `failed` + HTTP 401 | 令牌被吊销，重新生成并登录 |
| 一直是 `inactive` | 登录通了但没到账：账号不在活动范围，或今天已被别的客户端领走 |
| 改了插件代码没生效 | 路径式插件按位置引用，改完要重启 magpie |

## License

MIT
