# magpie-plugin-msmoli

一个 [magpie](https://github.com/yetone/magpie) 插件，替你领取 ModelScope（魔搭）的每日**魔粒**——每天自动签到一次，代替人工打开网页——并在账号卡片上显示余额与今日消耗。

## 魔粒是什么

ModelScope 的 API-Inference 是免费的，用魔粒结算：

| 发放项 | 额度 | 有效期 |
|---|---|---|
| 每日登录 | 200 | 24 小时 |
| 绑定阿里云账号，每日 | 50 | 24 小时 |
| 邮箱验证 / 个人介绍 / 主页 | 各 50 | 90 天，一次性 |

**每日发放的魔粒只有 24 小时。** 不累积，当天不用就作废。旗舰模型 2 魔粒一次（主流 1、轻量 0.5），所以每天 250 大约相当于 125 次调用。

## 安装

需要先装好 magpie（<https://usemagpie.ai>），并让 `magpie` 命令在 `PATH` 上；用 `magpie --version` 确认。

```bash
git clone https://github.com/MisonL/magpie-plugin-msmoli.git
cd magpie-plugin-msmoli
magpie plugin add "$PWD"
printf 'ms-你的令牌\n' | magpie plugin login msmoli
```

然后把签到打开：设置 → 用量 → 插件 → `msmoli` 那一行，或者改 `settings.json`
（在 magpie 自己的目录里，安装版是 `~/.config/magpie`）：

```json
{
  "pluginCheckins": {
    "msmoli": true
  }
}
```

令牌在 <https://modelscope.cn/my/myaccesstoken> 创建。同一把 `ms-` 令牌既是推理的 `Authorization: Bearer`，也是网页站的会话 Cookie，不需要另外配置。

之后 magpie 每天（北京日）每账号领取一次，失败当天稍后重试，结果直接显示在账号卡片上：

```
● plugin:msmoli  API key …a1b2 · 魔搭社区  魔粒 1% (今日用 2 / 领 250 · 余额 249.5)
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
| `failed` | 什么也没领到——包括下面的「还没到点」 |

用到的接口都在 `modelscope.cn`，请求头 `Cookie: m_session_id=ms-…`，外加浏览器 UA 和 `Referer` 即可，不需要 CSRF 令牌：

| 用途 | 路径 |
|---|---|
| 登录 / 签到触发 | `GET /api/v1/users/login/info` |
| 余额 | `GET /openapi/v1/magicubes/balance` |
| 账单 | `GET /openapi/v1/magicubes/transactions?page=1&page_size=50` |

账单里的 `type` 见到过 `EARN` 与 `SPEND_CONFIRM`，另有一种 `EXPIRE`（本插件不依赖它）。

### 什么时候领：签到时段

领取会等到一天里的某个时刻，默认落在 **北京时间 08:30–10:00** 之间——
每个账号在窗口里有自己的一分钟，由「日期 + 账号」算出，宿主重试时不会变。
这样请求看起来像人早上打开网站，而不是零点整被脚本点一下。

晚领不吃亏：每日魔粒**自到账起 24 小时过期**（15:35 到账就 15:35 过期），
所以 9 点领的额度能用第二天 9 点。

在 magpie 自己的目录里放一个 `msmoli.json`（安装版是 `~/.config/magpie`，
便携版是它的 data 目录）改：

```json
{ "checkinWindow": ["08:30", "10:00"] }
```

写成一个字符串也一样：`{ "checkinWindow": "08:30-10:00" }`。

`false` 关掉时段（宿主一问就领）。值写坏了（`08:30`–`08:00`、不是时刻）
会退回默认，而不是永远不领。结束时刻晚于 **23:30** 会被截到那里：
magpie 失败后隔 30 分钟才再问，落在当天最后半小时里的目标时刻可能
等不到下一次询问，午夜一过日期和目标一起换掉，那天的额度就丢了。
整段都落在 23:30 之后的窗口同样退回默认窗口，因为已经没有地方放目标时刻了。
文件每次被问都重读，改完不用重启 magpie。

与宿主调度的衔接：magpie 在北京日切换时问一次，之后**失败才**每 30 分钟再问
——`failed` 是唯一会被重试的结果，其余都会让当天就此了结。所以到了窗口里的
时刻之前，插件回答 `failed` 并说明几点领取，**一个请求都不发**。

代价要说清楚，因为插件没有别的办法表达「晚点再问」：真正领到之前，卡片上是
红点和 magpie 自己的「签到失败；magpie 稍后重试」；这段时间每次询问都会重写
`plugin-checkin.json`；窗口前执行 `magpie accounts checkin` 退出码非零。
把这三点都去掉的办法是把时段关掉。

红点持续多久，取决于 magpie 下一次什么时候问，而不只看目标时刻。实测某天：
目标 09:01，magpie 在 09:00:57 问（差三秒，答 `failed`），真正领取落在下一次
询问 09:31——红点约 9.5 小时，比只看窗口的 8.5 小时更长。

### 上游

magpie 没有给插件定时器、时钟，也不能决定自己什么时候被调用：
`auth.checkin(getAuth, info)` 只能返回一个结果，什么时候再问由宿主定。
上面这些都是在那个契约里绕出来的，绕得别扭的两处（把「还没到点」说成失败、
卡片只有整天的粒度）值得在
[这个 issue](https://github.com/yetone/magpie/issues/3245) 里要一个插件能用的
定时器和 `recheck`。

### 多个账号

插件是按账号写的，不是按令牌。magpie 把每个登录的令牌存成各自的 key——第一个
是 `msmoli`，之后的叫 `msmoli#xxxxxx`——并且**按账号逐个**问签到，每次通过
`getAuth` 交给插件这个账号自己的令牌。所以两把令牌时：

- 两个账号当天**各有自己的目标分钟**（哈希用的是「日期 + 这个账号的令牌」），
  不会撞在同一时刻；
- 每个账号的签到结果、重试、卡片显示都是分开记在 `plugin-checkin.json` 里的；
- 签到读到的昵称按令牌缓存，一个账号的名字不会跑到另一个账号那行上。

加第二个账号的方式一样，加完可以看两行：

```bash
printf 'ms-第二个令牌\n' | magpie plugin login msmoli
magpie accounts            # 两行，各自带自己的魔粒窗口
```

两个要知道的地方。卡片默认用令牌末四位称呼账号（`API key …a1b2`），除非你自己
起名——昵称只在内存里，因为写进 `plugin-auth.json` 等于把令牌存第二遍。跑多个
账号时建议起名：

```bash
magpie accounts alias msmoli "API key …a1b2" 主号
```

另外，每日额度是**按魔搭账号**算的，不是按 key：同一个魔搭用户的第二把令牌不会
多领一份。

## 为什么是独立的 provider，且不注册模型

插件注册的是 `msmoli`，而不是内置的 `modelscope` 预设，原因有两个：

1. 与预设撞名的插件 id 会被 magpie 命名空间化成 `<id>-plugin`，本来也就不是同一个 provider 了；叫 `modelscope` 只会和预设并排显示，让人误以为是同一个账号。
2. **安全。** 用量窗口读到「已用尽」时，magpie 网关会跳过该账号。如果签到插件挂在推理实际路由的那个 provider 上，一旦报 100% 就会把整条聊天链路从 magpie 里摘掉。

所以聊天继续走 `providers.json` 里带 API key 的 `modelscope` 预设，本插件只承载签到所需的登录态。

## 隐私

`login/info` 的响应里有 `Email`、`GitlabAccessToken` 等字段。本插件只读 `NickName` / `Name`，其余在解析后即丢弃。令牌只存在 magpie 自己的 `plugin-auth.json` 里——插件不落盘、不输出、不发给 `modelscope.cn` 以外的任何地方。

## 范围与边界

- 只领你自己账号的每日额度，幂等：一次签到读账单、触达登录、再读账单——三个请求，
到账晚了要再读一次账单确认时是四个。每天一次。
窗口开启之前的询问一个请求都不发。
用量读取只发两个请求，且永不触达登录端点，所以菜单栏的轮询不会变成签到。
- 每个请求 8 秒超时，响应体最多读 256 KiB，既拖不住宿主，也不会无限增长。
- `MAGPIE_MSMOLI_CONFIG` 可以覆盖配置文件路径。它是为了让测试不碰真实文件而存在的，生产环境同样生效。
- 每天另外 170 魔粒来自「喜欢 10 次（20）+ 发 AIGC 作品（100）+ 发 AIGC 模型（50）」。这些都没有 API，自动化等于驱动网页界面，本插件不碰。

## 排障

| 症状 | 处理 |
|---|---|
| `not signed in` | `printf 'ms-令牌\n' \| magpie plugin login msmoli` |
| 卡片上没有魔粒窗口，或签到没跑 | 重启 magpie（插件宿主有缓存） |
| `failed` + HTTP 401 | 令牌被吊销，重新生成并登录 |
| `failed` + HTTP 403 | 魔搭风控拒了这次请求，令牌本身没问题，30 分钟后会重试 |
| 窗口前卡片写着「签到失败 · 未到签到时段」 | 正常现象，见上面的「什么时候领」 |
| 一直是 `inactive` | 登录通了但没到账：账号不在活动范围，或今天已被别的客户端领走 |
| 改了插件代码没生效 | 路径式插件按位置引用，改完要重启 magpie |

## License

MIT
