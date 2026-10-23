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

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

// handleOf is a short, non-reversible stand-in for the token: the check-in
// target is derived from it so the per-day moment can be recomputed without
// anything on disk. It is only a seed — the caches below are keyed by the
// token itself, since two tokens sharing a 32-bit hash would share a name.
const fnv = (text) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const handleOf = (token) => fnv(token).toString(16)

// json asks one of ModelScope's web endpoints as the account. The timeout is
// its own: magpie gives a usage read 20s in total, and this plugin makes two
// or three requests within it.
async function json(token, path) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), TIMEOUT_MS)
  try {
    const res = await fetch(SITE + path, {
      // a redirect that leaves modelscope.cn must not carry the session
      // cookie off-site; the runtimes happen not to forward it, but say so
      redirect: "error",
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

// text makes a string from the server safe to put in a message. What the
// server says (an error's message, a grant's title) ends up in the account
// card, in magpie's log and on the terminal, and a remote answer is not
// trusted with control characters: a newline forges a log line, an escape
// sequence drives the terminal, and a bidi override can turn a name inside
// out. Visible characters are kept, up to a length that fits a card.
const text = (value, max = 120) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim()
    .slice(0, max)

const saidOf = (body) => text(body?.message ?? body?.Message ?? body?.msg ?? body?.code ?? "")

const dataOf = (body) => body?.data ?? body?.Data ?? {}

// recordsOf is the ledger's entries. A missing key is an empty ledger (the
// keys are optional in ModelScope's answers), but a records that is there and
// is not a list is a body we do not understand — a proxy's rewrite, a changed
// API — and must fail: read as empty it would report "claimed 0 today".
const recordsOf = (body) => {
  const records = dataOf(body)?.records
  if (records === undefined || records === null) return []
  if (!Array.isArray(records)) throw new Error("账单格式不认识：records 不是列表")
  return records
}

function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

// cnTime turns ModelScope's "2026-10-22 15:35:35" (Beijing time, no zone) into
// RFC 3339. Handed to new Date() as is, it would be read in the host's own
// zone, which is 8 hours off on a machine set anywhere else.
function cnTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value ?? ""))
  if (!m) return ""
  const [, y, mo, d, h, mi, s] = m
  const at = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)
  return Number.isFinite(at) ? new Date(at).toISOString() : ""
}

// ── 签到时段 ──────────────────────────────────────────────────────────────
// magpie 在北京日切换时问一次，之后每 30 分钟重试一次失败；插件没有自己的
// 定时器（见 README 的「上游」一节）。所以在还没到今天这个账号的目标时刻
// 时，只能回答 failed——那是宿主唯一会重试的结果——其余结果都会让当天就此
// 了结。夜里这一问一答不发出任何请求，领的动作留给上班时段的那一问。
const WINDOW_DEFAULT = ["08:30", "10:00"]

// LAST is the latest minute the window's end is capped at. The host asks
// again 30 minutes after a failure, and a new Beijing day starts afresh with
// a new target, so what a target needs is an ask *after* it landing on the
// same day. A target at 23:29 gets one ask, at 23:30 — and if that ask fails
// the day is lost with it. Capping the end at 23:00 leaves two: one at the
// target's own minute, one at 23:30 as a retry.
const LAST = 23 * 60
const DEFAULT_START = 8 * 60 + 30
const DEFAULT_END = 10 * 60

const CONFIG_ENV = "MAGPIE_MSMOLI_CONFIG"

// configPath is where the user's overrides live: beside magpie's own files,
// which is ~/.config/magpie for an installed magpie and the data folder for a
// portable one. The host hands that folder over as input.directory; guessing
// ~/.config/magpie here would silently ignore the file on a portable magpie.
function configPath(dir) {
  if (process.env[CONFIG_ENV]) return process.env[CONFIG_ENV]
  const base = dir || (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "magpie")
    : join(homedir(), ".config", "magpie"))
  return join(base, "msmoli.json")
}

// configOf reads the user's overrides, hot each call so a change reaches the
// next ask without restarting magpie. Anything unreadable or not an object
// is nothing.
function configOf(dir) {
  try {
    const raw = JSON.parse(readFileSync(configPath(dir), "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

// minuteOf reads "HH:MM" as minutes after midnight, null for anything else.
function minuteOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim())
  if (!m) return null
  const h = +m[1]
  const mi = +m[2]
  return h < 24 && mi < 60 ? h * 60 + mi : null
}

// windowOf is the check-in window as [start, end) minutes after Beijing
// midnight, or null when it is off. Both `["08:30", "10:00"]` and
// `"08:30-10:00"` are read; an unworkable value (bad clock time, start not
// before end) is not honoured, the documented default applying instead of a
// window that would never come due.
function windowOf(cfg) {
  const raw = cfg.checkinWindow
  if (raw === false) return null
  // "off" written as a string is the same intent as false; read as anything
  // else it would silently fall back to the default window instead
  if (typeof raw === "string" && /^(off|false|no)$/i.test(raw.trim())) return null
  const pair = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[-–—~至]/) : WINDOW_DEFAULT
  const start = minuteOf(pair[0])
  let end = minuteOf(pair[1])
  if (start === null || end === null || start >= end) return { start: DEFAULT_START, end: DEFAULT_END }
  if (end > LAST) {
    end = LAST
    if (start >= end) return { start: DEFAULT_START, end: DEFAULT_END }
  }
  return { start, end }
}

// minuteCN reads the clock in Beijing, the day ModelScope grants in, whatever
// zone the host runs in.
function minuteCN(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

// plan is the account's check-in for `day`: the moment in the window it
// claims at (fixed per day and account, so the 30-minute re-asks agree) and
// whether that moment has passed. token only feeds the hash.
function plan(win, token, day) {
  const target = win.start + (fnv(day + "|" + handleOf(token)) % (win.end - win.start))
  return { target, due: minuteCN() >= target }
}

// names holds the display name read at check-in, by token. login/info is also
// the check-in trigger, so the usage poll (the menu bar asks every few
// minutes) must never reach it. The name is empty for a while after the host
// restarts and comes back with the next check-in; it is not worth keeping the
// token on disk for. The map is keyed by the token itself, not by its hash:
// two tokens colliding in 32 bits would otherwise share a name and the card
// would show one account under the other's name.
const names = new Map()
const NAMES_MAX = 8

function rememberName(token, name) {
  if (!name) return
  names.delete(token)
  names.set(token, name)
  while (names.size > NAMES_MAX) names.delete(names.keys().next().value)
}

// named holds what this process has already written back, so a name is
// saved once and not on every ask.
const named = new Set()

// labelOf is what magpie shows this account as now, which is the string an
// alias is kept under: the accountId already on the sign-in, else the key's
// last four.
function labelOf(auth, token) {
  if (typeof auth?.accountId === "string" && auth.accountId) return auth.accountId
  return token.length >= 12 ? "API key …" + token.slice(-4) : "API key"
}

// aliasOf is the name the user gave this account in magpie's own
// providers.json, "" when none. magpie keeps those names under the account's
// label of the moment, so a write-back that renames the account would leave
// the user's name keyed to a label nothing carries any more — it would stop
// showing, with no sign of why.
function aliasOf(dir, label) {
  if (!dir || !label) return ""
  try {
    const raw = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"))
    const key = label.trim().toLowerCase()
    const lists = [raw?.providers]
    if (Array.isArray(raw?.pluginLeft)) lists.push(...raw.pluginLeft.map((l) => l?.provider))
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const p of list) {
        if (p?.id !== ID) continue
        const names = p.accountNames
        if (!names || typeof names !== "object") continue
        const mine = names[key]
        if (typeof mine === "string" && mine) return mine
      }
    }
  } catch {}
  return ""
}

// rememberAccountName tells magpie the account's own name, so its card reads
// "Mison" instead of "API key …a1b2". The sign-in is written as it already
// is — the same key, no second copy of the token — with the name beside it;
// an account that has one already is left alone.
async function rememberAccountName(client, token, name, auth, dir) {
  if (!name || !client?.auth?.set) return
  if (named.has(token) || auth?.accountId === name) return
  // an account the user has named keeps that name: writing the nickname over
  // it would re-key their alias to a label the account no longer has
  if (aliasOf(dir, labelOf(auth, token))) return
  named.add(token)
  try {
    // auth.set replaces the whole sign-in, so what the host handed us is the
    // base: a field we do not know about is kept, not dropped
    const body = { ...(auth && typeof auth === "object" ? auth : {}), type: "api", key: token, accountId: name }
    await client.auth.set({ path: { id: ID }, body })
  } catch (e) {
    // the card keeps the key's tail; nothing else depends on this. Put the
    // token back so the next ask tries the write again, and let the log call
    // be truly best-effort: a host whose log is synchronous returns undefined
    // where a promise is expected, and that must not throw out of here.
    named.delete(token)
    client?.app?.log?.({ body: { level: "warn", service: "msmoli", message: `account name not written back: ${e?.message ?? e}` } })?.catch?.(() => {})
  }
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

// amountOf is what a grant gave, as it goes into a message: the raw JSON is
// whatever the server said, so it is coerced and sanitized like every other
// remote string rather than interpolated as it came.
const amountOf = (record) => text(Number(record?.total_amount) || 0, 20)

export async function MsmoliPlugin(input) {
  // input.directory is magpie's own folder (host.go passes settings.Dir()),
  // which is where a portable magpie keeps everything too.
  const configDir = typeof input?.directory === "string" ? input.directory : ""
  // client.auth.set is how the account's display name gets back to magpie:
  // the host labels an account by its accountId, and an api-type sign-in has
  // none. Written once, at the first check-in, when the name is known.
  const client = input?.client

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
      //
      // 时段：被问到时若还没到今天这个账号的目标时刻，就在发任何请求之前
      // 回答 failed——唯一会被宿主重试的结果，别的都会让当天不再被问。
      // 代价是这段时间卡片上写着「签到失败；magpie 稍后重试」，那是今天
      // 宿主唯一能表达「还没到点」的说法（上游见 README）。
      async checkin(getAuth) {
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e), ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
        if (!token) return { outcome: "failed", message: "没有登录信息，请先登录" }

        const win = windowOf(configOf(configDir))
        if (win) {
          const day = todayCN()
          const p = plan(win, token, day)
          if (!p.due) {
            return {
              outcome: "failed",
              message: `未到签到时段：今日 ${clock(p.target)} 起领取（${clock(win.start)}–${clock(win.end)}，改 ${configPath(configDir)} 调整）`,
            }
          }
        }

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
          const name = text(me.NickName || me.Name || "", 40)
          rememberName(token, name)
          await rememberAccountName(client, token, name, auth, configDir)

          const daily = (await todayEarn(token)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          const credit = sumOf(daily)

          if (claimed) {
            const which = daily.map((r) => text(r.title, 40)).filter(Boolean).join(" + ")
            return { outcome: "done", credit, message: `今日已领取 ${credit} 魔粒` + (which ? `（${which}）` : "") }
          }
          if (daily.length) {
            const which = daily.map((r) => `${text(r.title, 40)} +${amountOf(r)}`).join("，")
            return { outcome: "claimed", credit, message: `领取 ${credit} 魔粒：${which}` }
          }
          // 触达了却没有到账记录：可能是账本还没写出来（发放是异步的），
          // 也可能这个账号本来就不在活动范围。magpie 把 inactive 当作当天
          // 已了结、不再重试，所以再读一次账本确认，别把晚到的发放丢掉。
          const later = (await todayEarn(token)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          if (later.length) {
            const credit2 = sumOf(later)
            const which = later.map((r) => `${text(r.title, 40)} +${amountOf(r)}`).join("，")
            return { outcome: "claimed", credit: credit2, message: `领取 ${credit2} 魔粒：${which}` }
          }
          return { outcome: "inactive", message: "登录已触达，但今天没有到账记录（账号可能不在活动范围）" }
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e), ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
      },

      // 魔粒余额与今日消耗，给账号卡片看。
      async usage(getAuth) {
        // everything the host could get wrong about the hand-over is the
        // card's problem alone: it must come back as {error}, never as a
        // rejection out of the hook
        let auth, token
        try {
          auth = await getAuth()
          token = tokenOf(auth)
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: signedOut(e) ? "expired" : "" }
        }
        if (!token) return { error: "没有登录信息", signIn: "" }
        // the name is only known from login/info, which usage must never
        // reach; a check-in in this process leaves it here for the card
        await rememberAccountName(client, token, names.get(token) ?? "", auth, configDir)
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

          // 今天还没领到时，把时段里的目标时刻写在卡片上，别让「领 0」
          // 看起来像是出了问题。
          const win = windowOf(configOf(configDir))
          const ahead = win && earned === 0 ? plan(win, token, day) : null
          const hint = ahead && !ahead.due ? ` · ${clock(ahead.target)} 领取` : ""

          return {
            plan: "魔搭社区",
            user: names.get(token) ?? "",
            balance: `${available} 魔粒可用`,
            windows: [
              {
                name: "魔粒",
                used,
                display: `今日用 ${spent} / 领 ${earned} · 余额 ${available}${hint}`,
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
