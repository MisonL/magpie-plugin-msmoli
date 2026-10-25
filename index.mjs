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
// PAGE_SIZE is one page of the ledger, and one page is all that is read. The
// ledger is aggregated — one row per (day, type, rule_key, model_tier), with a
// `count` on each — and sorted newest first, so today's rows are always at the
// front of page 1. Measured on a live account: 3–7 rows a day, i.e. one page
// reaches back a fortnight or so, not 50 days. That is enough because the
// ordering, not the page size, is what puts today first; what would break it
// is a single day with more than 50 rows. The server also caps page_size at 50
// (asking for 200 answers with page_size 50), so there is no headroom to buy
// by asking for more — a day's rows running past page 1 would need a second
// read, or the day's totals come out short (and a claim whose `daily_active`
// fell past the cut would read as "nothing granted").
const PAGE_SIZE = 50

// A hook's whole budget, not one request's. magpie runs a check-in round for
// every provider's accounts under one 2-minute context and asks them one
// account at a time, so a slow account that spent its own 4×8s would take the
// budget from the accounts after it. Capping the hook keeps one account from
// doing that; a hook cut short answers failed, which the host retries in half
// an hour, and that retry reads the ledger first — so nothing is lost.
const CHECKIN_BUDGET_MS = 25 * 1000
// A usage read is one balance and one ledger read under a 20s budget.
const USAGE_BUDGET_MS = 18 * 1000

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. The two are told apart by the caller so a key that is
// there and unusable does not read as "you never signed in".
const unusableKey = (auth) => {
  const key = auth?.type === "api" ? String(auth.key ?? "").trim() : ""
  return Boolean(key) && !/^[\x21-\x7e]+$/.test(key)
}
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

// json asks one of ModelScope's web endpoints as the account. Each request is
// capped at 8s, and at what is left of the hook's own budget when that is
// less: magpie runs every provider's check-ins under one 2-minute context and
// asks accounts one at a time, so a hook must not overrun its share. When the
// budget is gone the request is not sent at all — a spent Cookie could still
// be recorded upstream, and the answer would never be reconciled.
async function json(token, path, deadline = Infinity) {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error("预算已用完，本次请求未发出")
  const budget = Math.min(TIMEOUT_MS, left)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), budget)
  try {
    let res
    try {
      res = await fetch(SITE + path, {
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
    } catch (e) {
      // fetch's own failures are a bare English "fetch failed", and that one
      // string covers a dead network, a proxy, a captive portal and the
      // redirect this call refuses — the card would show it and nothing else.
      if (e === ctl.signal.reason || /timeout/i.test(String(e?.message ?? ""))) {
        throw new Error(`请求超时（${Math.round(budget / 1000)} 秒）`)
      }
      if (e?.name === "TypeError" || /fetch failed/i.test(String(e?.message ?? ""))) {
        throw new Error("请求失败：网络不通、被代理拦截，或被重定向到了别的站点")
      }
      throw e
    }
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
    // byteLength, not length: the streaming branch below counts bytes, and
    // text.length counts UTF-16 units — 256 KiB of Chinese would pass here as
    // 85K "characters" and let a third of a megabyte past the cap.
    const text = await res.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new Error("响应过大")
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
// The classes, not a hand-listed range: \p{Cc} is C0/C1, \p{Cf} covers the
// bidi controls, the zero-width joiners, the word joiner and the tag
// characters (U+E0000\u2013E007F) that can carry hidden data \u2014 the earlier list
// left U+200B\u2013200D, U+2060\u20132064 and U+061C through, so two accounts could be
// made to look like the same name. Truncation counts code points, so it can't
// cut a surrogate pair in half.
const text = (value, max = 120) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .trim()
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join("") : cleaned
}

const saidOf = (body) => text(body?.message ?? body?.Message ?? body?.msg ?? body?.code ?? "")

const dataOf = (body) => body?.data ?? body?.Data ?? {}

// recordsOf is the ledger's entries. `records` missing under a data object is
// an empty ledger (the keys are optional in ModelScope's answers), but a body
// with no data at all, or a records that is there and is not a list, is a body
// we do not understand — a proxy's rewrite, a changed API — and must fail:
// read as empty it would report "claimed 0 today", and the check-in would
// answer `inactive`, which ends the day.
const recordsOf = (body) => {
  const data = body?.data ?? body?.Data
  if (data === undefined || data === null || typeof data !== "object") throw new Error("账单格式不认识：没有 data")
  const records = data.records
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
  // Date.UTC normalizes rather than rejects: month 13 becomes January of the
  // next year, "99:99:99" rolls over days. The card would then count down to a
  // moment that looks perfectly reasonable and is not when the grant expires.
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return ""
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
// is nothing — and the BOM is stripped first, the way aliasOf does it: a file
// written by Notepad or PowerShell's Out-File starts with one, JSON.parse
// rejects it, and the user's `checkinWindow: false` would be read as "no
// setting at all" and replaced by the default window, with nothing said.
function configOf(dir) {
  try {
    const raw = JSON.parse(readFileSync(configPath(dir), "utf8").replace(/^\uFEFF/, ""))
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
//
// Exported for the test that pins the 23:00 cap: where a target lands is a
// hash of the day, so an end-to-end assertion about it only bites on the days
// the hash falls past 23:00 — the cap's regression would go green on the rest.
export function windowOf(cfg) {
  const raw = cfg.checkinWindow
  if (raw === false) return null
  // "off" written as a string is the same intent as false; read as anything
  // else it would silently fall back to the default window instead
  if (typeof raw === "string" && /^(off|false|no)$/i.test(raw.trim())) return null
  // "～" (U+FF5E) is the full-width tilde a Chinese IME produces for the "~"
  // key; it is a different code point from the ASCII one and was falling
  // through to the default window instead of being read. U+301C (Japanese
  // IME's wave dash) and U+2212 (a minus sign rather than a hyphen, which
  // some editors substitute) are the same hazard, one code point further out.
  const pair = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[-–—−~～〜至到]/) : WINDOW_DEFAULT
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

// waits reads a number of minutes the way a person would say it: "35 分钟",
// "1 小时", "9 小时 56 分钟". A card that said "596 分钟后" reads like a dump.
const waits = (minutes) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

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
// providers.json — "" when they haven't, undefined when the file could not be
// understood. The distinction matters: an alias is kept under the account's
// label of the moment, so a write-back that renames the account would leave
// the user's name keyed to a label nothing carries any more — it would stop
// showing, with no sign of why. A file that is mid-write, unreadable, or not
// the shape we know must therefore count as "don't write", not as "no alias".
function aliasOf(dir, label) {
  // no directory is not "the user has no alias": it is having nowhere to look
  if (!dir || !label) return undefined
  let raw
  try {
    raw = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8").replace(/^\uFEFF/, ""))
  } catch (e) {
    // a file that is missing is a fresh install, where there is no user state
    // to clobber — treat it as "no alias" and write. A file that is there but
    // cannot be read is state we must not write over blindly.
    return e?.code === "ENOENT" ? "" : undefined
  }
  // `null` and `[1,2,3]` parse but say nothing about this account, and a
  // lookup against them finds no alias. Reading that as "the user has none"
  // would write the nickname over state we never saw — the same mistake as
  // for an unreadable file, so it gets the same answer.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
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
  return ""
}

// rememberAccountName tells magpie the account's own name, so its card reads
// "Mison" instead of "API key …a1b2". The sign-in is written as it already
// is — the same key, no second copy of the token — with the name beside it;
// an account that has one already is left alone.
// maskToken hides all but the ends of a token, for messages that mention one.
// The log is magpie's own, but a token has no business in it whole.
const maskToken = (token) =>
  typeof token === "string" && token.length >= 12 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "…"

// cardText is what a host error becomes before it reaches the account card or
// the terminal. The host's message is not our text: magpie's own CLI scrubs
// tokens out of "no key ms-… for provider" for the same reason, and a message
// can carry a newline, an escape sequence or a bidi override. Sanitized and
// masked first, truncated second — the other order cuts a token in half, and
// half a token is not a token to split() on, so the front of it survives into
// the log. The nickname write-back's log learned that the hard way.
const cardText = (value, token) => {
  const masked = typeof token === "string" && token ? String(value ?? "").split(token).join(maskToken(token)) : String(value ?? "")
  return text(masked, 200)
}

// unusableName is a nickname that must not be written back: empty, the token
// itself (the server would be handed it twice), or a key that the host's
// accountNames lookup would read as inherited rather than as a name.
const unusableName = (name, token) =>
  !name || name === token || ["__proto__", "constructor", "prototype"].includes(name)

async function rememberAccountName(client, token, name, auth, dir) {
  if (!name || !client?.auth?.set) return
  if (named.has(token) || auth?.accountId === name) return
  // an account the user has named keeps that name: writing the nickname over
  // it would re-key their alias to a label the account no longer has. A
  // providers.json that can't be read says the same thing — don't write over
  // a state we can't see.
  if (aliasOf(dir, labelOf(auth, token)) !== "") return
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
    // the message can carry whatever the host put in it; scrub the token out
    // of it before it reaches magpie's log
    const why = cardText(whyOf(e), token)
    let logged = false
    try {
      const r = client?.app?.log?.({ body: { level: "warn", service: "msmoli", message: `account name not written back: ${why}` } })
      if (r && typeof r.catch === "function") r.catch(() => {})
      logged = true
    } catch {
      // a host whose log throws synchronously must not turn a successful
      // check-in into a failed one, nor a usage read into a rejection
    }
    void logged
  }
}

const signedOut = (e) => Boolean(e?.signIn === "expired" || e?.expired)

// whyOf is the message of a rejection. A rejected non-Error — a bare string, an
// object without a message, a host's own rejection value — would reach String()
// as "[object Object]", which tells the user nothing and reads like a bug in the
// plugin. The empty string lets the caller say something of its own instead.
const whyOf = (e) =>
  typeof e?.message === "string" && e.message ? e.message : typeof e === "string" ? e : ""

function fail(status) {
  return Object.assign(new Error(`HTTP ${status}`), { signIn: status === 401 ? "expired" : "" })
}

// todayEarn are today's credit grants, by the day ModelScope records them.
async function todayEarn(token, deadline) {
  const { res, body, parsed } = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
  if (res.status === 401) throw Object.assign(new Error("令牌失效或不属于国内站"), { signIn: "expired" })
  // 403 is ModelScope's risk control, not a bad token: the account may be
  // perfectly fine and only the request was refused.
  if (res.status === 403) throw new Error("被魔搭风控拒绝（HTTP 403）")
  if (res.status !== 200 || !parsed) throw new Error(`账单查询失败：响应不是 JSON（HTTP ${res.status}）`)
  if (!okOf(body)) throw new Error(`账单查询失败：${saidOf(body) || `HTTP ${res.status}`}`)
  const day = todayCN()
  return recordsOf(body).filter((r) => r?.type === "EARN" && r?.gmt_created === day)
}

// num reads a number from the server, 0 for anything that isn't a finite
// one: Number("1e400") is Infinity, and an Infinity would reach the card as
// "Infinity 魔粒可用" and a window's used/limit.
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// yin is a credit amount as a card says it: at most two decimals, with a
// trailing 0.30 written as 0.3. The tiers are 0.5/1/2, but a grant or a spend
// summed in binary floating point comes out as 0.30000000000000004, and that
// goes straight into the card and into the division below.
const yin = (n) => Math.round(n * 100) / 100

const sumOf = (records) => yin(records.reduce((n, r) => n + num(r?.total_amount), 0))

// amountOf is what a grant gave, as it goes into a message: the raw JSON is
// whatever the server said, so it is coerced and sanitized like every other
// remote string rather than interpolated as it came.
const amountOf = (record) => text(num(record?.total_amount), 20)

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
          return { outcome: "failed", message: cardText(whyOf(e), "") || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
        if (!token)
          return {
            outcome: "failed",
            // a key that is there but unusable is not a missing one: telling
            // the user to sign in sends them to the wrong place
            message: unusableKey(auth) ? "令牌内容无法识别（含空格、换行或非 ASCII 字符），请重新登录" : "没有登录信息，请先登录",
          }
        // the clock the requests run against: a hook that does not finish in
        // time has failed, as far as the host is concerned, and it asks again
        const deadline = Date.now() + CHECKIN_BUDGET_MS

        const win = windowOf(configOf(configDir))
        if (win) {
          const day = todayCN()
          const p = plan(win, token, day)
          if (!p.due) {
            // The host shows one line under a failed state, and "failed" is
            // the only outcome it retries, so this is the whole message the
            // user gets for the hours before the window. Lead with the thing
            // they care about — the time it will claim — rather than with
            // the word for why it hasn't yet. The config path is left out on
            // purpose: it repeats on every ask and ends up in screenshots,
            // and it is in the README for whoever wants to change it.
            const wait = p.target - minuteCN()
            return {
              outcome: "failed",
              message: `${clock(p.target)} 后自动领取（约 ${waits(wait)}后，无需操作）`,
            }
          }
        }

        try {
          const before = await todayEarn(token, deadline)
          const beforeDaily = before.filter((r) => DAILY_RULES.includes(r?.rule_key))
          const claimed = before.some((r) => r?.rule_key === "daily_active")

          const { res, body, parsed } = await json(token, LOGIN_INFO, deadline)
          if (res.status === 401)
            return { outcome: "failed", message: "令牌失效或不属于国内站（HTTP 401）", signIn: "expired" }
          // 403 是风控，不是令牌坏了：账号可能是好的，只是这次请求被拒
          if (res.status === 403) return { outcome: "failed", message: "被魔搭风控拒绝（HTTP 403），稍后会自动重试" }
          if (res.status !== 200 || !parsed)
            return { outcome: "failed", message: `登录接口失败：响应不是 JSON（HTTP ${res.status}）` }
          if (!okOf(body)) return { outcome: "failed", message: `登录接口失败：${saidOf(body) || `HTTP ${res.status}`}` }

          const me = dataOf(body)
          const candidate = text(me.NickName || me.Name || "", 40)
          const name = unusableName(candidate, token) ? "" : candidate
          rememberName(token, name)
          await rememberAccountName(client, token, name, auth, configDir)

          // done 用触发**之前**那一页的合计：今天已经领过，领到的就是那时
          // 账本上的数。用触发之后那一页的话，两次读之间账本一变（行被挤到
          // 下一页、或当日合计被重算），卡片会显示「今日已领取 0 魔粒」。
          if (claimed) {
            const credit = sumOf(beforeDaily)
            const which = beforeDaily.map((r) => text(r.title, 40)).filter(Boolean).join(" + ")
            return { outcome: "done", credit, message: `今日已领取 ${credit} 魔粒` + (which ? `（${which}）` : "") }
          }

          const daily = (await todayEarn(token, deadline)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          if (daily.length) {
            const credit = sumOf(daily)
            const which = daily.map((r) => `${text(r.title, 40)} +${amountOf(r)}`).join("，")
            return { outcome: "claimed", credit, message: `领取 ${credit} 魔粒：${which}` }
          }
          // 触达了却没有到账记录：可能是账本还没写出来（发放是异步的），
          // 也可能这个账号本来就不在活动范围。再读一次账本确认，别把刚写
          // 出来的发放丢掉。这一次重读买不到「等一会儿」——发放若真是几秒
          // 后才写出来，紧接着的重读也读不到；补上那一段的是宿主：北京时间
          // 12 点前，done/inactive 这类还没见到领取的回答会被当作暂定答案
          // 每 30 分钟重问一次（checkin.go 的 provisional，由
          // checkinSureHour 决定），到那时账本已经写出来了。
          const later = (await todayEarn(token, deadline)).filter((r) => DAILY_RULES.includes(r?.rule_key))
          if (later.length) {
            const credit = sumOf(later)
            const which = later.map((r) => `${text(r.title, 40)} +${amountOf(r)}`).join("，")
            return { outcome: "claimed", credit, message: `领取 ${credit} 魔粒：${which}` }
          }
          return { outcome: "inactive", message: "登录已触达，但今天没有到账记录（账号可能不在活动范围）" }
        } catch (e) {
          return { outcome: "failed", message: cardText(whyOf(e), token) || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
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
          return { error: cardText(whyOf(e), "") || "用量查询失败", signIn: signedOut(e) ? "expired" : "" }
        }
        if (!token) return { error: unusableKey(auth) ? "令牌内容无法识别，请重新登录" : "没有登录信息", signIn: "" }
        const deadline = Date.now() + USAGE_BUDGET_MS
        // the name is only known from login/info, which usage must never
        // reach; a check-in in this process leaves it here for the card.
        // Inside the try: the hook promises an {error}, never a rejection,
        // and this path reaches client.auth.set.
        try {
          await rememberAccountName(client, token, names.get(token) ?? "", auth, configDir)
          const bal = await json(token, BALANCE, deadline)
          if (bal.res.status === 401) throw fail(bal.res.status)
          if (bal.res.status === 403) throw new Error("被魔搭风控拒绝（HTTP 403）")
          if (bal.res.status !== 200 || !bal.parsed) throw new Error(`余额查询失败：响应不是 JSON（HTTP ${bal.res.status}）`)
          if (!okOf(bal.body)) throw new Error(`余额查询失败：${saidOf(bal.body) || `HTTP ${bal.res.status}`}`)
          const available = num(dataOf(bal.body).available_balance)

          const tx = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
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
            const amount = num(r?.total_amount)
            if (r?.type === "EARN") {
              // 「领」是今天入账的全部，促销一类也算：卡片问的是「今天进来
              // 多少、用掉多少」，把促销排除会让余额涨了 500 而卡片写「领 0」。
              // 签到报的 credit 是另一个问题（这次签到领到多少），只算日常
              // 额度，两个数不一样是各自的答案，不是同一个数的两种算法。
              earned += amount
              if (DAILY_RULES.includes(r?.rule_key) && r?.expire_at && (!earliest || r.expire_at < earliest)) earliest = r.expire_at
            } else if (r?.type === "SPEND_CONFIRM") {
              spent += amount
            }
          }

          // 不截断到 100：magpie 把 used > 100 读作「超额」
          // （host.js 的 "past 100 when overspent"）。今天没领到任何魔粒
          // 且余额为零，才算用尽。下限夹到 0：账本里的退款是负数的
          // SPEND_CONFIRM，不夹就会在卡片上出现「今日用 -50 / 领 200」和
          // 负百分比——宿主自己会夹，这里再兜一次。
          // summed in floating point: 0.1 + 0.2 is 0.30000000000000004, and it
          // would go into the card as written
          earned = yin(earned)
          spent = yin(spent)
          const usedToday = Math.max(0, spent)
          // 没有今天的入账时，百分比的分母换成「今天手里有多少」——用掉的
          // 加上还剩的。分母为 0 时沿用旧口径：余额也空了才算用尽。
          // 否则卡片会出现 used=0、今日用 348.5、领 0 的组合，进度条说没动，
          // 文字说花掉了一堆。
          const used =
            earned > 0
              ? Math.round((usedToday / earned) * 10000) / 100
              : usedToday + available > 0
                ? Math.round((usedToday / (usedToday + available)) * 10000) / 100
                : 100

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
                display: `今日用 ${usedToday} / 领 ${earned} · 余额 ${available}${hint}`,
                amount: usedToday,
                limit: earned,
                unit: "魔粒",
                resetsAt: cnTime(earliest),
                span: 86400,
              },
            ],
          }
        } catch (e) {
          return { error: cardText(whyOf(e), token) || "用量查询失败", signIn: signedOut(e) ? "expired" : "" }
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
