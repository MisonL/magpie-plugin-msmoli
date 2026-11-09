// ModelScope credits check-in for magpie — one provider that serves both
// modelscope.cn and modelscope.ai, each account on the site its token is from.
//
// magpie calls auth.checkin once a Beijing day per signed-in account while the
// provider's check-in switch is on, and again later that day after a failure.
// Hooks here: checkin, usage.
//
// How the claim works: ModelScope's OpenAPI has no check-in endpoint. What it
// has is a side effect — GET /api/v1/users/login/info counts as a website
// sign-in, and the server grants that day's credits with it (200 for the
// "register-and-sign-in" daily grant, 50 for a bound Aliyun account), once per day.
// modelscope.ai is the same backend with the same paths and the same
// daily_active rule, but separate accounts and separate tokens: measured, an
// ms- token authenticates only on the site it came from.
//
// The plugin serves no chat models: inference keeps using the API-key modelscope
// preset in providers.json. This provider exists only to carry the sign-in the
// check-in runs as.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

// One provider serves both sites: a token's site is a fact about the token,
// not about the card, so the plugin finds it per account instead of asking the
// user to pick a provider. A profile carries what differs between the sites —
// the origin, the plan line the card shows, and the word a 401 uses.
const CN = {
  site: "https://modelscope.cn",
  plan: "魔搭社区",
  where: "国内站",
}
const INTL = {
  site: "https://modelscope.ai",
  plan: "魔搭社区（国际版）",
  where: "国际站",
}
const SITES = [CN, INTL]

// The provider's id and name: one card, whatever mix of accounts it holds.
const ID = "msmoli"
const NAME = "ModelScope 魔粒"

// sites remembers which site each token signs in to, for the life of the
// process. Finding it costs one of the reads the hook was about to make anyway
// — a 401 is the only answer that rules a site out — and asking again on every
// poll would double every read. Bounded like `names`: a host is long-lived, and
// tokens come and go.
const sites = new Map()
const SITES_MAX = 64
const rememberSite = (token, profile) => {
  sites.delete(token)
  sites.set(token, profile)
  while (sites.size > SITES_MAX) sites.delete(sites.keys().next().value)
}

// profileForSite maps a value kept on a sign-in back to its site. Anything
// else — an older host's field, a hand-edited file — is ignored and the token
// probed again rather than trusted.
const profileForSite = (v) => (typeof v === "string" ? SITES.find((p) => p.site === v) : undefined)

const LOGIN_INFO = "/api/v1/users/login/info"
const BALANCE = "/openapi/v1/magicubes/balance"
const TXNS = "/openapi/v1/magicubes/transactions"

// The sign-in is the site's own web session, so every request carries a
// browser's UA rather than a bare fetch one — a bare UA is the one shape
// measured to get a different answer. The string is fixed on purpose (the
// suite pins it whole): it names a browser version rather than pretending to
// be one, and nothing here fingerprints beyond it.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// The daily-grant rules. This kind of credits expires in 24 hours; they do not
// accumulate.
const DAILY_RULES = ["daily_active", "aliyun_bindlogin"]

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
// A key that is not a string is not a key: String() on an array or a number
// turns it into text that passes SENDABLE, and the sign-in's key then goes out
// as a Cookie — measured, `key: [token]` sent the token and `key: 1234…` sent
// the number. The host writes a string; anything else is a file this plugin
// could not read, and it is refused the way an unsendable key is, not sent.
const rawKey = (auth) => (auth?.type === "api" && typeof auth.key === "string" ? auth.key.trim() : "")

// tokenOf is the key this sign-in carries, or "" when there is none or it is
// not one we can send. The two are told apart by the caller so a key that is
// there and unusable does not read as "you never signed in".
const unusableKey = (auth) => {
  if (auth?.type !== "api" || auth.key === undefined || auth.key === null) return false
  // a key of the wrong type is a store this plugin cannot read, not an absent
  // one: reported as unusable so the message says the token is unreadable
  if (typeof auth.key !== "string") return true
  const key = auth.key.trim()
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
// proxy's dial, and the "request timed out (8 s)" wording would send the user
// after the network
// when the proxy is what is down.
function saidFailure(e, ctl, budget) {
  if (e !== ctl.signal.reason && /^proxyconnect\b/i.test(String(e?.message ?? ""))) {
    return new Error("请求失败：代理连不上（检查 magpie 的代理设置）")
  }
  if (e === ctl.signal.reason || /timeout/i.test(String(e?.message ?? ""))) {
    // Ceiling, not round: the budget can be down to a few hundred
    // milliseconds when the hook's own deadline is what cut it short, and
    // "request timed out (0 s)" tells the user nothing about which of the two
    // it was. The flag is how siteRead tells a timeout (the link, which the
    // other site would wait out again) from a refusal (that site's answer).
    return Object.assign(new Error(`请求超时（${Math.max(1, Math.ceil(budget / 1000))} 秒）`), { timeout: true })
  }
  if (e?.name === "TypeError" || /fetch failed/i.test(String(e?.message ?? ""))) {
    return new Error("请求失败：网络不通、被代理拦截，或遇到了重定向")
  }
  return e
}

// siteRead is how the plugin learns a token's site: the remembered site is
// asked first, then the other one. Only a usable answer — a 200 that parses
// and does not say it failed — chooses a site and is remembered. A 401 drops
// the memory (another site may hold the token). Every other failure — a
// transport error, a proxy's 200 page, a 5xx, a 200 whose body denies the
// token, a 2xx that is not 200 (a 202 means accepted-and-not-done; gate()
// refuses it too) — moves the probe on to the other site: the remembered
// site being wrong (a re-keyed token), unreachable, or broken must not strand
// the account on it, and the domestic site can be broken on a network where
// the international one works. An API-level refusal (403 risk control, a 400
// on the request) is final: this site accepted the token and the answer is
// what the caller must report. A 429 is not that answer — a rate limit is the
// site's, not the token's — so the probe moves on and keeps it as the
// fallback, the way it treats a 5xx. The first failure is the one reported
// when neither site gives a usable answer, because it is the one the user was
// closest to (their token most often comes from the domestic site).
async function siteRead(token, path, deadline = Infinity) {
  const known = sites.get(token)
  const order = known ? [known, ...SITES.filter((p) => p !== known)] : SITES
  // A parsed 4xx/429/5xx that is not an answer is still the site *saying
  // something*, and it beats a transport error from the other site ("risk
  // control" is more useful than "check your proxy"). It is kept as `answer`
  // while the loop goes on: the site that gave it may not be the one holding
  // this token (a stale `site`, a re-keyed sign-in, a middlebox's 404).
  let answer
  let first
  for (const profile of order) {
    let got
    try {
      got = await json(profile.site, token, path, deadline)
    } catch (e) {
      // A timeout is the link, not the site, and the remembered site may be
      // the stale half of a re-keyed sign-in — the same state the 401 branch
      // exists for. The second read is bounded by the hook's own deadline, so
      // a dead network costs at most the budget it would have spent anyway;
      // giving up here left an account on a wrong or unreachable site all day.
      first ??= e instanceof Error ? { error: e } : { error: new Error("") }
      continue
    }
    if (got.res.status === 401 && got.parsed) {
      // A 401 where the token was accepted before: the sign-in may have been
      // re-keyed with a token of the other site, or the remembered site may be
      // stale (a kept `site` value, a proxy's 200 cached as an answer). A 401
      // that is not ModelScope's own JSON is a middlebox's challenge, not the
      // token being refused — it falls through like any other non-answer.
      if (profile === known) sites.delete(token)
      continue
    }
    if (got.parsed && got.res.status === 200) {
      if (okOf(got.body)) {
        rememberSite(token, profile)
        return { profile, ...got }
      }
      first ??= { answer: { profile, ...got } }
      continue
    }
    // A 4xx is the site answering — but a 404/405/451 from a middlebox, or a
    // 400/403 from the site that does not hold this token, is no better
    // evidence than a 5xx. Keep it as the best answer and let the other site
    // answer too; a genuine risk-control 403 on the right site still ends up
    // as the report when the other site has nothing better to say.
    if (got.parsed && got.res.status >= 400 && got.res.status < 500 && got.res.status !== 429) {
      answer ??= { profile, ...got }
      continue
    }
    first ??= { answer: { profile, ...got } }
  }
  if (answer) return answer
  if (first) {
    if ("error" in first) throw first.error
    return first.answer
  }
  throw deadToken("任一站点")
}

async function json(site, token, path, deadline = Infinity) {
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
      fetch(site + path, {
        // every redirect is refused, the site's own included: one that left
        // the origin would carry the session cookie off-site (the runtimes
        // happen not to forward it), and ModelScope's endpoints answer in place
        redirect: "error",
        headers: {
          Cookie: "m_session_id=" + token,
          "User-Agent": UA,
          Referer: site + "/",
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
    // an empty body is not an answer at all: a bare 401 from a proxy is the
    // path, not the site saying the token is refused, and reading it as "{}"
    // (parsed, an object) signed the account out over a middlebox's refusal
    return { res, body, parsed: body !== null && (text !== "" || res.status === 200) }
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

// ── Check-in window ───────────────────────────────────────────────────────
// magpie asks once at the Beijing-day rollover and retries a failure every 30
// minutes; the plugin has no timer of its own (see the README's "upstream"
// section). So before today's target moment for this account arrives, the only
// answer is failed — that is the one outcome the host retries; every other
// outcome ends the day there and then. That overnight ask-and-answer sends no
// request; the claim itself is left to the ask during working hours.
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
  // An empty name is remembered too. "The server gave no usable name" is a
  // fact as much as a name is: before this, `names` never held it, so the
  // "claimed and the name is known" shortcut never took and every provisional
  // re-ask in a morning touched login/info again — the dozen extra sign-ins
  // the shortcut exists to prevent. A read that failed does not come here, so
  // a later ask still tries once more.
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
//
// `id` is the provider's own: both sites keep their accounts in the same
// providers.json, and an alias is only this plugin's when the row's id says so.
function aliasOf(id, dir, label) {
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
      if (p?.id !== id) continue
      const names = p.accountNames
      if (!names || typeof names !== "object") continue
      const mine = names[key]
      if (typeof mine === "string" && mine) return mine
    }
  }
  return ""
}

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
// The matching runs over the alphanumeric characters alone, in one pass, and
// against the token's own alphanumeric run. Collecting "the characters the
// token is made of" instead let a character the token genuinely holds — the
// "-" of every ms- key — be used as a cutter: a server echoing the key with a
// "-" every 11 characters produced runs that were each under MIN_ECHO, and
// the whole key reached the card. Punctuation is now a separator whether the
// token holds it or not, and only its letters and digits say "this is the
// key". Everything else — whitespace, a zero-width space, a comma, a middle
// dot, an emoji, or the key's own hyphen — is stepped over and the pieces on
// either side joined for the comparison. Skipping them is what keeps an echo
// broken into short chunks whole, and a chunk under MIN_ECHO from surviving
// on its own. A whitelist of separators cannot do this: the set is open, and
// the one character it misses is the one the server uses.
//
// Stepping over a character as the scan went — and restarting one position
// later when the run came up short — made a run of them cost its own length
// at every position it contained: a 256 KiB body of newlines (a proxy's page,
// or a server echoing one) took minutes, inside a hook whose whole budget is
// 25 seconds, and the plugin host's event loop with it. Collected first, the
// same text is scanned once and the spans are put back where they were.
// MIN_ECHO is how much of the key must sit together before the text is taken
// for an echo. Ten rather than twelve, so that "a piece of at least 11
// characters of the key" is masked: with the scan starting one character past
// a short run (see maskEchoes below), a floor of 12 missed a run of 11 that
// opened a chunked echo. Ten still leaves an ordinary short word ("ms-dos",
// an 8-character slice) alone. The final review then showed the echo split
// into 8-character groups joined by one letter: each group is under this
// floor, so the mask steps over a single filler inside a run instead of
// restarting, and the floor applies to the joined run.
const MIN_ECHO = 10
// fold is the form an echo is compared in: NFKC (a full-width "ｍｓ" is the
// same key typed on another keyboard), lower case (a server that upper-cases
// its log is still echoing the key), and letters and digits only (everything
// else is a separator the echo inserted). Case and compatibility are not a
// change of secret, and comparing byte for byte left the whole key on the
// card when either changed.
const fold = (s) => (typeof s === "string" ? s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "") : "")
const maskEchoes = (s, token) => {
  if (typeof token !== "string") return s
  const flat = fold(token)
  if (flat.length < MIN_ECHO) return s
  // at/end are the source text's bounds for each folded character. One source
  // code point can fold into more than one ("ﬁ" is "fi"), so the end is kept
  // per entry rather than derived from the folded length.
  const vis = []
  const at = []
  const end = []
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i))
    for (const f of c.normalize("NFKC").toLowerCase()) {
      if (f >= "a" && f <= "z" || f >= "0" && f <= "9") {
        vis.push(f)
        at.push(i)
        end.push(i + c.length)
      }
    }
    i += c.length
  }
  let out = ""
  let from = 0
  for (let k = 0; k < vis.length; ) {
    let piece = ""
    let v = k
    let fillers = 0
    while (v < vis.length) {
      if (flat.includes(piece + vis[v])) {
        piece += vis[v]
        v++
        continue
      }
      // Characters the token does not hold at this point, between two pieces
      // of it: a server that prints "01234567x 89abcde0x …" writes
      // 8-character pieces under MIN_ECHO and a letter between them, and the
      // pieces together are the key. Up to as many characters as the run has
      // already matched are stepped over — an echo is mostly the key — and the
      // run resumes at the first of them that continues it. A filler may only
      // be stepped over *inside* a run: skipping a leading character before
      // anything matched swallowed the word in front of the key ("x ms-…" lost
      // its x). One filler was the first cut; two in a row then went through
      // ("01234567xx 89abcdefxx …" kept the whole body).
      if (piece.length === 0) break
      const stop = Math.min(vis.length, v + 1 + (piece.length - fillers))
      let hit = -1
      for (let j = v + 1; j < stop; j += 1) if (flat.includes(piece + vis[j])) { hit = j; break }
      // one character is stepped over however little has matched (a server's
      // single letter between pieces); more than one only when the run is
      // already long enough to be an echo under the lower floor. Without that
      // second half, "said: aaaa1111-b" matched the last s of "said" and then
      // skipped "id" to join the piece, and a 9-character slice that the floor
      // is meant to leave alone was masked as if it were longer.
      if (hit < 0 || (hit - v > 1 && piece.length < MIN_ECHO - 2)) break
      fillers += hit - v
      v = hit
    }
    // The floor counts the key's own characters, not the characters the echo
    // wrote them in: a slice carrying its own hyphens ("1-bbbb-2222-") is
    // twelve characters on the card and nine of the key, and nine is under the
    // floor by design — a fragment that short is not the key, and counting
    // punctuation would mask ordinary hyphenated text ("2026-11-08" is eight
    // of them). The README says so.
    if (piece.length >= MIN_ECHO) {
      // The span of the whole run, the characters skipped between its pieces
      // included. What sat between the last character written and the run's
      // first one — whitespace skipped while matching — is written out first,
      // so masking does not join two words that the echo had apart.
      out += s.slice(from, at[k])
      out += maskToken(token)
      from = end[v - 1]
      k = v
    } else {
      out += s.slice(from, end[k])
      from = end[k]
      k++
    }
  }
  return out + s.slice(from)
}

// INV is the control or format class for the shape test, less the line breaks:
// a shape is all that is known there, and run on across a line it would mask
// the next line's words. maskEchoes no longer needs a separate predicate —
// it keeps the alphanumeric characters and skips everything else.
const INV = String.raw`(?:(?![\n\r])[\p{Cc}\p{Cf}])`
// the one place a token-shaped run is turned into a mask is maskShaped, below:
// the shape alone found a run; the body it carries is what decides.

// A key of another shape with an invisible character inside it reaches the card
// as two words once that character is turned into a space, and neither half
// clears the word floor on its own: measured, a 27-character ghp_ token cut in
// two kept its 14-character back half, an sk-ant body its 12. tokenShaped steps
// over an invisible character only for the ms- shape. This removes one before
// the rest of the pipeline sees the text, but only where it sits between two
// key-alphabet characters — a real space, a line break or a comma is not glued,
// so a key is put back together and ordinary words are left alone. One
// character wide at each lookaround, so it is a linear pass.
const GLUE = new RegExp(String.raw`(?<=[A-Za-z0-9+\/=_.-])${INV}(?=[A-Za-z0-9+\/=_.-])`, "gu")

// tokenShaped is a ModelScope key seen in someone else's text. Every key
// ModelScope issues starts with "ms-", and tokenOf only lets visible ASCII
// out (SENDABLE), so the run it matches is the same character set — a key
// with an underscore in it goes out, and a pattern that stopped at
// [A-Za-z0-9-] would leave that one on the card whole. It is the shape, not
// the key, that is known here; the length floor keeps a short "ms-" word
// ("ms-dos") out of it. An invisible character between two of its characters
// does not end the run, for the reason maskEchoes steps over one.
//
// A key pasted with one space inside it ("ms-aaaa1111 bbbb-2222-…") is the
// same key, and each half is under every word floor on its own: that is the
// second arm, six characters, one space, five more. "ms-dos and ms-word" has
// no such shape (six and five characters either side of its real spaces).
// The body has to read as key material, not merely be eleven characters:
// an ordinary word after the front ("The ms-interviewing feature is
// unavailable" on the card, a nickname of the same) was masked whole and the
// nickname refused its write-back. A ModelScope key is hex or base64 with a
// digit in it, nearly always in hyphen-separated groups (aaaa1111-bbbb-2222-
// cccc-…); a word carries no digit and a version carries its digits as one
// dotted group ("ms-office 2016", "ms-cli 2026.11.9"). Either spelling does:
// 11+ that are all hex, or 11+ that carry a digit, and the body's last
// character joined to a letter or digit is a cut, not the end of a key
// ("ms-abc12345678abc" is one body, not "…5678" and "abc").
const keyChar = String.raw`(?:${INV}*[\x21-\x7e])`
const tokenShaped = new RegExp(
  String.raw`m${INV}*s${INV}*-(?:${keyChar}{11,}|${keyChar}{6,}[^\S\n\r]+${keyChar}{5,})`,
  "gu",
)
const keyBody = new RegExp(String.raw`(?:[0-9a-f]{11,}(?![0-9a-z])|(?=[\x21-\x7e]{11,})(?!\w)[\x21-\x7e]*\d)`)
// maskShaped is the replace both passes share: the shape finds a run that
// begins like a key; keyBody asks whether the run after the front reads as
// one. A run that does not is ordinary text and is handed back as written,
// untouched — the caller's own passes then judge it word by word.
const maskShaped = (m) => (keyBody.test(m) ? maskToken(m) : m)
// The vendor prefixes whose keys are not distinguishable from a name by its
// characters alone: the prefix is the evidence ("sk-" is Anthropic and OpenAI's,
// "sk_live_" Stripe's, "ghp_" GitHub's, "xoxb-" Slack's, "AKIA" AWS'). The body
// behind it is not asked — a name that starts with one of these is a key first.
const VENDOR = /^(?:sk-|sk_(?:live|test)_|gh[pousr]_|xox[abposr]-|akia|asia|aida|aliyun|ssh-rsa|-----begin)/
const keyAt = (word, letters) => isKeyWord(word, letters) || VENDOR.test(word) || /^ms-/i.test(word)
// maskSpaced is the other reading of a piece of text: a key cut by whitespace
// is read as one key. Measured without it: a 40-character ghp_ token cut into
// four went out whole, a foreign ms- key cut the same way, and each piece
// cleared the word floors on its own. The check gets both readings — maskKeys
// per word, and this per run — and text that reads as a key under either is
// masked.
//
// Three readings, the same shapes bin/sync.mjs's maskCut reads: a run of words
// on one line (the body of a key cut by spaces — the key-shaped word at an
// end of it is where the mask begins, its pieces short or a vendor front); a
// pair either side of a line break (the break a wrapped copy leaves), judged
// joined; a narrow run of words that are all short pieces (a key written one
// character per word). A word already carrying a mask is not judged again.
const MASKED = "…"
const startProse = (w) => /^[a-z]{2,}$/.test(w) && !VENDOR.test(w) && !/^ms-/.test(w)
function maskSpaced(s, letters) {
  if (s.length > 32 * 1024) return s
  const words = [...s.matchAll(/[\x21-\x7e]+/g)]
  if (words.length < 2) return s
  const at = (i) => words[i].index
  const end = (i) => words[i].index + words[i][0].length
  const gap = (i) => s.slice(end(i - 1), at(i))
  // a run's gaps: one space, a no-break or ideographic one, or one line break
  // (a key wrapped across lines, "ms-vqmjh\n75qa651i\n…"). A middot or a
  // bullet is a cut's other spelling ("ms-a·b·c") only from a key's front:
  // the front is the evidence that a cut made it, and a card's own middot
  // separators ("version 1.2.3 · build 45") do not start at one
  const front = (w) => VENDOR.test(w) || /^ms-/i.test(w)
  const runGap = (k, i) =>
    (/^[ \t\u00a0\u3000\r\n]+$/.test(gap(k)) && gap(k).length <= 2) || (/^[·•∙‧・]$/.test(gap(k)) && front(words[i][0]))
  const out = []
  let from = 0
  for (let i = 0; i < words.length; i += 1) {
    if (i > 0 && /^\r?\n$/.test(gap(i)) && end(i) - at(i - 1) >= 20) {
      const pair = words[i - 1][0] + words[i][0]
      if (!pair.includes(MASKED) && isKeyWord(pair, letters)) {
        out.push(s.slice(from, at(i - 1)), maskToken(pair))
        from = end(i)
        i += 1
        continue
      }
    }
    if (startProse(words[i][0])) continue
    const pairOfKeys = i + 1 < words.length && /^[ \t\u00a0\u3000]+$/.test(gap(i + 1)) && keyAt(words[i][0], letters) && keyAt(words[i + 1][0], letters)
    let j = i
    let head = i
    let body = words[i][0]
    for (let k = i + 1; !pairOfKeys && k < words.length && k - i <= 48 && runGap(k, i); k += 1) {
      // a word of four or more lower-case letters inside the run is prose
      // ("sk-User joined the team"), not a piece of a key. A run of exactly
      // four is a piece as readily as a word ("ms-v qmjh 75qa …" is a key cut
      // into fours), so it ends the run only when the run does not start at a
      // key's front
      if (words[k][0].length >= 4 && /^[a-z]{4,}$/.test(words[k][0]) && !/[0-9]/.test(body) && (words[k][0].length > 4 || !(VENDOR.test(words[i][0]) || /^ms-/i.test(words[i][0])))) break
      body += words[k][0]
      const pieces = words.slice(i, k + 1).map((w) => w[0])
      const cut = body.length >= 20 && !body.includes(MASKED) && pieces.every((w) => w.length <= 16 || VENDOR.test(w)) && !pieces.some((w) => w.length >= 7 && /^[A-Za-z]{7,}$/.test(w)) && (body.match(/[A-Za-z0-9]+/g) ?? []).some((r) => keyRun(r, letters))
      if (!cut) continue
      const hi = pieces.findIndex((w) => keyAt(w, letters) || (w.length >= 8 && /\d/.test(w) && /[A-Z]/.test(w)))
      j = k
      head = hi >= 0 ? i + hi : i
    }
    if (j === i) continue
    out.push(s.slice(from, at(head)), maskToken(words.slice(head, j + 1).map((w) => w[0]).join("").replaceAll(MASKED, "")))
    from = end(j)
    i = j
  }
  return out.join("") + s.slice(from)
}

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
// keeps "Daily check-in", a model tier or a rule_key readable on the card.
const RUN = /[A-Za-z0-9]+/g
// the characters a key's word can be built from; punctuation outside this set is
// the frame around it ("…", a trailing full stop, a comma)
const IDCH = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.-")
const keyRun = (r, letters = true) =>
  (letters && r.length >= 16 && /[a-z]/.test(r) && /[A-Z]/.test(r)) ||
  (r.length >= 32 && /\d/.test(r) && /[A-Za-z]/.test(r)) ||
  // (a nickname is judged without the case-mix arms — WangXiaoming2026 is a
  // word — but an all-caps id with a digit in it is still a key, and it is the
  // only shape those arms would have caught that the others do not)
  (r.length >= 16 && /\d/.test(r) && /[A-Z]/.test(r) && (letters || r === r.toUpperCase())) ||
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
  // a trailing = is base64 padding on its own. A + inside is the other sign,
  // but only beside a case mix: a phrase of lowercase words (foo+bar+baz+qux),
  // arithmetic and a phone number (+1-555-123-4567, 1+2+3+4+5) carry one too.
  // A generated key mixes cases; digits alone do not make it one
  if (c.endsWith("=")) return true
  return c.includes("+") && /[a-z]/.test(c) && /[A-Z]/.test(c)
}
// a word cut up by - _ . into pieces each under the run floor is one key when
// it flips case inside itself at least twice: a key does (AbCdEfGh.IjKlMnOp…,
// nUJqxrpd9Bc7-GvG7J--o…), and so does a vendor key whose front is lowercase
// words — sk-ant-api03-Eyai1pkJrF_Kbwt flips at Ey and at Kw. A name
// capitalises each piece and stops: MyProvider-Prod-Edition-2026 and
// Qwen3-Coder-480B-A35B-Instruct each flip at most once. Counting flips, not
// flipping pieces, is what keeps the vendor key (one flipping piece) from
// being lost
const alternates = (w) => (w.match(/[a-z][A-Z]/g) ?? []).length >= 2
// A slice of a generated key can be handed back with no known key to compare
// against — "no key 5gli9zadx8zg9jez for provider" from a host whose
// getAuth failed — and a 12–15-character lowercase run has no case mix, no
// digit by shape alone and no length floor to catch it. Its letters do not
// read as a word: a run of them has few vowels (usually none), letters and
// digits alternate, or digits make up much of it. A real word — "modelscope",
// "workbuddy", "trae-global" — carries vowels; a long provider id with a date
// in it sits under the length floor. The band is narrow on purpose: 40 and
// over is the other shapes' business, and under 12 the fragments a legitimate
// message carries (a version, a rule id) are short enough to stay.
const VOWELS = /[aeiouy]/g
const randomish = (r) => {
  if (r.length < 12 || r.length > 40 || !/[a-z]/.test(r)) return false
  if ((r.match(VOWELS) ?? []).length / r.length >= 0.2) return false
  const digits = (r.match(/\d/g) ?? []).length
  const transitions = (r.match(/[a-z][0-9]|[0-9][a-z]/g) ?? []).length
  return transitions >= 2 || digits >= 4
}
const isKeyWord = (w, letters = true) => {
  if (w.length < 12) return false
  // a run with no word in it (a slash of a key a host printed with no key in
  // hand) is judged by shape; the caller that knows a name from a key skips
  // this arm by passing `letters: false` (nameText, when a name is being shown)
  if (letters && /^[a-z0-9]+$/.test(w) && randomish(w)) return true
  if (!/[\\/]/.test(w)) {
    if (UUID.test(w) || base64y(w) || (w.match(RUN) ?? []).some((r) => keyRun(r, letters))) return true
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

// maskAll is the three readings a card's text gets, in order: the run reading
// (maskSpaced), the harder cut (maskCut), and then word by word (maskKeys) —
// whatever one of them finds is masked, and what it masked is left alone by
// the next two.
// maskCaps is the key written without its spaces ("AKIAIOSFODNN 7EXAMPLE"),
// after the run readings: a word mixing capitals and digits, or one from a
// vendor's front ("AKIA"), joined with the words after it where the join is
// all capitals and digits — the shape every vendor key keeps — and long
// enough to be one of them. The join only covers the pieces that are the
// key's own alphabet; a word outside it ("the key AKIAIOSFODNN7 EXAM PLES
// here") is where the join stops, and the joined part is what is masked.
const maskCaps = (s) => {
  // a body with no capital in it has no vendor key written without its
  // spaces (every one of their shapes is all capitals and digits)
  if (s.length > 32 * 1024 || !/[A-Z]/.test(s)) return s
  const words = [...s.matchAll(/[\x21-\x7e]+/g)]
  const at = (i) => words[i].index
  const end = (i) => words[i].index + words[i][0].length
  const out = []
  let from = 0
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i][0]
    if (!VENDOR.test(w) && !(/^[A-Z0-9]{4,}$/.test(w) && /[A-Z]/.test(w))) continue
    let j = i
    let body = w
    while (j + 1 < words.length && s.slice(end(j), at(j + 1)).length <= 2 && /^[A-Z0-9]{2,}$/.test(words[j + 1][0]) && /^[A-Z0-9]+$/.test(body)) {
      j += 1
      body += words[j][0]
    }
    if (j === i || body.length < 16 || /[a-z]/.test(body)) continue
    out.push(s.slice(from, at(i)), maskToken(body))
    from = end(j)
    i = j
  }
  return out.join("") + s.slice(from)
}

const maskAll = (s, letters) => maskKeys(maskCut(maskSpaced(maskCaps(s), letters), letters), letters)
// maskKeys walks the words of a piece of text: one word that is itself a key
// goes, and inside a word that is not, only the key-like runs and UUIDs go.
// Punctuation that cannot be part of a key stays where it was, so a card
// reads "（bonus ghp_16C7…8B4a）" rather than losing its brackets. A key cut by
// spaces is not this walk's to find — it sees one word at a time, and four
// pieces under the floors are four words kept; maskSpaced reads the run.
//
// The lead and tail of punctuation are found by walking in from each end, not
// by an anchored regex. `word.slice(lead).match(/[^…]*$/)` backtracked from
// every start position when a word began and ended with an identity character
// and held a long punctuation run between them: a + 200k "!" + a took 117s for
// one match, and a server controls the ledger title it sits in. (A word of
// nothing but punctuation does not show it — the first start position matches
// cleanly — so the test uses that shape)
// maskCut is the harder cut: a key whose front is itself cut, or whose pieces
// are cut in two ("ghp _12 34A …", "sk-a nt-a pi03 -Eya …"). Read from a head
// — a word carrying a vendor prefix, or folding the key's own case down to a
// capital and a digit, or a run of capitals and digits alone (a key written
// without its spaces: "AKIAIOSF ODNN7EXA MPLE") — the run goes on while every
// piece is short and none is prose, and the join is a key or the key's pieces
// keep flipping case between them. The head is where the mask begins.
const conts = (w) => (/[0-9]/.test(w) || /[A-Z]/.test(w)) && !VENDOR.test(w)
function maskCut(s, letters) {
  // a body of many KiB of one-character words costs far more reading than a
  // card ever shows, and a hook's whole budget is 25 seconds: past 32 KiB the
  // pass is skipped, and the other two readings (linear in the text) still run
  if (s.length > 32 * 1024) return s
  const words = [...s.matchAll(/[\x21-\x7e]+/g)]
  if (words.length < 3) return s
  const at = (i) => words[i].index
  const end = (i) => words[i].index + words[i][0].length
  const gap = (i) => s.slice(end(i - 1), at(i))
  // the same line-break join as the run reading, and for the same reason
  // the same gaps as the run reading, and for the same reason
  const front = (w) => VENDOR.test(w) || /^ms-/i.test(w)
  const runGap = (k, i) =>
    s.slice(end(k - 1), at(k)).length <= 2 &&
    (/^[ \t\u00a0\u3000]+$/.test(gap(k)) || /^\r?\n$/.test(gap(k)) || (/^[·•∙‧・]$/.test(gap(k)) && front(words[i][0])))
  const out = []
  let from = 0
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i][0]
    // a key written one character per word starts at a piece of one or two
    // characters inside such a run (five or more one-character words); the
    // join decides whether the pieces are one key
    const tiny = w.length <= 2 && words[i + 4] !== undefined && words.slice(i, i + 5).every((x) => x[0].length <= 2)
    if (!VENDOR.test(w) && !conts(w) && !tiny) continue
    let j = i
    let body = w
    let mixed = false
    for (let k = i + 1; w.length <= 16 && k < words.length && k - i <= 64; k += 1) {
      if (!runGap(k, i)) break
      const x = words[k][0]
      if (x.length > 16) break
      // a piece of one capital and lower-case letters right after the head is
      // a word on its own ("sk-User"), and a word of four or more lower-case
      // letters inside the run is prose ("the team") — unless the head is a
      // run of capitals and digits, where every piece is the key's
      if (/^[A-Z][a-z]+$/.test(x) && k === i + 1 && !/[0-9]/.test(body)) break
      // the same piece-versus-prose split as the run reading: four lower-case
      // letters end the run unless the run starts at a key's front
      if (/^[a-z]{4,}$/.test(x) && body.length >= 4 && !/[0-9]/.test(body) && !/^[A-Z0-9]+$/.test(body) && (x.length > 4 || !(VENDOR.test(w) || /^ms-/i.test(w)))) break
      body += x
      if (body.length < 20 || body.includes(MASKED)) continue
      const whole = body.length >= 16 && (body.match(/[A-Za-z0-9]+/g) ?? []).some((r) => keyRun(r, letters)) // every keyRun arm floors at 16
      const flips = body.match(/[a-z][A-Z]/g) ?? []
      // (only asked once both is on the table; most of a run's words carry one case)
      let pairMix = -1
      let shortMix = false
      if (whole || flips.length >= 2) {
        const run = words.slice(i, k + 1)
        pairMix = run.filter((y) => /[a-z]/.test(y[0]) && /[A-Z]/.test(y[0])).length
        shortMix = pairMix > 0 && run.some((y) => y[0].length <= 12 && /[a-z]/.test(y[0]) && /[A-Z]/.test(y[0]))
      }
      if (whole || flips.length >= 2 || (pairMix >= 2 && shortMix)) {
        j = k
        mixed = whole || flips.length >= 2
      }
    }
    if (j === i || !mixed) continue
    const run = words.slice(i, j + 1)
    // a run of words that are each prose-shaped ("Rebecca Deborah Bradford")
    // is two runs of words, not a key
    if (run.every((x) => /^[a-z]{3,}$/i.test(x[0]))) continue
    out.push(s.slice(from, at(i)), maskToken(run.map((x) => x[0]).join("")))
    from = end(j)
    i = j
  }
  return out.join("") + s.slice(from)
}

const maskKeys = (s, letters = true) => {
  return s.replace(/[^\s]+/g, (word) => {
    // The word in the other spellings a key is printed in — full-width
    // characters, mostly. Nothing below can read it: there is no ASCII body
    // and no ASCII path prefix, so every pass saw ordinary text. Measured, a
    // host error carrying "no key ｍｓ－… for provider" printed the whole
    // token, and NFKC put it back together. The folded copy is what the shape
    // tests judge, and the word as written is what is masked.
    const folded = word.normalize("NFKC")
    if (folded !== word) {
      const plain = folded.toLowerCase()
      if (isKeyWord(folded, letters) || (plain.match(RUN) ?? []).some((r) => keyRun(r, letters)) || UUID.test(folded)) return maskToken(word)
    }
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
    const masked = isKeyWord(word, letters)
      ? maskToken(body)
      : body.replace(RUN, (r) => (keyRun(r, letters) ? maskToken(r) : r)).replace(UUID_ANY, (m) => maskToken(m))
    return lead + masked + tail
  })
}

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
  let s = String(value ?? "").replace(GLUE, "")
  if (typeof token === "string" && token) s = s.split(token).join(maskToken(token))
  s = maskEchoes(s, token).replace(tokenShaped, maskShaped)
  return text(maskAll(s, true), max)
}
// The account's own name is text the user picked, not a server's message: a
// long camelCase name ("MisonLiangWithALongName") is key-shaped to maskKeys and
// was shown as "Miso…Name" on the card. Names still go through the passes that
// matter — the key this process holds, the ms- shape, other vendors' key
// shapes, a bare digest — only the "16+ characters with a case mix" arm is off.
const nameText = (value, token, max = 200) => {
  let s = String(value ?? "").replace(GLUE, "")
  if (typeof token === "string" && token) s = s.split(token).join(maskToken(token))
  // with no token in hand the mask's shape pass is the only guard there is,
  // so the case-mix arm has to stay on
  return text(maskAll(maskEchoes(s, token).replace(tokenShaped, maskShaped), !token), max)
}

// hostText is cardText for the two exits where there is no token to split on:
// getAuth itself failed, so the plugin never got as far as reading the key.
// The host's message can still carry one — magpie's own wording for a missing
// key is "no key <key> for provider" — and these two lines would print it
// whole. With no key in hand the shape is all there is, which cardText does.
const hostText = (value) => nameText(value, "")

// unusableName is a nickname that must not be written back: empty, the token
// itself or a piece of it (the server would be handed it twice), a key the
// host's accountNames lookup would read as inherited rather than as a name, or
// a string the card would mask — because that string is a key, and writing it
// back puts the plaintext in plugin-auth.json's accountId, where the card's
// mask does not reach. Measured: a server that answered NickName with
// ghp_16C7e42F292c6912E7710c838347Ae178B4a had it stored verbatim, and a
// sk-ant body cut to 40 characters with it. The card judges word by word, so
// the test does too; but a camelCase name ("MisonLiangWithALongName") is
// key-shaped to the card as well, and it is not a key — a generated key nearly
// always carries a digit or a base64 symbol, and a name nearly never does, so
// nameIsKey asks for one of those beside the card's verdict.
// The piece is looked for before the cut to 40: a token longer than 40, cut
// to 40, is no longer equal to the token, and its front would be written to
// plugin-auth.json as the account's name. A substring of 12+ characters is the
// piece: a name shorter than that is not an echo worth refusing — a person's
// name can share nine or ten characters with any key ("cafebabe2026"), and the
// card still masks whatever a shorter piece is in front of.
const insideEcho = (name, token) => {
  const n = fold(name)
  const t = fold(token)
  return n.length >= MIN_ECHO + 2 && t.includes(n)
}
// tightName is a name with the characters an echo may insert taken out. A
// server that echoed the token into a nickname can space it out just as a
// message can, and "ms-01234567 89abcdef…" is no longer a substring of the
// token — but the tight form is.
const tightName = (name) => name.replace(/[\s\p{Cc}\p{Cf}]+/gu, "")
// flatName keeps only the characters a token is made of. Any other character
// in a name — a space, a comma, a bracket — is something an echo inserted, and
// the token's own characters survive in order.
const flatName = (name) => name.replace(/[^A-Za-z0-9]/g, "")
// insideToken: the name is in the token, or its tight form is, or its flat
// form is a run of the token's flat form. Either way every character of it is
// already in plugin-auth.json, so writing it back leaks nothing new — which is
// what makes nameIsKey skip it. A token that holds the name is the proof; it
// does not matter how long the name is.
const insideToken = (name, token) => {
  if (typeof token !== "string" || token === "") return false
  if (token.includes(name) || token.includes(tightName(name))) return true
  const flat = flatName(name)
  const t = fold(token)
  if (flat.length >= 20 && t.includes(flat)) return true
  // the same answer for the case and compatibility folds: an upper-cased or
  // full-width name is the same characters the sign-in already holds
  const n = fold(name)
  return n.length >= 20 && t.includes(n)
}
// echoesToken: the name is the token being handed back — the token itself, or
// a piece long enough to be an echo. The threshold is the mask's own (MIN_ECHO,
// 10) rather than the 20 it used to be: a nickname of 10–19 characters is not
// a name a person picks, and the card's `user` line printed it whole while the
// mask said nothing about pieces that short. A name of a few characters that
// happens to sit inside a token ("ms", "ab") is still a name.
const echoesToken = (name, token) => {
  if (typeof token !== "string" || !token) return false
  if (name.includes(token)) return true
  const n = fold(name)
  const t = fold(token)
  if (!n || !t) return false
  if (n.includes(t)) return true
  return insideToken(name, token) && tightName(name).length >= MIN_ECHO
}
// runsThrough: the name's folded characters carry MIN_ECHO of the token's, in
// order, even when the echo spaced them out with characters the token does not
// hold. maskEchoes stops at a filler ("ms-0123abcd4567x 89ef…" is pieces each
// under MIN_ECHO), but the pieces still spell the key once the filler is
// dropped, and a nickname is written to plugin-auth.json as a second copy of
// it. A name that shares a dozen characters of a 32-character key in order is
// not a name a person picks; a short name ("ms", "Mison") cannot reach the
// floor.
//
// The run is measured as the longest run the name shares with the key, not by
// one greedy pass: a stray character at the name's start or end used to take
// the key's first or last position on that pass and hide the body behind it
// ("f 01234567x 89abcde0x …" either way round). Ordinary nicknames share 6 or
// 7 characters in a row with a realistic key; a key body spelled out shares
// 30+.
//
// A name can reach a run by luck too: a nickname that is a string of digits
// is a run of any key holding them in order ("1234567890" is nine characters
// of most of them). A run is taken for the key when it is most of the name (a
// dozen characters and half of it, or twenty of it however short the name is),
// or when the name's whole folded self is a run of the key that a person's
// name could not be — anything but digits, spaces and hyphens ("bbbb 2222"
// against a key with those characters in a row).
const MANY = MIN_ECHO + 2
const BACK_MANY = MANY + MIN_ECHO
// The DP below is n × t cells. Neither side is bounded by this plugin: the
// name comes from the server's answer (a 256 KiB body is allowed) and the key
// from the host's sign-in. Measured before this cap existed: a 128 KiB name
// against a 32 Ki-character key spent 19 s of CPU inside a hook whose whole
// budget is 25 s, and an ordinary 128 KiB nickname against a realistic key
// spent ~1.8 s. No answer needs that: the write-back is cut to 40 characters,
// so a longer name is not a name a person picks, and refusing it is the safe
// direction. The cell cap keeps the work under ~60 ms at the measured rate and
// refuses the name instead of spending the budget on it.
const NAME_LCS_MAX = 512
const LCS_CELLS = 2_000_000
function longestRun(n, t) {
  let prev = new Int32Array(t.length + 1)
  let cur = new Int32Array(t.length + 1)
  for (let i = 1; i <= n.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = n[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const swap = prev
    prev = cur
    cur = swap
    cur.fill(0)
  }
  return prev[t.length]
}
const runsThrough = (name, token) => {
  const n = fold(name)
  const t = fold(token)
  if (n.length < MIN_ECHO || t.length < MIN_ECHO) return false
  if (insideToken(name, token) && n.length < 20) return false
  // too long a name to be a name, or too much DP work to spend a hook's budget
  // on: treat it as unusable, which is what the write-back does with any name
  // it cannot vouch for. The card still shows its usual mask for the shape.
  if (n.length > NAME_LCS_MAX || t.length > NAME_LCS_MAX || n.length * t.length > LCS_CELLS) return true
  const run = longestRun(n, t)
  if (run >= MANY && (run * 2 >= n.length || run >= BACK_MANY)) return true
  // a nickname that is almost nothing but the key's characters, in the key's
  // order, is the key written with something between its characters. A string
  // of digits is not: those are a run of any key that holds them, and a name
  // made of them says nothing about which.
  return run >= MIN_ECHO && run * 3 >= n.length * 2 && !/^[\d\s-]+$/.test(tightName(name))
}
const nameIsKey = (name, token) =>
  !insideToken(name, token) &&
  name.split(/\s+/).some(
    (w) =>
      isKeyWord(w) &&
      ((w.match(/\d/g) ?? []).length >= 6 || /[+/=]/.test(w) || /^[0-9a-f]{16,}$/i.test(w)),
  )
const unusableName = (name, token) =>
  !name ||
  name === token ||
  echoesToken(name, token) ||
  runsThrough(name, token) ||
  nameIsKey(name, token) ||
  nameShape(name) ||
  ["__proto__", "constructor", "prototype"].includes(name)
// nameShape: the name is a credential of a shape this sign-in does not hold —
// another account's key, or this one's written in another spelling. The tests
// above look for the token in hand; a server echoing a *different* key
// ("ｍｓ－…" in full width, a bare 32-character body) matched none of them and
// was written back as accountId. Only credential shapes count: an ordinary
// name, camelCase or carrying a year (WangXiaoming2026), is a name.
//
// The ms- arm is the shape the card's own mask uses (tokenShaped), not a
// narrower list of characters: a nickname written as ms-foreign_key… carries an
// underscore, the card masks it, and the narrow arm passed it through to be
// stored as the account's name — the one field the card's mask does not reach.
// Every character a header can carry is a key's character, so the question is
// the shape, not the spelling.
const nameShape = (name) => {
  // the same invisible-character join the card runs before its shape test:
  // "ms-foreign​_key…" is the same key to the card, and a nameShape that
  // read it as "ms-foreign_key…" (with a zero-width space in it) refused it by
  // luck rather than by rule. The space fold after it is for a name written
  // with spaces between the pieces — a shape that survived the key comparison
  // in another spelling.
  const t = name.replace(GLUE, "").normalize("NFKC").toLowerCase().replace(/\s+/g, "")
  // the ms- arm asks the card's own question of the body (keyBody): a word
  // after the front is a name ("ms-interviewing" is one, and refusing it left
  // the account with no name at all). A name that is a key of another vendor —
  // sk-ant-api03-Eyai1pkJrF_Kbwt has three digits and satisfied none of
  // nameIsKey's extra requirements — is the shape the vendor's own prefix
  // marks, and a vendor key's body is what the shape tests already accept.
  return /^ms-/.test(t)
    ? keyBody.test(t)
    : VENDOR.test(t) ||
        /^[0-9a-f]{16,}$/.test(t) ||
        UUID.test(t)
}

// withStreak puts the streak on an answer only when it was read to the end.
// An explicit `streak: undefined` is not "said nothing": the host reads the
// field with num(), and undefined becomes 0 — a card showing "0 天" for a run
// the plugin could not see the end of. The key is left out instead, and the
// answer is told about an expiry the walk met on the way (`marks`), which the
// walk records because a claim that already landed still has to reach the
// host as "the token was refused".
const withStreak = (answer, streak, marks) =>
  ({
    ...answer,
    ...(streak === undefined ? {} : { streak }),
    ...(marks?.expired ? { signIn: "expired" } : {}),
  })
// WRITE_WAIT_MS caps how long a hook waits for the host's write-back. The
// lock it takes can block for ~20s (host.js's lockAuth, when another process
// holds plugin-auth.json), and magpie runs every provider's check-ins under
// one two-minute budget — one contended account must not eat a third of it
// for a field the card can live without.
const WRITE_WAIT_MS = 3000

// BOUNDED is what bounded answers when the timer won: the promise's own value
// could be undefined, and "the host never answered" must not read as "the host
// said nothing".
const BOUNDED = Symbol("bounded")
const bounded = (p, ms) => {
  let timer
  const alarm = new Promise((resolve) => {
    timer = setTimeout(() => resolve(BOUNDED), Math.max(0, ms))
    if (timer && typeof timer.unref === "function") timer.unref()
  })
  return Promise.race([p, alarm]).finally(() => clearTimeout(timer))
}

// waitFor resolves when `p` settles or after `ms`, whichever comes first; the
// loser is left running. The timer is unref'd so it never holds a process open.
const waitFor = (p, ms) => {
  let timer
  const alarm = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === "function") timer.unref()
  })
  return Promise.race([p, alarm]).finally(() => clearTimeout(timer))
}

// rememberAccountFields tells magpie what the plugin learned about this
// sign-in: the account's own name (so the card reads "Mison" instead of
// "API key …a1b2"), and — for an account on the international site — the site
// itself, so a restarted host does not have to hand the token to the domestic
// site for a 401 first. A site the probe has since found to be wrong is
// removed. The sign-in is written as it already is — the same key, no second
// copy of the token — with those fields beside it; what is already there is
// left alone. Everything goes in one write: auth.set takes plugin-auth.json's
// lock, and two writes would take it twice.
async function rememberAccountFields(client, token, learned, auth, dir, budgetEnd = Infinity, getAuth) {
  // "can write" is a function, not a truthy value: `{ auth: { set: 1 } }` is a
  // client that cannot write, and `!client?.auth?.set` let it through to call
  // a number — the TypeError is caught below, but it logs "account facts not
  // written back" on every check-in, a failure report for a client that never
  // had a chance to succeed.
  if (typeof client?.auth?.set !== "function") return
  // auth.set replaces the whole sign-in, and the copy the hook read when it
  // started can be a minute old by the time the requests are done. Written on
  // top of that copy, an edit made meanwhile is undone: a new key pasted in
  // while the hook ran was overwritten with the old one, and a field added
  // was dropped. The host only refuses the write when the account is gone
  // entirely (host.js's `had && !(key in all)`), so the read is repeated here
  // and the write lands on the freshest copy. A sign-in that no longer holds
  // this key is not this key's account any more: the facts learned here are
  // about a token it no longer carries, so nothing is written.
  let base = auth
  if (typeof getAuth === "function") {
    try {
      // The read is host I/O like the write: it takes the same store lock and
      // can block for ~20s. Capped by the same budget, and an unreadable store
      // means no write at all — falling back to the copy from the start of the
      // hook is exactly the stale base that overwrote a key pasted meanwhile.
      const cap = Math.max(0, Math.min(WRITE_WAIT_MS, budgetEnd - Date.now()))
      // Nothing left of the hook's budget: the read and the write both take
      // the host's store lock, and starting either at zero would spend the
      // time the answer was supposed to fit in. The fields are best-effort.
      if (cap <= 0) return
      const now = await waitFor(Promise.resolve().then(getAuth), cap)
      // what the host hands over is not always a plain object (a callable
      // carrying the fields is a sign-in too); the key is what says it is
      // still this account's entry, and the spread below skips a non-object
      if (now === undefined || tokenOf(now) !== token) return
      base = now
    } catch {
      return
    }
  }
  const name = learned?.name ?? ""
  // Only the international site is worth keeping: a probe tries the domestic
  // one first, so recording it saves no request and costs a locked write.
  const site = learned?.profile?.site === INTL.site ? INTL.site : ""
  const wantSite = !!site && base?.site !== site
  // A sign-in that names a site but the probe found the account on the
  // domestic one is stale — the key was replaced under it. Left alone, every
  // restart would pay a 401 against the site it names, so it is dropped. The
  // probe has to have actually found the domestic site for this to mean
  // anything: after a failed read, `learned.profile` is null, the site was
  // simply not reached, and clearing it would be an own-goal on a blip.
  const wantClear =
    !site &&
    learned?.probeDone &&
    typeof base?.site === "string" &&
    base.site !== ""
  const at = named.get(token)
  const cooling = at !== undefined && Date.now() - at < NAME_AGAIN_MS
  // an account the user has named keeps that name: writing the nickname over
  // it would re-key their alias to a label the account no longer has. A
  // providers.json that can't be read says the same thing — don't write over
  // a state we can't see.
  const wantName =
    !!name && base?.accountId !== name && !cooling && aliasOf(ID, dir, labelOf(base, token)) === ""
  if (!wantName && !wantSite && !wantClear) return
  if (wantName) {
    named.delete(token)
    named.set(token, Date.now())
    while (named.size > NAMES_MAX) named.delete(named.keys().next().value)
  }
  try {
    // auth.set replaces the whole sign-in, so the freshest copy the host
    // handed us is the base: a field we do not know about is kept, not dropped
    const body = {
      ...(base && typeof base === "object" ? base : {}),
      type: "api",
      key: token,
      ...(wantName ? { accountId: name } : {}),
      ...(wantSite ? { site } : {}),
    }
    if (wantClear) delete body.site
    // auth.set takes plugin-auth.json's lock and, when another process holds
    // it, can block for up to ~20s (host.js's lockAuth). The answer is worth
    // more than this best-effort write, and a check-in round serves every
    // provider under one two-minute budget, so the wait is capped: a write
    // still waiting past the cap finishes behind the hook instead of holding
    // it. A rejection that comes after the cap is handled where it lands —
    // reported and retried on the next ask — so a locked store does not cost
    // an hour of the nickname's cooldown with no sign that anything failed.
    const writing = Promise.resolve(client.auth.set({ path: { id: ID }, body }))
    // the handler is attached before the race so a rejection that lands after
    // the cap still finds one; both sides of the cap run the same report
    // one report per write: the failure reaches both the attached handler and
    // the race, and a doubled line would read as two failed writes
    let reported = false
    const failed = (e) => {
      if (reported) return
      reported = true
      onWriteFailed(e, client, token, wantName)
    }
    // The cap is the hook's own budget end as well as WRITE_WAIT_MS: a hook
    // that spent its reads right up to the budget must not spend three more
    // seconds waiting for a lock, or the whole hook outlives the number the
    // README promises. A write still pending then finishes behind the hook.
    const cap = Math.max(0, Math.min(WRITE_WAIT_MS, budgetEnd - Date.now()))
    writing.catch(failed)
    try {
      await waitFor(writing, cap)
    } catch (e) {
      failed(e)
    }
  } catch (e) {
    // a synchronous throw from the host's own set(): same report, same retry
    onWriteFailed(e, client, token, wantName)
  }
}

// onWriteFailed is the one report for every failed write, whether it failed at
// once or after the wait was capped: the name goes back so the next ask tries
// again, and the reason is logged without the token in it. Best-effort — a
// host whose log is synchronous returns undefined here, and that must not
// throw out of the caller.
function onWriteFailed(e, client, token, wantName) {
  if (wantName) named.delete(token)
  // the message can carry whatever the host put in it; scrub the token out of
  // it before it reaches magpie's log
  const why = cardText(whyOf(e), token)
  try {
    const r = client?.app?.log?.({ body: { level: "warn", service: ID, message: `account facts not written back: ${why}` } })
    if (r && typeof r.catch === "function") r.catch(() => {})
  } catch {
    // a host whose log throws synchronously must not turn a successful
    // check-in into a failed one, nor a usage read into a rejection
  }
}

const signedOut = (e) => Boolean(e?.signIn === "expired" || e?.expired)

// whyOf is the message of a rejection. A rejected non-Error — a bare string, an
// object without a message, a host's own rejection value — would reach String()
// as "[object Object]", which tells the user nothing and reads like a bug in the
// plugin. The empty string lets the caller say something of its own instead.
const whyOf = (e) => {
  const m = typeof e?.message === "string" && e.message ? e.message : typeof e === "string" ? e : ""
  // a body nested deep enough to overflow the identity pass is a shape this
  // plugin does not read, and the card must not carry the runtime's English
  // sentence for it
  return m.includes("Maximum call stack size exceeded") ? "账单格式不认识：嵌套过深" : m
}

// EXPIRED is what a 401 says, wherever it is met: the ledger read before the
// touch, the touch itself, or either of usage's two reads. Three wordings
// used to exist for one condition ("the token is invalid or not from the CN
// site", the same plus an HTTP 401 suffix, and a bare "HTTP 401" from the
// balance/ledger path), and the
// README's troubleshooting row promises the user will see the status code in
// it — which only two of the three carried. `where` is the profile's CN site /
// INT site, and stays in the one wording so the card says which site refused
// the token.
const expired = (where) => `令牌失效或不属于${where}（HTTP 401）`

// deadToken is what every 401 becomes: the token is revoked, and magpie only
// signs the account out when the hook says so. Both call sites guard
// `status === 401` before throwing this, so there is no other status to name.
const deadToken = (where) => Object.assign(new Error(expired(where)), { signIn: "expired" })

// RISK is what every 403 says — ModelScope's risk control, not a bad token:
// the account may be perfectly fine and only the request was refused. The
// check-in's touch adds the retry it can promise; usage's two reads do not
// (the host polls on its own schedule, nothing here is retried).
const RISK = "被魔搭风控拒绝（HTTP 403）"

// gate turns a reply that is not an answer into the error it is, so the four
// reads that talk to ModelScope (the ledger, the touch, usage's balance and
// usage's ledger) do not each carry their own copy of the four checks. `what`
// names the read in the message ("ledger query failed" / "balance query
// failed" / "login endpoint failed"); `risk` is the 403 wording, which the
// touch alone extends with the retry it can promise. `profile` is there for
// the one site-specific word a 401 carries (the CN site / the INT site).
//
// The parse check and the status check are separate on purpose: a body that
// does not parse is not JSON; a body that parses and carries a 429/500 is the
// server saying why in its own words ("too many requests" / "system busy").
// Merged, a JSON-carrying 429 was reported as "the response is not JSON" and
// sent the user to check their proxy.
const gate = (profile, res, body, parsed, token, what, risk = RISK) => {
  // A 401 is the token being refused only when it is ModelScope's own JSON.
  // A proxy's HTML 401 ("proxy authentication required") is the path, not the
  // sign-in, and signing the account out over it costs the user their login:
  // it falls through to the ordinary error, and the host retries in half an
  // hour.
  if (res.status === 401 && parsed) throw deadToken(profile.where)
  if (res.status === 403) throw new Error(risk)
  if (!parsed) throw new Error(`${what}：响应不是 JSON（HTTP ${res.status}）`)
  if (res.status !== 200 || !okOf(body)) throw new Error(`${what}：${saidOf(body, token) || `HTTP ${res.status}`}`)
}

// todayEarn are today's credit grants, by the day ModelScope records them.
// The day is read at each call, on purpose: a check-in that crosses midnight
// between its reads reports what its touch granted on the new day, which is
// true, where diffing both reads against the old day would answer inactive.
async function todayEarn(token, deadline) {
  const { profile, res, body, parsed } = await siteRead(token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
  gate(profile, res, body, parsed, token, "账单查询失败")
  const day = todayCN()
  const first = recordsOf(body)
  const { all, pages, complete, last, seenPages, seenRows, total } = await dayRows(profile, token, day, first, deadline, body)
  return {
    profile,
    day,
    all,
    pages,
    complete,
    last,
    seenPages,
    seenRows,
    // the number the walk finished on, not the first page's: a total that grew
    // on a later page (or was printed only there) is the one that says whether
    // the streak's next page is worth reading
    total,
    rows: all.filter((r) => r?.type === "EARN" && onDay(r?.gmt_created, day)),
  }
}

// DAY_PAGES bounds the extra ledger reads a page full of today's rows costs.
// Rows come newest first, so today's rows sit at the top and spill onto the
// next page only when today alone holds more rows than a page. A page whose
// oldest row is already before `day` is where they end.
const DAY_PAGES = 4

// dayRows returns the rows the caller already read plus the pages that can
// still hold `day`'s rows, and whether the walk proved it saw the end of
// them. A page is followed when it is full and holds nothing older than
// today, and — the case a server contradicts itself in — when it has room to
// spare but its `total` still promises rows this walk has not seen: a short
// page that is not the last one used to end the walk, and a day whose
// remaining rows sat behind it was read as a complete ledger.
//
// `complete` says the end was proved: a page older than `day`, a page with
// room to spare whose `total` the rows in hand account for, or an empty page
// with no `total`. An extra page that fails (a transport error, a 5xx, a body
// that is not JSON), a budget already gone, or a `total` still ahead of the
// rows stops the walk with `complete` false — the numbers are a floor, and
// the check-in must not read "no grant today" into a ledger it could not
// finish. `pages` is the highest page read, so the streak walk resumes after
// it instead of asking for a page twice (the second read counted its rows
// again and made the ledger look finished one page early).
// stable is a value's identity with its object keys sorted: JSON.stringify
// keeps insertion order, so the same rows with their fields in another order
// read as a different page and were summed twice. `deep` bounds the recursion:
// a body nested thousands deep overflowed the stack and answered the card with
// the runtime's English sentence; past the bound a value is identified by its
// depth alone, which keeps the pass cheap and total (a server that sends such
// a row has no identity to lose).
const STABLE_DEPTH = 64
const stable = (v, deep = 0) =>
  deep > STABLE_DEPTH
    ? `"<depth ${deep}>"`
    : Array.isArray(v)
      ? `[${v.map((x) => stable(x, deep + 1)).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stable(v[k], deep + 1)}`)
            .join(",")}}`
        : JSON.stringify(v)
const rowKey = (r) => stable(r)

async function dayRows(profile, token, day, first, deadline, body) {
  const all = [...first]
  let rows = first
  let pages = 1
  // A page seen before is the page number being ignored, and a row seen before
  // is the server shifting its window between reads: the same grant then sits
  // at the bottom of one page and the top of the next, and summing both
  // reports it twice.
  const seenPages = new Set([stable(first)])
  const seenRows = new Set(first.map(rowKey))
  let { total, contradicted } = totalOf(body, first)
  let complete = false
  for (;;) {
    const older = rows.some((r) => {
      const s = String(r?.gmt_created ?? "").slice(0, 10)
      return isDay(s) && s < day
    })
    if (older) {
      complete = true
      break
    }
    // The number the page printed beside its rows is the whole ledger's count:
    // when the rows in hand already account for it, there is no next page to
    // read, whether this page was full or not.
    if (!contradicted && total !== null && all.length >= total) {
      complete = true
      break
    }
    // A full page with no `total` that the walk stopped reading (the page cap,
    // the budget) is a truncation, not an end: the ledger may continue past
    // it. It used to be called complete here, and a day with 300 rows answered
    // 250 with no "未读完" on the card and no failed on the check-in. Proving
    // the end needs a page older than the day, a page with room to spare, or a
    // total the rows account for.
    if (total === null && rows.length >= PAGE_SIZE && (pages > DAY_PAGES || deadline <= Date.now())) break
    // a page with room to spare is the end — unless `total` still promises
    // rows, in which case the server is contradicting itself and the rest may
    // be on the next page anyway (bounded by DAY_PAGES below)
    // a `total` below the rows beside it is the ledger contradicting itself:
    // it proves neither "this is the end" nor "there is more", so the page is
    // walked on like a short page with no total at all
    if (rows.length < PAGE_SIZE && !contradicted && (total === null || all.length >= total)) {
      complete = true
      break
    }
    if (pages > DAY_PAGES || deadline <= Date.now()) break
    let got
    try {
      got = await json(profile.site, token, `${TXNS}?page=${pages + 1}&page_size=${PAGE_SIZE}`, deadline)
    } catch {
      break
    }
    const { res } = got
    // the same rule gate applies to the first page: only a 200 carrying the
    // success envelope is an answer. A 202 used to be read as the end of the
    // ledger, which confirmed a day that was never finished. A 401 is the same
    // token being refused, and swallowing it here kept a confirmed expiry off
    // the card and out of the check-in's answer: it goes through the same
    // dead-token throw the first page's gate uses.
    if (got.parsed && res.status === 401) throw deadToken(profile.where)
    if (!got.parsed || res.status !== 200 || !okOf(got.body)) break
    // a page whose shape this walk cannot read — no data, records not a list —
    // is a page it failed to read, the same as a 500 on it: the walk stops with
    // the rows it has and `complete` false, so the card says the number is low
    // and the check-in retries. Letting recordsOf throw here failed the whole
    // hook with its sentence and threw away the first page's rows.
    let raw
    let pageTotal
    try {
      raw = recordsOf(got.body)
      pages += 1
      // the page's own `total` is checked the way the first page's was: a page
      // that prints fewer rows than its number promises is contradicting itself
      // and cannot end the walk on that number.
      pageTotal = totalOf(got.body, raw)
    } catch {
      break
    }
    if (pageTotal.contradicted) break
    // the page's own `total` is the ledger's count as the server sees it now;
    // a ledger that grew between the reads printed 51 on the first page and 52
    // on the second, and the walk ended on the first page's number with one
    // row still unread. The latest number wins, and a total that has grown
    // keeps the walk going. Only a number the server *printed* can win: a
    // short page that omits `total` synthesises one from the rows in hand,
    // and overwriting the known total with it ended a walk before the page
    // that held the rest of the day's rows (measured: 52 promised, 5 seen,
    // page 3 never read).
    //
    // A printed total below the rows already read, or below one an earlier page
    // printed, is the ledger contradicting itself — 50 read, then a page
    // claiming 52 while the rows in hand pass it — and adopting it would end
    // the walk on the number it just refuted. The walk stops here, incomplete.
    if (pageTotal.said !== null) {
      if (pageTotal.said < all.length || (total !== null && pageTotal.said < total)) break
      total = pageTotal.said
    }
    // an empty page is the end of the ledger, or — with a `total` still
    // counting rows — the server saying two things at once; no page after it
    // is worth reading. A page repeating one already read is the page number
    // being ignored, and summing it again would inflate the day's numbers.
    const stamp = stable(raw)
    if (!raw.length || seenPages.has(stamp)) {
      complete = !raw.length && total === null ? true : total !== null && all.length >= total
      break
    }
    seenPages.add(stamp)
    const fresh = raw.filter((r) => !seenRows.has(rowKey(r)))
    for (const r of fresh) seenRows.add(rowKey(r))
    if (!fresh.length) {
      // every row on this page was already counted: the window moved, not the
      // ledger
      complete = total !== null && all.length >= total
      break
    }
    rows = fresh
    all.push(...fresh)
  }
  // `last` is the page the walk stopped on, for a following page-reader to
  // recognise as already read. It is handed over only when the walk stopped
  // *without* proving the end (a failed page, a spent budget): there the next
  // page is the same one again, and reading it twice is what inflated the day.
  // A walk that proved the end has nothing after it, and an empty page is the
  // end whatever `total` said — seeding either would make the ledger's next
  // ask look like a repeat and silence a streak that was read to the last day.
  return {
    all,
    pages,
    complete,
    total,
    last: complete || !rows.length ? null : rows,
    seenPages,
    seenRows,
  }
}

// totalOf is how many rows the ledger holds altogether, from the `total` the
// page carries beside its `records`; null when that cannot be known. It is
// what tells a full page from a complete one: the page size caps at 50 (the
// server answers page_size=200 with 50), so a page that comes back with 50
// rows may be the whole ledger or the first sliver of it. A page with room to
// spare is complete by definition, so a missing `total` is answered by the
// rows in hand there; a full page without one is unknown, and the streak walk
// leaves its answer unsaid rather than treat the page as the whole ledger.
//
// `said` is the distinction the two callers need: the number the server
// printed, or null. A short page that prints no `total` synthesises one from
// the rows in hand — correct to read as "that is the whole ledger" for the page
// it was computed from, and wrong to *overwrite* a number an earlier page
// printed. Measured: a ledger whose first page promised 52 rows, whose second
// carried 5 and no total, had the known 52 replaced by the 5 it could see, the
// walk stopped at 51 rows, and the 300 credits on page 3 were never read.
const totalOf = (body, rows) => {
  const n = dataObjectOf(body, "账单格式不认识：没有 data").total
  // a total below the rows it is printed beside is the ledger contradicting
  // itself; neither number can be trusted to say whether the page is whole.
  // That is not the same as a missing total, which the caller reads as "the
  // rows in hand are the ledger": a short page of a contradicted ledger must
  // not be called complete on the strength of the number it just refuted.
  //
  // A total of another type ("60", 5.5) is the same contradiction, not a
  // missing one: the server printed a number it did not stand behind, and
  // reading the short page beside it as "that is the whole ledger" ends the
  // walk before the pages that hold the rest of today's rows.
  if (n !== undefined && n !== null && !Number.isInteger(n)) return { total: null, said: null, contradicted: true }
  if (Number.isInteger(n)) return n >= rows.length ? { total: n, said: n, contradicted: false } : { total: null, said: null, contradicted: true }
  return { total: rows.length < PAGE_SIZE ? rows.length : null, said: null, contradicted: false }
}

// prevDay is the Beijing day before `day`. The rows carry date labels with no
// zone attached, so subtracting on the UTC date is right: the label is a
// calendar day, not an instant.
// isDay is a stamp's first ten characters when they name a day that exists.
// The shape alone let "2026-00-00" through: it sorts before every real day, so
// it read as an old row and ended a walk on the spot.
const isDay = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const prevDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// STREAK_PAGES caps how far back the streak walk may read. One page reaches
// back a fortnight or so on a live account (3–7 rows a day); a run longer
// than that is followed onto the next page, because on the account this was
// written for the whole ledger held 16 days of daily grants on page 1 and one
// row on page 2 — without the second page the run was silently unknown. Eight
// pages is ~100 days of rows: past that the walk stops and the streak is left
// unsaid, rather than spend a check-in's budget paging through a year.
const STREAK_PAGES = 8

// daysWithGrant is the set of Beijing days a list of ledger rows grants a
// daily rule on, in the "YYYY-MM-DD" shape the rows' stamps start with. A
// stamp that is not a date is skipped: it does not say which day it grants,
// so it may not stand for one. (The date shape that matters for the walk
// itself is checked where stamps are compared as "older than" — see dayRows
// and streakOf: an empty stamp sorted before every real day and ended a run.)
const daysWithGrant = (rows, into = new Set()) => {
  for (const r of rows) {
    const stamp = typeof r?.gmt_created === "string" ? r.gmt_created.slice(0, 10) : ""
    if (isDay(stamp) && r?.type === "EARN" && DAILY_RULES.includes(r?.rule_key)) into.add(stamp)
  }
  return into
}

// streakOf is how many consecutive Beijing days up to `day` carried a daily
// grant — the run magpie prints as "N-day streak" beside a check-in. The
// first page comes from the check-in's own ledger read; when the run is still
// going at the oldest row of a page whose `total` says there is more, the
// next page is read (readPage) and the walk carries on. The answer is
// undefined when today's grant is not in the rows, and when the walk runs out
// of pages first: magpie prints any number it is given, so a run it could not
// see the end of is not told at all rather than told short.
async function streakOf(records, day, total, readPage, deadline) {
  const days = daysWithGrant(records)
  if (!days.has(day)) return undefined
  let held = records.length
  let n = 1
  let d = day
  for (;;) {
    const prev = prevDay(d)
    if (days.has(prev)) {
      n++
      d = prev
      continue
    }
    // Nothing grants on `prev`. That is a real break when a row older than it
    // has been read — the ledger goes on past the gap and still says nothing
    // that day — or when the rows read are the whole ledger. `total` is null
    // when a full page did not say how many rows the ledger holds, or said a
    // number the rows contradict; the next page is the only way to learn
    // whether that page was the whole ledger, so it is read when there is one.
    // The date part is compared only when it is a date: an empty or malformed
    // stamp sorted before every real day and ended the run on the spot.
    const older = records.some((r) => {
      const s = typeof r?.gmt_created === "string" ? r.gmt_created.slice(0, 10) : ""
      return isDay(s) && s < prev
    })
    if (older) return n
    if (total !== null && held >= total) return n
    if (!readPage || deadline <= Date.now()) return undefined
    const more = await readPage()
    if (more === null) return undefined
    // An empty page settles it: with a known `total` still counting rows it is
    // the ledger contradicting itself, and nothing after this can be trusted
    // to be the end of the run; with no `total`, it is the end of the ledger.
    if (!more.length) return total === null ? n : undefined
    daysWithGrant(more, days)
    records = more
    held += more.length
  }
}

// ledgerReader hands streakOf one page at a time, past the pages the check-in
// already read. `from` is the highest page that read reached: asking for page
// 2 again would append its rows a second time, and the doubled count made the
// ledger look finished one page early. It gives up — null, which leaves the
// streak unsaid — when STREAK_PAGES is spent in all, when a page cannot be
// read (a 403, a budget already gone), or when the ledger answers with a page
// that is not a list. A page error must not fail the check-in: the claim has
// already happened, and the answer it deserves is the one already computed,
// not a failure the host retries half an hour later.
const ledgerReader = (profile, token, deadline, from = 1, first = null, seenPages = null, seenRows = null, marks = null) => {
  let page = from
  let left = Math.max(0, STREAK_PAGES - from)
  // every page and row the day walk read, not just the page it stopped on: a
  // server that cycles through its pages repeated one the walk had already
  // summed, and counting it again filled the ledger's `total` and let the
  // streak claim an end it never saw.
  const seen = new Set(seenPages ? [...seenPages] : [])
  if (first !== null) seen.add(stable(first))
  const counted = new Set(seenRows ? [...seenRows] : [])
  if (first !== null) for (const r of first) counted.add(rowKey(r))
  return async () => {
    if (left <= 0) return null
    left -= 1
    page += 1
    try {
      const { res, body, parsed } = await json(profile.site, token, `${TXNS}?page=${page}&page_size=${PAGE_SIZE}`, deadline)
      gate(profile, res, body, parsed, token, "账单查询失败")
      const rows = recordsOf(body)
      // a page already read (the server ignoring the page number, or cycling)
      // is not the walk's next step: counted again it fills the ledger's
      // `total` and ends a streak the walk could not see the end of
      const stamp = stable(rows)
      if (seen.has(stamp)) return null
      seen.add(stamp)
      // an empty page is the end of the ledger, not a repeat: streakOf reads
      // it as the proof that the run went as far as there is
      if (!rows.length) return []
      const fresh = rows.filter((r) => !counted.has(rowKey(r)))
      for (const r of fresh) counted.add(rowKey(r))
      if (!fresh.length) return null
      return fresh
    } catch (e) {
      // a 401 the gate confirmed is the token refused; the walk still gives up
      // softly (the claim already landed), but the host is told about the
      // expiry through `marks`
      if (marks && signedOut(e)) marks.expired = true
      return null
    }
  }
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
// settles the day) and a blank balance as "0 credits available". A padded number
// (" 251.5 ") is not blank: it says what it means.
const blankOf = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim())

// amountOf is a ledger row's total_amount. A value that is there and is not a
// number is a body we do not understand, and reads as a failure rather than as
// 0: the same rule the whole body gets one level up. A localized "1,200", a
// format change, a null — each would otherwise make a real grant look like
// "nothing arrived": the check-in would answer `inactive` (which settles the
// day) and the card would say claimed 0 next to a balance that clearly moved.
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
  // "Infinity credits" would be printed for a body we cannot actually read. The
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

      // A static-token check-in: paste an access token that starts with ms-.
      //
      // Neither prompts nor authorize is declared: magpie already asks for the
      // key on its own for an api-type method, and the token is stored as the
      // key itself. Declaring prompts would write its answer into metadata as
      // well, putting the same token on disk twice (host.js's save()); and
      // authorize sees only the answers to prompts, not that key, so it cannot
      // stand in for it. The placeholder hints at the format; a wrong one shows
      // as a 401 on the first check-in or usage read.
      methods: [
        {
          type: "api",
          label: "ModelScope 访问令牌（国内站或国际站）",
          placeholder: "ms-…",
        },
      ],

      // The check-in: first see whether today's credits have landed, then touch
      // the login, and finally read the ledger back to reconcile. A direct touch
      // cannot tell "just claimed" from "claimed long ago"; the ledger can.
      //
      // Timing: when asked, if today's target moment for this account has not
      // arrived yet, answer failed before sending any request — the one outcome
      // the host retries; any other one stops the day from being asked again.
      // The cost is that the card reads "check-in failed; magpie will retry
      // later" during that stretch, the only way the host has today to say "not
      // yet time" (see the README's upstream section).
      async checkin(getAuth) {
        // The whole hook's budget starts here, not after the host hands the
        // sign-in over: a store read that waits on another process's lock is
        // this hook's time too, and 18 seconds of it plus a request timeout
        // put a 25-second hook past its own limit.
        const deadline = Date.now() + CHECKIN_BUDGET_MS
        let auth, token
        try {
          const got = await bounded(Promise.resolve().then(getAuth), deadline - Date.now())
          if (got === BOUNDED) return { outcome: "failed", message: "读取登录信息超时，稍后自动重试" }
          auth = got
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
            // next ask, half an hour later, so "in about 8 minutes" outlives the
            // eight minutes: a real card still read that at 09:47 for a
            // 09:28 target whose credits had already landed. The target and
            // the cadence are both absolute, and the cadence is also why the
            // claim is not at the target sharp — a plugin has no timer, so
            // it runs on the host's next ask, not at the moment it named.
            return {
              outcome: "failed",
              // the zone is named because only the minute is: the target is
              // Beijing's whatever zone the host's own clock is in, and the
              // host shows other times (resets, a window's expiry) in the
              // machine's zone beside it.
              message: `${clock(p.target)} 后自动领取（北京时间，magpie 每半小时问一次，无需操作）`,
            }
          }
        }

        // The site the token was found on is kept on the sign-in, so a
        // restarted host goes straight there instead of handing the token to
        // the domestic site for a 401 first. A value that is not one of the
        // two is ignored and the token probed again.
        const kept = profileForSite(auth?.site)
        if (kept && !sites.has(token)) rememberSite(token, kept)

        // The nickname is written back after the answer is made, not between
        // the touch and the reads that reconcile it: magpie's auth.set takes
        // plugin-auth.json's lock synchronously (host.js's lockAuth, up to
        // twice its 10s stale time when another process holds it), and that
        // wait came out of this hook's 25s — a claim that had landed was then
        // answered "budget used up" and shown as failed for half an hour.
        // The write is also capped (WRITE_WAIT_MS) so a locked store cannot
        // stretch the hook past its budget even from the tail.
        let name = ""
        // the site the reads found the token on, for the write-back after the
        // answer; null until the first read has answered
        let probe = null
        // a confirmed expiry met on a read that is allowed to fail softly
        // (the name lookup, the streak walk): the day's answer stands, and the
        // host still has to hear that the token was refused
        const marks = { expired: false }
        const answer = await (async () => {
        try {
          let before = await todayEarn(token, deadline)
          let rolls = 0
          for (;;) {
          const profile = before.profile
          probe = profile
          const beforeDaily = before.rows.filter((r) => DAILY_RULES.includes(r?.rule_key))
          const claimed = before.rows.some((r) => r?.rule_key === "daily_active")
          // A baseline that was not read to the end cannot prove the day's
          // grant absent: the row may sit on the page that failed, and the
          // touch-then-diff would report a row nobody read as this run's gain.
          // `failed` is the one outcome the host retries.
          if (!before.complete && !claimed) return { outcome: "failed", message: "账单读取不完整，稍后自动重试" }
          // What this run granted is the ledger's growth, not a new key: the
          // rows are aggregated per (day, type, rule_key, model_tier), so a
          // second grant of a rule already in today's page grows that row's
          // amount instead of adding one. An account that already had today's
          // aliyun_bindlogin (from the website, say) and gains nothing from
          // the touch must not report "claimed 50" — and one that gains more
          // of a rule it already had must still report it.
          // Only the daily-rule rows go into the comparison. The ledger also
          // holds EARN rows of other rules — promotions, bind bonuses — and a
          // row of one that carries no amount (a server-side adjustment, a
          // rule added since) would throw here and answer `failed` for a day
          // whose claim had already landed. Those rows are not what this
          // comparison is about, so their amounts are never read. It is the
          // same rule the usage card follows: only the kinds it sums need an
          // amount.
          const byRule = (rows) => {
            const m = new Map()
            for (const r of rows) m.set(r?.rule_key, (m.get(r?.rule_key) ?? 0) + amountOf(r))
            return m
          }
          // `beforeDaily` and every `rows` handed to grew(...) are already
          // filtered to DAILY_RULES by the caller.
          const beforeByRule = byRule(beforeDaily)
          // The name a rule is shown by: the first row of that key that carries
          // one. Rows aggregate per (day, type, rule_key, model_tier), so a key
          // can have several rows and the first can be a tier whose title the
          // server left blank — taking rows[0]'s title alone would drop the name
          // from a grant that has one on another row, and the card would read
          // "+50" with nothing in front of it.
          const titleOf = (rows, key) =>
            rows.find((r) => r?.rule_key === key && typeof r.title === "string" && r.title.trim())?.title
          const grew = (rows, pageDay) => {
            const after = byRule(rows)
            // The rows of a new Beijing day cannot be diffed against the day
            // before it: a grant that landed at 00:00:xx on the 50 already in
            // yesterday's page would net to zero.
            const base = pageDay === before.day ? beforeByRule : new Map()
            const out = []
            for (const [key, sum] of after) {
              const gain = yin(sum - (base.get(key) ?? 0))
              if (gain > 0) out.push({ key, gain, title: titleOf(rows, key) })
            }
            return out
          }

          // Claimed today and the name already known: the touch has nothing
          // left to do. magpie asks a `done` again every half hour before noon
          // when it has not seen the claim itself (provisional), and each ask
          // touching login/info was one more recorded sign-in — up to a dozen
          // a morning for an account claimed on the website. "Known" includes
          // a remembered "the server gave no usable name" (`names` holds the
          // empty string then), or the touch would repeat for exactly the
          // accounts whose nickname is unusable.
          const known = names.has(token)
          if (claimed && known) {
            name = names.get(token)
          } else if (claimed) {
            // The grant is already in the ledger, so this read is only for the
            // card's name. A refusal or a broken answer must not turn the day
            // into `failed`: the host retries a failed day every half hour,
            // touching login/info each time, for a claim that already landed.
            name = ""
            try {
              const { res, body, parsed } = await json(profile.site, token, LOGIN_INFO, deadline)
              if (res.status === 401 && parsed) throw deadToken(profile.where)
              gate(profile, res, body, parsed, token, "登录接口失败", `${RISK}，稍后会自动重试`)
              const me = dataOf(body)
              // A name is a string. Anything else — a number, an object, a list —
              // would reach text() as "12345" or "[object Object]" and be written
              // back as the account's name, and magpie's card would show that
              // instead of the key's tail. NickName wins when it is a name; Name
              // is the fallback it always was.
              const str = (v) => (typeof v === "string" && v.trim() ? v : "")
              const raw = str(me.NickName) || str(me.Name)
              const candidate = text(raw, 40)
              // judged whole, then cut: the cut can leave a piece of the token
              // in the name that neither the cut string nor the whole one
              // answers for alone (see runsThrough)
              name = unusableName(raw, token) || unusableName(candidate, token) ? "" : candidate
              rememberName(token, name)
            } catch (e) {
              // no name this ask; the day still stands as done — but a 401 the
              // gate confirmed is the token refused, and the host is told
              if (signedOut(e)) marks.expired = true
            }
          } else {
            const { res, body, parsed } = await json(profile.site, token, LOGIN_INFO, deadline)
            // A 403 is risk control, not a bad token: the account may be fine and
            // only this request was refused.
            gate(profile, res, body, parsed, token, "登录接口失败", `${RISK}，稍后会自动重试`)

            const me = dataOf(body)
            // A name is a string. Anything else — a number, an object, a list —
            // would reach text() as "12345" or "[object Object]" and be written
            // back as the account's name, and magpie's card would show that
            // instead of the key's tail. NickName wins when it is a name; Name
            // is the fallback it always was.
            const str = (v) => (typeof v === "string" && v.trim() ? v : "")
            const raw = str(me.NickName) || str(me.Name)
            const candidate = text(raw, 40)
            // judged whole, then cut: the cut can leave a piece of the token
            // in the name that neither the cut string nor the whole one
            // answers for alone (see runsThrough)
            name = unusableName(raw, token) || unusableName(candidate, token) ? "" : candidate
            rememberName(token, name)
          }

          const gained = (rows, pageDay) => {
            const grew1 = grew(rows, pageDay)
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

          // The name read above can sit across Beijing midnight: the baseline
          // is then yesterday's, and answering `done` for it would settle the
          // new day without claiming it. A day that changed while the hook ran
          // is re-read and the walk starts over for the new day (twice at
          // most, so a clock that keeps rolling cannot loop the hook).
          if (todayCN() !== before.day && rolls < 2) {
            rolls += 1
            const wasDay = before.day
            before = await todayEarn(token, deadline)
            probe = before.profile
            // The touch was this run's, and the day changed under it: the
            // baseline is yesterday's, and `gained` reads an empty one for a
            // page whose day is not the one it is handed. So the new day's
            // whole page is the diff — every daily grant on it was written
            // between the two reads (the page had nothing for the new day when
            // the baseline was read). A grant the server stamped with
            // yesterday's date (a late write) is not on this page at all, and
            // is not claimed here: it belongs to yesterday's answer, which
            // this run already gave.
            const bornToday = gained(before.rows.filter((r) => DAILY_RULES.includes(r?.rule_key)), wasDay)
            if (bornToday) {
              return withStreak({
                outcome: "claimed",
                credit: bornToday.credit,
                message: `领取 ${bornToday.credit} 魔粒：${bornToday.which}` + (before.complete ? "" : "；账单未读完，数字偏低"),
                ...(marks.expired ? { signIn: "expired" } : {}),
              }, await streakOf(before.all, before.day, before.total, ledgerReader(profile, token, deadline, before.pages, before.last, before.seenPages, before.seenRows, marks), deadline), marks)
            }
            if (!before.complete) {
              return { outcome: "failed", message: "账单读取不完整，稍后自动重试", ...(marks.expired ? { signIn: "expired" } : {}) }
            }
            continue
          }

          // A done uses the totals from the page **before** the touch: if today
          // was already claimed, what was claimed is the number the ledger held
          // then. From the page after the touch, a ledger that changed between
          // the two reads (rows pushed to the next page, or the day's total
          // recomputed) would make the card say today's claim is 0 credits.
          if (claimed) {
            const credit = sumOf(beforeDaily)
            // each title is cut and stringified as before, and the join is
            // masked once at the end: two titles that each carry a piece of the
            // key under MIN_ECHO spell it together, and a per-title mask never
            // sees the pair.
            const joined = beforeDaily
              .map((r) => cardText(r.title, token, 40))
              .filter(Boolean)
              .join(" + ")
            const which = cardText(joined, token, 200)
            // An EARN row can carry a reversal, and a day whose grants were
            // reversed nets below zero. magpie clamps the numeric credit
            // itself (host.js's num: Math.max(0, v)) but renders `message`
            // verbatim, so a negative claimed-today line would reach the card:
            // a claim of a negative amount is not a thing. The rows are still
            // named — the user can see which ones — but the amount stops at
            // zero, the way the usage card's limit already does.
            const shown = Math.max(0, credit)
            // The streak is read from the page **before** the touch here too:
            // the touch grants nothing new for an account already claimed, so
            // the two readings answer the same thing, and this one is the page
            // the totals above were taken from.
            return withStreak({
              outcome: "done",
              credit: shown,
              message: `今日已领取 ${shown} 魔粒` + (which ? `（${which}）` : "") + (before.complete ? "" : "；账单未读完，数字偏低"),
              ...(marks.expired ? { signIn: "expired" } : {}),
            }, await streakOf(before.all, before.day, before.total, ledgerReader(profile, token, deadline, before.pages, before.last, before.seenPages, before.seenRows, marks), deadline), marks)
          }

          // Both claimed exits answer the same way; the streak is computed in
          // one place so a change to it cannot land in one branch only.
          const claimedNow = async (page, gain) => {
            const streak = await streakOf(page.all, page.day, page.total, ledgerReader(profile, token, deadline, page.pages, page.last, page.seenPages, page.seenRows, marks), deadline)
            return withStreak({
              outcome: "claimed",
              credit: gain.credit,
              message: `领取 ${gain.credit} 魔粒：${gain.which}` + (page.complete ? "" : "；账单未读完，数字偏低"),
              ...(marks.expired ? { signIn: "expired" } : {}),
            }, streak, marks)
          }

          const fresh = await todayEarn(token, deadline)
          probe = fresh.profile
          const daily = gained(fresh.rows.filter((r) => DAILY_RULES.includes(r?.rule_key)), fresh.day)
          if (daily) return await claimedNow(fresh, daily)
          // Touched, yet no credit record: the ledger may not be written yet
          // (grants are asynchronous), or this account may simply not be in the
          // campaign. Read the ledger once more to confirm, and do not drop a
          // grant that was just written. This re-read buys no "wait a while" —
          // if the grant really is written a few seconds later, the immediate
          // re-read cannot see it either. Before Beijing noon the host covers
          // that stretch: a done/inactive that has not seen a claim is a
          // provisional answer, re-asked every 30 minutes (provisional, decided
          // by checkinSureHour). From noon the host settles the day, so in the
          // afternoon the plugin asks for one more ask half an hour later itself,
          // via until.
          const again = await todayEarn(token, deadline)
          probe = again.profile
          const later = gained(again.rows.filter((r) => DAILY_RULES.includes(r?.rule_key)), again.day)
          if (later) return await claimedNow(again, later)
          // A ledger this walk could not finish is not evidence that nothing
          // arrived: the grant may sit on the page that failed, and `inactive`
          // without `until` settles the day on that. The last read is the one
          // that decides — an earlier incomplete read is answered by this one.
          // The touch has happened, so the answer that costs nothing is
          // `failed` — the one outcome the host retries, which reads the
          // ledger again half an hour later.
          if (!again.complete) {
            return { outcome: "failed", message: "账单读取不完整，稍后自动重试" }
          }
          const hourCN = Math.floor(minuteCN() / 60)
          // Before noon the host re-asks a provisional answer every half hour,
          // so an `inactive` here is safe: a grant that is simply late is read
          // again, and the repeat past noon gets the `until` below. From noon
          // the host settles the day, so the first `inactive` from noon on
          // carries `until`, once per day. A check-in that lands just after
          // midnight is before SURE_HOUR and already covered by the host's
          // provisional re-ask — that is the guard, and it is the hour, not a
          // stale day flag: `deferred` holds the Beijing day the `until` was
          // given on, and a new day starts with no flag, so the afternoon of
          // the new day gets its own `until` like any other day.
          if (hourCN >= SURE_HOUR && deferred.get(token) !== today) {
            for (const [k, d] of deferred) if (d !== today) deferred.delete(k)
            deferred.set(token, today)
            return {
              outcome: "inactive",
              message: "登录已触达，账本里还没有今天的到账；半小时后再核对一次",
              until: new Date(Date.now() + AGAIN_MS).toISOString(),
            }
          }
          if (beforeDaily.length) {
            // no until: this answer settles the day, so the line must not
            // promise a re-check the host will not make. Today has credits of
            // other kinds and no check-in reward, which reads as an account
            // outside the activity rather than a grant still on its way.
            return { outcome: "inactive", message: "登录已触达，今天有到账但没有签到奖励（账号可能不在活动范围）" }
          }
          return { outcome: "inactive", message: "登录已触达，但今天没有到账记录（账号可能不在活动范围）" }
          }
        } catch (e) {
          return { outcome: "failed", message: cardText(whyOf(e), token) || "签到失败", ...(signedOut(e) ? { signIn: "expired" } : {}) }
        }
        })()
        // best-effort, and never a reason for the hook to reject: the write
        // catches its own failures, and anything it could still throw (an
        // unreadable providers.json read) must not undo the answer above
        try {
          await rememberAccountFields(client, token, { name, profile: probe, probeDone: !!probe }, auth, configDir, deadline, getAuth)
        } catch {}
        return answer
      },

      // The credits balance and today's usage, for the account card.
      async usage(getAuth) {
        // everything the host could get wrong about the hand-over is the
        // card's problem alone: it must come back as {error}, never as a
        // rejection out of the hook
        const deadline = Date.now() + USAGE_BUDGET_MS
        let auth, token
        try {
          const got = await bounded(Promise.resolve().then(getAuth), deadline - Date.now())
          if (got === BOUNDED) return { error: "读取登录信息超时，稍后自动重试" }
          auth = got
          token = tokenOf(auth)
        } catch (e) {
          return { error: hostText(whyOf(e)) || "用量查询失败", signIn: signedOut(e) ? "expired" : "" }
        }
        if (!token) return { error: unusableKey(auth) ? "令牌内容无法识别，请重新登录" : "没有登录信息", signIn: "" }
        // the same seeding as the check-in's: a site kept on the sign-in saves
        // the domestic-site 401 a restarted host would otherwise pay first
        const kept = profileForSite(auth?.site)
        if (kept && !sites.has(token)) rememberSite(token, kept)
        // the name is only known from login/info, which usage must never
        // reach; a check-in in this process leaves it here for the card, and
        // the write-back of a name the check-in failed to write is retried
        // here. That write is the last thing before the answer, not the first
        // thing before the reads: the host's auth.set can wait out a lock for
        // ~20s (see the check-in's own note), and a wait spent before the
        // reads came out of the 18s the two of them share — the card answered
        // "budget used up" for a name it had just written. Everything here is inside
        // the try, so the hook still promises an {error} and never a
        // rejection, whatever that write or the reads do.
        try {
          const bal = await siteRead(token, BALANCE, deadline)
          const profile = bal.profile
          gate(profile, bal.res, bal.body, bal.parsed, token, "余额查询失败")
          // A missing data read as 0 would turn "did not understand" into a
          // definite and wrong conclusion, "balance is zero"; the card would
          // read "0 credits available". recordsOf on the ledger side is the
          // same. The field layer is too: available_balance absent, null, or
          // renamed is not a zero balance.
          const balData = dataObjectOf(bal.body, "余额查询失败：响应里没有 data")
          const rawAvailable = balData.available_balance
          if (blankOf(rawAvailable)) {
            throw new Error("余额查询失败：响应里没有 available_balance")
          }
          // A number or a numeric string is a balance. Anything else is not:
          // Number([]) is 0 and Number(true) is 1, both finite, so the plain
          // isFinite check let an empty list through as "0 credits available" — the
          // definite wrong answer this guard exists to stop — and a boolean
          // through as one credit. A formatted string ("1,234") is a number we
          // cannot read, not 0, and blankOf covers the field that holds
          // nothing but spaces, which `Number` also reads as 0.
          const kind = typeof rawAvailable
          if (kind !== "number" && kind !== "string") throw new Error("余额查询失败：available_balance 不是数字")
          const availableN = Number(rawAvailable)
          if (!readable(availableN)) throw new Error("余额查询失败：available_balance 不是数字")
          // a balance is not a debt: the server's reversal direction can put it
          // below zero, and "-5 credits available" is not a thing the card can show
          const available = Math.max(0, yin(availableN))

          const tx = await json(profile.site, token, `${TXNS}?page=1&page_size=${PAGE_SIZE}`, deadline)
          gate(profile, tx.res, tx.body, tx.parsed, token, "账单查询失败")

          const day = todayCN()
          const walked = await dayRows(profile, token, day, recordsOf(tx.body), deadline, tx.body)
          let earned = 0
          let spent = 0
          let earliest = ""
          for (const r of walked.all) {
            // Only the two kinds that go into the card's numbers need an
            // amount. A row of a kind we do not sum is not counted either
            // way, and failing the whole card over its amount would turn a
            // ledger that grew a new kind (an expiry row, say) into "no
            // numbers at all" — the opposite of what the rule is for.
            if (onDay(r?.gmt_created, day)) {
              if (r?.type === "EARN") {
                // "Claimed" means everything credited today, promotions
                // included: the card asks "how much came in, how much was
                // used", and excluding promotions would show "claimed 0" while
                // the balance rose by 500. The credit the check-in reports is a
                // different question (how much this check-in claimed), counting
                // only the daily grants; the two numbers differing is each
                // giving its own answer, not two ways of computing one number.
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

          // Not truncated at 100: magpie reads used > 100 as "overspent"
          // (host.js's "past 100 when overspent"). Today's credits being spent
          // up means nothing was claimed today and the balance is zero. The
          // lower bound is clamped to 0: refunds in the ledger are negative
          // SPEND_CONFIRM rows, and without the clamp the card would show a
          // "used -50 today / claimed 200" combination and a negative
          // percentage — the host clamps it itself; this is one more safety net.
          // summed in floating point: 0.1 + 0.2 is 0.30000000000000004, and it
          // would go into the card as written
          earned = yin(earned)
          spent = yin(spent)
          // The credit direction can also come out negative (reversals,
          // clawbacks). Without the clamp the card would write "claimed -50",
          // and a negative limit makes even less sense. Same for the spend
          // direction.
          const earnedToday = Math.max(0, earned)
          const usedToday = Math.max(0, spent)
          // When there is no credit today, the percentage's denominator becomes
          // "how much is in hand today" — what was used plus what remains. When
          // that denominator is 0 the old measure stands: only a depleted
          // balance counts as spent up. Otherwise the card would show the
          // combination used=0, used 348.5 today, claimed 0 — the progress bar
          // says nothing moved while the text says a lot was spent.
          //
          // Both numbers in the ledger passed readable(), yet the ratio can be
          // large enough to overflow to Infinity at ×10000; the host reads a
          // non-finite used as 0 (host.js's num accepts only finite numbers),
          // and so "almost all used up" was drawn as nothing having moved. When
          // the percentage cannot be computed it is handed to the host as "not
          // said" (used omitted = null), and the text line still states the
          // real amounts.
          const pct = (n, d) => {
            const v = Math.round((n / d) * 10000) / 100
            return Number.isFinite(v) ? v : null
          }
          // More used than claimed today, yet a balance remains: what was spent
          // is yesterday's not-yet-expired credits, not an overage. The
          // denominator switches to "how much is in hand today" then too —
          // otherwise, 250 claimed yesterday at 15:00, 250 claimed today, 300
          // used this morning, the card would draw a 120% overage beside a
          // balance of 200. An overage holds only when the balance is empty too.
          const used =
            earnedToday > 0 && (usedToday <= earnedToday || available === 0)
              ? pct(usedToday, earnedToday)
              : usedToday + available > 0
                ? pct(usedToday, usedToday + available)
                : 100

          // Before today's credits are claimed, put the window's target moment
          // on the card, so "claimed 0" does not look like something went wrong.
          //
          // The config is read only when the card actually needs the target:
          // after the day's grant has landed there is no hint to compute, and
          // this file read is the hook's only synchronous I/O — a poll every
          // few minutes per account should not pay for it to be thrown away.
          // `win` is null when earnedToday is non-zero, so `ahead` is null
          // exactly where `win && earnedToday === 0` used to make it so.
          const win = earnedToday === 0 ? windowOf(configOf(configDir)) : null
          const ahead = win ? plan(win, token, day) : null
          // the minute is Beijing's (minuteCN), while the card's reset time is
          // the machine's zone: say which one this is, or a reader elsewhere
          // takes it for their own clock.
          const hint = ahead && !ahead.due ? ` · ${clock(ahead.target)} 领取（北京时间）` : ""
          // A walk that could not finish leaves the two numbers a floor: the
          // ledger contradicted itself, or a page failed. Said on the card, so
          // they are not read as the day's whole truth.
          const part = walked.complete ? "" : " · 账单未读完，数字偏低"

          // last, and awaited: the card must not be answered ahead of the
          // write (a poll answered before it would race the very retry this
          // exists for), while the reads above have already had the budget to
          // themselves.
          await rememberAccountFields(client, token, { name: names.get(token) ?? "", profile, probeDone: true }, auth, configDir, deadline, getAuth)

          return {
            plan: profile.plan,
            user: nameText(names.get(token) ?? "", token),
            balance: `${available} 魔粒可用`,
            windows: [
              {
                name: "魔粒",
                used,
                display: `今日用 ${usedToday} / 领 ${earnedToday} · 余额 ${available}${hint}${part}`,
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

    // Make the provider show up by name without registering any model: chat
    // still goes through the API-key modelscope preset in providers.json.
    async config(config) {
      // The host builds `{ provider: {}, ...userConfig }`, and the provider in
      // the user config overrides the default {}. When that is not an object (a
      // string an old version wrote, a hand-edited number), the `[profile.id] =`
      // below throws a TypeError, and the host only logs the config hook's
      // error — the plugin still appears, just without a name, and there is no
      // sign of what went wrong. `??=` guards only null/undefined, not "", 0, or
      // false; a container that cannot hold an id has nothing worth keeping, so
      // the whole thing is replaced.
      if (!config.provider || typeof config.provider !== "object") config.provider = {}
      // Keep the name the user has changed: magpie stores a provider's name in
      // providers.json, and this hook runs on every start — forcing the default
      // back would silently undo a rename made in the UI, the same rule as the
      // account-nickname one ("a user-named thing is left alone"). A value that
      // is not an object counts as none.
      const was = config.provider[ID] && typeof config.provider[ID] === "object" ? config.provider[ID] : {}
      config.provider[ID] = {
        ...was,
        name: typeof was.name === "string" && was.name ? was.name : NAME,
      }
    },
  }
}


// testables is how the pure helpers the tests pin are reached without
// exporting them as functions: magpie's loader treats every exported function
// as a plugin entry (see windowOf above), but an object it skips. The tests
// are the only reader.
export const testables = { windowOf, streakOf, CN, INTL, sites, maskAll }

export default MsmoliPlugin
