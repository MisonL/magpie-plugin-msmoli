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
import { isAbsolute, join } from "node:path"

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
// A usage read is one balance and one ledger read under an 18s budget, so two
// 8s requests at the per-request cap still fit.
const USAGE_BUDGET_MS = 18 * 1000

// SENDABLE is what a key may consist of and still go out: visible ASCII and
// nothing else. A key outside it would put the whole value into a fetch error
// message ("…is an invalid header value"), which magpie logs and shows. One
// rule, one place — tokenOf and unusableKey must agree on it, or a key one of
// them accepts and the other refuses has no single answer to give the user.
const SENDABLE = /^[\x21-\x7e]+$/
const rawKey = (auth) => (auth?.type === "api" ? String(auth.key ?? "").trim() : "")

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. The two are told apart by the caller so a key that is
// there and unusable does not read as "you never signed in".
const unusableKey = (auth) => {
  const key = rawKey(auth)
  return Boolean(key) && !SENDABLE.test(key)
}
const tokenOf = (auth) => {
  const token = rawKey(auth)
  // Refused here, before it can be echoed anywhere.
  return token && SENDABLE.test(token) ? token : ""
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

// saidFailure is what a request's failure becomes before it reaches the card.
// Both halves of the call can fail and neither speaks for itself: fetch's own
// failures are a bare English "fetch failed" that covers a dead network, a
// proxy, a captive portal and the redirect this call refuses, and a body that
// dies after the headers came — the socket dropped, the reply cut short —
// raises from the read, worded by each runtime its own way ("terminated" on
// Node, a whole sentence about passing `verbose: true` on Bun; both measured
// against a real socket). An error of our own — a budget spent, a body over
// the cap — is already in the user's words and passes through.
//
// magpie's own fetch, behind a proxy, fails in Go's words — a plain Error
// "proxyconnect tcp: dial tcp 127.0.0.1:7890: i/o timeout" (host.js), not a
// TypeError — so it is named before the timeout test: its "i/o timeout" is the
// proxy's dial, and "请求超时（8 秒）" would send the user after the network
// when the proxy is what is down.
function saidFailure(e, ctl, budget) {
  if (e !== ctl.signal.reason && /^proxyconnect\b/i.test(String(e?.message ?? ""))) {
    return new Error("请求失败：代理连不上（检查 magpie 的代理设置）")
  }
  if (e === ctl.signal.reason || /timeout/i.test(String(e?.message ?? ""))) {
    // Ceiling, not round: the budget can be down to a few hundred
    // milliseconds when the hook's own deadline is what cut it short, and
    // "请求超时（0 秒）" tells the user nothing about which of the two it was.
    return new Error(`请求超时（${Math.max(1, Math.ceil(budget / 1000))} 秒）`)
  }
  if (e?.name === "TypeError" || /fetch failed/i.test(String(e?.message ?? ""))) {
    return new Error("请求失败：网络不通、被代理拦截，或遇到了重定向")
  }
  return e
}

async function json(token, path, deadline = Infinity) {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error("预算已用完，本次请求未发出")
  const budget = Math.min(TIMEOUT_MS, left)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), budget)
  // The cap holds even for a fetch that does not listen to its signal: magpie
  // puts its own fetch in when a proxy is set, and its CONNECT dial runs on a
  // timer of its own (host.js's proxyRefuses). Raced against the abort, the
  // hook answers at the budget whatever the fetch underneath is still doing.
  const aborted = new Promise((_, reject) => {
    ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true })
  })
  aborted.catch(() => {})
  try {
    const res = await Promise.race([
      aborted,
      fetch(SITE + path, {
        // every redirect is refused, the site's own included: one that left
        // modelscope.cn would carry the session cookie off-site (the runtimes
        // happen not to forward it), and ModelScope's endpoints answer in place
        redirect: "error",
        headers: {
          Cookie: "m_session_id=" + token,
          "User-Agent": UA,
          Referer: SITE + "/",
          Accept: "application/json",
        },
        signal: ctl.signal,
      }),
    ])
    // The read is inside the same try on purpose: the request answering is not
    // the same as its body arriving, and the timer above covers both.
    const text = await Promise.race([aborted, readBounded(res)])
    let body = null
    try {
      body = text ? JSON.parse(text) : {}
    } catch {}
    return { res, body, parsed: body !== null }
  } catch (e) {
    throw saidFailure(e, ctl, budget)
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
        // The read is abandoned either way, so a cancel that fails has nothing
        // to add: its own error ("terminated", a runtime's sentence about
        // sockets) would replace the one sentence the user can act on. Not
        // awaited at all, that rejection is unobserved, and an unobserved
        // rejection is a process-level failure in Node.
        try {
          await reader.cancel()
        } catch {}
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
//
// The classes, not a hand-listed range: \p{Cc} is C0/C1, \p{Cf} covers the
// bidi controls, the zero-width joiners, the word joiner and the tag
// characters (U+E0000-E007F) that can carry hidden data — the earlier list
// left U+200B-U+200D, U+2060-U+2064 and U+061C through, so two accounts could
// be made to look like the same name. Truncation counts code points, so it
// cannot cut a surrogate pair in half.
const text = (value, max = 120) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .trim()
  // A UTF-16 unit is one code point or half of a surrogate pair, never the
  // reverse, so a string no longer than max in units is no longer than max
  // in code points either: the array and the join are only needed to cut.
  if (cleaned.length <= max) return cleaned
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join("") : cleaned
}

// saidOf is a server's own words for a failure, masked and sanitized. The
// token is split out before the length cut: a server (or a proxy in front of
// it) that echoes the session back would otherwise put it on the card whole,
// and a cut token is no longer one to split() on.
const saidOf = (body, token) => cardText(body?.message ?? body?.Message ?? body?.msg ?? body?.code ?? "", token, 120)

const dataOf = (body) => body?.data ?? body?.Data ?? {}

// dataObjectOf is the strict read of the same field: a body with no data at
// all, or a data that is not an object (a list of rows, a string, a number)
// is one we did not understand, not one with nothing in it. typeof null is
// "object", so the null check is the one the type test alone cannot make.
// Both readers of the field carry their own words for the failure; the test
// itself lives here once so the two cannot drift.
const dataObjectOf = (body, message) => {
  const data = body?.data ?? body?.Data
  if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message)
  return data
}

// recordsOf is the ledger's entries. `records` missing under a data object is
// an empty ledger (the keys are optional in ModelScope's answers), but a body
// with no data at all, a data that is a list rather than an object (the rows
// themselves, unlabelled), or a records that is there and is not a list, is a
// body we do not understand — a proxy's rewrite, a changed API — and must
// fail: read as empty it would report "claimed 0 today", and the check-in
// would answer `inactive`, which ends the day.
const recordsOf = (body) => {
  const data = dataObjectOf(body, "账单格式不认识：没有 data")
  const records = data.records
  if (records === undefined || records === null) return []
  if (!Array.isArray(records)) throw new Error("账单格式不认识：records 不是列表")
  return records
}

function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

// onDay says whether a ledger row was recorded on the Beijing day `day`.
// ModelScope answers "2026-10-26" today, but the same API answers other
// fields of the same row in "2026-10-26 09:13:40", and a change to the
// column's format would turn every row into "not today": the ledger would
// read as empty, the check-in would answer `inactive`, and `inactive` settles
// the day with "the account may not be in the campaign". Comparing the date
// part is right for both spellings and wrong for neither.
const onDay = (stamp, day) => {
  const s = String(stamp ?? "")
  return s.slice(0, 10) === day && /^\d{4}-\d{2}-\d{2}/.test(s)
}

// cnTime turns ModelScope's "2026-10-22 15:35:35" (Beijing time, no zone) into
// RFC 3339. Handed to new Date() as is, it would be read in the host's own
// zone, which is 8 hours off on a machine set anywhere else.
function cnTime(value) {
  // The whole string, with nothing after the seconds. ModelScope writes
  // "2026-10-26 09:13:40" with no zone, and the shift below is right for
  // exactly that. A reply that grew a zone ("…T00:00:24Z", "…+00:00") would
  // match the first 19 characters and then have its zone ignored, moving the
  // card's countdown a full 8 hours; failing to a "" is the honest answer.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*$/.exec(String(value ?? ""))
  if (!m) return ""
  const [, y, mo, d, h, mi, s] = m
  // Date.UTC normalizes rather than rejects: month 13 becomes January of the
  // next year, Feb 30 becomes March, "99:99:99" rolls over days. The card
  // would then count down to a moment that looks perfectly reasonable and is
  // not when the grant expires. Ranges first, then the day is checked by
  // asking the date that came out: a real calendar day is the one that comes
  // back. (+8h undoes the Beijing shift below, so the check is on the date
  // the server wrote, not the UTC one it maps to.)
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return ""
  const at = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +s)
  const back = new Date(at + 8 * 3600e3)
  if (back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return ""
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
// same day. The host does not ask at the target's minute: its look runs every
// 30 minutes on a phase of its own, so the first ask past a target can come up
// to half an hour late, and the retry after a failure half an hour after that.
// Capping the end at 23:00 keeps both inside the day for any target before it;
// a later cap could leave a target with one ask, or none.
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
  // A set-but-relative XDG_CONFIG_HOME is ignored by magpie itself (appdir's
  // rooted() in env.go), so joining it would read a file magpie never keeps:
  // "./magpie/msmoli.json", resolved against whatever folder magpie happened
  // to be started in. The user's real window then silently does nothing,
  // because the plugin read a different file. Only an absolute one counts.
  const xdg = process.env.XDG_CONFIG_HOME
  const rooted = Boolean(xdg) && isAbsolute(xdg)
  const base = dir || (rooted ? join(xdg, "magpie") : join(homedir(), ".config", "magpie"))
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
// The colon may be full width: U+FF1A is what a Chinese IME produces for that
// key, so "13：00" is the shape a user in that layout actually types. Read as
// a bad value it fell back to the default window with no sign, and the claim
// then went out at a time the user never named.
function minuteOf(text) {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{2})$/.exec(String(text ?? "").trim())
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
// Kept out of the module's exports on purpose. magpie's plugin loader takes
// *every* function a module exports as a plugin entry (host.js's servers():
// with `default` a function, it iterates Object.values(mod)), calls it with
// the plugin input, and reads the hooks off what comes back. An exported
// helper is therefore run as a second plugin: today it answers an object with
// no hooks and nothing happens, but a throw there is caught by the loader's
// per-plugin try/catch and the whole package is listed as failed to load. It
// is reachable for tests through `testables` below, which is an object and so
// not a plugin entry.
function windowOf(cfg) {
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
// NAMES_MAX bounds the map, not the accounts: at 8 a ninth signed-in account
// pushed the first one's name out, and its card went back to the key's tail.
const names = new Map()
const NAMES_MAX = 64

function rememberName(token, name) {
  if (!name) return
  names.delete(token)
  names.set(token, name)
  while (names.size > NAMES_MAX) names.delete(names.keys().next().value)
}

// named holds when this process last wrote a name back, by token, so a name is
// not written on every ask. It is a time, not a flag: signing out and in again
// with the same token gives a sign-in with no accountId, and a flag kept for
// the life of the process left that account showing "API key …" until magpie
// restarted. A name the sign-in already carries is never written; one it lacks
// is written again once NAME_AGAIN_MS has passed.
const named = new Map()
const NAME_AGAIN_MS = 60 * 60 * 1000

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
  // pluginLeft is magpie's own: [{package, provider: {…one Provider…}}]
  // (plugin_left.go's LeftRecord). Each record carries a single provider, so
  // it is wrapped back into a list here; reading it as a list already
  // skipped every record, and an alias kept there went unseen.
  if (Array.isArray(raw?.pluginLeft)) {
    for (const l of raw.pluginLeft) if (l?.provider && typeof l.provider === "object") lists.push([l.provider])
  }
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

// maskEchoes masks a piece of the token wherever the text carries one. The
// exact split in cardText catches a byte-for-byte echo; a server (or a proxy
// in front of it) that logged only the front of the session, or framed it
// with a prefix, is no longer equal to the key and split() walked past it. A
// piece is a run of the text that is a contiguous substring of the token, at
// least MIN_ECHO characters long — below that a coincidence is likelier than
// an echo, and a two-character nickname that sits inside a key ("ms") is not
// one. maskToken is length-preserving in neither direction here, which is
// fine: what it leaves behind (at most nine characters) is under MIN_ECHO, so
// the scan does not match its own output.
//
// A control or format character — which text() turns into a space — is
// stepped over: a zero-width space pasted into an echoed token (chat clients
// add them), or a \x01 inside one, cut it into pieces each under MIN_ECHO,
// and both pieces reached the card. A line break is stepped over too: what is
// matched is a piece of the real key, not a shape, so a key broken across two
// lines is still the key, and masking it whole is the point.
//
// The matching runs over the visible characters alone, in one pass. Stepping
// over a character as the scan went — and restarting one position later when
// the run came up short — made a run of them cost its own length at every
// position it contained: a 256 KiB body of newlines (a proxy's page, or a
// server echoing one) took minutes, inside a hook whose whole budget is 25
// seconds, and the plugin host's event loop with it. Collected first, the
// same text is scanned once and the spans are put back where they were.
const MIN_ECHO = 12
const maskEchoes = (s, token) => {
  if (typeof token !== "string" || token.length < MIN_ECHO) return s
  const vis = []
  const at = []
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i))
    if (!invisible(c)) {
      vis.push(c)
      at.push(i)
    }
    i += c.length
  }
  let out = ""
  let from = 0
  for (let k = 0; k < vis.length; ) {
    let piece = ""
    let v = k
    while (v < vis.length && token.includes(piece + vis[v])) {
      piece += vis[v]
      v++
    }
    if (piece.length >= MIN_ECHO) {
      // the span of the whole run, invisible characters inside it included,
      // and the ones between it and the last character written before it
      out += maskToken(token)
      from = at[v - 1] + vis[v - 1].length
      k = v
    } else {
      out += s.slice(from, at[k] + vis[k].length)
      from = at[k] + vis[k].length
      k++
    }
  }
  return out + s.slice(from)
}

// invisible is a control or format character: what a token pasted out of a
// chat client carries, and what an echo may have added inside one. INV is the
// same class for the shape test, less the line breaks: a shape is all that is
// known there, and run on across a line it would mask the next line's words.
const invisible = (c) => /[\p{Cc}\p{Cf}]/u.test(c)
const INV = String.raw`(?:(?![\n\r])[\p{Cc}\p{Cf}])`

// tokenShaped is a ModelScope key seen in someone else's text. Every key
// ModelScope issues starts with "ms-", and tokenOf only lets visible ASCII
// out (SENDABLE), so the run it matches is the same character set — a key
// with an underscore in it goes out, and a pattern that stopped at
// [A-Za-z0-9-] would leave that one on the card whole. It is the shape, not
// the key, that is known here; the length floor keeps a short "ms-" word
// ("ms-dos") out of it. An invisible character between two of its characters
// does not end the run, for the reason maskEchoes steps over one.
const tokenShaped = new RegExp(String.raw`m${INV}*s${INV}*-(?:${INV}*[\x21-\x7e]){11,}`, "gu")

// keyShaped catches a key this plugin does not hold. tokenShaped knows only
// the ms- prefix, so a server — or a proxy in front of it — that echoes
// another vendor's credential into a message or a ledger title put it on the
// card whole. Measured before this was written: 34 of the 40 characters of a
// ghp_ token, all 20 of an AWS access-key id, all 32 of a hex digest. The
// card's promise is that a key never reaches it, and a key of somebody else's
// is still somebody's key.
//
// The shape rules are the ones bin/sync.mjs applies to a typed value, so the
// two halves of this tool agree about what "looks like a key" means: a run of
// 16+ characters mixing cases, 32+ mixing digits and letters, 16+ carrying
// digits and capitals, 16+ of hex holding both a letter and a digit; a UUID;
// and a word whose own separators cut it into pieces none of which is over the
// floor but which together are — a key written as nUJqxrpd9Bc7-GvG7J--o… or
// AbCdEfGh.IjKlMnOp… (measured on the card before that arm was added: all 34
// of the first, all 35 of the second). A word does not qualify — which is what
// keeps "每日签到", a model tier or a rule_key readable on the card.
const RUN = /[A-Za-z0-9]+/g
// the characters a key's word can be built from; punctuation outside this set is
// the frame around it ("…", a trailing full stop, a comma)
const IDCH = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.-")
const keyRun = (r) =>
  (r.length >= 16 && /[a-z]/.test(r) && /[A-Z]/.test(r)) ||
  (r.length >= 32 && /\d/.test(r) && /[A-Za-z]/.test(r)) ||
  (r.length >= 16 && /\d/.test(r) && /[A-Z]/.test(r)) ||
  // 16+ of hex with both a letter and a digit in it: a digest, a session id, a
  // fragment of a key. Not a word (abcdefgh… carries letters that are not hex,
  // modelscope20261031 carries more than hex), and not a number
  (r.length >= 16 && /^[0-9a-fA-F]+$/.test(r) && /\d/.test(r) && /[a-fA-F]/.test(r))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// under 12 characters there is no key to hide and maskToken would have to
// print "…" for what is only a short word
const PATHY = /^(?:[~/.]|[A-Za-z]:[\\/]|\\\\)/
const compact = (w) => w.replace(/[^A-Za-z0-9]/g, "")
const splitDigest = (w, c) => {
  const pieces = w.match(RUN) ?? []
  return (
    c.length >= 32 &&
    /\d/.test(c) &&
    /[A-Za-z]/.test(c) &&
    pieces.some((r) => r.length >= 12) &&
    pieces.every((r) => r.length < 32)
  )
}
// a short key carried the base64 symbols + and = as part of its body
// (AbCdEfGh+IjKlMnOp, dGhpc2lzYQ==). The [+=] arm that used to run here masked
// a server's retry=true and an id=12345 with them; this arm keeps the symbols
// but demands one of them in a whole word that is at least 12 characters of the
// key alphabet. retry=true and id=1234567890 carry a bare =, code=ENOENT
// neither, and none of them is masked. The ends are stripped by the same
// alphabet — a card can put a full stop after the word, and a dot is not part
// of a base64 body even though IDCH keeps it for a path or a version
const B64CH = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-")
const stripB64 = (w) => {
  let a = 0
  while (a < w.length && !B64CH.has(w[a])) a += 1
  let b = w.length
  while (b > a && !B64CH.has(w[b - 1])) b -= 1
  return w.slice(a, b)
}
const base64y = (w) => {
  const c = stripB64(w)
  if (c.length < 12 || !/^[A-Za-z0-9+/=_-]+$/.test(c)) return false
  if (c.endsWith("=")) return true
  return c.includes("+") && ((/[a-z]/.test(c) && /[A-Z]/.test(c)) || /\d/.test(c))
}
// a word cut up by - _ . into pieces each under the run floor is one key when
// two of its pieces alternate case inside themselves: a key does (AbCdEfGh,
// nUJqxrpd9Bc7); a name capitalises each piece and stops, so at most one piece
// ever flips — Qwen3-Coder-480B-A35B-Instruct has none, MyProvider-Prod-Edition-2026
// exactly one
const alternates = (w) => (w.match(RUN) ?? []).filter((r) => /[a-z][A-Z]/.test(r)).length >= 2
const isKeyWord = (w) => {
  if (w.length < 12) return false
  if (!/[\\/]/.test(w)) {
    if (UUID.test(w) || base64y(w) || (w.match(RUN) ?? []).some(keyRun)) return true
    // the separators out: a key cut into pieces by - _ . is still one key, and
    // the pieces together are long and alternate case where a name's do not.
    // A word with no separator is not judged here — the run test above has
    // already seen all of it, and base64y the ones with + or =
    const c = compact(w)
    if (c === w) return false
    if (c.length >= 20 && alternates(w)) return true
    return splitDigest(w, c)
  }
  // with a separator it is one key only when it does not start like a path and
  // carries two parts of 12+ characters mixing cases: that is an AWS secret
  // (wJalr…/K7MDENG/bPxRfi…), and a pair of ordinary folder names is not
  const parts = w.split(/[\\/]/).filter((seg) => seg.length >= 12 && /[a-z]/.test(seg) && /[A-Z]/.test(seg))
  return !PATHY.test(w) && parts.length >= 2
}

// maskKeys walks the words of a piece of text: one word that is itself a key
// goes, and inside a word that is not, only the key-like runs and UUIDs go.
// Punctuation that cannot be part of a key stays where it was, so a card
// reads "（bonus ghp_16C7…8B4a）" rather than losing its brackets.
//
// The lead and tail of punctuation are found by walking in from each end, not
// by an anchored regex. `word.slice(lead).match(/[^…]*$/)` backtracked from
// every start position when a word began and ended with an identity character
// and held a long punctuation run between them: a + 200k "!" + a took 117s for
// one match, and a server controls the ledger title it sits in. (A word of
// nothing but punctuation does not show it — the first start position matches
// cleanly — so the test uses that shape)
const maskKeys = (s) =>
  s.replace(/[^\s]+/g, (word) => {
    let a = 0
    while (a < word.length && !IDCH.has(word[a])) a += 1
    let b = word.length
    while (b > a && !IDCH.has(word[b - 1])) b -= 1
    const lead = word.slice(0, a)
    const tail = word.slice(b)
    const body = word.slice(a, b)
    if (!body) return word
    // the decision runs on the whole word, not the stripped body: a UNC path
    // begins with two backslashes, and \ is not in the identity set — stripped
    // as "lead", the rest looked like a relative path with two long camelCase
    // folders and was masked whole (the same test on the word sees PATHY)
    const masked = isKeyWord(word)
      ? maskToken(body)
      : body.replace(RUN, (r) => (keyRun(r) ? maskToken(r) : r)).replace(UUID_ANY, (m) => maskToken(m))
    return lead + masked + tail
  })

// cardText is what a host error becomes before it reaches the account card or
// the terminal. The host's message is not our text: magpie's own CLI scrubs
// tokens out of "no key ms-… for provider" for the same reason, and a message
// can carry a newline, an escape sequence or a bidi override. Sanitized and
// masked first, truncated second — the other order cuts a token in half, and
// half a token is not a token to split() on, so the front of it survives into
// the log. The nickname write-back's log learned that the hard way.
//
// It is also the door every server string in a message goes through: the
// check-in puts the login answer's message and the ledger's titles straight
// into its line, and a server (or a proxy in front of it) that echoes the
// session back must not put it on the card whole.
//
// Three passes, in this order. The key itself, whatever its shape or length:
// a split on the exact string masks it whole. Then a piece of it (maskEchoes)
// for the echo that is no longer equal to it — cut short, or framed. Then,
// when there is no key in hand, whatever is merely token-shaped: that pass is
// all hostText has, and all a message from magpie carries. Fourth, whatever
// looks like a key of ANOTHER vendor (keyShaped) — the server's own words are
// not vetted by the shape of ours.
const cardText = (value, token, max = 200) => {
  let s = String(value ?? "")
  if (typeof token === "string" && token) s = s.split(token).join(maskToken(token))
  return text(maskKeys(maskEchoes(s, token).replace(tokenShaped, (m) => maskToken(m))), max)
}

// hostText is cardText for the two exits where there is no token to split on:
// getAuth itself failed, so the plugin never got as far as reading the key.
// The host's message can still carry one — magpie's own wording for a missing
// key is "no key <key> for provider" — and these two lines would print it
// whole. With no key in hand the shape is all there is, which cardText does.
const hostText = (value) => cardText(value, "")

// unusableName is a nickname that must not be written back: empty, the token
// itself or a piece of it (the server would be handed it twice), or a key the
// host's accountNames lookup would read as inherited rather than as a name.
// The piece is looked for before the cut to 40: a token longer than 40, cut
// to 40, is no longer equal to the token, and its front would be written to
// plugin-auth.json as the account's name. A substring of 20+ characters is
// the piece; a nickname of a few characters that happens to sit inside a
// token ("ms", "ab") is a nickname.
const unusableName = (name, token) =>
  !name ||
  name === token ||
  (typeof token === "string" && ((name.length >= 20 && token.includes(name)) || name.includes(token))) ||
  ["__proto__", "constructor", "prototype"].includes(name)

async function rememberAccountName(client, token, name, auth, dir) {
  // "can write" is a function, not a truthy value: `{ auth: { set: 1 } }` is a
  // client that cannot write, and `!client?.auth?.set` let it through to call
  // a number — the TypeError is caught below, but it logs "account name not
  // written back" on every check-in, a failure report for a client that never
  // had a chance to succeed.
  if (!name || typeof client?.auth?.set !== "function") return
  if (auth?.accountId === name) return
  const at = named.get(token)
  if (at !== undefined && Date.now() - at < NAME_AGAIN_MS) return
  // an account the user has named keeps that name: writing the nickname over
  // it would re-key their alias to a label the account no longer has. A
  // providers.json that can't be read says the same thing — don't write over
  // a state we can't see.
  if (aliasOf(dir, labelOf(auth, token)) !== "") return
  named.delete(token)
  named.set(token, Date.now())
  while (named.size > NAMES_MAX) named.delete(named.keys().next().value)
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
    try {
      const r = client?.app?.log?.({ body: { level: "warn", service: "msmoli", message: `account name not written back: ${why}` } })
      if (r && typeof r.catch === "function") r.catch(() => {})
    } catch {
      // a host whose log throws synchronously must not turn a successful
      // check-in into a failed one, nor a usage read into a rejection
    }
  }
}

const signedOut = (e) => Boolean(e?.signIn === "expired" || e?.expired)

// whyOf is the message of a rejection. A rejected non-Error — a bare string, an
// object without a message, a host's own rejection value — would reach String()
// as "[object Object]", which tells the user nothing and reads like a bug in the
// plugin. The empty string lets the caller say something of its own instead.
const whyOf = (e) =>
  typeof e?.message === "string" && e.message ? e.message : typeof e === "string" ? e : ""

// EXPIRED is what a 401 says, wherever it is met: the ledger read before the
// touch, the touch itself, or either of usage's two reads. Three wordings
// used to exist for one condition ("令牌失效或不属于国内站", the same plus
// "（HTTP 401）", and a bare "HTTP 401" from the balance/ledger path), and the
// README's troubleshooting row promises the user will see the status code in
// it — which only two of the three carried.
const EXPIRED = "令牌失效或不属于国内站（HTTP 401）"

// deadToken is what every 401 becomes: the token is revoked, and magpie only
// signs the account out when the hook says so. Both call sites guard
// `status === 401` before throwing this, so there is no other status to name.
const deadToken = () => Object.assign(new Error(EXPIRED), { signIn: "expired" })

// RISK is what every 403 says — ModelScope's risk control, not a bad token:
// the account may be perfectly fine and only the request was refused. The
// check-in's touch adds the retry it can promise; usage's two reads do not
// (the host polls on its own schedule, nothing here is retried).
const RISK = "被魔搭风控拒绝（HTTP 403）"

// gate turns a reply that is not an answer into the error it is, so the four
// reads that talk to ModelScope (the ledger, the touch, usage's balance and
// usage's ledger) do not each carry their own copy of the four checks. `what`
// names the read in the message ("账单查询失败" / "余额查询失败" / "登录接口
// 失败"); `risk` is the 403 wording, which the touch alone extends with the
// retry it can promise.
//
// The parse check and the status check are separate on purpose: a body that
// does not parse is not JSON; a body that parses and carries a 429/500 is the
// server saying why in its own words (「请求过于频繁」「系统繁忙」). Merged,
// a JSON-carrying 429 was reported as "响应不是 JSON" and sent the user to
// check their proxy.
const gate = (res, body, parsed, token, what, risk = RISK) => {
  if (res.status === 401) throw deadToken()
  if (res.status === 403) throw new Error(risk)
  if (!parsed) throw new Error(`${what}：响应不是 JSON（HTTP ${res.status}）`)
  if (res.status !== 200 || !okOf(body)) throw new Error(`${what}：${saidOf(body, token) || `HTTP ${res.status}`}`)
}

// todayEarn are today's credit grants, by the day ModelScope records them.
// The day is read at each call, on purpose: a check-in that crosses midnight
// between its reads reports what its touch granted on the new day, which is
// true, where diffing both reads against the old day would answer inactive.
async function todayEarn(token, deadline) {
  const { res, body, parsed } = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
  gate(res, body, parsed, token, "账单查询失败")
  const day = todayCN()
  return recordsOf(body).filter((r) => r?.type === "EARN" && onDay(r?.gmt_created, day))
}

// SURE_HOUR is magpie's checkinSureHour (workbuddy_checkin.go): before noon,
// Beijing, a done or inactive for an account magpie hasn't seen claim today is
// provisional and asked again every 30 minutes; from noon on it settles the
// day. AGAIN_MS is that same half hour, said by the plugin itself after noon.
const SURE_HOUR = 12
const AGAIN_MS = 30 * 60 * 1000

// deferred holds, by token, the Beijing day an `inactive` was answered with an
// `until` after noon. One deferral a day: the ask it buys reads the ledger a
// half hour later, which is the wait the immediate re-read cannot buy, and an
// account really not in the campaign must still settle.
const deferred = new Map()

// blankOf is a field that carries no number in it at all: absent, null, or
// nothing but whitespace. The empty string was already refused at both
// numeric sites; the spaces were not, and `Number("   ")` is 0 — so a blank
// amount read as "a grant of nothing" (the check-in answers `inactive`, which
// settles the day) and a blank balance as "0 魔粒可用". A padded number
// (" 251.5 ") is not blank: it says what it means.
const blankOf = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim())

// amountOf is a ledger row's total_amount. A value that is there and is not a
// number is a body we do not understand, and reads as a failure rather than as
// 0: the same rule the whole body gets one level up. A localized "1,200", a
// format change, a null — each would otherwise make a real grant look like
// "nothing arrived": the check-in would answer `inactive` (which settles the
// day) and the card would say 领 0 next to a balance that clearly moved.
// Absent is included: a row with no amount cannot be summed either way.
const amountOf = (row) => {
  const raw = row?.total_amount
  if (blankOf(raw)) throw new Error("账单格式不认识：没有 total_amount")
  // a number or a numeric string, as for the balance: Number(true) is 1 and
  // Number([]) is 0, both finite, and neither is an amount
  const kind = typeof raw
  if (kind !== "number" && kind !== "string") throw new Error("账单格式不认识：total_amount 不是数字")
  const n = Number(raw)
  // readable, not just isFinite: a huge finite value ("1e307") survives isFinite
  // and only blows up at the card, where yin's ×100 overflows to Infinity — so
  // "Infinity 魔粒" would be printed for a body we cannot actually read. The
  // same door the balance read and yin itself use.
  if (!readable(n)) throw new Error("账单格式不认识：total_amount 不是数字")
  return n
}

// readable says a value is a number we can put on a card. Finite is not enough:
// yin multiplies by 100 to round, and a finite value past ~1.8e306 overflows
// that to Infinity — finite in, "Infinity" out. The three places a server
// number enters the card (a ledger amount, the balance, a summed amount) all
// pass through it, so the rule lives once.
const readable = (n) => Number.isFinite(n) && Number.isFinite(n * 100)

// yin is a credit amount as a card says it: at most two decimals, with a
// trailing 0.30 written as 0.3. The tiers are 0.5/1/2, but a grant or a spend
// summed in binary floating point comes out as 0.30000000000000004, and that
// goes straight into the card and into the division below. Its own readable()
// check catches the one path its callers cannot: a sum of many rows, each of
// which was readable on its own but whose total crosses the ×100 overflow.
const yin = (n) => {
  if (!readable(n)) throw new Error("账单格式不认识：金额超出可显示范围")
  return Math.round(n * 100) / 100
}

const sumOf = (records) => yin(records.reduce((n, r) => n + amountOf(r), 0))

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
          return { outcome: "failed", message: hostText(whyOf(e)) || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
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

        const today = todayCN()
        const win = windowOf(configOf(configDir))
        if (win) {
          const p = plan(win, token, today)
          if (!p.due) {
            // The host shows one line under a failed state, and "failed" is
            // the only outcome it retries, so this is the whole message the
            // user gets for the hours before the window. Lead with the thing
            // they care about — the time it will claim — rather than with
            // the word for why it hasn't yet. The config path is left out on
            // purpose: it repeats on every ask and ends up in screenshots,
            // and it is in the README for whoever wants to change it.
            //
            // No countdown. The host keeps this line on the card until its
            // next ask, half an hour later, so "约 8 分钟后" outlives the
            // eight minutes: a real card still read that at 09:47 for a
            // 09:28 target whose credits had already landed. The target and
            // the cadence are both absolute, and the cadence is also why the
            // claim is not at the target sharp — a plugin has no timer, so
            // it runs on the host's next ask, not at the moment it named.
            return {
              outcome: "failed",
              message: `${clock(p.target)} 后自动领取（magpie 每半小时问一次，无需操作）`,
            }
          }
        }

        // The nickname is written back after the answer is made, not between
        // the touch and the reads that reconcile it: magpie's auth.set takes
        // plugin-auth.json's lock synchronously (host.js's lockAuth, up to
        // twice its 10s stale time when another process holds it), and that
        // wait came out of this hook's 25s — a claim that had landed was then
        // answered "预算已用完" and shown as failed for half an hour.
        let name = ""
        const answer = await (async () => {
        try {
          const before = await todayEarn(token, deadline)
          const beforeDaily = before.filter((r) => DAILY_RULES.includes(r?.rule_key))
          const claimed = before.some((r) => r?.rule_key === "daily_active")
          // What this run granted is the ledger's growth, not a new key: the
          // rows are aggregated per (day, type, rule_key, model_tier), so a
          // second grant of a rule already in today's page grows that row's
          // amount instead of adding one. An account that already had today's
          // aliyun_bindlogin (from the website, say) and gains nothing from
          // the touch must not report "claimed 50" — and one that gains more
          // of a rule it already had must still report it.
          const byRule = (rows) => {
            const m = new Map()
            for (const r of rows) m.set(r?.rule_key, (m.get(r?.rule_key) ?? 0) + amountOf(r))
            return m
          }
          const beforeByRule = byRule(beforeDaily)
          // The name a rule is shown by: the first row of that key that carries
          // one. Rows aggregate per (day, type, rule_key, model_tier), so a key
          // can have several rows and the first can be a tier whose title the
          // server left blank — taking rows[0]'s title alone would drop the name
          // from a grant that has one on another row, and the card would read
          // "+50" with nothing in front of it.
          const titleOf = (rows, key) =>
            rows.find((r) => r?.rule_key === key && typeof r.title === "string" && r.title.trim())?.title
          const grew = (rows) => {
            const after = byRule(rows)
            const out = []
            for (const [key, sum] of after) {
              const gain = yin(sum - (beforeByRule.get(key) ?? 0))
              if (gain > 0) out.push({ key, gain, title: titleOf(rows, key) })
            }
            return out
          }

          // Claimed today and the name already known: the touch has nothing
          // left to do. magpie asks a `done` again every half hour before noon
          // when it has not seen the claim itself (provisional), and each ask
          // touching login/info was one more recorded sign-in — up to a dozen
          // a morning for an account claimed on the website.
          const known = names.get(token) ?? ""
          if (claimed && known) {
            name = known
          } else {
            const { res, body, parsed } = await json(token, LOGIN_INFO, deadline)
            // 403 是风控，不是令牌坏了：账号可能是好的，只是这次请求被拒
            gate(res, body, parsed, token, "登录接口失败", `${RISK}，稍后会自动重试`)

            const me = dataOf(body)
            // A name is a string. Anything else — a number, an object, a list —
            // would reach text() as "12345" or "[object Object]" and be written
            // back as the account's name, and magpie's card would show that
            // instead of the key's tail. NickName wins when it is a name; Name
            // is the fallback it always was.
            const str = (v) => (typeof v === "string" && v.trim() ? v : "")
            const candidate = text(str(me.NickName) || str(me.Name), 40)
            name = unusableName(candidate, token) ? "" : candidate
            rememberName(token, name)
          }

          // done 用触发**之前**那一页的合计：今天已经领过，领到的就是那时
          // 账本上的数。用触发之后那一页的话，两次读之间账本一变（行被挤到
          // 下一页、或当日合计被重算），卡片会显示「今日已领取 0 魔粒」。
          if (claimed) {
            const credit = sumOf(beforeDaily)
            const which = beforeDaily.map((r) => cardText(r.title, token, 40)).filter(Boolean).join(" + ")
            // An EARN row can carry a reversal (冲正), and a day whose grants
            // were reversed nets below zero. magpie clamps the numeric credit
            // itself (host.js's num: Math.max(0, v)) but renders `message`
            // verbatim, so "今日已领取 -50 魔粒" would reach the card: a claim of
            // a negative amount is not a thing. The rows are still named — the
            // user can see which ones — but the amount stops at zero, the way
            // the usage card's limit already does.
            const shown = Math.max(0, credit)
            return { outcome: "done", credit: shown, message: `今日已领取 ${shown} 魔粒` + (which ? `（${which}）` : "") }
          }

          const gained = (rows) => {
            const grew1 = grew(rows)
            if (!grew1.length) return null
            const credit = yin(grew1.reduce((n, g) => n + g.gain, 0))
            // A key with no name on any of its rows is shown by its amount
            // alone; joining a blank title would put "+50" with a leading space
            // where the name should be.
            const which = grew1
              .map((g) => {
                const name = cardText(g.title, token, 40)
                return name ? `${name} +${g.gain}` : `+${g.gain}`
              })
              .join("，")
            return { credit, which }
          }

          const daily = gained((await todayEarn(token, deadline)).filter((r) => DAILY_RULES.includes(r?.rule_key)))
          if (daily) return { outcome: "claimed", credit: daily.credit, message: `领取 ${daily.credit} 魔粒：${daily.which}` }
          // 触达了却没有到账记录：可能是账本还没写出来（发放是异步的），
          // 也可能这个账号本来就不在活动范围。再读一次账本确认，别把刚写
          // 出来的发放丢掉。这一次重读买不到「等一会儿」——发放若真是几秒
          // 后才写出来，紧接着的重读也读不到。北京时间 12 点前补上那一段的
          // 是宿主：还没见到领取的 done/inactive 是暂定答案，每 30 分钟重问
          // （provisional，由 checkinSureHour 决定）。12 点起宿主就当天了结，
          // 所以下午的时段由插件自己用 until 要一次半小时后的重问。
          const later = gained((await todayEarn(token, deadline)).filter((r) => DAILY_RULES.includes(r?.rule_key)))
          if (later) return { outcome: "claimed", credit: later.credit, message: `领取 ${later.credit} 魔粒：${later.which}` }
          const hourCN = Math.floor(minuteCN() / 60)
          if (hourCN >= SURE_HOUR && deferred.get(token) !== today) {
            for (const [k, d] of deferred) if (d !== today) deferred.delete(k)
            deferred.set(token, today)
            return {
              outcome: "inactive",
              message: "登录已触达，账本里还没有今天的到账；半小时后再核对一次",
              until: new Date(Date.now() + AGAIN_MS).toISOString(),
            }
          }
          return { outcome: "inactive", message: "登录已触达，但今天没有到账记录（账号可能不在活动范围）" }
        } catch (e) {
          return { outcome: "failed", message: cardText(whyOf(e), token) || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
        })()
        // best-effort, and never a reason for the hook to reject: the write
        // catches its own failures, and anything it could still throw (an
        // unreadable providers.json read) must not undo the answer above
        try {
          await rememberAccountName(client, token, name, auth, configDir)
        } catch {}
        return answer
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
          return { error: hostText(whyOf(e)) || "用量查询失败", signIn: signedOut(e) ? "expired" : "" }
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
          gate(bal.res, bal.body, bal.parsed, token, "余额查询失败")
          // data 缺失读成 0 会把「没读懂」翻译成「余额为零」——一个确定又
          // 错误的结论，卡片会写「0 魔粒可用」。账本那侧的 recordsOf 同理。
          // 字段这一层也一样：available_balance 缺失、null、或改了名字，
          // 都不是 0 元的余额。
          const balData = dataObjectOf(bal.body, "余额查询失败：响应里没有 data")
          const rawAvailable = balData.available_balance
          if (blankOf(rawAvailable)) {
            throw new Error("余额查询失败：响应里没有 available_balance")
          }
          // A number or a numeric string is a balance. Anything else is not:
          // Number([]) is 0 and Number(true) is 1, both finite, so the plain
          // isFinite check let an empty list through as "0 魔粒可用" — the
          // definite wrong answer this guard exists to stop — and a boolean
          // through as one 魔粒. A formatted string ("1,234") is a number we
          // cannot read, not 0, and blankOf covers the field that holds
          // nothing but spaces, which `Number` also reads as 0.
          const kind = typeof rawAvailable
          if (kind !== "number" && kind !== "string") throw new Error("余额查询失败：available_balance 不是数字")
          const availableN = Number(rawAvailable)
          if (!readable(availableN)) throw new Error("余额查询失败：available_balance 不是数字")
          // a balance is not a debt: the server's 冲正 direction can put it
          // below zero, and "-5 魔粒可用" is not a thing the card can show
          const available = Math.max(0, yin(availableN))

          const tx = await json(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
          gate(tx.res, tx.body, tx.parsed, token, "账单查询失败")

          const day = todayCN()
          let earned = 0
          let spent = 0
          let earliest = ""
          for (const r of recordsOf(tx.body)) {
            // Only the two kinds that go into the card's numbers need an
            // amount. A row of a kind we do not sum is not counted either
            // way, and failing the whole card over its amount would turn a
            // ledger that grew a new kind (an expiry row, say) into "no
            // numbers at all" — the opposite of what the rule is for.
            if (onDay(r?.gmt_created, day)) {
              if (r?.type === "EARN") {
                // 「领」是今天入账的全部，促销一类也算：卡片问的是「今天进来
                // 多少、用掉多少」，把促销排除会让余额涨了 500 而卡片写「领 0」。
                // 签到报的 credit 是另一个问题（这次签到领到多少），只算日常
                // 额度，两个数不一样是各自的答案，不是同一个数的两种算法。
                earned += amountOf(r)
              } else if (r?.type === "SPEND_CONFIRM") {
                spent += amountOf(r)
              }
            }
            // The countdown ends when the soonest of the day's credits is
            // actually lost, so it reads every daily grant that is still
            // running — including yesterday's, which runs until 24 hours after
            // it landed and can expire before today's own grant does. Tying it
            // to today's rows alone pointed the countdown past a batch that
            // disappears sooner. A grant already expired cannot be "when the
            // credits run out" either.
            if (r?.type === "EARN" && DAILY_RULES.includes(r?.rule_key) && r?.expire_at) {
              const at = cnTime(r.expire_at)
              if (at && Date.parse(at) > Date.now() && (!earliest || at < earliest)) earliest = at
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
          // 入账方向也可能出现负数（冲正、回收）。不夹的话卡片会写
          // 「领 -50」，而 limit 是负的更没意义。用掉的方向同理。
          const earnedToday = Math.max(0, earned)
          const usedToday = Math.max(0, spent)
          // 没有今天的入账时，百分比的分母换成「今天手里有多少」——用掉的
          // 加上还剩的。分母为 0 时沿用旧口径：余额也空了才算用尽。
          // 否则卡片会出现 used=0、今日用 348.5、领 0 的组合，进度条说没动，
          // 文字说花掉了一堆。
          //
          // 记账里两个数都过了 readable()，比值却可能大到 ×10000 溢出成
          // Infinity；宿主对非有限的 used 读作 0（host.js 的 num 只认有限数），
          // 于是「几乎全用光」被画成没动过。算不出百分比就交给宿主当「没说」
          // （used 省略 = null），文字那行仍然写着真实的数量。
          const pct = (n, d) => {
            const v = Math.round((n / d) * 10000) / 100
            return Number.isFinite(v) ? v : null
          }
          // 用掉的超过今天领的、余额却还有：花的是昨天那份还没过期的魔粒，
          // 不是超额。那时分母同样换成「今天手里有多少」——否则昨天 15:00
          // 领 250、今天领 250、上午用掉 300，卡片会画成 120% 的超额，旁边
          // 写着余额 200。超额只在余额也空了时才成立。
          const used =
            earnedToday > 0 && (usedToday <= earnedToday || available === 0)
              ? pct(usedToday, earnedToday)
              : usedToday + available > 0
                ? pct(usedToday, usedToday + available)
                : 100

          // 今天还没领到时，把时段里的目标时刻写在卡片上，别让「领 0」
          // 看起来像是出了问题。
          const win = windowOf(configOf(configDir))
          const ahead = win && earnedToday === 0 ? plan(win, token, day) : null
          const hint = ahead && !ahead.due ? ` · ${clock(ahead.target)} 领取` : ""

          return {
            plan: "魔搭社区",
            user: names.get(token) ?? "",
            balance: `${available} 魔粒可用`,
            windows: [
              {
                name: "魔粒",
                used,
                display: `今日用 ${usedToday} / 领 ${earnedToday} · 余额 ${available}${hint}`,
                amount: usedToday,
                limit: earnedToday,
                unit: "魔粒",
                resetsAt: earliest,
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
      // 宿主是 `{ provider: {}, ...userConfig }` 拼出来的，用户配置里那个
      // provider 会盖掉默认的 {}。它不是对象时（旧版本写的字符串、手改的
      // 数字），下面 `[ID] =` 会抛 TypeError，宿主只把 config 钩子的错误
      // 记进日志——插件照常出现，只是没有名字，看不出哪里错了。`??=` 只挡
      // null/undefined，挡不住 ""、0、false；一个装不下 ID 的容器里没有可
      // 保留的东西，整个换掉。
      if (!config.provider || typeof config.provider !== "object") config.provider = {}
      // 用户自己改过的名字留着：magpie 把 provider 的名字存在 providers.json
      // 里，而钩子每次启动都跑一遍——强制写回默认值会把 UI 里的改名悄悄撤销，
      // 与账号昵称那条「用户命名过就不动」是同一条规矩。值不是对象时当作没有。
      const was = config.provider[ID] && typeof config.provider[ID] === "object" ? config.provider[ID] : {}
      config.provider[ID] = {
        ...was,
        name: typeof was.name === "string" && was.name ? was.name : "ModelScope 魔粒",
      }
    },
  }
}

// testables is how the pure helpers the tests pin are reached without
// exporting them as functions: magpie's loader treats every exported function
// as a plugin entry (see windowOf above), but an object it skips. The tests
// are the only reader.
export const testables = { windowOf }

export default MsmoliPlugin
