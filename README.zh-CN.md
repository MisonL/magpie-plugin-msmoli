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

需要先装好 magpie（<https://usemagpie.ai>）。macOS 上用 `magpie --version` 确认命令在 `PATH` 上；
不在的话用 app 里的完整路径 `/Applications/magpie.app/Contents/MacOS/magpie`。

### 方式一：直接从 GitHub 装（不用 clone，能跟着更新）

装进 magpie 自己的插件目录（安装版是 `~/.config/magpie/plugins`，便携版是 data 目录下的 `plugins`），
以后 `magpie plugin update` 就能更新：

```bash
magpie plugin add github:MisonL/magpie-plugin-msmoli
printf 'ms-你的令牌\n' | magpie plugin login msmoli
```

### 方式二：clone 到本地再装

留一份自己的副本，打算改代码就用这种。magpie 是**按位置引用**这个文件夹而不是拷走，
所以文件夹不在（比如外置盘没挂）插件就加载不了，更新也得先 pull 再 add 一次：

```bash
git clone https://github.com/MisonL/magpie-plugin-msmoli.git
cd magpie-plugin-msmoli
magpie plugin add "$PWD"
printf 'ms-你的令牌\n' | magpie plugin login msmoli
```

两种方式结果一样：设置 → 用量 → 插件 里多出 `msmoli` 一行。登录态是按 provider 名
（`msmoli`）存的、不绑文件夹，所以两种方式之间切换、或把 clone 挪个位置，都不用重新登录。

### 已经在 magpie 里配好 ModelScope？几条命令把 key 同步给插件

如果你之前为了聊天已经把 ModelScope 加进「供应商」（`providers.json` 里有 key），
本包自带一个小工具可以把同一把令牌登录给插件，不用再找一遍。

用 GitHub 方式装的，magpie 会在自己的插件目录里放一份：

```bash
node ~/.config/magpie/plugins/node_modules/magpie-plugin-msmoli/bin/sync.mjs --status      # 先看两边状态
node ~/.config/magpie/plugins/node_modules/magpie-plugin-msmoli/bin/sync.mjs --to-plugin   # 执行同步
```

用 clone 方式装的，跑 clone 里那份（`./bin/sync.mjs`；Windows 或 WSL 上文件可能没有
可执行位，用 `node bin/sync.mjs` 跑）——magpie 只是按位置引用那个文件夹，并不会拷走。
便携版的目录结构相同，只是根目录是它的 `data` 文件夹；探测不到时用 `--dir <magpie 的配置
目录>`（安装版是 `~/.config/magpie`，便携版是它的 `data` 目录）和 `--magpie <magpie 可执行
文件的路径>` 指明。`npx magpie-plugin-msmoli` 要等
包发布到 npm 之后才能用——npm 12 默认禁用 `npx github:…`，别从那条路开始。

- 它只读 magpie 的两个文件；写入交给 magpie 自己的 CLI（`plugin login`、
  `plugin logout`、`provider key`）完成，输出里不会出现令牌，失败信息也一样；
- 插件已经用同一把令牌登录时它什么都不改；两边是**不同**的令牌时它默认拒绝
  ——直接 login 会新增第二个账号，换一把则需要 `--force`，且只在插件**只有一个账号**时
  才放行（logout 会一次登出该 provider 的全部账号）；
- 反向也有：`--to-preset` 把插件主账号的令牌写回内置预设（要 `--force`，因为那把
  key 是聊天正在用的）；
- 内置侧若有多个可能的 provider（比如自己搭的同域名中转），它不猜，用
  `--from <id>` 指定；`--dry-run` 只打印要执行的命令，不真跑。

把签到打开：设置 → 用量 → 插件 → `msmoli` 那一行，或者改 `settings.json`
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
● msmoli  API key …a1b2 · 魔搭社区  魔粒 1% (今日用 2 / 领 250 · 余额 249.5) ↻14h24m tomorrow 09:31  249.5 魔粒可用 left
```

## 签到是怎么做的

ModelScope 没有公开的签到端点。它有的是一个副作用：`GET /api/v1/users/login/info` 会被服务端记成一次登录，当天第一次调用就发放 `daily_active` 200 与 `aliyun_bindlogin` 50。同一天重复调用不再发放。

只调一次无法区分「本次领取」和「几小时前就领过了」，所以这个钩子在它前后读账单：

1. 先读今天的 `EARN` 记录——`daily_active` 在不在？
2. 触达 `login/info`
3. 再读一次账单

于是有四种结果：

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

账单里的 `type` 见到过 `EARN` 与 `SPEND_CONFIRM`，另有一种 `EXPIRE`（本插件忽略它）。
记录按「日期 + 类型 + 规则 + 模型档位」聚合——某天用了几个档位，当天就有几条消耗记录——
每条带 `count`，列表按日期倒序。让「一页 50 条」够用的是**倒序**：今天的行排在所有更早
的行前面。实测一个账号每天 3~7 行，所以一页大约覆盖两周、而不是 50 天；真正会出问题的是
「单日超过 50 行」那种情况。加大每页条数也没用——服务端把 `page_size=200` 也按 50 回。

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

`false` 关掉时段（宿主一问就领），写成 `"off"` 也一样。值写坏了
（`08:30`–`08:00`、不是时刻）会退回默认，而不是永远不领。结束时刻晚于
**23:00** 会被截到那里：宿主每 30 分钟问一次，一个目标时刻需要它之后还有落到
同一天的询问。落在最后半小时的目标能等到的询问更少，一旦都失败，当天的额度
就一起丢了；截到 23:00 至少能留下两次。
整段都落在 23:00 之后的窗口同样退回默认窗口，因为已经没有地方放目标时刻了。
文件每次被问都重读，改完不用重启 magpie。

与宿主调度的衔接：magpie 在北京日切换时问一次，之后每 30 分钟问一次——失败
一定再问；`done`/`inactive`/`ineligible` 这类「还没见到领取」的回答，在北京
时间 12 点前也会被当作暂定答案再问（厂商那边的「今天」可能还没翻篇）。所以到了
窗口里的时刻之前，插件回答 `failed` 并说明几点领取，**一个请求都不发**。
`failed` 仍是唯一保证会被再问的结果，其余只在当天还没被证实前才会被重问。

代价要说清楚，因为插件没有别的办法表达「晚点再问」：真正领到之前，卡片上是
红点和 magpie 自己的「签到失败；magpie 稍后重试」；这段时间每次询问都会重写
`plugin-checkin.json`；窗口前执行 `magpie accounts checkin` 退出码非零。
把这三点都去掉的办法是把时段关掉。

红点持续多久，取决于 magpie 下一次什么时候问，而不只看目标时刻。实测某天：
目标 09:01，magpie 在 09:00:57 问（差三秒，答 `failed`），真正领取落在下一次
询问 09:31——从零点算约 9.5 小时，而不是只看窗口起点 08:30 会以为的 8.5 小时。

### 上游

magpie 没有给插件定时器、时钟，也不能决定自己什么时候被调用：
`auth.checkin(getAuth, info)` 只能返回一个结果，什么时候再问由宿主定。
上面这些都是在那个契约里绕出来的，绕得别扭的两处（把「还没到点」说成失败、
卡片只有整天的粒度）值得在
[这个 issue](https://github.com/yetone/magpie/issues/3245) 里要一个插件能用的
定时器和 `recheck`。

同一个「没有定时器」还带来两个要知道的后果：目标时刻只能靠宿主自己的询问去够，
机器睡眠期间错过的那次会在醒来后的下一次询问补上（只有睡过午夜才会丢当天）；
两次询问之间插件也没法自己重试——上面那个时段上限买到的那次重试，就是为此存在的。

### 多个账号

插件是按账号写的，不是按令牌。magpie 把每个登录的令牌存成各自的 key——第一个
是 `msmoli`，之后的叫 `msmoli#xxxxxx`——并且**按账号逐个**问签到，每次通过
`getAuth` 交给插件这个账号自己的令牌。所以两把令牌时：

- 两个账号当天**各有自己的目标分钟**（哈希用的是「日期 + 这个账号的令牌」），
  通常不在同一时刻——极小概率会撞上，代价只是两个账号共用那一分钟；
- 每个账号的签到结果、重试、卡片显示都是分开记在 `plugin-checkin.json` 里的；
- 签到读到的昵称按令牌缓存，一个账号的名字不会跑到另一个账号那行上。

加第二个账号的方式一样，加完可以看两行：

```bash
printf 'ms-第二个令牌\n' | magpie plugin login msmoli
magpie accounts            # 两行，各自带自己的魔粒窗口
```

卡片用魔搭给的名字称呼账号。api 型登录本身没有名字，所以签到会把昵称写回去
——还是同一条登录记录，令牌仍然只存一份，只是旁边多了 `accountId`。

写回发生在宿主进程里**真正跑了一次签到**的时候。刚装好时卡片显示令牌末四位
（`API key …a1b2`）。当天已经签过的账号不会再被问（magpie 直接复用记录），
所以升级后要等**下一次**签到才会出现名字。

如果你想自己起名，magpie 自己的 alias 优先：

```bash
magpie accounts alias msmoli "API key …a1b2" 主号
```

第二个参数是账号**现在**显示的名字：第一次签到之前是令牌末四位，之后是签到
写回的魔搭昵称。你起过名的账号不会被改掉——签到不会把昵称盖到你的 alias 上
——所以两个名字都能用，alias 优先于昵称。

另外，每日额度属于**魔搭账号**，不属于 key：领取在服务端按「账号 + 当天」幂等，
所以同一个魔搭用户的第二把令牌拿到的是 `done`，不会再多 250。

## 为什么是独立的 provider，且不注册模型

插件注册的是 `msmoli`，而不是内置的 `modelscope` 预设，原因有两个：

1. 与预设撞名的插件 id 会被 magpie 命名空间化成 `<id>-plugin`，本来也就不是同一个 provider 了；叫 `modelscope` 只会和预设并排显示，让人误以为是同一个账号。
2. **安全。** 用量窗口读到「已用尽」时，magpie 网关会跳过该账号。如果签到插件挂在推理实际路由的那个 provider 上，一旦报 100% 就会把整条聊天链路从 magpie 里摘掉。

所以聊天继续走 `providers.json` 里带 API key 的 `modelscope` 预设，本插件只承载签到所需的登录态。

### 两条 ModelScope 行，为什么不会打架

供应商页会出现两条：`ModelScope`（预设，带模型）和 `ModelScope 魔粒`（本插件，0 模型）。
它们是两个独立 provider，共用同一把令牌，但互不干扰：

| | `modelscope` 预设 | `msmoli`（本插件） |
|---|---|---|
| 提供聊天模型 | 是 | 否——`magpie models` 里从不出现 |
| 用量卡片 | 无（预设没有余额接口） | 魔粒余额与今日消耗 |
| 签到 | 魔搭没有内置签到 | 本插件，每天一次 |
| 网关可达 | 是 | 否，所以卡片读到 100% 也不会导致绕路 |

同一把令牌出现在两处是 magpie 的设计：预设在 `providers.json` 存 key，插件在
`plugin-auth.json` 存登录态。两边填同一个 `ms-` 令牌是正常的。没有任何逻辑会
拿插件那张卡去决定聊天走哪里——独立 id 的意义就在这里。

真正要知道的一点：**两行都不产生额外开销**；删掉插件的登录态，聊天照常；
删掉预设，签到照常。它们各自独立失败。

## 隐私

`login/info` 的响应里有 `Email`、`GitlabAccessToken` 等字段。本插件只读 `NickName` / `Name`，其余在解析后即丢弃。令牌只存在 magpie 自己的 `plugin-auth.json` 里——插件不输出、不发给 `modelscope.cn` 以外的任何地方。

唯一写回的是那个昵称，写成已有登录记录上的 `accountId`，好让 magpie 的卡片能称呼账号。它走宿主自己的 `client.auth.set`（这个接口是整条替换），所以插件把宿主交给它的内容原样交回、只多加一个名字，令牌仍然只存一份。

它还会读 `providers.json`（magpie 自己的 provider 列表），只为一件事：这个账号你是不是已经自己起过名了。起过就什么都不写，你的名字保持原样，昵称不会盖上去。

## 范围与边界

- 只领你自己账号的每日额度，幂等：一次签到读账单、触达登录、再读账单——三个请求，
到账晚了要再读一次账单确认时是四个。每天一次。
窗口开启之前的询问一个请求都不发。
用量读取只发两个请求，且永不触达登录端点，所以菜单栏的轮询不会变成签到。
- 每个请求 8 秒超时，响应体最多读 256 KiB，既拖不住宿主，也不会无限增长。
一次签到整体 25 秒放弃，一次用量读取 18 秒——magpie 把所有 provider 的签到放在
同一个两分钟预算里、账号逐个问，一个钩子超时会挤掉后面的账号。被截断的钩子回答
`failed`，宿主半小时后重试，而重试会先读账单再领，所以不会丢额度。
- `MAGPIE_MSMOLI_CONFIG` 可以覆盖配置文件路径。它是为了让测试不碰真实文件而存在的，生产环境同样生效。
- 每天另外 170 魔粒来自「喜欢 10 次（20）+ 发 AIGC 作品（100）+ 发 AIGC 模型（50）」。这些都没有 API，自动化等于驱动网页界面，本插件不碰。

## 排障

| 症状 | 处理 |
|---|---|
| `not signed in` | `printf 'ms-令牌\n' \| magpie plugin login msmoli` |
| 卡片上没有魔粒窗口，或签到没跑 | 重启 magpie（插件宿主有缓存） |
| `failed` + HTTP 401 | 令牌被吊销，重新生成并登录 |
| `failed` + HTTP 403 | 魔搭风控拒了这次请求，令牌本身没问题，30 分钟后会重试 |
| 窗口前卡片写着 failed，附一行「09:56 后自动领取（约 1 小时 33 分钟后，无需操作）」 | 正常现象——卡片以领取时刻开头，见上面的「什么时候领」 |
| 一直是 `inactive` | 登录通了但当天账单里没有记录：账号可能不在活动范围，或者发放还没写出来（别处领过的会显示成 `done`） |
| 改了插件代码没生效 | 路径式插件按位置引用，改完要重启 magpie |
| 两种方式都装了一遍，`magpie plugin list` 说 msmoli "served by" 其中一个 | 这是 magpie 在提醒同一个 provider id 有两份。删掉一份：`magpie plugin rm github:MisonL/magpie-plugin-msmoli` 或 `magpie plugin rm <路径>`。magpie 把 alias 挂在当初设它的那个包名下，所以删掉一份可能连带把显示名也收走——重新 add 那个包，或者再设一次 alias 就回来 |

## License

MIT
