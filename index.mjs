// ModelScope (魔搭) 魔粒 check-in for magpie.
//
// magpie calls auth.checkin once a Beijing day per signed-in account while the
// provider's check-in switch is on, and again later that day after a failure.
// Hooks here: checkin, usage.
//
// 签到机制：ModelScope 的 OpenAPI 里没有签到端点。访问
// GET /api/v1/users/login/info 会被服务端记成一次登录，随即发放当日
// 「注册并登录 200」与「绑定阿里云账号 50」，当日幂等。
//
// 本插件不提供任何聊天模型：推理仍走 providers.json 里 API key 版的
// modelscope 预设。这个 provider 只为承载签到所需的登录态而存在。

const SITE = "https://modelscope.cn"
const LOGIN_INFO = "/api/v1/users/login/info"
const BALANCE = "/openapi/v1/magicubes/balance"
const TXNS = "/openapi/v1/magicubes/transactions"

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// 每日发放的规则。这类魔粒 24 小时过期，不累积。
const DAILY_RULES = ["daily_active", "aliyun_bindlogin"]

const ID = "msmoli"

const TIMEOUT_MS = 20000
const PAGE_SIZE = 50

const tokenOf = (auth) => (auth?.type === "api" ? String(auth.key ?? "").trim() : "")

// timedAbort is a signal that aborts on its own after TIMEOUT_MS, and when the
// caller's signal does. Written by hand rather than with AbortSignal.any, which
// older Node releases don't have.
function timedAbort(signal) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), TIMEOUT_MS)
  const stop = () => {
    clearTimeout(timer)
    ctl.abort(signal?.reason)
  }
  if (signal) {
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
  }
  ctl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  return ctl.signal
}

// json asks one of ModelScope's web endpoints as the account.
async function json(token, path, signal) {
  const res = await fetch(SITE + path, {
    headers: {
      Cookie: "m_session_id=" + token,
      "User-Agent": UA,
      Referer: SITE + "/",
      Accept: "application/json",
    },
    signal: timedAbort(signal),
  })
  let body = {}
  try {
    body = await res.json()
  } catch {}
  return { res, body }
}

// okOf reads either envelope ModelScope uses: {success} or {Code: 200}.
const okOf = (body) => {
  if (typeof body?.success === "boolean") return body.success
  if (typeof body?.Success === "boolean") return body.Success
  const code = body?.Code ?? body?.code
  return code === undefined || String(code) === "200"
}

const saidOf = (body) => String(body?.message ?? body?.Message ?? body?.msg ?? body?.code ?? "")

const dataOf = (body) => body?.data ?? body?.Data ?? {}
const recordsOf = (body) => dataOf(body)?.records ?? []

function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

// cnTime turns ModelScope's "2026-10-22 15:35:35" (Beijing time, no zone) into
// RFC 3339. Handed to new Date() as is, it would be read in the host's own
// zone, which is 8 hours off on a machine set anywhere else.
function cnTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text ?? ""))
  if (!m) return ""
  const [, y, mo, d, h, mi, s] = m
  const at = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)
  return Number.isFinite(at) ? new Date(at).toISOString() : ""
}

// names holds the display name read at check-in, by token. login/info is also
// the check-in trigger, so the usage poll (the menu bar asks every few
// minutes) must never reach it. The name is empty for a while after the host
// restarts and comes back with the next check-in; it is not worth keeping the
// token on disk for.
const names = new Map()

const signedOut = (e) => Boolean(e?.signIn === "expired" || e?.expired)

function fail(status) {
  return Object.assign(new Error(`HTTP ${status}`), { signIn: status === 401 || status === 403 ? "expired" : "" })
}

// todayEarn are today's credit grants, by the day ModelScope records them.
async function todayEarn(token, signal) {
  const { res, body } = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, signal)
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("令牌失效或不属于国内站"), { signIn: "expired" })
  if (res.status !== 200 || !okOf(body)) throw new Error(`账单查询失败：${saidOf(body) || `HTTP ${res.status}`}`)
  const day = todayCN()
  return recordsOf(body).filter((r) => r?.type === "EARN" && r?.gmt_created === day)
}

const sumOf = (records) => records.reduce((n, r) => n + (Number(r?.total_amount) || 0), 0)

export async function MsmoliPlugin(_input) {
  return {
    auth: {
      provider: ID,

      // 静态令牌签到：粘贴一把 ms- 开头的访问令牌即可。
      //
      // 不声明 prompts，也不声明 authorize：magpie 对 api 型方法本来就会单独
      // 问一次 key，令牌存为 key 本身。声明 prompts 会让它的答案再被写进
      // metadata，同一把令牌落盘两遍（host.js 的 save()）；而 authorize 只看
      // 得到 prompts 的答案，看不到那个 key，没法替代它。格式由 placeholder
      // 提示，错了由第一次签到或用量读取报 401。
      methods: [
        {
          type: "api",
          label: "ModelScope 访问令牌",
          placeholder: "ms-…",
        },
      ],

      // 签到：先看今天到账没有，再触达登录，最后回读对账。直接触达无法区分
      // 「本次领取」与「早就领过」，而账单能。
      async checkin(getAuth) {
        const token = tokenOf(await getAuth())
        if (!token) return { outcome: "failed", message: "没有登录信息，请先登录" }
        try {
          const before = await todayEarn(token)
          const claimed = before.some((r) => r?.rule_key === "daily_active")

          const { res, body } = await json(token, LOGIN_INFO)
          if (res.status === 401 || res.status === 403)
            return { outcome: "failed", message: `令牌失效或不属于国内站（HTTP ${res.status}）`, signIn: "expired" }
          if (res.status !== 200 || !okOf(body))
            return { outcome: "failed", message: `登录接口失败：${saidOf(body) || `HTTP ${res.status}`}` }

          const me = dataOf(body)
          const name = String(me.NickName || me.Name || "")
          if (name) names.set(token, name)

          const daily = (await todayEarn(token)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          const credit = sumOf(daily)

          if (claimed) {
            const which = daily.map((r) => r.title).filter(Boolean).join(" + ")
            return { outcome: "done", credit, message: `今日已领取 ${credit} 魔粒` + (which ? `（${which}）` : "") }
          }
          if (daily.length) {
            const which = daily.map((r) => `${r.title} +${r.total_amount}`).join("，")
            return { outcome: "claimed", credit, message: `领取 ${credit} 魔粒：${which}` }
          }
          return { outcome: "inactive", message: "登录已触达，但今天没有到账记录（账号可能不在活动范围）" }
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e), ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
      },

      // 魔粒余额与今日消耗，给账号卡片看。
      async usage(getAuth) {
        const token = tokenOf(await getAuth())
        if (!token) throw new Error("没有登录信息")
        try {
          const bal = await json(token, BALANCE)
          if (bal.res.status === 401 || bal.res.status === 403) throw fail(bal.res.status)
          if (bal.res.status !== 200 || !okOf(bal.body)) throw new Error(`余额查询失败：${saidOf(bal.body) || `HTTP ${bal.res.status}`}`)
          const available = Number(dataOf(bal.body).available_balance) || 0

          const tx = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`)
          if (tx.res.status === 401 || tx.res.status === 403) throw fail(tx.res.status)
          if (tx.res.status !== 200 || !okOf(tx.body)) throw new Error(`账单查询失败：${saidOf(tx.body) || `HTTP ${tx.res.status}`}`)

          const day = todayCN()
          let earned = 0
          let spent = 0
          let earliest = ""
          for (const r of recordsOf(tx.body)) {
            if (r?.gmt_created !== day) continue
            const amount = Number(r?.total_amount) || 0
            if (r?.type === "EARN") {
              earned += amount
              if (DAILY_RULES.includes(r?.rule_key) && r?.expire_at && (!earliest || r.expire_at < earliest)) earliest = r.expire_at
            } else if (r?.type === "SPEND_CONFIRM") {
              spent += amount
            }
          }

          // 不截断到 100：magpie 把 used > 100 读作「超额」
          // （host.js 的 "past 100 when overspent"）。今天没领到任何魔粒
          // 且余额为零，才算用尽。
          const used = earned > 0 ? (spent / earned) * 100 : available > 0 ? 0 : 100

          return {
            plan: "魔搭社区",
            user: names.get(token) ?? "",
            balance: `${available} 魔粒可用`,
            windows: [
              {
                name: "魔粒",
                used,
                display: `今日用 ${spent} / 领 ${earned} · 余额 ${available}`,
                amount: spent,
                limit: earned,
                unit: "魔粒",
                resetsAt: cnTime(earliest),
                span: 86400,
              },
            ],
          }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: signedOut(e) ? "expired" : "" }
        }
      },
    },

    // 让 provider 以名字出现，不注册任何模型：聊天仍走 providers.json 里
    // API key 版的那个 modelscope 预设。
    async config(config) {
      config.provider ??= {}
      config.provider[ID] = {
        ...(config.provider[ID] ?? {}),
        name: "ModelScope 魔粒",
      }
    },
  }
}

export default MsmoliPlugin
