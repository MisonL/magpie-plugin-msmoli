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

const TIMEOUT_MS = 8000
const PAGE_SIZE = 50

const tokenOf = (auth) => {
  const token = auth?.type === "api" ? String(auth.key ?? "").trim() : ""
  // A token with anything but visible ASCII in it would put the whole value
  // into a fetch error message ("…is an invalid header value"), which magpie
  // logs and shows. Refused here, before it can be echoed anywhere.
  return token && /^[\x21-\x7e]+$/.test(token) ? token : ""
}

// handleOf is a short, non-reversible stand-in for the token, so the caches
// below never hold the secret itself.
function handleOf(token) {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

// json asks one of ModelScope's web endpoints as the account. The timeout is
// its own: magpie gives a usage read 20s in total, and this plugin makes two
// or three requests within it.
async function json(token, path) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), TIMEOUT_MS)
  try {
    const res = await fetch(SITE + path, {
      headers: {
        Cookie: "m_session_id=" + token,
        "User-Agent": UA,
        Referer: SITE + "/",
        Accept: "application/json",
      },
      signal: ctl.signal,
    })
    const text = await readBounded(res)
    let body = null
    try {
      body = text ? JSON.parse(text) : {}
    } catch {}
    return { res, body, parsed: body !== null }
  } finally {
    // the answer is here: the timer has nothing left to guard, and one left
    // pending would hold the host's event loop open after the work is done
    clearTimeout(timer)
  }
}

// MAX_BODY is how much of a response is read. ModelScope's answers are a few
// kilobytes; a proxy's error page or a hostile endpoint must not be able to
// take the plugin host's memory with it (magpie itself caps its own upstream
// reads at 1MiB).
const MAX_BODY = 256 * 1024

// readBounded reads a response's text, refusing one that is too large.
async function readBounded(res) {
  const declared = Number(res.headers?.get?.("content-length") ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error(`响应过大（${declared} 字节）`)
  if (!res.body) {
    const text = await res.text()
    if (text.length > MAX_BODY) throw new Error("响应过大")
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel()
        throw new Error("响应过大")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  const merged = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    merged.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

// okOf reads either envelope ModelScope uses: {success} or {Code: 200}. A
// body with neither is not an answer we understand — a proxy's error page, a
// captive portal, an empty reply — and must not pass for a success.
const okOf = (body) => {
  if (typeof body?.success === "boolean") return body.success
  if (typeof body?.Success === "boolean") return body.Success
  const code = body?.Code ?? body?.code
  return code !== undefined && String(code) === "200"
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
const NAMES_MAX = 8

function rememberName(token, name) {
  if (!name) return
  const h = handleOf(token)
  names.delete(h)
  names.set(h, name)
  while (names.size > NAMES_MAX) names.delete(names.keys().next().value)
}

const signedOut = (e) => Boolean(e?.signIn === "expired" || e?.expired)

function fail(status) {
  return Object.assign(new Error(`HTTP ${status}`), { signIn: status === 401 ? "expired" : "" })
}

// todayEarn are today's credit grants, by the day ModelScope records them.
async function todayEarn(token) {
  const { res, body, parsed } = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`)
  if (res.status === 401) throw Object.assign(new Error("令牌失效或不属于国内站"), { signIn: "expired" })
  // 403 is ModelScope's risk control, not a bad token: the account may be
  // perfectly fine and only the request was refused.
  if (res.status === 403) throw new Error("被魔搭风控拒绝（HTTP 403）")
  if (res.status !== 200 || !parsed) throw new Error(`账单查询失败：响应不是 JSON（HTTP ${res.status}）`)
  if (!okOf(body)) throw new Error(`账单查询失败：${saidOf(body) || `HTTP ${res.status}`}`)
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

          const { res, body, parsed } = await json(token, LOGIN_INFO)
          if (res.status === 401)
            return { outcome: "failed", message: "令牌失效或不属于国内站（HTTP 401）", signIn: "expired" }
          // 403 是风控，不是令牌坏了：账号可能是好的，只是这次请求被拒
          if (res.status === 403) return { outcome: "failed", message: "被魔搭风控拒绝（HTTP 403），稍后会自动重试" }
          if (res.status !== 200 || !parsed)
            return { outcome: "failed", message: `登录接口失败：响应不是 JSON（HTTP ${res.status}）` }
          if (!okOf(body)) return { outcome: "failed", message: `登录接口失败：${saidOf(body) || `HTTP ${res.status}`}` }

          const me = dataOf(body)
          const name = String(me.NickName || me.Name || "")
          rememberName(token, name)

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
          // 触达了却没有到账记录：可能是账本还没写出来（发放是异步的），
          // 也可能这个账号本来就不在活动范围。magpie 把 inactive 当作当天
          // 已了结、不再重试，所以再读一次账本确认，别把晚到的发放丢掉。
          const later = (await todayEarn(token)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          if (later.length) {
            const credit2 = sumOf(later)
            const which = later.map((r) => `${r.title} +${r.total_amount}`).join("，")
            return { outcome: "claimed", credit: credit2, message: `领取 ${credit2} 魔粒：${which}` }
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
          if (bal.res.status === 401) throw fail(bal.res.status)
          if (bal.res.status === 403) throw new Error("被魔搭风控拒绝（HTTP 403）")
          if (bal.res.status !== 200 || !bal.parsed) throw new Error(`余额查询失败：响应不是 JSON（HTTP ${bal.res.status}）`)
          if (!okOf(bal.body)) throw new Error(`余额查询失败：${saidOf(bal.body) || `HTTP ${bal.res.status}`}`)
          const available = Number(dataOf(bal.body).available_balance) || 0

          const tx = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`)
          if (tx.res.status === 401) throw fail(tx.res.status)
          if (tx.res.status === 403) throw new Error("被魔搭风控拒绝（HTTP 403）")
          if (tx.res.status !== 200 || !tx.parsed) throw new Error(`账单查询失败：响应不是 JSON（HTTP ${tx.res.status}）`)
          if (!okOf(tx.body)) throw new Error(`账单查询失败：${saidOf(tx.body) || `HTTP ${tx.res.status}`}`)

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
            user: names.get(handleOf(token)) ?? "",
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
