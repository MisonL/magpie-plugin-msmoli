// The plugin's pure logic, tested without the network: what each endpoint's
// answer means, how a day's ledger is read, and how ModelScope's times are
// parsed. Run with: node --test test/

import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { MsmoliPlugin, testables } from "../index.mjs"

const { windowOf, streakOf } = testables

// The check-in window reads its own config file, which the host would keep at
// ~/.config/magpie/msmoli.json. Tests point it at a temp file so the suite
// doesn't depend on (or touch) a real one, and start with the window off, the
// way a user would have it who wants the claim as soon as magpie asks.
// MSMOLI_FAKE_NOW moves the whole suite's clock, for checking that no test
// depends on the day it runs: the check-in target is a hash of the day, so a
// fixed-clock assertion would pass today and fail on some other date.
const SHIFT = Number(process.env.MSMOLI_FAKE_NOW ?? NaN)
if (Number.isFinite(SHIFT)) {
  const realNow = Date.now
  const LOAD = realNow()
  Date.now = () => SHIFT + (realNow() - LOAD)
}

const TEST_CONFIG = join(tmpdir(), `msmoli-test-${process.pid}.json`)
process.env.MAGPIE_MSMOLI_CONFIG = TEST_CONFIG
writeFileSync(TEST_CONFIG, JSON.stringify({ checkinWindow: false }))

// Every test that needs a temp folder makes it through tmpDir so the whole
// run's scratch space is recorded and removed once at the end. Tests that
// already rmSync their own dir simply leave nothing behind for the hook; the
// ones that never did (a dir per test, and the proto-key test one per loop
// turn) used to pile up in $TMPDIR across CI and dev runs — 200k+ folders — so
// the cleanup lives here in one place instead of trusting every test to have a
// finally. The base config file is removed alongside them.
const scratchDirs = []
const tmpDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(TEST_CONFIG, { force: true })
})

// withDirectory runs fn with the plugin reading its own config from dir, and
// puts MAGPIE_MSMOLI_CONFIG back afterwards whatever happens. Deleting the
// variable without restoring it leaves every later test on the default
// 08:30-10:00 window — which is how a morning test run started failing, and
// how a config test came to assert nothing.
const withDirectory = async (dir, fn) => {
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
}

// withWindow sets the window for a test and puts the clock where it says, so
// "before the window" and "after it" don't depend on when the suite runs.
const withWindow = async (window, cn, fn) => {
  writeFileSync(TEST_CONFIG, JSON.stringify({ checkinWindow: window }))
  const at = Date.parse(cn.replace(" ", "T") + "+08:00")
  const realNow = Date.now
  Date.now = () => at
  try {
    return await fn()
  } finally {
    Date.now = realNow
    writeFileSync(TEST_CONFIG, JSON.stringify({ checkinWindow: false }))
  }
}

// targetOf asks at a clock before any window and reads back the moment the
// plugin will claim at. The moment is a hash of the day and the account, so a
// test that assumed a fixed clock would fail on some days of the year. The
// card leads with that moment instead of naming the configured window, so
// tests that care which window was read assert the target lands inside it.
const targetFrom = (message) => {
  const m = /^(\d{2}):(\d{2}) 后自动领取/.exec(message)
  assert.ok(m, `the message should lead with the target: ${message}`)
  return { minute: +m[1] * 60 + +m[2], text: `${m[1]}:${m[2]}` }
}
const targetOf = async (checkin) =>
  targetFrom((await checkin(async () => ({ type: "api", key: "ms-test" }))).message)

const hooks = await MsmoliPlugin({})
const auth = hooks.auth

// The Beijing day the plugin reads, as it computes it: fixtures follow the
// clock so these tests don't expire.
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const tomorrow = new Date(Date.now() + 32 * 3600e3).toISOString().slice(0, 10)
const yesterday = new Date(Date.now() + 8 * 3600e3 - 24 * 3600e3).toISOString().slice(0, 10)

// A day of ModelScope's ledger, as /openapi/v1/magicubes/transactions gives it.
const day = (over = {}) => ({
  gmt_created: today,
  type: "EARN",
  rule_key: "daily_active",
  title: "注册并登录",
  total_amount: 200,
  count: 1,
  expire_days: 1,
  expire_at: `${tomorrow} 00:00:24`,
  ...over,
})

const spend = (amount, count = 1, on = today) => ({
  gmt_created: on,
  type: "SPEND_CONFIRM",
  rule_key: "api_inference",
  model_tier: "ultra",
  total_amount: amount,
  count,
})

// reply is what fetch gives back: the plugin reads the body as a stream, so
// a fake answers in kind. `raw` stands in for a body that isn't JSON, and
// `bytes` for one that is too large to read. `noLength` drops the
// content-length header, so the size cap has to be enforced while reading;
// `noBody` drops the stream, leaving only text() — the other branch of
// readBounded.
const reply = (hit) => {
  const text = hit.raw !== undefined ? hit.raw : JSON.stringify(hit.body ?? {})
  const bytes = hit.bytes !== undefined ? hit.bytes : new TextEncoder().encode(text)
  // `chunkBytes` hands the body over in pieces of at most that many bytes, the
  // way a socket does — a piece can end in the middle of a multi-byte
  // character. The default is one piece, which is what most tests want.
  const step = Math.max(1, hit.chunkBytes ?? bytes.length)
  const pieces = []
  for (let at = 0; at < bytes.length; at += step) pieces.push(bytes.subarray(at, at + step))
  return {
    status: hit.status ?? 200,
    headers: {
      get: (name) =>
        name.toLowerCase() !== "content-length" || hit.noLength ? null : String(bytes.length),
    },
    body: hit.noBody
      ? undefined
      : {
          getReader() {
            let at = 0
            return {
              async read() {
                if (at >= pieces.length) return { done: true, value: undefined }
                return { done: false, value: pieces[at++] }
              },
              async cancel() {},
              releaseLock() {},
            }
          },
        },
    text: async () => text,
  }
}

// fakeFetch answers each path with the given body.
function fakeFetch(responses) {
  const calls = []
  const fn = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    calls.push(path)
    const hit = responses[path]
    if (!hit) return reply({ status: 404, raw: "404 page not found" })
    return reply(hit)
  }
  fn.calls = calls
  return fn
}

const withFetch = async (responses, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = fakeFetch(responses)
  try {
    return await fn(globalThis.fetch)
  } finally {
    globalThis.fetch = real
  }
}

test("the plugin declares its provider and one api sign-in method", () => {
  assert.equal(auth.provider, "msmoli")
  assert.equal(auth.methods.length, 1)
  assert.equal(auth.methods[0].type, "api")
  // prompts would put the token into metadata as well (host.js's save())
  assert.equal(auth.methods[0].prompts, undefined)
  assert.equal(auth.methods[0].authorize, undefined)
})

test("the config hook names the provider and registers no model", async () => {
  const config = {}
  await hooks.config(config)
  assert.equal(config.provider.msmoli.name, "ModelScope 魔粒")
  assert.equal(config.provider.msmoli.models, undefined)
})

test("the config hook keeps a provider name the user set", async () => {
  // magpie keeps a provider's name in providers.json and runs every config
  // hook on each start: writing ours over it would undo a rename made in its
  // UI, with no sign of why. Everything else the entry carries stays too.
  const config = { provider: { msmoli: { name: "我的魔搭", options: { note: "kept" } } } }
  await hooks.config(config)
  assert.equal(config.provider.msmoli.name, "我的魔搭")
  assert.deepEqual(config.provider.msmoli.options, { note: "kept" })
})

test("a provider entry that is not an object is no entry, and a name that is not a name is the default", async () => {
  // providers.json is another program's file and can arrive half-written or
  // hand-edited: the entry a string, the name blank or a number. Both guards
  // are `&&` — read as `||`, spreading a string writes its characters back
  // as index keys, and "" or 42 becomes the provider's only visible label.
  const past = { provider: { msmoli: "旧条目" } }
  await hooks.config(past)
  assert.deepEqual(past.provider.msmoli, { name: "ModelScope 魔粒" }, "a string is not an entry to spread")
  for (const name of ["", 42]) {
    const config = { provider: { msmoli: { name } } }
    await hooks.config(config)
    assert.equal(config.provider.msmoli.name, "ModelScope 魔粒", `${JSON.stringify(name)} is not a name to keep`)
  }
})

// ── Two sites, one provider ────────────────────────────────────────────────
// modelscope.cn and modelscope.ai are one backend — same paths, same grant
// rules, same 24-hour expiry — but separate accounts: an ms- token answers 401
// on the site it did not come from. So the card is one (`msmoli`) and each
// account's site is found from the token itself, on the first read the hook
// makes: the read goes to the domestic site and only a 401 sends it to the
// international one. The tests below pin each piece of that — the origin a
// read lands on, the plan line, the 401 wording, and that a known site is
// remembered instead of being probed on every poll.

const BALANCE_PATH = "/openapi/v1/magicubes/balance"
const TX_PATH = "/openapi/v1/magicubes/transactions?page=1&page_size=50"
const CN_ORIGIN = "https://modelscope.cn"
const INTL_ORIGIN = "https://modelscope.ai"

// withUrlFetch is withFetch that remembers the whole URL, not only the path:
// the two sites answer on identical paths, so the path-keyed fake cannot tell
// which origin was asked. A hit may be a function, called per request with the
// origin and the 1-based count for that path, for the reads that change
// between calls.
const withUrlFetch = async (responses, fn) => {
  const real = globalThis.fetch
  const urls = []
  const counts = new Map()
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    const u = new URL(url)
    const key = u.pathname + u.search
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    const hit = responses[key]
    if (!hit) return reply({ status: 404, raw: "404 page not found" })
    return reply(typeof hit === "function" ? hit(u.origin, n) : hit)
  }
  try {
    return await fn(urls)
  } finally {
    globalThis.fetch = real
  }
}

// bySite answers differently on the two origins of the same path.
const bySite = (cn, intl) => (origin) => (origin === CN_ORIGIN ? cn : intl)

test("one provider serves both sites, and it is the only entry", () => {
  // A second provider would be a second card the user has to tell apart; the
  // token already says which site it is from.
  assert.equal(auth.provider, "msmoli")
  assert.equal(testables.CN.site, CN_ORIGIN)
  assert.equal(testables.INTL.site, INTL_ORIGIN)
})

test("a domestic token reads modelscope.cn and never .ai", async () => {
  const responses = {
    [BALANCE_PATH]: { body: { success: true, data: { available_balance: 5 } } },
    [TX_PATH]: { body: { success: true, data: { records: [] } } },
  }
  const { out, origins } = await withUrlFetch(responses, async (urls) => {
    const out = await auth.usage(async () => ({ type: "api", key: "ms-cn-site" }))
    return { out, origins: [...new Set(urls.map((u) => new URL(u).origin))] }
  })
  assert.ok(!out.error, out.error)
  assert.equal(out.plan, "魔搭社区")
  assert.deepEqual(origins, [CN_ORIGIN], `a domestic token must not reach .ai: ${origins}`)
})

test("an international token is found by its first 401 and then reads modelscope.ai", async () => {
  testables.sites.clear()
  const responses = {
    [BALANCE_PATH]: bySite({ status: 401, body: { message: "unauthorized" } }, { body: { success: true, data: { available_balance: 7 } } }),
    [TX_PATH]: bySite({ status: 401, body: { message: "unauthorized" } }, { body: { success: true, data: { records: [] } } }),
  }
  const token = "ms-intl-0000-0000-0000-000000000002"
  const { out, urls } = await withUrlFetch(responses, async (urls) => {
    const out = await auth.usage(async () => ({ type: "api", key: token }))
    return { out, urls: urls.slice() }
  })
  assert.ok(!out.error, out.error)
  assert.equal(out.plan, "魔搭社区（国际版）")
  assert.equal(new URL(urls[0]).origin, CN_ORIGIN, "the first read tries the domestic site")
  assert.equal(new URL(urls[1]).origin, INTL_ORIGIN, "the 401 sends it to the international one")
  assert.deepEqual(
    [...new Set(urls.slice(2).map((u) => new URL(u).origin))],
    [INTL_ORIGIN],
    `once the site is known every read stays there: ${urls.join(", ")}`,
  )
})

test("the site is remembered, so a later poll does not ask the other site", async () => {
  testables.sites.clear()
  const responses = {
    [BALANCE_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { available_balance: 1 } } }),
    [TX_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { records: [] } } }),
  }
  const token = "ms-intl-0000-0000-0000-000000000003"
  await withUrlFetch(responses, async () => auth.usage(async () => ({ type: "api", key: token })))
  const origins = await withUrlFetch(responses, async (urls) => {
    const out = await auth.usage(async () => ({ type: "api", key: token }))
    assert.ok(!out.error, out.error)
    return [...new Set(urls.map((u) => new URL(u).origin))]
  })
  assert.deepEqual(origins, [INTL_ORIGIN], "the second poll must not probe .cn again")
})

test("the check-in reads the kept site directly too, with no domestic probe", async () => {
  // the check-in seeds the same cache the usage read does. Without it, the
  // first thing a restarted host does for an international account — the
  // check-in round — pays the domestic-site 401 even though the sign-in says
  // which site it is.
  testables.sites.clear()
  const dir = tmpDir("msmoli-checkseedsite-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const token = "ms-intl-0000-0000-0000-000000000025"
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async () => {} } } })
    const responses = {
      [TX_PATH]: bySite(
        { status: 401, body: {} },
        { body: { success: true, data: { records: [day()] } } },
      ),
      "/api/v1/users/login/info": bySite(
        { status: 401, body: {} },
        { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      ),
    }
    const { r, origins } = await withUrlFetch(responses, async (urls) => {
      const r = await p.auth.checkin(async () => ({ type: "api", key: token, site: INTL_ORIGIN }))
      return { r, origins: [...new Set(urls.map((u) => new URL(u).origin))] }
    })
    assert.equal(r.outcome, "done", r.message)
    assert.deepEqual(origins, [INTL_ORIGIN], `a kept site is read directly: ${origins}`)
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("the site is written onto the sign-in, so a restarted host skips the 401", async () => {
  // The in-memory cache above dies with the process. What survives is the
  // sign-in in plugin-auth.json, and the host round-trips fields it does not
  // know (parseAuth is plain JSON.parse, writeAuth serializes the whole
  // object), so `site` is written there once instead of being re-probed after
  // every restart.
  testables.sites.clear()
  const dir = tmpDir("msmoli-sitesave-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const token = "ms-intl-0000-0000-0000-000000000021"
    const writes = []
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    const responses = {
      [TX_PATH]: bySite(
        { status: 401, body: { message: "unauthorized" } },
        { body: { success: true, data: { records: [] } } },
      ),
      "/api/v1/users/login/info": bySite(
        { status: 401, body: { message: "unauthorized" } },
        { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      ),
    }
    await withUrlFetch(responses, async () => {
      await p.auth.checkin(async () => ({ type: "api", key: token }))
    })
    assert.equal(writes.length, 1, `the name and the site share one write: ${JSON.stringify(writes)}`)
    assert.equal(writes[0].body.site, INTL_ORIGIN, "the site the token was found on is kept")
    assert.equal(writes[0].body.accountId, "alice", "the name is written in the same write, not a second one")
    assert.equal(writes[0].body.key, token)
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a sign-in carrying the site is read there directly, with no domestic probe", async () => {
  // What the write above is for: after a restart, the memory is empty and only
  // the sign-in remembers. The domestic site is not asked at all — the kept
  // value is authoritative, not a hint that saves nothing.
  testables.sites.clear()
  const token = "ms-intl-0000-0000-0000-000000000022"
  const responses = {
    [BALANCE_PATH]: bySite(
      { status: 401, body: {} },
      { body: { success: true, data: { available_balance: 3 } } },
    ),
    [TX_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { records: [] } } }),
  }
  const { out, origins } = await withUrlFetch(responses, async (urls) => {
    const out = await auth.usage(async () => ({ type: "api", key: token, site: INTL_ORIGIN }))
    return { out, origins: [...new Set(urls.map((u) => new URL(u).origin))] }
  })
  assert.ok(!out.error, out.error)
  assert.equal(out.plan, "魔搭社区（国际版）")
  assert.deepEqual(origins, [INTL_ORIGIN], `a kept site must not be probed again: ${origins}`)
})

test("a site value the plugin does not know is ignored, not trusted", async () => {
  // A hand-edited file, or a field a future host writes for its own reasons.
  // Only the two sites the plugin serves are taken, and anything else falls
  // back to the probe — a value read as a site would send the token, and
  // through it the session, to an origin this plugin never chose.
  testables.sites.clear()
  const token = "ms-intl-0000-0000-0000-000000000023"
  const responses = {
    [BALANCE_PATH]: bySite(
      { status: 401, body: {} },
      { body: { success: true, data: { available_balance: 3 } } },
    ),
    [TX_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { records: [] } } }),
  }
  const { out, origins } = await withUrlFetch(responses, async (urls) => {
    const out = await auth.usage(async () => ({ type: "api", key: token, site: "https://modelscope.evil.example" }))
    return { out, origins: [...new Set(urls.map((u) => new URL(u).origin))] }
  })
  assert.ok(!out.error, out.error)
  assert.deepEqual(origins, [CN_ORIGIN, INTL_ORIGIN], `an unknown site is not a site: ${origins}`)
})

test("a domestic sign-in carries no site field, because the probe tries it first", async () => {
  // Writing the domestic site would cost a locked auth.set on every account
  // and save no request: a probe already goes there first.
  testables.sites.clear()
  const dir = tmpDir("msmoli-cnsite-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day()] } },
        },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => {
        await p.auth.checkin(async () => ({ type: "api", key: "ms-cnsite-0000-0000-0000-000000000024" }))
      },
    )
    assert.equal(writes.length, 1, "the name alone is worth a write")
    assert.equal(writes[0].body.site, undefined, "the domestic site is not written")
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a domestic site that cannot be reached still lets an international token be found", async () => {
  // The domestic site can be unreachable on a network where the international
  // one answers — and the token is a fact, not a guess made from whichever
  // request happened to work. A transport error must therefore move on to the
  // other site, not end the read.
  testables.sites.clear()
  const token = "ms-intl-0000-0000-0000-000000000007"
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    seen.push(u.origin)
    if (u.origin === CN_ORIGIN) throw new TypeError("fetch failed")
    const hit = {
      [BALANCE_PATH]: { body: { success: true, data: { available_balance: 2 } } },
      [TX_PATH]: { body: { success: true, data: { records: [] } } },
    }[u.pathname + u.search]
    return reply(hit)
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: token }))
    assert.ok(!u.error, u.error)
    assert.equal(u.plan, "魔搭社区（国际版）")
    assert.deepEqual([...new Set(seen)], [CN_ORIGIN, INTL_ORIGIN])
  } finally {
    globalThis.fetch = real
  }
})

test("when both sites cannot be reached, the card says so instead of expiring the account", async () => {
  // A transport failure says nothing about the token: reporting it as a dead
  // token would sign the account out over a proxy problem. Both sites are
  // tried, and what comes back is the network wording.
  testables.sites.clear()
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n += 1
    throw new TypeError("fetch failed")
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-nowhere-0000-0000-0000-000000000008" }))
    assert.equal(n, 2, "both sites are tried before giving up")
    assert.match(u.error, /请求失败/, u.error)
    assert.notEqual(u.signIn, "expired", "a network failure is not a revoked token")
  } finally {
    globalThis.fetch = real
  }
})

test("when both sites fail differently, the first site's failure is the one reported", async () => {
  // siteRead keeps the *first* failure (`firstError ??= e`) because the
  // domestic site is the one the token most often belongs to: its failure is
  // the one the user was closest to. A fixture that fails both sites the same
  // way cannot see the difference — `firstError = e` kept the suite green —
  // so the two sites fail differently here: whichever wording the card shows
  // says which failure was kept.
  testables.sites.clear()
  const token = "ms-first-err-0000-0000-0000-000000000011"
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.origin === CN_ORIGIN) throw new Error("proxyconnect tcp: dial tcp 127.0.0.1:7890: i/o timeout")
    throw new Error("The operation timed out")
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: token }))
    assert.match(u.error, /代理连不上/, `the domestic site's failure is the one kept, got: ${u.error}`)
    assert.doesNotMatch(u.error, /请求超时/, `the second site's timeout must not replace it: ${u.error}`)
    assert.notEqual(u.signIn, "expired", "a transport failure is not a revoked token")
  } finally {
    globalThis.fetch = real
  }
})

test("two accounts of one provider, each on its own site, keep their own plan line", async () => {
  // The single card holds both sites at once: a domestic account and an
  // international one must not be shown as the same site just because they
  // share a provider id.
  testables.sites.clear()
  const responses = {
    [BALANCE_PATH]: (origin) =>
      origin === CN_ORIGIN ? { body: { success: true, data: { available_balance: 5 } } } : { body: { success: true, data: { available_balance: 9 } } },
    [TX_PATH]: { body: { success: true, data: { records: [] } } },
  }
  // the international token meets a 401 on .cn; the domestic one does not
  const cn = await withUrlFetch(
    { ...responses, [BALANCE_PATH]: (origin) => (origin === CN_ORIGIN ? { body: { success: true, data: { available_balance: 5 } } } : { status: 401, body: {} }) },
    async () => auth.usage(async () => ({ type: "api", key: "ms-cn-two-0000-0000-0000-000000000009" })),
  )
  const intl = await withUrlFetch(
    { ...responses, [BALANCE_PATH]: (origin) => (origin === CN_ORIGIN ? { status: 401, body: {} } : { body: { success: true, data: { available_balance: 9 } } }) },
    async () => auth.usage(async () => ({ type: "api", key: "ms-intl-two-0000-0000-0000-000000000010" })),
  )
  assert.equal(cn.plan, "魔搭社区")
  assert.equal(intl.plan, "魔搭社区（国际版）")
  assert.equal(cn.balance, "5 魔粒可用")
  assert.equal(intl.balance, "9 魔粒可用")
})

test("the remembered sites are bounded, and the oldest goes first", async () => {
  // A long-lived host sees tokens come and go; an unbounded map would keep
  // every one of them for the life of the process. Same shape as `names`.
  testables.sites.clear()
  const response = {
    [BALANCE_PATH]: { body: { success: true, data: { available_balance: 1 } } },
    [TX_PATH]: { body: { success: true, data: { records: [] } } },
  }
  const tokens = Array.from({ length: 65 }, (_, i) => `ms-bound-${String(i).padStart(4, "0")}-0000-0000-000000000011`)
  await withUrlFetch(response, async () => {
    for (const key of tokens) await auth.usage(async () => ({ type: "api", key }))
  })
  assert.equal(testables.sites.size, 64, "the cache is capped at 64 tokens")
  assert.equal(testables.sites.has(tokens[0]), false, "the oldest token is the one evicted")
  assert.equal(testables.sites.has(tokens[64]), true, "the newest is kept")
})

test("a token both sites refuse is expired, and says so", async () => {
  testables.sites.clear()
  const refused = { status: 401, body: { success: false, message: "Invalid authentication" } }
  const u = await withFetch({ [BALANCE_PATH]: refused, [TX_PATH]: refused }, async () =>
    auth.usage(async () => ({ type: "api", key: "ms-dead-0000-0000-0000-000000000004" })),
  )
  assert.equal(u.signIn, "expired")
  assert.match(u.error, /令牌失效/, u.error)
  assert.match(u.error, /401/, u.error)
  // and it must not blame one site for a token neither accepted
  assert.match(u.error, /任一站点/, u.error)
})

test("the international check-in claims on modelscope.ai and never touches .cn", async () => {
  testables.sites.clear()
  const records = [day(), day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 })]
  const responses = {
    [TX_PATH]: (origin, n) =>
      origin === CN_ORIGIN ? { status: 401, body: { message: "unauthorized" } } : { body: { success: true, data: { records: n <= 2 ? [] : records } } },
    "/api/v1/users/login/info": bySite(() => ({ status: 401, body: {} }), { body: { Code: 200, Success: true, Data: { NickName: "alice" } } }),
  }
  const token = "ms-intl-0000-0000-0000-000000000005"
  const { r, urls } = await withUrlFetch(responses, async (urls) => {
    const r = await auth.checkin(async () => ({ type: "api", key: token }))
    return { r, urls: urls.slice() }
  })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 250)
  assert.ok(urls.some((u) => u.startsWith(INTL_ORIGIN) && u.includes("/api/v1/users/login/info")), `the touch must reach .ai: ${urls.join(", ")}`)
  assert.ok(!urls.some((u) => u.startsWith(CN_ORIGIN) && u.includes("/api/v1/users/login/info")), `the touch must not reach .cn: ${urls.join(", ")}`)
})

test("a 401 after the site is known names that site", async () => {
  testables.sites.clear()
  const token = "ms-intl-0000-0000-0000-000000000006"
  const ok = {
    [BALANCE_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { available_balance: 1 } } }),
    [TX_PATH]: bySite({ status: 401, body: {} }, { body: { success: true, data: { records: [] } } }),
  }
  // first, find the site with a successful read
  await withUrlFetch(ok, async () => {
    const u = await auth.usage(async () => ({ type: "api", key: token }))
    assert.ok(!u.error, u.error)
  })
  // then the ledger refuses: the card must name the site that refused
  const u = await withFetch(
    { [BALANCE_PATH]: { body: { success: true, data: { available_balance: 1 } } }, [TX_PATH]: { status: 401, body: { message: "unauthorized" } } },
    async () => auth.usage(async () => ({ type: "api", key: token })),
  )
  assert.equal(u.signIn, "expired")
  assert.match(u.error, /令牌失效或不属于国际站（HTTP 401）/, u.error)
})

test("checkin claims when the day had no daily_active", async () => {
  const before = { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } } }
  const after = {
    "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
      body: { success: true, data: { records: [day(), day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 })] } },
    },
    "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
  }
  // the first read is empty, the second has the grants
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    if (path === "/api/v1/users/login/info") return reply(after[path])
    reads += 1
    return reply(reads === 1 ? before[path] : after[path])
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 250)
    assert.match(r.message, /250/)
  } finally {
    globalThis.fetch = real
  }
})

test("checkin reports done when the day already had daily_active", async () => {
  const body = { success: true, data: { records: [day()] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done")
      assert.equal(r.credit, 200)
    },
  )
})

// ── The streak ──────────────────────────────────────────────────────────────
// The host prints "{n}-day streak" beside a done/claimed answer only when the
// result carries a streak (host.js: r.streak ? … : "" — num() reads anything
// but a finite number as 0), so the plugin's whole job is to count the run
// the ledger shows, and to say nothing when it cannot see the whole run.

// daysBack is the Beijing date label `n` days before today, the shape
// streakOf walks over.
const daysBack = (n) =>
  new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400e3).toISOString().slice(0, 10)

test("the check-in reports the run of daily grants ending today", async () => {
  const records = [day(), day({ gmt_created: daysBack(1) }), day({ gmt_created: daysBack(2) })]
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000031" }))
      assert.equal(r.outcome, "done")
      assert.equal(r.streak, 3, `three days in a row: ${JSON.stringify(r)}`)
    },
  )
})

test("a day without a grant ends the run, and what came before it is not counted", async () => {
  // today, no grant yesterday, grants on the two days before: the run is 1,
  // not 3 — a streak counts consecutive days, not days.
  const records = [day(), day({ gmt_created: daysBack(2) }), day({ gmt_created: daysBack(3) })]
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000032" }))
      assert.equal(r.streak, 1, `a gap yesterday restarts the count: ${JSON.stringify(r)}`)
    },
  )
})

test("no run is reported for a ledger holding yesterday's grant but not today's", async () => {
  // The hooks only ask for a streak on done/claimed, where today's grant is
  // in hand. Called with a page that stops yesterday, the answer is "not
  // known" — counting from yesterday would print a run that is not today's.
  assert.equal(
    await streakOf([day({ gmt_created: daysBack(1) })], today, 1, null, Date.now() + 1000),
    undefined,
  )
  assert.equal(await streakOf([day()], today, 1, null, Date.now() + 1000), 1, "today alone is a 1-day run")
})

test("a claim that just landed reports the streak from the page it landed on", async () => {
  // the claimed path reads the ledger again after the touch; the run has to
  // come from that read, not from the empty one before it.
  const real = globalThis.fetch
  let reads = 0
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    reads += 1
    const records = reads === 1 ? [] : [day(), day({ gmt_created: daysBack(1) })]
    return reply({ body: { success: true, data: { records } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000033" }))
    assert.equal(r.outcome, "claimed", r.message)
    assert.equal(r.streak, 2, `today and yesterday: ${JSON.stringify(r)}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a run that continues past page 1 is followed onto page 2", async () => {
  // The live account this was written for: page 1 is full (50 rows, 16 days)
  // and its oldest row is still a daily grant, with one more row on page 2.
  // `total` is what says page 2 exists; the run's end is only there.
  const first = Array.from({ length: 50 }, (_, i) => day({ gmt_created: daysBack(i) }))
  const second = Array.from({ length: 10 }, (_, i) => day({ gmt_created: daysBack(50 + i) }))
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    seen.push(u.searchParams.get("page"))
    const page = Number(u.searchParams.get("page"))
    return reply({
      body: { success: true, data: { page, page_size: 50, total: 60, records: page === 1 ? first : second } },
    })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000034" }))
    assert.equal(r.outcome, "done")
    assert.equal(r.streak, 60, `the run runs onto page 2: ${JSON.stringify(r)}`)
    assert.deepEqual(seen, ["1", "2"], `page 2 is read once, not once per walk step: ${seen}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a page whose total is its own row count is the whole ledger, and no second page is asked for", async () => {
  // 50 rows in the ledger, 50 on the page: the run really does end at the
  // oldest row, and the streak is exact — no extra request to prove it.
  const records = Array.from({ length: 50 }, (_, i) => day({ gmt_created: daysBack(i) }))
  const real = globalThis.fetch
  let ledgerReads = 0
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    ledgerReads += 1
    return reply({ body: { success: true, data: { page: 1, page_size: 50, total: 50, records } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000035" }))
    assert.equal(r.streak, 50, `a complete ledger gives an exact run: ${JSON.stringify(r)}`)
    assert.equal(ledgerReads, 1, "a complete page needs no second read")
  } finally {
    globalThis.fetch = real
  }
})

test("a page that cannot be read leaves the streak unsaid, and the check-in still answers", async () => {
  // A 403 on page 2 says nothing about the claim that already landed. The
  // streak is dropped; the answer keeps its outcome and credit, and the host
  // must not be handed a failure for a day that was claimed.
  const first = Array.from({ length: 50 }, (_, i) => day({ gmt_created: daysBack(i) }))
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    if (u.searchParams.get("page") === "2") return reply({ status: 403, body: { message: "forbidden" } })
    return reply({ body: { success: true, data: { page: 1, page_size: 50, total: 90, records: first } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000036" }))
    assert.equal(r.outcome, "done", `the claim stands: ${JSON.stringify(r)}`)
    assert.equal(r.streak, undefined, `a run it could not see the end of is not a streak: ${JSON.stringify(r)}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a run longer than the pages the walk may read is left unsaid", async () => {
  // STREAK_PAGES stops the walk; what it saw by then is a floor, not the run.
  // 50 grants a page, a thousand rows in the ledger: the walk stops at page 8.
  const real = globalThis.fetch
  let ledgerReads = 0
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    ledgerReads += 1
    const page = Number(u.searchParams.get("page"))
    const records = Array.from({ length: 50 }, (_, i) => day({ gmt_created: daysBack((page - 1) * 50 + i) }))
    return reply({ body: { success: true, data: { page, page_size: 50, total: 1000, records } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000037" }))
    assert.equal(r.streak, undefined, `a run past the page cap is not a streak: ${JSON.stringify(r)}`)
    assert.equal(ledgerReads, 8, `the walk stops at STREAK_PAGES: ${ledgerReads}`)
  } finally {
    globalThis.fetch = real
  }
})

test("an empty page while total still counts rows leaves the run unsaid", async () => {
  // `total` said 60 rows, 50 came back, and page 2 answers with nothing: the
  // ledger contradicts itself. Cutting the run at the page boundary would
  // print a number the plugin has no reason to believe; the streak is dropped.
  const first = Array.from({ length: 50 }, (_, i) => day({ gmt_created: daysBack(i) }))
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    const page = Number(u.searchParams.get("page"))
    return reply({
      body: { success: true, data: { page, page_size: 50, total: 60, records: page === 1 ? first : [] } },
    })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000039" }))
    assert.equal(r.outcome, "done", `the claim stands: ${JSON.stringify(r)}`)
    assert.equal(r.streak, undefined, `an empty page is not the end of the run: ${JSON.stringify(r)}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a gap inside a full page still ends the run, and the count is kept", async () => {
  // the truncation cases above must not swallow the ordinary one: with a real
  // gap in view — rows older than the gap are on the page — the run is known,
  // and a page with more behind it does not change that. No second page is
  // read to prove it.
  const records = [
    day(),
    day({ gmt_created: daysBack(1) }),
    ...Array.from({ length: 48 }, (_, i) => day({ gmt_created: daysBack(i + 3) })),
  ]
  const real = globalThis.fetch
  let ledgerReads = 0
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    }
    ledgerReads += 1
    return reply({ body: { success: true, data: { page: 1, page_size: 50, total: 100, records } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-streak-0000-0000-0000-000000000038" }))
    assert.equal(r.streak, 2, `today and yesterday, then a gap: ${JSON.stringify(r)}`)
    assert.equal(ledgerReads, 1, "a gap in view needs no second read")
  } finally {
    globalThis.fetch = real
  }
})

test("checkin reports inactive when nothing is granted", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: {} } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "inactive")
    },
  )
})

test("a refused token fails the check-in as expired", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 401, body: { message: "unauthorized" } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-bad" }))
      assert.equal(r.outcome, "failed")
      assert.equal(r.signIn, "expired")
    },
  )
})

test("a token refused at login/info expires the check-in too", async () => {
  // the ledger read comes first; when it succeeds the login/info read is the
  // one that finds the token dead, and its 401 has to expire the account the
  // same way — otherwise magpie keeps re-asking with a dead token
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { status: 401, body: { message: "unauthorized" } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-bad" }))
      assert.equal(r.outcome, "failed")
      assert.equal(r.signIn, "expired")
    },
  )
})

test("a check-in that cannot read the ledger fails rather than settling the day", async () => {
  // a proxy's error page or a changed API is not an empty ledger. Read as
  // empty it would answer inactive, which magpie takes as the day being
  // settled — the day's claim would be lost with no retry.
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { raw: "<html>proxy error</html>" },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed", "an unreadable ledger must not read as inactive")
    },
  )
})

test("a check-in envelope that is not a success fails, not settles", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: false, message: "bad request" } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      assert.match(r.message, /bad request/)
    },
  )
})

test("a check-in 403 is risk control too, and does not sign the account out", async () => {
  // the check-in touches login/info, whose 403 is also risk control: marking
  // it expired would sign out an account that is perfectly fine. The touch's
  // wording also carries the retry it can promise (the host asks again in
  // 30 minutes) — usage's two reads do not, since nothing there is retried
  // by this hook; that suffix is the one difference between the two 403
  // messages, and it has its own assertion below.
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { status: 403, body: { success: false, code: "RiskControl" } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      assert.match(r.message, /风控/)
      assert.match(r.message, /HTTP 403/, `the card names the status code: ${r.message}`)
      assert.match(r.message, /稍后会自动重试/, `the touch names the retry it can promise: ${r.message}`)
      assert.notEqual(r.signIn, "expired", "a 403 is not a bad token")
    },
  )
})

test("checkin without a sign-in fails instead of asking", async () => {
  const r = await auth.checkin(async () => ({}))
  assert.equal(r.outcome, "failed")})

test("usage reads the balance and the day's ledger, and never the sign-in endpoint", async () => {
  const body = {
    success: true,
    data: {
      records: [
        day(),
        day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 }),
        spend(330, 165),
      ],
    },
  }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0, total_balance: 0, frozen_amount: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async (fetch) => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.equal(w.name, "魔粒")
      assert.equal(w.amount, 330)
      assert.equal(w.limit, 250)
      // 330 spent of 250 granted with nothing left: over 100 means overspent,
      // not capped
      assert.ok(w.used > 100, `used should exceed 100, got ${w.used}`)
      // and the exact number is the ratio to two decimals — 33000/250, the
      // scale written `* 10001` reads 132.01 next to the same 330 and 250
      assert.equal(w.used, Math.round((330 / 250) * 10000) / 100)
      // the window runs a day; span written 86401 drifts a second a day
      assert.equal(w.span, 86400, "the window's span is the day it runs")
      assert.match(w.display, /余额 0/)
      assert.equal(fetch.calls.some((c) => c.includes("login/info")), false)
    },
  )
})

test("usage reports the daily grant as used up when nothing is left", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].used, 100)
    },
  )
})

test("a ModelScope time is parsed as Beijing time, whatever the host's zone", async () => {
  const body = { success: true, data: { records: [day({ expire_at: `${tomorrow} 00:00:24` })] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 250 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      // <tomorrow> 00:00:24 +08:00 is the day before at 16:00:24Z
      const want = new Date(`${tomorrow}T00:00:24+08:00`).toISOString()
      assert.equal(u.windows[0].resetsAt, want)
    },
  )
})

test("usage without a sign-in says so, as an error and not a rejection", async () => {
  // the host reads usage for the card and has nothing to catch a throw with:
  // the hook answers {error} even when the hand-over itself is broken
  const u = await auth.usage(async () => ({}))
  assert.ok(u.error, "an object with an error, not a rejection")
  const r = await auth.usage(async () => {
    throw new Error("gone")
  })
  assert.match(r.error, /gone/)
  assert.equal(r.signIn, "", "a plain failure does not mark the sign-in expired")
})

// withMockTimers guards the three tests that move the clock. t.mock.timers
// exists from node 18.19 and 20.4; the shipped code does not need it, but a
// user on an older patch would see these three go red on a tree that works,
// which reads as a broken plugin. Skipped out loud, the way sync.test.mjs
// skips a platform without symlinks — the reason shows in the run.
const withMockTimers = (t) => {
  if (t.mock?.timers?.enable) return true
  t.skip("t.mock.timers needs node 18.19+ or 20.4+")
  return false
}

test("a whole check-in gives up at its own budget, not per request", { timeout: 8000 }, async (t) => {
  // magpie runs every provider's check-ins under one two-minute context, one
  // account at a time: four 8-second requests inside one hook would take 32s
  // and starve the accounts after it. The hook's own 25s budget is what keeps
  // one slow account from doing that.
  if (!withMockTimers(t)) return
  const real = globalThis.fetch
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  // each request answers after 7s — under the per-request cap, over the budget
  // (the budget reads Date.now(), which the mock timer does not move: advance
  // both together, as a slower clock would)
  const realNow = Date.now
  let at = realNow()
  Date.now = () => at
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(reply({ body: { success: true, data: { records: [] } } })), 7000)
      init.signal.addEventListener("abort", () => {
        clearTimeout(t)
        reject(init.signal.reason ?? new Error("aborted"))
      }, { once: true })
    })
  try {
    const pending = auth.checkin(async () => ({ type: "api", key: "ms-budget" }))
    await new Promise((resolve) => setImmediate(resolve))
    // step past the 25s budget; whatever requests were left are cut
    for (let i = 0; i < 4; i++) {
      at += 7000
      t.mock.timers.tick(7000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    const r = await pending
    assert.equal(r.outcome, "failed", "a hook over its budget answers failed")
  } finally {
    Date.now = realNow
    globalThis.fetch = real
  }
})

test("a request that hangs gives up instead of holding the host", { timeout: 8000 }, async (t) => {
  if (!withMockTimers(t)) return
  const real = globalThis.fetch
  // Node 20.4 took the object form ({ apis: […] }); 18.19 and 20.0–20.3 only
  // know the array form, and the array form on 20+ mocks setImmediate too,
  // which the wait below needs. Try the newer shape, fall back for the older.
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true })
    })
  try {
    const pending = auth.usage(async () => ({ type: "api", key: "ms-test" }))
    // let the request reach its setTimeout before the clock is moved
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(20001)
    const u = await pending
    // usage reports rather than throws
    assert.ok(u.error, "usage should report the failure")
  } finally {
    globalThis.fetch = real
  }
})

test("a 200 that isn't ModelScope's answer is a failure, not an empty balance", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { raw: "<html>proxy error</html>" },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { raw: "<html>proxy error</html>" },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "usage should report the failure")
      assert.equal(u.windows, undefined, "no window: a zero balance would read as used up")
    },
  )
})

test("a JSON body without ModelScope's envelope is a failure too", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { data: { available_balance: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "usage should report the failure")
    },
  )
})


test("an account whose grant has not landed yet is asked again, not written off", async () => {
  // the ledger answers empty twice, then has the grant: the grant was late
  let reads = 0
  const grants = { success: true, data: { records: [day(), day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 })] } }
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    reads += 1
    return reply({ body: reads >= 3 ? grants : { success: true, data: { records: [] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 250)
  } finally {
    globalThis.fetch = real
  }
})

test("a remote message cannot forge a log line or drive the terminal", async () => {
  // the server's own strings end up in magpie's log and on a terminal; a
  // newline or an escape sequence from there is not ours to trust
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: false, message: "bad\u001b[31mred\n2026-10-23 00:00:00 FAKE LOG LINE" } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "still a failure")
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(u.error), false, `control characters survived: ${JSON.stringify(u.error)}`)
      assert.match(u.error, /red/, "the visible text is kept")
    },
  )
})

test("a grant's title from the ledger is sanitized before it reaches the card", async () => {
  const nasty = day({ title: "注册并登录\u001b]0;pwned\u0007\nFAKE" })
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [nasty] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "ali\nc e" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done")
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(r.message), false, `control characters survived: ${JSON.stringify(r.message)}`)
    },
  )
})

test("a bidi override and a forged amount from the ledger are sanitized too", async () => {
  // a nickname that reads one way and another under an RLO, and a grant whose
  // amount is not a number but a string carrying its own log line: both reach
  // the card through fields the plugin renders, so both must be neutralized
  const nasty = day({ title: "注册并登录", total_amount: "1\u001b]0;pwned\u0007\nFAKE" })
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [nasty] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "ali\u202ecec\nFAKE" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      // the amount is not a number, so nothing sums it: it is dropped rather
      // than echoed, and no control byte or bidi override survives anywhere
      assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(r.message), false,
        `invisible characters survived: ${JSON.stringify(r.message)}`)

      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(/[\u202e]/.test(JSON.stringify(u)), false, "the nickname reached the card with its override intact")
    },
  )
})

test("a ledger whose records is not a list is a failure, not a crash", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 1 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: { nope: true } } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "a body without a real ledger is not a balance of zero")
      assert.doesNotMatch(u.error, /is not a function/, "an internal error must not reach the card")
    },
  )
})

test("a token with a line break in it is refused before it can be echoed", async () => {
  const real = globalThis.fetch
  let asked = 0
  globalThis.fetch = async () => {
    asked += 1
    return reply({ body: { success: true, data: { available_balance: 1 } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-abc\nINJECTED" }))
    assert.equal(r.outcome, "failed")
    assert.equal(asked, 0, "no request should have been made with an unusable token")
    assert.equal(r.message.includes("INJECTED"), false, "the token must not reach the message")
  } finally {
    globalThis.fetch = real
  }
})

test("a 403 is risk control, not a token that expired", async () => {
  // both 403 sites have to be reached: the balance read first, then the
  // ledger. A fixture that only refuses the ledger never gets past the
  // balance, so the ledger's own 403 was never exercised.
  for (const at of ["balance", "transactions"]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance":
          at === "balance"
            ? { status: 403, body: { success: false, code: "RiskControl" } }
            : { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50":
          at === "transactions"
            ? { status: 403, body: { success: false, code: "RiskControl" } }
            : { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.ok(u.error, `usage should report the refusal at ${at}`)
        assert.match(u.error, /风控/, `${at}: the message should name the refusal`)
        assert.match(u.error, /HTTP 403/, `${at}: and the status code the README promises: ${u.error}`)
        assert.equal(u.signIn, "", `${at}: a 403 must not mark the sign-in expired`)
      },
    )
  }
})

test("a response too large to read is refused", async () => {
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { bytes: new Uint8Array(300 * 1024) },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "usage should report the refusal")
      assert.match(u.error, /过大/)
    },
  )
})

test("a body over the cap is cut off while it is read, with no length to check first", async () => {
  // a chunked answer has no content-length, so the only guard left is the
  // running byte count: without it the whole body is buffered
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { noLength: true, bytes: new Uint8Array(300 * 1024) },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error ?? "", /过大/, "the running count has to stop it")
    },
  )
})

test("the cap counts bytes, whichever way the body arrives", async () => {
  // 100k Chinese characters are 300KB on the wire but only 100k UTF-16 units:
  // a cap compared against text.length lets three times the limit through.
  // Both branches of readBounded have to agree on the unit.
  const big = "中".repeat(100_000)
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { noBody: true, raw: big, noLength: true },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error ?? "", /过大/, "300KB of text must not pass a 256KiB cap")
    },
  )
})

test("the body cap is 256 KiB: one byte over is refused, the cap itself is not", async () => {
  // The README states the number ("read to at most 256 KiB"), so the boundary
  // is a promise, not an implementation detail. A cap written 257 KiB lets a
  // 256 KiB + 1 body through; one written `>=` refuses the cap itself. Both
  // are one-character edits no other test distinguishes — 300KB fixtures pass
  // under every one of them.
  const CAP = 256 * 1024
  const real = globalThis.fetch
  // the declared-length branch, then the streaming one with no length to
  // check first — the same boundary, one byte apart, on each
  for (const streamed of [false, true]) {
    for (const [bytes, refused] of [
      [CAP, false],
      [CAP + 1, true],
    ]) {
      globalThis.fetch = async (url) => {
        if (!String(url).includes("balance")) return reply({ body: { success: true, data: { records: [] } } })
        if (streamed) return reply({ noLength: true, bytes: new Uint8Array(bytes) })
        return {
          status: 200,
          headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(bytes) : null) },
          body: null,
          text: async () => "x".repeat(bytes),
        }
      }
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const why = `${streamed ? "streamed " : ""}${bytes} bytes`
      if (refused) assert.match(u.error ?? "", /过大/, `${why} is over the cap: ${u.error}`)
      // the body is not JSON, so it fails either way — what matters is which
      // way: a size refusal names the size, the parse failure does not
      else assert.doesNotMatch(u.error ?? "", /过大/, `${why} is the cap itself, not over it: ${u.error}`)
    }
  }
  globalThis.fetch = real
})

// ── The check-in window ───────────────────────────────────────────────
// failed is the only outcome the host retries: an answer before the target
// must be failed — anything else and the day is never asked again. That
// before-target pass must not send any request.
test("before the window the check-in asks for nothing and answers failed", async () => {
  await withWindow(["08:30", "10:00"], `${today} 07:00:00`, async () => {
    let asked = 0
    const real = globalThis.fetch
    globalThis.fetch = async () => {
      asked += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      assert.match(r.message, /后自动领取/)
      // the minute is Beijing's; a host in another zone must be told so
      assert.match(r.message, /（北京时间，/, `the wait line names its zone: ${r.message}`)
      const m = /^(\d{2}):(\d{2}) 后自动领取/.exec(r.message)
      assert.ok(m, `the message says when today's claim will run: ${r.message}`)
      const at = +m[1] * 60 + +m[2]
      assert.ok(at >= 8 * 60 + 30 && at < 10 * 60, `the target ${m[1]}:${m[2]} is inside 08:30-10:00`)
      assert.equal(asked, 0, "nothing may be sent before the window")
    } finally {
      globalThis.fetch = real
    }
  })
})

test("after the window opens the check-in claims as usual", async () => {
  // 10:00 is past every target in [08:30, 10:00), whatever the day's hash
  await withWindow(["08:30", "10:00"], `${today} 10:00:00`, async () => {
    // the claim's own target falls anywhere in the window; 09:59 is after
    // every one of them only if the window ends at 10:00 — assert the gate
    // passes by driving a full claim.
    const body = { success: true, data: { records: [day(), day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 })] } }
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
        // today already has daily_active, so past the gate it settles as done
        assert.equal(r.outcome, "done")
        assert.match(r.message, /已领取/)
      },
    )
  })
})

test('checkinWindow written as "off" turns the window off too', async () => {
  // false and "off" are the same intent; read as a string of two clock times
  // the latter would silently fall back to the default window instead
  await withWindow("off", `${today} 02:00:00`, async () => {
    const body = { success: true, data: { records: [day()] } }
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-off" }))
        assert.equal(r.outcome, "done", `a string "off" must turn the window off, got ${r.message}`)
      },
    )
  })
})

test("checkinWindow off claims at once, as if there were no window", async () => {
  await withWindow(false, `${today} 02:00:00`, async () => {
    const body = { success: true, data: { records: [day()] } }
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(r.outcome, "done", "off means the claim runs whenever magpie asks")
      },
    )
  })
})

test("the window is read from the folder magpie reports, not a guessed one", async () => {
  // a portable magpie keeps its files in its data folder, not ~/.config/magpie;
  // a config read from the guessed path would be ignored without a word
  const dir = tmpDir("msmoli-portable-")
  const file = join(dir, "msmoli.json")
  writeFileSync(file, JSON.stringify({ checkinWindow: ["13:00", "14:00"] }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const portable = await MsmoliPlugin({ directory: dir })
    const at = Date.parse(`${today} 12:00:00`.replace(" ", "T") + "+08:00")
    const realNow = Date.now
    Date.now = () => at
    let asked = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      asked += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      const r = await portable.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      const t = targetFrom(r.message)
      assert.ok(
        t.minute >= 13 * 60 && t.minute < 14 * 60,
        `the target ${t.text} came from input.directory, not a guessed one`,
      )
      assert.equal(asked, 0)
    } finally {
      Date.now = realNow
      globalThis.fetch = realFetch
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a config file that is not JSON, or not an object, is the default window", async () => {
  // the file is hand-edited by users; a stray comma or a JSON array must not
  // make the plugin stop claiming — it reads as "no overrides at all"
  const dir = tmpDir("msmoli-bad-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  const realNow = Date.now
  try {
    for (const junk of ['{"checkinWindow": ["13:00",', "[1,2,3]", "null", "", "false", '"08:30-10:00"']) {
      writeFileSync(join(dir, "msmoli.json"), junk)
      const p = await MsmoliPlugin({ directory: dir })
      Date.now = () => Date.parse(`${today} 02:00:00`.replace(" ", "T") + "+08:00")
      const r = await p.auth.checkin(async () => ({ type: "api", key: "ms-bad" }))
      // 02:00 is before any default window; all of these must still answer
      // with the default window rather than claiming or throwing
      assert.equal(r.outcome, "failed", `junk config ${JSON.stringify(junk)} must not crash or claim`)
      const t = targetFrom(r.message)
      assert.ok(
        t.minute >= 8 * 60 + 30 && t.minute < 10 * 60,
        `junk config ${JSON.stringify(junk)} must read as the default, not ${t.text}`,
      )
    }
  } finally {
    Date.now = realNow
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("an unusable window falls back to the default instead of never claiming", async () => {
  // start after end: honored, the account would never be due — so the default
  await withWindow(["10:00", "08:30"], `${today} 02:00:00`, async () => {
    let asked = 0
    const real = globalThis.fetch
    globalThis.fetch = async () => {
      asked += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      // 02:00 is before the default window's earliest moment (08:30)
      const t = targetFrom(r.message)
      assert.ok(
        t.minute >= 8 * 60 + 30 && t.minute < 10 * 60,
        `the target ${t.text} came from the default window, not the broken one`,
      )
      assert.equal(asked, 0)
    } finally {
      globalThis.fetch = real
    }
  })
})

test("the window written as one string is honored, not ignored", async () => {
  // "13:00-14:00" is a different window from the default, so this tells the
  // string form apart from "unreadable value": 12:00 is outside it but inside
  // 08:30-10:00, and 13:30 is inside it.
  const count = async (cn) => {
    let asked = 0
    const real = globalThis.fetch
    globalThis.fetch = async () => {
      asked += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      return { asked, r }
    } finally {
      globalThis.fetch = real
    }
  }

  await withWindow("13:00-14:00", `${today} 12:00:00`, async () => {
    const { asked, r } = await count()
    assert.equal(r.outcome, "failed")
    const t = targetFrom(r.message)
    assert.ok(
      t.minute >= 13 * 60 && t.minute < 14 * 60,
      `the target ${t.text} came from the window written as one string`,
    )
    assert.equal(asked, 0)
  })

  // 14:30 is past every target in 13:00-14:00, so the claim must run there.
  await withWindow("13:00-14:00", `${today} 14:30:00`, async () => {
    const { asked } = await count()
    assert.ok(asked > 0, "once the window has passed the claim runs")
  })
})

test("a window reaching into the late evening is capped, so a failed ask still has a retry", async () => {
  // the host asks again 30 minutes after a failure; a target in the last half
  // hour of the day has no ask left before the day (and the target) resets, so
  // the claim would be lost and the card would read failed until midnight
  const dir = tmpDir("msmoli-late-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: ["22:00", "23:59"] }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const late = await MsmoliPlugin({ directory: dir })
    const realNow = Date.now
    const realFetch = globalThis.fetch
    // ask from the first minute of the day: before any target in the window
    Date.now = () => Date.parse(`${today} 00:01:00`.replace(" ", "T") + "+08:00")
    globalThis.fetch = async () => reply({ body: { success: true, data: { records: [] } } })
    let target
    try {
      const r = await late.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      target = await targetOf(late.auth.checkin)
      assert.ok(target.minute <= 23 * 60, `target ${target.text} must leave a retry ask before midnight`)
      assert.ok(target.minute >= 22 * 60, `target ${target.text} must stay inside the configured start`)
    } finally {
      Date.now = realNow
      globalThis.fetch = realFetch
    }
    // one minute past that target the claim is due, on the same day
    const late2 = Date.parse(`${today} ${target.text}:00`.replace(" ", "T") + "+08:00") + 60e3
    Date.now = () => late2
    let asked = 0
    globalThis.fetch = async () => {
      asked += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      await late.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(asked > 0, "a capped window must still claim on its own day")
    } finally {
      Date.now = realNow
      globalThis.fetch = realFetch
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("two tokens are two accounts: own target, own name, no bleed", async () => {
  // magpie keeps the first sign-in as `msmoli` and later ones as
  // `msmoli#xxxxxx`, and asks the check-in once per account, handing each
  // its own token. The hash is over the day and the token, so two accounts
  // must not land on the same minute, and one's name must not show on the
  // other's row.
  const dir = tmpDir("msmoli-two-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: ["08:30", "10:00"] }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const two = await MsmoliPlugin({ directory: dir })
    const A = "ms-aaaa1111-0000-0000-0000-000000000001"
    const B = "ms-bbbb2222-0000-0000-0000-000000000002"
    const at = Date.parse(`${today} 07:00:00`.replace(" ", "T") + "+08:00")
    const realNow = Date.now
    Date.now = () => at
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => reply({ body: { success: true, data: { records: [] } } })
    try {
      const ask = async (tok) => {
        const r = await two.auth.checkin(async () => ({ type: "api", key: tok }))
        const m = /^(\d{2}):(\d{2}) 后自动领取/.exec(r.message)
        return m ? `${m[1]}:${m[2]}` : null
      }
      const ta = await ask(A)
      const tb = await ask(B)
      assert.ok(ta && tb, `both accounts should report a target: ${ta} / ${tb}`)
      assert.notEqual(ta, tb, `two accounts must not share a target (both ${ta})`)
    } finally {
      Date.now = realNow
      globalThis.fetch = realFetch
    }

    // the name read at check-in is keyed by token, so B never sees A's
    // A clock past the window is required here: before its target the
    // check-in answers failed without ever reaching login/info, so the name
    // would never be read — a test run in the morning would fail on that
    // alone (the suite did, at 08:24 Beijing).
    const past = Date.parse(`${today} 10:30:00`.replace(" ", "T") + "+08:00")
    Date.now = () => past
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes("/login/info")) return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
      if (u.includes("balance")) return reply({ body: { success: true, data: { available_balance: 5 } } })
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      await two.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      const ua = await two.auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const ub = await two.auth.usage(async () => ({ type: "api", key: B }))
      assert.equal(ua.user, "alice", "the account that checked in has its name")
      assert.equal(ub.user, "", "the other account must not borrow it")
    } finally {
      Date.now = realNow
      globalThis.fetch = realFetch
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("the name read at check-in is written back so the card can show it", async () => {
  // magpie labels an account by its accountId; an api-type sign-in has none,
  // so the card would read "API key …a1b2". The check-in is the one place the
  // name is known, so it writes it back — the same sign-in, the token once.
  const dir = tmpDir("msmoli-nm-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-nametest-0000-0000-0000-000000000009"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        // an auth the host might hand over with fields of its own
        await withClient.auth.checkin(async () => ({ type: "api", key: token, metadata: { kept: "yes" } }))
        assert.equal(writes.length, 1, "the name is written back once")
        const body = writes[0].body
        assert.equal(body.accountId, "Mison")
        assert.equal(body.key, token)
        // auth.set replaces the whole sign-in, so the kind has to be restated
        // here: dropped or mis-typed, the account comes back as a sign-in of a
        // type magpie has no renderer for.
        assert.equal(body.type, "api", "the write-back is still an api sign-in")
        assert.equal(JSON.stringify(body).split(token).length - 1, 1, "the token appears once, not twice")
        assert.equal(body.metadata?.kept, "yes", "fields the host already had are kept")

        // a second ask does not write again, and one already named is left alone
        await withClient.auth.checkin(async () => ({ type: "api", key: token, accountId: "Mison" }))
        assert.equal(writes.length, 1, "nothing new to write")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a sign-in that is not an object is not spread into the write-back", async () => {
  // auth.set replaces the whole sign-in, so the host's own fields are kept —
  // but only when what the host handed over is an object. `typeof` is what
  // draws that line: a callable carrying auth fields is not a sign-in, and
  // spreading one would copy whatever it carries onto the account's sign-in.
  const dir = tmpDir("msmoli-fnauth-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-fn-0000-0000-0000-000000000026"
    const handOver = () => {}
    handOver.type = "api"
    handOver.key = token
    handOver.stray = "not a field of the sign-in"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => handOver)
        assert.equal(writes.length, 1, "the nickname is still written back")
        assert.equal(writes[0].body.accountId, "Mison")
        assert.equal(writes[0].body.stray, undefined, "a callable is not a sign-in to spread")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an account the user already named is not renamed under them", async () => {
  // magpie keeps an alias under the account's label of the moment. Writing the
  // nickname over an account whose label the user has aliased would leave the
  // alias keyed to a label nothing carries: the name would silently vanish
  // from the card.
  const dir = tmpDir("msmoli-al-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-nametest-0000-0000-0000-000000000010"
  const label = "API key …0010"
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ providers: [{ id: "msmoli", accountNames: { [label.toLowerCase()]: "主号" } }] }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, "the user's own name is left alone")

        // once the alias is gone, the nickname is written as usual
        writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "msmoli" }] }))
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 1, "with no alias, the nickname is written")
        assert.equal(writes[0].body.accountId, "Mison")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a providers.json with a BOM is read, not kept from being written back", async () => {
  // Notepad and PowerShell's Out-File write a BOM into JSON on Windows, and
  // magpie's own #1821 is about that. aliasOf reads providers.json with its
  // own BOM strip — the same rule configOf has — and losing it makes a file
  // that parses look unreadable: aliasOf answers "could not look", the
  // nickname is never written back, and nothing says why.
  const dir = tmpDir("msmoli-aliasbom-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(join(dir, "providers.json"), "﻿" + JSON.stringify({ providers: [{ id: "msmoli" }] }))
  const token = "ms-aliasbom-0000-0000-0000-000000000027"
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 1, "a BOM must not read as an unreadable file: the name is written back")
        assert.equal(writes[0].body.accountId, "Mison")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the usage card says when the day's claim will run", async () => {
  await withWindow(["08:30", "10:00"], `${today} 07:30:00`, async () => {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        // the card's own reset time is the machine's zone; this one is Beijing's
        assert.match(u.windows[0].display, /· 0[89]:\d\d 领取（北京时间）/)
      },
    )
  })
})

test("the same account's target minute is stable within a day", async () => {
  // the host re-asks every 30 minutes; a target that moved between asks would
  // make the window meaningless
  await withWindow(["08:30", "10:00"], `${today} 06:00:00`, async () => {
    const seen = new Set()
    const real = globalThis.fetch
    globalThis.fetch = async () => reply({ body: { success: true, data: { records: [] } } })
    try {
      for (let i = 0; i < 6; i++) {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-stable" }))
        const m = /^(\d{2}:\d{2}) 后自动领取/.exec(r.message)
        assert.ok(m, `message should carry the target: ${r.message}`)
        seen.add(m[1])
      }
      assert.equal(seen.size, 1, `one target per day per account, saw ${[...seen]}`)
    } finally {
      globalThis.fetch = real
    }
  })
})

// ── Review round two: invisible characters, a token posing as a nickname,
// non-finite numbers ─────────────────────────────────────────────
test("invisible characters in a nickname never reach the written-back name", async () => {
  // U+200B/200D (zero-width), U+2060 (word joiner), U+061C (ALM) and the tag
  // characters U+E0000–E007F all survived the earlier sanitizer: two accounts
  // could be made to look identical on the card, and tags can carry hidden data
  const dir = tmpDir("msmoli-zw-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-zwtest-0000-0000-0000-000000000011"
    const nasty = "Mi​so⁠n؜\u{E0041}"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: nasty } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 1)
        const id = writes[0].body.accountId
        assert.equal(/\p{Cf}/u.test(id), false, `invisible characters survived: ${JSON.stringify(id)}`)
        assert.match(id, /Mi/)
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a nickname that is the token itself is not written back", async () => {
  const dir = tmpDir("msmoli-tokname-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-tokname-0000-0000-0000-000000000012"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: token } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, "a server that echoes the token back must not get it stored as a name")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a non-finite amount from the server never reaches the card", async () => {
  // Number("1e400") is Infinity: a balance we cannot read is not a balance,
  // and it must not show as an Infinity balance or as zero either
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: "1e400" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error ?? "", /不是数字|没有 available_balance/, `should refuse the balance: ${u.error}`)
      assert.ok(!u.windows, "no card is built from a balance we did not understand")
    },
  )
  // a ledger row's amount is summed, and an unreadable one is a body we do
  // not understand: read as 0 it would say it claimed 0 beside a balance
  // that moved
  const body = { success: true, data: { records: [day({ total_amount: "1e400" }), spend("1e400")] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error ?? "", /total_amount 不是数字/, `should refuse the row's amount: ${u.error}`)
      assert.ok(!u.windows, "no card is built from a ledger we did not understand")
    },
  )
})

test("a ledger with a refund in it never shows a negative day", async () => {
  // a refund is recorded as a negative SPEND_CONFIRM. Summed as it comes, the
  // card would read today's spend as -50 against a claim of 200, with a
  // negative percentage.
  const body = { success: true, data: { records: [day(), spend(200), spend(-250)] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 300 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.equal(w.amount, 0, `spend must not go negative, got ${w.amount}`)
      assert.equal(w.used, 0)
      assert.doesNotMatch(u.windows[0].display, /-/, "no minus sign in the day's line")
    },
  )
})

test("a non-Error rejection says something, not [object Object]", async () => {
  // getAuth can reject with anything the host hands over; String() of a bare
  // object reads as "[object Object]" on the card, which looks like the
  // plugin broke rather than the sign-in being unusable
  const u = await auth.usage(async () => {
    throw { code: 42 }
  })
  assert.ok(u.error, "it must report an error")
  assert.doesNotMatch(u.error, /\[object/, `the message was ${JSON.stringify(u.error)}`)

  const plain = await auth.usage(async () => {
    throw "no hand-over"
  })
  assert.equal(plain.error, "no hand-over", "a string rejection is its own message")
})

test("a spent budget sends no request at all", async () => {
  // a request that is not sent cannot be recorded upstream; one sent with no
  // budget left is answered after the hook the host already gave up on. Both
  // the whole budget gone and exactly zero left must send nothing: `left <= 0`
  // written `< 0` sends the ledger read with a 0 ms budget, and a budget of
  // 19 seconds (or 18.018) leaves 1 s (18 ms) for a read that then goes out.
  for (const spent of [18_000, 60_000]) {
    const realFetch = globalThis.fetch
    const realNow = Date.now
    let clock = Date.parse(`${today} 10:30:00`.replace(" ", "T") + "+08:00")
    Date.now = () => clock
    const asked = []
    globalThis.fetch = async (url) => {
      asked.push(new URL(url).pathname)
      clock += spent // this one answer outlasts the hook's whole budget
      return reply({ body: { success: true, data: { available_balance: 300 } } })
    }
    try {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, `usage must fail rather than answer (spent ${spent} ms)`)
    } finally {
      globalThis.fetch = realFetch
      Date.now = realNow
    }
    assert.deepEqual(asked, ["/openapi/v1/magicubes/balance"], `no request may go out with the budget gone (spent ${spent} ms)`)
  }
})

test("a check-in whose first read spends the whole budget sends no touch", async () => {
  // the check-in's own 25-second budget, to the millisecond: the ledger read
  // is answered at exactly deadline, so the touch has nothing left. A budget
  // of 26 seconds leaves 1 s and the touch goes out; 25.025 leaves 25 ms.
  const realFetch = globalThis.fetch
  const realNow = Date.now
  let clock = Date.parse(`${today} 10:30:00`.replace(" ", "T") + "+08:00")
  Date.now = () => clock
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(new URL(url).pathname)
    clock += 25_000 // this one answer spends the whole check-in budget
    return reply({ body: { success: true, data: { records: [] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "failed", "a check-in that never reached the touch has failed")
    assert.match(r.message, /预算已用完/, `the card should say the budget ran out: ${r.message}`)
  } finally {
    globalThis.fetch = realFetch
    Date.now = realNow
  }
  assert.deepEqual(asked, ["/openapi/v1/magicubes/transactions"], "the touch must not go out with the budget gone")
})

test("the check-in budget is 25 seconds: one fewer still has a millisecond left", async () => {
  // The test above answers at *exactly* the deadline, so a 24-second budget
  // refuses the touch there just as 25 does — and so would 24.999. Only a
  // spend just short of 25 s tells them apart: at 24_999 ms there is 1 ms
  // left, `left <= 0` is false, and the touch goes out. The constant is
  // documented as 25 seconds, and the README says so.
  for (const [spend, wantTouch] of [
    [24_999, true],
    [25_000, false],
  ]) {
    const realFetch = globalThis.fetch
    const realNow = Date.now
    let clock = Date.parse(`${today} 10:30:00`.replace(" ", "T") + "+08:00")
    Date.now = () => clock
    const asked = []
    globalThis.fetch = async (url) => {
      asked.push(new URL(url).pathname)
      clock += spend
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    } finally {
      globalThis.fetch = realFetch
      Date.now = realNow
    }
    const touched = asked.length > 1
    assert.equal(touched, wantTouch, `spending ${spend}ms of a 25s budget: touch sent = ${touched}`)
  }
})

// ── Window parsing: read windowOf directly, not the day's hash ────────
// The target instant is the hash of "day + account"; an end-to-end test of
// the LAST truncation only bites on days whose hash lands past 23:00
// (measured: about half the dates let the regression through). The
// truncation itself is a pure function — assert it directly.
test("the module exports no bare function the host would take for a plugin", async () => {
  // magpie's servers() takes every exported function as a plugin entry when
  // `default` is a function (which it is here), calls it with the plugin input
  // and reads hooks off the answer. A helper exported for the tests runs as a
  // second plugin that way; today it answers an object with no hooks and
  // nothing happens, but a throw from it is caught by the loader's per-plugin
  // try/catch and the whole package is reported as failed to load. Helpers
  // live on `testables`, which the loader skips because it is an object.
  //
  // Two entries are intended: the international site is a second provider over
  // the same hooks. Anything else appearing here is an accident.
  const mod = await import("../index.mjs")
  // exactly as servers() builds its list, de-dup included: the named export
  // `MsmoliPlugin` is the same function `default` is, and the Set keeps it
  // from running twice
  const seen = new Set()
  const entries = []
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue
    seen.add(v)
    if (typeof v === "function") entries.push(v)
  }
  assert.deepEqual(
    entries.map((f) => f.name).sort(),
    ["MsmoliPlugin"],
    `every exported function is run as a plugin entry; found ${entries.map((f) => f.name).join(", ")}`,
  )
  // and the one helper the tests need is still reachable
  assert.equal(typeof testables.windowOf, "function")
})

test("windowOf caps the end at 23:00, whatever the configured end", () => {
  for (const end of ["23:59", "23:30", "23:01"]) {
    const w = windowOf({ checkinWindow: ["22:00", end] })
    assert.equal(w?.end, 23 * 60, `end ${end} must be capped`)
  }
  // a start at or past the cap is not a window: the default applies
  assert.deepEqual(windowOf({ checkinWindow: ["23:10", "23:59"] }), { start: 8 * 60 + 30, end: 10 * 60 })
  // an ordinary window is left alone
  assert.deepEqual(windowOf({ checkinWindow: ["08:30", "10:00"] }), { start: 8 * 60 + 30, end: 10 * 60 })
  assert.deepEqual(windowOf({ checkinWindow: ["22:00", "23:00"] }), { start: 22 * 60, end: 23 * 60 })
  // and the default itself is the documented 08:30-10:00, not merely
  // somewhere near it: the window a config-less install gets is the one the
  // README names, and its end written one minute late is invisible to every
  // test that only says "inside the window"
  assert.deepEqual(windowOf({}), { start: 8 * 60 + 30, end: 10 * 60 }, "no setting at all is the documented default")
})

test("windowOf reads the shapes a user writes, and refuses the ones it cannot", () => {
  // every separator below is tried on a window that is *not* the default, so
  // a separator the split misses falls back to 08:30-10:00 and shows up here
  for (const sep of ["-", "~", "～", "–", "—", " 至 "]) {
    assert.deepEqual(
      windowOf({ checkinWindow: `13:00${sep}14:00` }),
      { start: 13 * 60, end: 14 * 60 },
      `"${sep}" must separate the two times`,
    )
  }
  assert.deepEqual(windowOf({ checkinWindow: "08:30-10:00" }), { start: 8 * 60 + 30, end: 10 * 60 })
  for (const off of [false, "off", "OFF", "false", "no"]) {
    assert.equal(windowOf({ checkinWindow: off }), null, `${JSON.stringify(off)} turns the window off`)
  }
  // each of these must come back as the default — and each must *not* be a
  // window of its own. ["8:30","10:00"] used to sit in this list, but one-digit
  // hours are read (minuteOf takes \d{1,2}), so it parses to exactly the
  // default and the assertion could not fail either way.
  // ["09:00","24:30"]: the end's hour is out of range but the start's is not,
  // so an hour bound widened from `> 23` to `> 24` honours 24:30 as a real
  // end (capped to 23:00) instead of falling back — a window the user never
  // named. The ["24:00","25:00"] pair above cannot see it: both ends fail,
  // and the fallback is reached through the other one.
  for (const bad of [["10:00", "08:30"], ["24:00", "25:00"], ["09:00", "24:30"], ["009:30", "10:00"], ["08:60", "10:00"], ["nope", "10:00"], [], null, 7]) {
    assert.deepEqual(windowOf({ checkinWindow: bad }), { start: 8 * 60 + 30, end: 10 * 60 }, `${JSON.stringify(bad)} falls back to the default`)
    assert.notDeepEqual(windowOf({ checkinWindow: bad }), { start: 13 * 60, end: 14 * 60 }, `${JSON.stringify(bad)} is not a window of its own`)
  }
  // a one-digit hour is a clock time, and reads as one
  assert.deepEqual(windowOf({ checkinWindow: ["8:30", "10:00"] }), { start: 8 * 60 + 30, end: 10 * 60 })
  // the minute is two digits, the hour is not: a one-digit minute is a shape
  // the parser does not read, so the window falls back rather than guessing
  // "09:5" means 09:05
  for (const bad of [["09:5", "10:00"], ["09:00", "10:5"]]) {
    assert.deepEqual(windowOf({ checkinWindow: bad }), { start: 8 * 60 + 30, end: 10 * 60 }, `${JSON.stringify(bad)} is not a clock time`)
  }
  // a bound with something after the seconds is not a clock time either: the
  // regex's `$` is what keeps "13:30x" from reading as 13:30, and a dropped
  // `$` honours a window the user never wrote
  for (const bad of [["13:30x", "14:00"], ["13:30", "14:00x"], ["13:30x", "14:00x"]]) {
    assert.deepEqual(windowOf({ checkinWindow: bad }), { start: 8 * 60 + 30, end: 10 * 60 }, `${JSON.stringify(bad)} is not a window of its own`)
  }
  // "off" written with anything around it is a value the parser does not read,
  // so it falls back to the default — turning the window OFF would end the
  // check-ins silently. Both anchors are what keep "off" exact: dropped, the
  // regex matches a prefix ("offx") or a suffix ("xoff") of the word.
  for (const notOff of ["xoff", "offx", "falsey", "noo", "onno", "nox"]) {
    assert.deepEqual(windowOf({ checkinWindow: notOff }), { start: 8 * 60 + 30, end: 10 * 60 }, `${JSON.stringify(notOff)} is not an off-intent value`)
  }
  // a full-width colon is what a Chinese IME produces for that key: read as a
  // bad value it silently fell back to the default window, and the claim went
  // out at a time the user never named
  assert.deepEqual(windowOf({ checkinWindow: "13：00-14：00" }), { start: 13 * 60, end: 14 * 60 })
  assert.deepEqual(windowOf({ checkinWindow: ["09：15", "11：45"] }), { start: 9 * 60 + 15, end: 11 * 60 + 45 })
})

test("a window whose ends meet is not a window of width zero", () => {
  // Both "start before end" guards are `>=`, and equality is the whole of
  // what that buys: plan() takes `hash % (end - start)`, so a window of width
  // zero is a modulo by zero. The target comes out NaN, `minuteCN() >= NaN`
  // is false forever, and the account never claims that day — while the card
  // reads that it will auto-claim after NaN:NaN. Widening either guard to `>`
  // survives every
  // other test in this file, so the equality case needs its own.
  const dflt = { start: 8 * 60 + 30, end: 10 * 60 }
  assert.deepEqual(windowOf({ checkinWindow: ["09:00", "09:00"] }), dflt, "equal ends are not a window")
  assert.deepEqual(windowOf({ checkinWindow: "09:00-09:00" }), dflt, "the same, written as one string")
  // the second guard's equality, reached through the 23:00 cap: 23:30 caps
  // its end onto its own start
  assert.deepEqual(windowOf({ checkinWindow: ["23:00", "23:30"] }), dflt, "a cap that lands on the start is not a window")
})

test("a one-minute window pins the target to that minute", async () => {
  // With the window one minute wide the hash has nothing to choose, so the
  // target is the start whatever the day and the account. That is the only
  // way to read the target back exactly: every other window is a range, and
  // a wrong minute arithmetic still lands inside a wide one. It pins plan()
  // and the clock() the card prints together.
  await withWindow(["09:28", "09:29"], `${today} 07:00:00`, async () => {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-pin" }))
    assert.match(r.message, /^09:28 后自动领取/, `the card must name the target minute: ${r.message}`)
  })
})

test("the target minute itself is due, not one minute short", async () => {
  // plan() is `minuteCN() >= target`. Written `>`, an ask landing on the
  // target's own minute answers that it will auto-claim after 09:28 while the
  // clock reads
  // 09:28 — the card contradicting itself — and the claim slips to the next
  // ask, half an hour later. The host asks on its own schedule, so an ask
  // landing exactly on the target is one in thirty.
  const t = await withWindow(["08:30", "10:00"], `${today} 07:00:00`, () => targetOf(auth.checkin))
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => {
      await withWindow(["08:30", "10:00"], `${today} ${t.text}:00`, async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
        assert.doesNotMatch(r.message, /后自动领取/, `at ${t.text} sharp the plugin must claim, not defer: ${r.message}`)
      })
    },
  )
})

test("a minute before the target it still waits, not claims early", async () => {
  // plan() compares minuteCN() — the Beijing clock as minutes after midnight —
  // with the target. The hour term read as `* 61` adds a minute for every
  // hour of the day: at 09:27 a 09:28 target already reads as due, and the
  // claim goes out a minute early (later in the day, half an hour early).
  // The one-minute window pins the target to 09:28, so the clock is the only
  // variable left in the comparison.
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => {
      await withWindow(["09:28", "09:29"], `${today} 09:27:00`, async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-pin" }))
        assert.match(r.message, /^09:28 后自动领取/, `one minute early must still wait: ${r.message}`)
      })
    },
  )
})

test("the Beijing day is +8 hours, at the hour it matters", async () => {
  // 23:30 Beijing is 15:30 UTC. A shift one hour off (or the host's own zone)
  // reads that as the next day, and two things break at once: todayCN() stops
  // matching a ledger row stamped today — the card would say it claimed 0
  // next to a
  // balance that had just moved, and the check-in would answer `inactive`,
  // which settles the day — and minuteCN() falls back to 00:30, so a window
  // that should be long due answers that it will auto-claim after … again.
  // Every other test
  // computes its fixtures with the same +8, so they move with the constant;
  // this one pins it to a known instant instead.
  await withWindow(["22:00", "23:30"], `${today} 23:30:00`, async () => {
    const [r, u] = await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 181.5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
      },
      async () => [
        await auth.checkin(async () => ({ type: "api", key: "ms-test" })),
        await auth.usage(async () => ({ type: "api", key: "ms-test" })),
      ],
    )
    assert.doesNotMatch(r.message, /后自动领取/, `23:30 Beijing is past a 22:00-23:30 target: ${r.message}`)
    assert.match(u.windows[0].display, /领 200/, `a row stamped today must count at 23:30 Beijing: ${u.windows[0].display}`)
  })
})

test("a write-back failure is retried later, and never logs the token", async () => {
  // the host can refuse the write (a locked file, a daemon restarting). The
  // name has to be tried again on the next ask, and the log line must not
  // carry the token even if the host's error message echoes it.
  const dir = tmpDir("msmoli-wbfail-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const token = "ms-wbfail-0000-0000-0000-000000000013"
    let attempts = 0
    const logs = []
    const withClient = await MsmoliPlugin({
      directory: dir,
      client: {
        auth: {
          set: async () => {
            attempts += 1
            throw new Error(`auth store busy (key ${token})`)
          },
        },
        app: { log: (entry) => logs.push(entry) },
      },
    })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(attempts, 1)
        const logged = logs.map((l) => l.body?.message ?? "").join("\n")
        assert.ok(logged.includes("account facts not written back"), "the failure is logged")
        // the two fields that decide where the line lands in magpie's log: a
        // wrong level buries it, a wrong service hides it from the filter
        assert.equal(logs[0].body.level, "warn", "it is a warning, not a debug line")
        assert.equal(logs[0].body.service, "msmoli", "and it is filed under this plugin")
        assert.ok(!logged.includes(token), `the token leaked into the log: ${logged}`)
        assert.match(logged, /ms-w…0013/, "the masked tail still identifies the account")

        // the next ask tries again — the name is not remembered as written
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(attempts, 2, "a failed write must be retried on the next ask")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a logged rejection that is not an Error does not print [object Object]", async () => {
  const dir = tmpDir("msmoli-wbobj-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const logs = []
    const withClient = await MsmoliPlugin({
      directory: dir,
      client: {
        auth: { set: async () => { throw { code: "EBUSY" } } },
        app: { log: (entry) => logs.push(entry) },
      },
    })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: "ms-wbobj-0000-0000-0000-000000000014" }))
        const logged = logs.map((l) => l.body?.message ?? "").join("\n")
        assert.doesNotMatch(logged, /\[object Object\]/)
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a nickname that is a prototype key is not written back", async () => {
  // the host looks names up in an object; "__proto__"/"constructor" would be
  // inherited properties rather than a name
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const dir = tmpDir("msmoli-proto-")
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const saved = process.env.MAGPIE_MSMOLI_CONFIG
    delete process.env.MAGPIE_MSMOLI_CONFIG
    try {
      const writes = []
      const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      const token = `ms-proto-0000-0000-0000-0000000000${name.length}`
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: name } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        async () => {
          await withClient.auth.checkin(async () => ({ type: "api", key: token }))
          assert.equal(writes.length, 0, `${name} must not be stored as an account name`)
        },
      )
    } finally {
      if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
      else process.env.MAGPIE_MSMOLI_CONFIG = saved
    }
  }
})

test("an alias kept on a plugin-left provider still counts as the user's name", async () => {
  // magpie keeps removed plugins' providers under pluginLeft, each record
  // {package, provider: {…one Provider…}} (plugin_left.go's LeftRecord) — the
  // provider is a single object, not a list. Read as a list the record was
  // skipped and the user's alias went unseen, so the nickname was written
  // over it.
  const dir = tmpDir("msmoli-left-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-left-0000-0000-0000-000000000015"
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({
      providers: [{ id: "openai" }],
      pluginLeft: [
        {
          package: "github:MisonL/magpie-plugin-msmoli",
          provider: { id: "msmoli", accountNames: { "api key …0015": "主号" } },
        },
      ],
    }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, "the user's name lives in pluginLeft, and must not be overwritten")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a pluginLeft entry that is not a record is skipped, not tripped over", async () => {
  // providers.json is magpie's own, but it is also user state that can be mid-
  // write or hand-edited: the file's reader already treats anything it cannot
  // understand as "don't write". A null entry is exactly that — and the record
  // walk must not let one take the whole check-in down with it.
  const dir = tmpDir("msmoli-leftjunk-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-left-0000-0000-0000-000000000025"
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({
      providers: [{ id: "msmoli" }],
      pluginLeft: [null, "junk", { package: "p" }, { package: "p", provider: null }],
    }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const r = await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.notEqual(r.outcome, "failed", `a junk pluginLeft entry is not a failed check-in: ${r.message}`)
        assert.equal(writes.length, 1, "the nickname is still written back")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the countdown reads the daily grants only, not every EARN row", async () => {
  // A promo credit (infocomplement_*) carries its own expiry and can be gone
  // before the daily batch is. resetsAt is the daily batches' soonest loss —
  // the comment on that loop says so — so a promo must not move it: the card
  // would point its ↻ at a grant that is not the one the user claims every
  // day. Both `&&`s of that condition can be widened to `||` without any
  // other test noticing, so the row has to be here.
  const promo = day({
    rule_key: "infocomplement_profile_experience",
    title: "资料完善",
    total_amount: 50,
    expire_at: `${tomorrow} 00:00:24`,
  })
  const daily = day({ expire_at: `${tomorrow} 09:46:41` })
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 200 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [promo, daily] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, `${tomorrow}T01:46:41.000Z`, `the daily grant is the countdown, not the promo: ${u.windows[0].resetsAt}`)
    },
  )
})

test("an expiry the plugin cannot parse resets nothing, rather than 1970", async () => {
  const body = { success: true, data: { records: [day({ expire_at: "not a date" })] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 10 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, "", "an unparseable expiry is no reset time")
    },
  )
})

test("the pre-window line outlives the card's 30-minute cache", async () => {
  // magpie renders a check-in answer verbatim until its next ask, half an
  // hour later. A relative wait of about eight minutes is false for most of
  // that time;
  // seen on a real card at 09:47, still promising the 09:28 claim was eight
  // minutes away while the day's credits had already landed. Both facts in
  // the line are absolute — the target and the host's own cadence. The
  // cadence also explains why the claim is not at the target sharp: a plugin
  // has no timer, so it runs on the host's next ask.
  await withWindow(["08:30", "10:00"], `${today} 07:00:00`, async () => {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-words" }))
    assert.doesNotMatch(
      r.message,
      /约\s*\d/,
      `a relative wait goes stale while the card shows it: ${r.message}`,
    )
    assert.match(r.message, /^(\d{2}):(\d{2}) 后自动领取/)
    assert.match(r.message, /每半小时问一次/, `the line should say when the host asks again: ${r.message}`)
  })
})

test("a success flag that is not a boolean is not read as success", async () => {
  // the server (or a proxy) could answer "success": "false" as a string;
  // `!== undefined` would read that as a success, and a refused answer would
  // pass for an empty balance
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: "false", data: { available_balance: 999 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, `a string "false" must not pass for success: ${JSON.stringify(u)}`)
      assert.equal(u.windows, undefined)
    },
  )
})

test("a login/info that is not JSON fails the check-in rather than settling the day", async () => {
  // reaching login/info is the claim; a proxy's error page in its place must
  // not read as "no nickname" and slide on into the inactive path
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { raw: "<html>proxy error</html>" },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed", "an unreadable login/info must not settle the day")
      // The parse branch's own words, not just the login endpoint: the next
      // line down also says the login endpoint failed (with `HTTP 200` for a
      // body that did not
      // parse, since saidOf of it is empty), so matching the shared prefix
      // left `if (res.status !== 200 || !parsed)` on index.mjs free to be
      // turned into `if (false)` with the suite still green.
      assert.match(r.message, /登录接口失败：响应不是 JSON（HTTP 200）/, `the parse branch's own words: ${r.message}`)
    },
  )
})

test("a login/info that refuses in its own words, or in none at all", async () => {
  // The envelope branch (index.mjs): a 200 that parses but says no. Its two
  // arms answer differently on purpose — the server's message when there is
  // one, the status when there is not — and both were unpinned: the only
  // test on this path asserted just the shared login-endpoint prefix, which
  // the server's own message (asking the user to bind a phone number first)
  // satisfies, so `|| `HTTP ${res.status}`` could be deleted and an empty
  // login-failure message shipped unnoticed.
  for (const { bad, want } of [
    { bad: { body: { success: false, message: "请先绑定手机号" } }, want: /登录接口失败：请先绑定手机号$/ },
    { bad: { body: { success: false } }, want: /登录接口失败：HTTP 200$/ },
  ]) {
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        "/api/v1/users/login/info": bad,
      },
      async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.equal(r.outcome, "failed", `${JSON.stringify(bad)} must fail the check-in`)
    assert.match(r.message, want, `the envelope branch's own words: ${r.message}`)
    assert.doesNotMatch(r.message, /不是 JSON/, "a body that parsed is not the parse branch")
    assert.notEqual(r.signIn, "expired", "a refused answer is not a bad token")
  }
})

test("the name cache holds exactly 64 accounts: the 64th stays, the 65th evicts the first", async () => {
  // login/info is the claim, so the name is only ever read at check-in; the
  // cache is capped so a long-lived host does not grow one entry per account
  // seen forever. The cap is 64, not 8: at 8 a ninth signed-in account pushed
  // the first one's name out and its card went back to the key's tail. 64 in,
  // none out; the 65th takes the oldest and leaves the rest.
  const tokens = Array.from({ length: 65 }, (_, i) => `ms-lru-0000-0000-0000-000000000${String(i).padStart(2, "0")}`)
  const checkin = async (i) => {
    globalThis.fetch = fakeFetch({
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: `user${i}` } } },
    })
    await auth.checkin(async () => ({ type: "api", key: tokens[i] }))
  }
  const nameOf = async (i) => {
    globalThis.fetch = fakeFetch({
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    })
    return (await auth.usage(async () => ({ type: "api", key: tokens[i] }))).user
  }
  for (let i = 0; i < 64; i++) await checkin(i)
  for (let i = 0; i < 64; i++) assert.equal(await nameOf(i), `user${i}`, `the 64th check-in evicts nothing: ${i}`)
  await checkin(64)
  assert.equal(await nameOf(0), "", "the 65th check-in takes the oldest")
  assert.equal(await nameOf(1), "user1", "and only the oldest")
  assert.equal(await nameOf(64), "user64", "the newest is kept")
})

test("a usage read that meets a dead token marks the sign-in expired, at either step", async () => {
  // usage touches balance first, then the ledger; a 401 at either one means
  // the token is no good, and magpie only signs the account out if the hook
  // says so. The card's wording is the same at both steps and says the status
  // code, which is what the README's troubleshooting row promises — the
  // ledger path used to answer a bare "HTTP 401" while the check-in said
  // the token was invalid or not from the CN site (HTTP 401), so the one
  // condition had two texts.
  for (const at of ["balance", "transactions"]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance":
          at === "balance"
            ? { status: 401, body: { message: "unauthorized" } }
            : { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50":
          at === "transactions"
            ? { status: 401, body: { message: "unauthorized" } }
            : { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-bad" }))
        assert.ok(u.error, `${at}: a 401 is an error`)
        assert.equal(u.signIn, "expired", `${at}: a 401 must expire the sign-in`)
        assert.match(u.error, /401/, `${at}: the card names the status code: ${u.error}`)
        assert.match(u.error, /令牌失效/, `${at}: and says what it means: ${u.error}`)
      },
    )
  }
})

test("a declared oversize is refused before the body is read at all", async () => {
  // the precheck exists so a hostile or broken endpoint cannot make the host
  // buffer 300KB before the cap is noticed: the reader must never be pulled
  const real = globalThis.fetch
  let pulled = false
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(400 * 1024) : null) },
    body: {
      getReader() {
        pulled = true
        return {
          async read() {
            return { done: false, value: new Uint8Array(1024) }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
    text: async () => "x",
  })
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.match(u.error ?? "", /过大/)
  } finally {
    globalThis.fetch = real
  }
  assert.equal(pulled, false, "a declared oversize must be refused without reading it")
})

test("the name cache keeps the most recently seen, not the first seen", async () => {
  // it is an LRU so the account that just checked in is the one still named;
  // a plain FIFO would evict it right after its own check-in
  const tokens = Array.from({ length: 10 }, (_, i) => `ms-lru2-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`)
  const feed = (i) => {
    globalThis.fetch = fakeFetch({
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: `u${i}` } } },
    })
  }
  const real = globalThis.fetch
  try {
    for (let i = 0; i < 7; i++) {
      feed(i)
      await auth.checkin(async () => ({ type: "api", key: tokens[i] }))
    }
    // touch the oldest again, then add four more to push it past the bound
    feed(0)
    await auth.checkin(async () => ({ type: "api", key: tokens[0] }))
    for (let i = 7; i < 10; i++) {
      feed(i)
      await auth.checkin(async () => ({ type: "api", key: tokens[i] }))
    }
    globalThis.fetch = fakeFetch({
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    })
    const touched = await auth.usage(async () => ({ type: "api", key: tokens[0] }))
    assert.equal(touched.user, "u0", "the account that checked in most recently after its last use is kept")
  } finally {
    globalThis.fetch = real
  }
})

test("a providers.json that cannot be read is not written over", async () => {
  // Three states, and the third is the one that matters here: a missing file
  // is a fresh install (write the name), an alias means the user named the
  // account (leave it), and a file that is there but unreadable is state we
  // cannot see — writing the nickname would re-key an alias we could not
  // read, dropping the user's name from the card with no sign of why.
  // "5", "true" and "[1,2,3]" are the other half of the same rule: they parse
  // as valid JSON and are still not a providers.json. A shape guard written
  // `raw === null || typeof raw !== "object" || Array.isArray(raw)` with its
  // middle arm joined by `&&` lets every one of them through, and the
  // nickname is written over state the user could not have meant to lose.
  for (const [i, broken] of ["{ not json", "", "null", "[1,2,3", "5", "true", "[1,2,3]"].entries()) {
    const dir = tmpDir("msmoli-badalias-")
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    writeFileSync(join(dir, "providers.json"), broken)
    const saved = process.env.MAGPIE_MSMOLI_CONFIG
    delete process.env.MAGPIE_MSMOLI_CONFIG
    try {
      const writes = []
      const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      const token = `ms-badalias-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        async () => {
          await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        },
      )
      assert.equal(writes.length, 0, `an unreadable providers.json (${JSON.stringify(broken)}) must not be written over`)
    } finally {
      if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
      else process.env.MAGPIE_MSMOLI_CONFIG = saved
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a providers.json that is missing is a fresh install, and gets the name", async () => {
  // the other side of the same distinction: nothing to clobber
  const dir = tmpDir("msmoli-noalias-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-noalias-0000-0000-0000-000000000016"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
      },
    )
    assert.equal(writes.length, 1, "a missing providers.json must not stop the write")
    assert.equal(writes[0].body.accountId, "Mison")
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("usage counts only today's rows, not yesterday's grants", async () => {
  // the ledger is a rolling history, so the day filter is what keeps the card
  // from reporting a grant that has already expired. Every other fixture gives
  // its rows gmt_created: today, which leaves the filter itself unpinned —
  // removing it changed nothing the suite could see.
  const yesterday = new Date(Date.parse(`${today}T00:00:00+08:00`) - 86400e3).toISOString().slice(0, 10)
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              day({ gmt_created: yesterday, total_amount: 200 }),
              day({ gmt_created: yesterday, rule_key: "aliyun_bindlogin", total_amount: 50 }),
              spend(4, 2, yesterday),
            ],
          },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      // limit is what the day granted, amount what it spent: yesterday's 250
      // must show up in neither
      assert.equal(u.windows[0].limit, 0, "yesterday's grant is not today's")
      assert.equal(u.windows[0].amount, 0, "nor is yesterday counted as spend")
    },
  )
})

test("usage resets at the earliest grant that is still running", async () => {
  // the card's countdown has to end when the first of the day's grants
  // expires, not the last: a grant that runs out unnoticed is credits the
  // user believes they still have. The stamps are offsets from now, not fixed
  // clock times: a fixture pinned to "today 13:05" reads as already expired
  // whenever the suite runs in the afternoon, and the test then asserts a
  // different answer depending on the hour.
  //
  // `now` is read once, not by every at(): at() truncates to whole seconds,
  // so two calls with a second boundary in between produce stamps a second
  // apart, and the assertion compared the fixture's stamp with a later one.
  // That is a one-in-a-thousand flake per run — seen once in round 11 under a
  // mutation and logged as unreproduced. tools/ticking-clock.mjs makes it
  // deterministic: a clock that advances a second per read turns all three
  // countdown tests red on the old shape (npm run test:clock).
  const now = Date.now()
  const at = (ms) => new Date(now + 8 * 3600e3 + ms).toISOString().slice(0, 19).replace("T", " ")
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              // the one that runs out first is listed first, so a "keep the
              // last one seen" reading of the ledger would answer tomorrow
              day({ rule_key: "aliyun_bindlogin", total_amount: 50, expire_at: at(2 * 3600e3) }),
              day({ rule_key: "daily_active", total_amount: 200, expire_at: at(20 * 3600e3) }),
            ],
          },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const want = new Date(Date.parse(`${at(2 * 3600e3).replace(" ", "T")}+08:00`)).toISOString()
      assert.equal(u.windows[0].resetsAt, want, `the soonest still-running grant: ${u.windows[0].resetsAt}`)
    },
  )
})

test("the countdown follows a grant from yesterday that has not run out yet", async () => {
  // daily credits run 24 hours from when they land, so yesterday's grant is
  // still being spent today and can expire before today's own. Reading only
  // today's rows pointed the countdown past a batch that disappears sooner.
  // `now` read once for the reason above.
  const now = Date.now()
  const at = (ms) => new Date(now + 8 * 3600e3 + ms).toISOString().slice(0, 19).replace("T", " ")
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              day({ total_amount: 200, expire_at: at(20 * 3600e3) }),
              day({ gmt_created: yesterday, rule_key: "daily_active", total_amount: 150, expire_at: at(3 * 3600e3) }),
            ],
          },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const want = new Date(Date.parse(`${at(3 * 3600e3).replace(" ", "T")}+08:00`)).toISOString()
      assert.equal(u.windows[0].resetsAt, want, `yesterday's grant expires first: ${u.windows[0].resetsAt}`)
      // and it is not counted as today's grant
      assert.equal(u.windows[0].limit, 200, "yesterday's amount is not today's")
    },
  )
})

test("a grant that already expired is not the moment the credits run out", async () => {
  // a countdown that has already passed tells the user nothing; the next
  // expiry is the answer. `now` read once for the reason above.
  const now = Date.now()
  const at = (ms) => new Date(now + 8 * 3600e3 + ms).toISOString().slice(0, 19).replace("T", " ")
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              day({ rule_key: "aliyun_bindlogin", total_amount: 50, expire_at: at(-3 * 3600e3) }),
              day({ rule_key: "daily_active", total_amount: 200, expire_at: at(20 * 3600e3) }),
            ],
          },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const want = new Date(Date.parse(`${at(20 * 3600e3).replace(" ", "T")}+08:00`)).toISOString()
      assert.equal(u.windows[0].resetsAt, want, `an expired grant is behind us, not ahead: ${u.windows[0].resetsAt}`)
    },
  )
})

test("a check-in whose ledger read is refused by risk control says so", async () => {
  // the first read of the day is the ledger, and it can be refused before
  // login/info is ever reached. Reporting that as "not JSON" would send the
  // user to look at the wrong thing.
  await withFetch(
    { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 403, body: { success: false, code: "RiskControl" } } },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      assert.match(r.message, /风控/, `should name risk control, got: ${r.message}`)
      assert.doesNotMatch(r.message, /不是 JSON/)
      assert.notEqual(r.signIn, "expired")
    },
  )
})

test("a usage read refused by risk control names it, without 'not JSON' in the message", async () => {
  // the earlier assertion accepted /403/, and the generic refusal for any
  // non-200 carries "HTTP 403" too — so the branch that says risk control
  // was never
  // actually exercised.
  for (const at of ["balance", "transactions"]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance":
          at === "balance"
            ? { status: 403, body: { success: false } }
            : { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50":
          at === "transactions" ? { status: 403, body: { success: false } } : { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.match(u.error, /风控/, `${at}: should name risk control, got: ${u.error}`)
        assert.doesNotMatch(u.error, /不是 JSON/, `${at}: a 403 is not a parse failure`)
        assert.equal(u.signIn, "", `${at}: a 403 is not a bad token`)
      },
    )
  }
})

test("a non-200 that answers JSON repeats what it said, not 'not JSON'", async () => {
  // The status gate said `res.status !== 200 || !parsed` in one line and its
  // message called the body "not JSON" for both. A 429 or a 500 from the
  // vendor, or from a proxy that explains itself in JSON, parses perfectly
  // well: reporting it as a parse failure throws away the server's own words
  // (too many requests, system busy) and sends the reader to look at the
  // network.
  // Splitting the two conditions is what this pins — the suite was fully
  // green with the gate widened to `>= 400`, because nothing sent a 2xx other
  // than 200 and no test ever put JSON in a non-200.
  const okBalance = { body: { success: true, data: { available_balance: 5 } } }
  const okLedger = { body: { success: true, data: { records: [] } } }
  for (const [at, want] of [
    ["balance", /余额查询失败：请求过于频繁/],
    ["transactions", /账单查询失败：请求过于频繁/],
  ]) {
    const u = await withFetch(
      {
        "/openapi/v1/magicubes/balance":
          at === "balance" ? { status: 429, body: { success: false, message: "请求过于频繁" } } : okBalance,
        "/openapi/v1/magicubes/transactions?page=1&page_size=50":
          at === "transactions" ? { status: 429, body: { success: false, message: "请求过于频繁" } } : okLedger,
      },
      async () => auth.usage(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok(u.error, `${at}: a 429 is an error`)
    assert.match(u.error, want, `${at}: the server's own words: ${u.error}`)
    assert.doesNotMatch(u.error, /不是 JSON/, `${at}: a body that parsed is not a parse failure`)
    assert.equal(u.signIn, "", `${at}: a rate limit is not a bad token`)
  }
  // and the same at the check-in's own ledger read, which has a copy of the line
  const r = await withFetch(
    { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { success: false, message: "系统繁忙" } } },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /账单查询失败：系统繁忙/, `check-in: the server's own words: ${r.message}`)
  assert.doesNotMatch(r.message, /不是 JSON/, "check-in: a body that parsed is not a parse failure")
})

test("a login/info that answers JSON on a non-200 says what it said", async () => {
  // same split at the check-in's login step, where a 429 with the vendor's
  // own words was reported as not-JSON and those words thrown away.
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { status: 429, body: { success: false, message: "请求过于频繁" } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.equal(r.outcome, "failed", "a 429 must not settle the day")
  assert.match(r.message, /登录接口失败：请求过于频繁/, `the server's own words: ${r.message}`)
  assert.doesNotMatch(r.message, /不是 JSON/, "a body that parsed is not a parse failure")
  assert.notEqual(r.signIn, "expired", "a rate limit is not a bad token")
})

test("a login/info on a 2xx that is not 200 does not settle the day", async () => {
  // The gate is `res.status !== 200`, not "no error": a 202 or a 206 is a
  // proxy or a half-finished answer, not the reply login/info gives. The
  // fixture carries a *well-formed* success envelope on the odd status, or
  // the check is masked — an empty body fails `okOf` on its own, so the day
  // would not settle whichever way the gate is written. With the gate widened
  // to `>= 400`, and with the status check dropped in favour of `!okOf`
  // alone, the suite stayed green: the well-formed 202 then walked on into
  // the inactive path and settled the day as an account perhaps outside the
  // active range — a
  // conclusion drawn from an answer the vendor never finished sending.
  for (const status of [202, 206]) {
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        "/api/v1/users/login/info": { status, body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.equal(r.outcome, "failed", `a ${status} must not settle the day`)
    assert.notEqual(r.outcome, "inactive", `a ${status} is not "not in the campaign"`)
    assert.match(r.message, /登录接口/, `a ${status} names the step: ${r.message}`)
  }
})

test("a 2xx that is not 200 is a refusal on the usage reads too", async () => {
  // The same widened gate survived on all three usage reads: a 202 carrying a
  // perfectly well-formed success body was read as a real answer, and the
  // card showed a claim of 200 from a request the vendor never completed. A 202
  // means accepted-and-not-done; only 200 is the answer.
  const goodLedger = {
    body: {
      success: true,
      data: {
        records: [day({ rule_key: "daily_active", total_amount: 200, expire_at: "" })],
      },
    },
  }
  const goodBalance = { body: { success: true, data: { available_balance: 251.5 } } }
  for (const at of ["balance", "transactions"]) {
    const u = await withFetch(
      {
        "/openapi/v1/magicubes/balance": at === "balance" ? { status: 202, ...goodBalance } : goodBalance,
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": at === "transactions" ? { status: 202, ...goodLedger } : goodLedger,
      },
      async () => auth.usage(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok(u.error, `${at}: a 202 is not an answer`)
    assert.equal(u.windows, undefined, `${at}: no card from a request still in flight`)
    assert.match(u.error, /HTTP 202/, `${at}: names the status: ${u.error}`)
    assert.doesNotMatch(u.error, /不是 JSON/, `${at}: a body that parsed is not a parse failure`)
  }
  // and the check-in's ledger read has its own copy of the gate
  const r = await withFetch(
    { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 202, ...goodLedger } },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.equal(r.outcome, "failed", "a 202 must not settle the day")
  assert.match(r.message, /HTTP 202/, `check-in names the status: ${r.message}`)
})

test("an envelope that says Code 200 is an answer, not a failure", async () => {
  // login/info answers {Code: 200, Data} with no success flag at all; the
  // ledger and balance always carry `success`, so that branch of okOf is only
  // reached if this test reaches it.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { Code: 200, Data: { available_balance: 7 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { Code: 200, Data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, `Code 200 should read as success: ${u.error}`)
      assert.match(u.windows[0].display, /余额 7/)
    },
  )
  // and a Code that is not 200 is still a refusal
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { Code: 500, Message: "boom" } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { Code: 200, Data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error, /boom/)
    },
  )
})

test("a grant title that would be cut mid-pair keeps its whole characters", async () => {
  // text() counts code points so a truncation cannot leave half an emoji
  // behind; the earlier fixtures all had short titles, so the cut never ran.
  // The title is cut at 40, so 39 letters plus two emoji has to give back one.
  const title = `${"a".repeat(39)}😀😀`
  // the first ledger read is the "before" one and has to be empty, or the
  // check-in reads as already done and never reports the grant's title
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Data: { NickName: "alice" } } })
    reads += 1
    return reply({ body: { success: true, data: { records: reads === 1 ? [] : [day({ title })] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed")
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.message), `a lone surrogate survived: ${JSON.stringify(r.message)}`)
    assert.ok(r.message.includes("😀"), "the emoji that fit are whole")
  } finally {
    globalThis.fetch = real
  }
})

test("a server string that would fill the card is cut, not passed through", async () => {
  // text() caps every string that reaches the card, magpie's log and
  // plugin-checkin.json. The cap itself was never asserted: the emoji test
  // above depends on the cut at 40 but still passes with truncation removed
  // entirely, so nothing noticed a few hundred characters of a server's
  // title landing whole in the line the host stores.
  const title = "长".repeat(500)
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Data: { NickName: "alice" } } })
    reads += 1
    return reply({ body: { success: true, data: { records: reads === 1 ? [] : [day({ title })] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed")
    const points = Array.from(r.message).length
    assert.ok(points < 100, `the title reached the card whole: ${points} code points`)
  } finally {
    globalThis.fetch = real
  }
})

test("a second check-in in the same process does not write the name again", async () => {
  // `named` is the once-per-token guard. The earlier test's second ask carried
  // accountId the host had already saved, so the "already named" condition
  // short-circuited first and the guard itself was never reached.
  const dir = tmpDir("msmoli-once-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-nametest-0000-0000-0000-000000000011"
    let reads = 0
    const real = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname
      if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Data: { NickName: "Mison" } } })
      reads += 1
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      // both asks hand over a bare api sign-in, as a host that has not saved
      // the name yet would: only `named` can stop the second write
      await withClient.auth.checkin(async () => ({ type: "api", key: token }))
      await withClient.auth.checkin(async () => ({ type: "api", key: token }))
      assert.equal(writes.length, 1, "the name is written once, not once per ask")
      assert.equal(writes[0].body.accountId, "Mison")
      void reads
    } finally {
      globalThis.fetch = real
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a check-in whose sign-in hand-over rejects with a non-Error says nothing odd", async () => {
  // the host can reject with a bare object. whyOf is what keeps that from
  // reaching the card as "[object Object]" — only the usage path was pinned.
  // A message that is not a string at all is the same bug one step over:
  // `typeof e?.message === "string" || e.message` returns an object message
  // unchanged, and String() then prints it as exactly that.
  for (const thrown of [{ code: 42 }, "gone", { message: {} }, { message: 42 }]) {
    const r = await auth.checkin(async () => {
      throw thrown
    })
    assert.equal(r.outcome, "failed")
    assert.doesNotMatch(r.message, /object Object/, `a non-Error leaked through: ${r.message}`)
    assert.match(r.message, /签到失败|gone/, `should give a usable message, got: ${r.message}`)
  }
})

test("a host error that carries the token is masked on the two getAuth exits too", async () => {
  // These two exits run before the key is in hand — getAuth itself failed —
  // so there is no token to split on, and they used to pass the host's text
  // through unmasked. magpie's own wording for a missing key names it
  // ("no key <key> for provider"), so the text can carry one.
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const dir = tmpDir("msmoli-getauth-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const real = globalThis.fetch
  let asked = 0
  globalThis.fetch = async () => {
    asked += 1
    throw new Error("should not have been asked")
  }
  try {
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    const fail = async () => {
      throw new Error(`no key ${token} for provider`)
    }
    const u = await p.auth.usage(fail)
    const c = await p.auth.checkin(fail)
    for (const [what, said] of [["usage", u.error], ["checkin", c.message]]) {
      assert.ok(said, `${what}: there should be a message`)
      assert.ok(!said.includes(token), `${what}: the token reached the card: ${JSON.stringify(said)}`)
      assert.match(said, /ms-a…5555/, `${what}: it should be shown masked: ${JSON.stringify(said)}`)
    }
    assert.equal(asked, 0, "a failed getAuth must not send a request")
  } finally {
    globalThis.fetch = real
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token-shaped run is masked whatever its first character and length", async () => {
  // hostText's tokenShaped has to accept a digit right after "ms-": every real
  // ModelScope token is ms-<hex>, so a third of them open with 2-9. Narrowed
  // to [A-Za-z0-10] the run stops matching and the whole key is printed by the
  // two exits that have no token to split on. The 10 is the shortest tail the
  // pattern takes; 11 lets a 14-character key through, which maskToken would
  // still have shown by its ends. sync.mjs's show() has the same test; this
  // side had none.
  const dir = tmpDir("msmoli-hostsahpe-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  try {
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    for (const tok of ["ms-5abc1234-dead-beef-0000-123456789abc", "ms-a1234567890"]) {
      const fail = async () => {
        throw new Error(`no key ${tok} for provider`)
      }
      const u = await p.auth.usage(fail)
      const c = await p.auth.checkin(fail)
      for (const [what, said] of [["usage", u.error], ["checkin", c.message]]) {
        assert.ok(!said.includes(tok), `${what}: the token reached the card whole: ${JSON.stringify(said)}`)
        assert.match(said, /…/, `${what}: it should be shown masked: ${JSON.stringify(said)}`)
      }
    }
    // the other side of the boundary: ms- plus one plus ten is the pattern's
    // minimum, so a 13-character run is below it and is not a token. Pinned so
    // the boundary cannot drift: one character wider and a real token of that
    // length would be printed whole.
    const short = "ms-abcdefghij" // 13 characters
    const u13 = await p.auth.usage(async () => {
      throw new Error(`no key ${short} for provider`)
    })
    assert.ok(u13.error.includes(short), `a 13-character run is below the pattern and is shown whole: ${JSON.stringify(u13.error)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an error from the host reaches the card scrubbed, like the log's does", async () => {
  // magpie's own CLI scrubs tokens out of "no key ms-… for provider", so the
  // host demonstrably does put them in error text. The four card exits used to
  // pass that text through untouched — only the nickname log did not.
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const dir = tmpDir("msmoli-card-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error(`invalid header value: ${token}\r\n\u001b[2J‮tail`)
  }
  try {
    const u = await hooks.auth.usage(async () => ({ type: "api", key: token }))
    const c = await hooks.auth.checkin(async () => ({ type: "api", key: token }))
    for (const [what, said] of [["usage", u.error], ["checkin", c.message]]) {
      assert.ok(said, `${what}: there should be a message`)
      assert.ok(!said.includes(token), `${what}: the token reached the card: ${JSON.stringify(said)}`)
      const bad = Array.from(said).filter((ch) => {
        const c = ch.codePointAt(0)
        return c < 9 || (c > 10 && c < 32) || c === 127 || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e)
      })
      assert.deepEqual(bad, [], `${what}: control characters survived: ${JSON.stringify(said)}`)
    }
  } finally {
    globalThis.fetch = real
  }
})

test("a host log that throws synchronously does not reject the usage hook", async () => {
  // usage promises an {error}, never a rejection — and the nickname write-back
  // sits on its path. `?.catch?.()` only catches a rejected promise, not a
  // throw made while the call itself is being made.
  const dir = tmpDir("msmoli-logthrow-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-nametest-0000-0000-0000-000000000012"
  const real = globalThis.fetch
  globalThis.fetch = async (url) => ({
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => {
      const at = String(url)
      if (at.includes("login/info")) return JSON.stringify({ Code: 200, Data: { NickName: "Mison" } })
      if (at.includes("balance")) return JSON.stringify({ success: true, data: { available_balance: 5 } })
      return JSON.stringify({ success: true, data: { records: [] } })
    },
  })
  try {
    const client = {
      auth: { set: async () => { throw new Error("write refused") } },
      app: { log: () => { throw new Error("log threw") } },
    }
    const hooks = await MsmoliPlugin({ directory: dir, client })
    // the check-in puts the name in the process cache; usage then writes it back
    await hooks.auth.checkin(async () => ({ type: "api", key: token }))
    const u = await hooks.auth.usage(async () => ({ type: "api", key: token }))
    assert.equal(u.error, undefined, `usage should have read fine, got: ${u.error}`)
    assert.ok(u.windows?.[0], "the card is still filled in")
  } finally {
    globalThis.fetch = real
  }
})

test("a host log whose promise rejects leaves no unhandled rejection behind", async () => {
  // The write-back's log is best-effort: a host's log returning a promise that
  // rejects must be swallowed, or Node prints an unhandled rejection and — on
  // a host that treats one as fatal — the whole check-in dies after its work
  // is done. `typeof r.catch === "function"` flipped to !== attaches nothing
  // and does exactly that; no other test observes the difference, because the
  // card and the state are unchanged either way.
  const dir = tmpDir("msmoli-logreject-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-nametest-0000-0000-0000-000000000077"
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on("unhandledRejection", onUnhandled)
  const real = globalThis.fetch
  globalThis.fetch = async (url) => ({
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () =>
      String(url).includes("login/info")
        ? JSON.stringify({ Code: 200, Data: { NickName: "Mison" } })
        : JSON.stringify({ success: true, data: { records: [] } }),
  })
  try {
    const hooks = await MsmoliPlugin({
      directory: dir,
      client: {
        auth: { set: async () => { throw new Error("write refused") } },
        app: { log: () => Promise.reject(new Error("log channel down")) },
      },
    })
    await hooks.auth.checkin(async () => ({ type: "api", key: token }))
    // the rejection settles a few microtasks after the hook returns
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(unhandled.map((e) => e?.message), [], "a best-effort log must not reject unhandled")
  } finally {
    process.off("unhandledRejection", onUnhandled)
    globalThis.fetch = real
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the write-back log masks the token before truncating, not after", async () => {
  // The other order cuts a token in half; half a token is not a token to
  // split() on, so the front of it reaches the log. Padding puts the token
  // across the 200-code-point cut.
  const dir = tmpDir("msmoli-cut-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const logged = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => ({
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () =>
      String(url).includes("login/info")
        ? JSON.stringify({ Code: 200, Data: { NickName: "Mison" } })
        : JSON.stringify({ success: true, data: { records: [] } }),
  })
  try {
    const hooks = await MsmoliPlugin({
      directory: dir,
      client: {
        auth: { set: async () => { throw new Error(`${"x".repeat(190)}${token} trailing`) } },
        app: { log: async (o) => logged.push(o.body.message) },
      },
    })
    await hooks.auth.checkin(async () => ({ type: "api", key: token }))
    assert.equal(logged.length, 1, "the failure is logged")
    assert.ok(!logged[0].includes(token.slice(0, 8)), `the front of the token survived: ${JSON.stringify(logged[0].slice(180))}`)
    assert.ok(logged[0].includes("ms-a…5555"), "the masked token is what got logged")
  } finally {
    globalThis.fetch = real
  }
})

test("a config file with a BOM is read, not quietly replaced by the default window", async () => {
  // Notepad and PowerShell's Out-File write a BOM. JSON.parse rejects it, and
  // a user who wrote checkinWindow: false would get the default window back
  // with nothing said. The file has to be the one the plugin reads: the env
  // variable wins over the directory, so it is cleared for this test.
  const dir = tmpDir("msmoli-bom-")
  writeFileSync(join(dir, "msmoli.json"), "\uFEFF" + JSON.stringify({ checkinWindow: false }))
  await withDirectory(dir, async () => {
    const hooks = await MsmoliPlugin({ directory: dir })
    const realNow = Date.now
    Date.now = () => Date.parse("2026-10-25T00:30:00+08:00") // before any window
    const real = globalThis.fetch
    let asked = 0
    globalThis.fetch = async () => {
      asked += 1
      return { status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ success: true, data: { records: [] } }) }
    }
    try {
      const r = await hooks.auth.checkin(async () => ({ type: "api", key: "ms-bomtest" }))
      assert.doesNotMatch(r.message, /后自动领取/, `the window was applied despite checkinWindow: false: ${r.message}`)
      assert.ok(asked > 0, "with the window off, the check-in goes ahead")
    } finally {
      globalThis.fetch = real
      Date.now = realNow
    }
  })
})

test("a time that is not a time is refused instead of rolled over", async () => {
  // Date.UTC normalizes: month 13 is January next year, "99:99:99" rolls two
  // days on. The card would count down to a moment that reads fine and is not
  // when the grant expires.
  //
  // Each part is tried on its own. The single composite fixture this test
  // used to carry ("2026-13-45 99:99:99") is refused by the month check
  // whatever happens to the rest, so deleting the minute and second limits
  // kept the suite green — and those two are the only parts the round-trip
  // check below cannot see: 09:99:99 rolls to 10:41 on the *same* Beijing
  // calendar day, so the date that comes back matches. Month, day and hour
  // all roll the date and are caught twice over; minute and second are the
  // load-bearing half of that line.
  //
  // The stamps sit a year out, as in the February test: rolled onto a moment
  // in the past, the "still running" filter would drop them and the test
  // would pass even if cnTime accepted the date.
  const nextYear = new Date(Date.now() + 8 * 3600e3 + 365 * 86400e3).getUTCFullYear()
  for (const [stamp, why] of [
    [`${nextYear}-13-05 09:13:40`, "month 13"],
    [`${nextYear}-10-45 09:13:40`, "day 45"],
    [`${nextYear}-10-05 25:13:40`, "hour 25"],
    [`${nextYear}-10-05 09:99:40`, "minute 99"],
    [`${nextYear}-10-05 09:13:99`, "second 99"],
    // the boundary itself, not one past it: 60 is the first value the limit
    // refuses, and `> 59` widened to `> 60` leaves 99 refused and 60 accepted.
    // A minute of 60 rolls into the next hour on the same day, so the
    // round-trip check below cannot see it either.
    [`${nextYear}-10-05 09:60:40`, "minute 60"],
    [`${nextYear}-10-05 09:13:60`, "second 60"],
  ]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ expire_at: stamp })] } },
        },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(u.windows[0].resetsAt, "", `${why} is no time at all: ${JSON.stringify(u.windows[0])}`)
      },
    )
  }
  // and the control: the same stamp with every part in range is a time, so
  // the loop above is not passing because the fixture stopped reaching cnTime
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ expire_at: `${nextYear}-10-05 09:13:40` })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, `${nextYear}-10-05T01:13:40.000Z`, "the control stamp is a time")
    },
  )
  // a late-evening stamp, for the round-trip check's own +8: taken with 9
  // hours the check asks for 00:30 of the next day, and a real 23:30 expiry —
  // the shape the ledger writes every day — would come back as "not a time"
  // and drop off the countdown.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ expire_at: `${nextYear}-10-05 23:30:00` })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, `${nextYear}-10-05T15:30:00.000Z`, "a 23:30 expiry is a time")
    },
  )
  // the year is four digits, not "three or more": a stamp whose year lost a
  // digit still round-trips through Date.UTC and reads as a real moment, and
  // the countdown would point at it.
  for (const stamp of ["999-10-05 09:13:40", `${nextYear}1-10-05 09:13:40`]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ expire_at: stamp })] } },
        },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(u.windows[0].resetsAt, "", `a ${stamp.split("-")[0].length}-digit year is no time: ${JSON.stringify(u.windows[0])}`)
      },
    )
  }
})

test("a time at the edge of every range is still a time", async () => {
  // The rejection test above tries values one past each limit; the limits
  // themselves have to pass. Tighten any of them by one — `+mo > 12` to
  // `> 11`, `+d < 1` to `< 2`, `> 59` to `> 58` — and not one rejection
  // breaks, so the suite stayed green while a real New Year's Eve expiry
  // (month 12, 23:59:59) or the first of a month read back as "no time" and
  // fell off the countdown. Each stamp sits a year out so the "still
  // running" filter keeps it.
  const nextYear = new Date(Date.now() + 8 * 3600e3 + 365 * 86400e3).getUTCFullYear()
  for (const [stamp, want, why] of [
    // month 12, hour 23, minute 59, second 59 in one stamp
    [`${nextYear}-12-31 23:59:59`, `${nextYear}-12-31T15:59:59.000Z`, "month 12, 23:59:59"],
    // month 1 and day 1, at the day's first second: the -8h shift lands on
    // the previous UTC date, which is the day the round-trip check compares
    [`${nextYear}-01-01 00:00:00`, `${nextYear - 1}-12-31T16:00:00.000Z`, "month 1, day 1, midnight"],
    // Beijing midnight mid-month: exactly 8 hours back is the previous UTC
    // day, so the round-trip check's own +8h has to be 8h to the second —
    // at 8h less 8s it asks for 23:59:52 of the day before and refuses a
    // stamp that is a perfectly real moment
    [`${nextYear}-10-05 00:00:00`, `${nextYear}-10-04T16:00:00.000Z`, "midnight mid-month"],
  ]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ expire_at: stamp })] } },
        },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(u.windows[0].resetsAt, want, `${why} is a time: ${JSON.stringify(u.windows[0])}`)
      },
    )
  }
})

test("a ledger with no data at all is a failure, not an empty day", async () => {
  // `inactive` ends the day. A body whose data went missing (a proxy rewrite,
  // a renamed field) is one we did not understand, and has to be retried.
  await withFetch(
    { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true } } },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed", `a shapeless body must not settle the day: ${r.outcome}`)
      assert.match(r.message, /账单格式/)
    },
  )
})

test("a Data that is null is a body we do not understand, not an internal error", async () => {
  // `body.data ?? body.Data` hands a capitalised Data through when the
  // lowercase one is absent, so a Data that is null reaches the guard as
  // null — and typeof null is "object", the one value the type check alone
  // cannot catch. Left to fall through, `data.records` throws a TypeError
  // whose text ("Cannot read properties of null") is what the card would
  // show: the user is told about a JavaScript fault instead of an answer
  // the plugin could not read. Both readers of `data` get the same shape.
  const fine = { body: { success: true, data: { available_balance: 5 } } }
  const fineTx = { body: { success: true, data: { records: [] } } }
  const nullData = { body: { success: true, Data: null } }
  await withFetch(
    { "/openapi/v1/magicubes/balance": fine, "/openapi/v1/magicubes/transactions?page=1&page_size=50": nullData },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed", `a null ledger must not settle the day: ${r.outcome}`)
      assert.match(r.message, /账单格式/, `the card should say what we could not read: ${r.message}`)
      assert.doesNotMatch(r.message, /Cannot read propert/, "an internal error must not reach the card")
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error, /账单格式/, `usage reads the same ledger: ${u.error}`)
      assert.doesNotMatch(u.error, /Cannot read propert/, "an internal error must not reach the card")
    },
  )
  await withFetch(
    { "/openapi/v1/magicubes/balance": nullData, "/openapi/v1/magicubes/transactions?page=1&page_size=50": fineTx },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error, /没有 data/, `the balance's own guard answers too: ${u.error}`)
      assert.doesNotMatch(u.error, /Cannot read propert/, "an internal error must not reach the card")
    },
  )
})

test("the window reads the other separators an IME or an editor substitutes", () => {
  const at = (v) => {
    const w = windowOf({ checkinWindow: v })
    return w && `${String(w.start / 60 | 0).padStart(2, "0")}:${String(w.start % 60).padStart(2, "0")}`
  }
  for (const sep of ["-", "–", "—", "−", "~", "～", "〜", "至", "到"]) {
    assert.equal(at(`09:15${sep}11:45`), "09:15", `separator ${JSON.stringify(sep)} was not read`)
  }
})

test("done reports the day's grant from before the trigger, not from a page that changed", async () => {
  // the account was already in today: the credit is what the ledger said
  // before login/info was touched. Reading it again after the trigger lets a
  // page that changed between the two reads answer a claim of 0 credits for
  // today.
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Data: { NickName: "alice" } } })
    reads += 1
    // the first (pre-trigger) read has the grant; every later one is empty
    return reply({
      body: {
        success: true,
        data: { records: reads === 1 ? [day(), day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 })] : [] },
      },
    })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "done")
    assert.equal(r.credit, 250, `the day's own grant, not a later empty page: ${r.message}`)
    // the day's rows are named on the card, joined by " + ". The separator is
    // the only thing between two titles, so a wrong one runs them together
    // into a name the user never had a grant for.
    assert.match(
      r.message,
      /今日已领取 250 魔粒（注册并登录 \+ 绑定阿里云账号）/,
      `both rows must be named, joined by " + ": ${r.message}`,
    )
  } finally {
    globalThis.fetch = real
  }
})

test("a row stamped with a time is still today's row", async () => {
  // The column answers "2026-10-26" today, but the same API writes other
  // fields of the same row as "2026-10-26 09:13:40". An exact-string compare
  // would turn every row into "not today": the ledger reads as empty, the
  // check-in answers `inactive`, and `inactive` settles the day with "the
  // account may not be in the campaign" — a false answer that is never asked
  // again that day.
  for (const stamp of [`${today} 09:13:40`, `${today}T09:13:40`, `${today} 00:00:00`]) {
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ gmt_created: stamp })] } },
        },
      },
      async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(r.outcome, "done", `${stamp} is today's row: ${r.message}`)
        assert.equal(r.credit, 200)
      },
    )
  }
  // and a row from another day is still another day's
  await withFetch(
    {
      "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ gmt_created: `${yesterday} 23:59:59` })] } },
      },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "inactive", `yesterday's row is not today's: ${r.message}`)
    },
  )
})

test("a stamp that merely mentions the date is not today's row", async () => {
  // onDay reads the date *part* of the stamp: the spellings ModelScope writes
  // both begin with the day, and a stamp carrying the date somewhere else is
  // a shape we do not understand. Read as `includes(day)`, a row whose text
  // happens to mention today would be summed into today's numbers — a grant
  // the ledger never recorded that day, on the card next to a balance that
  // did not move. (Measured by mutation: `s.includes(day)` survived the whole
  // suite before this test.)
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ gmt_created: `更新于 ${today}` })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].limit, 0, `a stamp not starting with the day is not today's: ${u.windows[0].display}`)
    },
  )
})

test("a day whose grants were reversed does not claim a negative credit", async () => {
  // An EARN row can be a reversal (a correcting entry), and a day netting
  // below zero is a
  // real state. magpie clamps `credit` itself (host.js's num: Math.max(0, v))
  // but passes `message` through verbatim (checkin.go renders it under the
  // card's row), so the card read that -50 credits were claimed today: a
  // claim of a negative
  // amount is not a thing. The rows are still named; the amount stops at zero.
  await withFetch(
    {
      "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              day({ rule_key: "daily_active", title: "注册并登录", total_amount: 200 }),
              day({ rule_key: "daily_active", title: "冲正", total_amount: -250 }),
            ],
          },
        },
      },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done")
      assert.doesNotMatch(r.message, /-\d/, `the card must not say 今日已领取 -50: ${r.message}`)
      assert.match(r.message, /冲正/, `the reversal is still named: ${r.message}`)
      assert.equal(r.credit, 0, `a negative claim is not a claim: ${r.message}`)
    },
  )
})

test("a day that nets to a positive grant still reports it", async () => {
  // the clamp must not swallow a partial reversal: 200 + (-50) is 150
  await withFetch(
    {
      "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [
              day({ rule_key: "daily_active", title: "注册并登录", total_amount: 200 }),
              day({ rule_key: "daily_active", title: "冲正", total_amount: -50 }),
            ],
          },
        },
      },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done")
      assert.equal(r.credit, 150, `the day's net grant: ${r.message}`)
    },
  )
})

test("a spent day with no grant today shows a bar that matches the numbers", async () => {
  // before the day's grant, spending comes out of what is left. used=0 next to
  // a line saying used 348.5 today against 0 claimed says the bar did not
  // move while the text says it did.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 100 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [spend(348.5, 1)] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.equal(w.limit, 0)
      assert.equal(w.amount, 348.5)
      assert.ok(w.used > 0 && w.used < 100, `the bar should be part-way, got ${w.used}`)
      // 348.5 of the 448.5 it had
      assert.equal(w.used, Math.round((348.5 / 448.5) * 10000) / 100)
    },
  )
})

test("a summed credit has no floating-point tail", async () => {
  // 0.1 + 0.2 is 0.30000000000000004, and it goes straight into the card
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ total_amount: 0.1 }), day({ rule_key: "aliyun_bindlogin", total_amount: 0.2 })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].limit, 0.3, `a tail survived: ${u.windows[0].display}`)
      assert.ok(!/0\.30000000000000004/.test(u.windows[0].display), u.windows[0].display)
    },
  )
})

test("a key that is there but cannot be sent is not reported as a missing sign-in", async () => {
  // the key is present, just unusable (a newline from a paste). A message
  // about missing login information
  // sends the user to sign in again, which is not what is wrong.
  const withBadKey = async () => ({ type: "api", key: "ms-aaaa1111\nbbbb-2222" })
  const r = await auth.checkin(withBadKey)
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /无法识别/, `should name the key, got: ${r.message}`)
  assert.doesNotMatch(r.message, /没有登录信息/)
  const u = await auth.usage(withBadKey)
  assert.match(u.error, /无法识别/, `usage should name it too, got: ${u.error}`)
  // and an empty sign-in still says to sign in
  const none = await auth.checkin(async () => ({}))
  assert.match(none.message, /没有登录信息/)
})

test("the one unusable-key test covers a space, not just a newline", async () => {
  // The rule is "visible ASCII and nothing else" (0x21-0x7e). A newline is
  // below the range, but so is the space — and a key with a space in it is
  // what a paste from a wrapped terminal actually produces. Widened to
  // [\x20-\x7e] the guard passes it through, the Cookie header carries it,
  // and fetch answers with its own English about an invalid header value.
  const withSpace = async () => ({ type: "api", key: "ms-aaaa1111 bbbb-2222" })
  const r = await auth.checkin(withSpace)
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /无法识别/, `a space is not sendable either: ${r.message}`)
  const u = await auth.usage(withSpace)
  assert.match(u.error, /无法识别/, `usage should name it too: ${u.error}`)
})

test("a key pasted with whitespace around it is the same key", async () => {
  // The other side of the same rule: a token copied by hand or out of a
  // wrapped terminal often arrives with a newline or spaces around it. The
  // plugin trims before testing and before sending (rawKey), and so does the
  // sync tool (presetCandidates), so the two halves agree about the same
  // credential. Without the trim the key fails the visible-ASCII test and the
  // user is told their key is unusable — for a key that works everywhere else.
  const padded = " \tms-test-0000000000\n"
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers?.Cookie ?? "")
    return reply({ body: { success: true, data: { records: [] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: padded }))
    assert.notEqual(r.outcome, "failed", `a padded key is a usable key: ${r.message}`)
    assert.ok(seen.length > 0, "the request must have gone out")
    for (const cookie of seen) {
      assert.equal(cookie, "m_session_id=ms-test-0000000000", `the Cookie carries the trimmed key: ${cookie}`)
    }
  } finally {
    globalThis.fetch = real
  }
})

test("every request is made as the browser the README says it is", async () => {
  // README: "a browser UA and a Referer are enough". The plugin's sign-in is
  // the site's own web session, and the endpoints were measured answering
  // exactly this shape; a bare fetch UA is the one thing known to get a
  // different answer. Nothing asserted either header — dropping one, or
  // writing "Mozilla/6.0" (a prefix no browser has ever sent), was invisible
  // to the suite.
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers ?? {})
    return reply({ body: { success: true, data: { records: [] } } })
  }
  try {
    await auth.checkin(async () => ({ type: "api", key: "ms-test-0000000000" }))
    assert.ok(seen.length > 0, "a request must have gone out")
    for (const headers of seen) {
      assert.match(headers["User-Agent"] ?? "", /^Mozilla\/5\.0 .*Chrome\//, `not a browser UA: ${JSON.stringify(headers["User-Agent"])}`)
      assert.match(headers["User-Agent"] ?? "", /Safari\/537\.36$/, `a Chrome UA ends the way Chrome's does: ${JSON.stringify(headers["User-Agent"])}`)
      // and the whole string, not just its ends: the middle is a browser's
      // own tokens (AppleWebKit/537.36, KHTML, like Gecko), and a typo there
      // is a UA no browser has ever sent while the shape assertions above
      // still pass
      assert.equal(
        headers["User-Agent"],
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "the UA is one browser's, whole",
      )
      assert.equal(headers.Referer, "https://modelscope.cn/", "the Referer is the site root")
      assert.equal(headers.Accept, "application/json")
    }
  } finally {
    globalThis.fetch = real
  }
})

test("a network failure says what happened instead of the bare English", async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed")
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "failed")
    assert.doesNotMatch(r.message, /^fetch failed$/, `the raw English reached the card: ${r.message}`)
    assert.match(r.message, /网络|代理|重定向/, `should say what it may be, got: ${r.message}`)
  } finally {
    globalThis.fetch = real
  }
  // the name is not the only way a runtime says it: an Error that is not a
  // TypeError but says "fetch failed" is the same failure, and the message
  // test is what catches it.
  globalThis.fetch = async () => {
    throw new Error("fetch failed")
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "failed")
    assert.doesNotMatch(r.message, /^fetch failed$/, `a plain Error with the same words reached the card: ${r.message}`)
    assert.match(r.message, /网络|代理|重定向/, `should say what it may be, got: ${r.message}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a body that dies half-read is told in the user's words, not the runtime's", async () => {
  // The fetch itself answered — headers and a start of a body — so the
  // request did not fail where the translation lives. A captive-portal proxy
  // or a server that drops the socket mid-reply raises from the read instead,
  // and each runtime words that its own way: Node gives "terminated", Bun a
  // whole sentence about verbose: true and fetch(). Measured against a real
  // socket on both.
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          throw new TypeError("terminated")
        },
        releaseLock() {},
        cancel: async () => {},
      }),
    },
    text: async () => {
      throw new TypeError("terminated")
    },
  })
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.doesNotMatch(u.error, /^terminated$/, `the raw runtime string reached the card: ${u.error}`)
    assert.doesNotMatch(u.error, /verbose: true/, `a runtime's own advice reached the card: ${u.error}`)
    assert.match(u.error, /网络|代理|重定向/, `should say what it may be, got: ${u.error}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a body that hangs half-read gives up at its own timeout, and says so", { timeout: 8000 }, async (t) => {
  // the request's timer is armed for the whole call, but the translation that
  // reads it sat around fetch alone: a reply that stops after the headers is
  // cut by that same timer, from the read, and would reach the card as the
  // bare word the abort was given ("timeout").
  if (!withMockTimers(t)) return
  const real = globalThis.fetch
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  globalThis.fetch = async (url, init) => ({
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
          }),
        releaseLock() {},
        cancel: async () => {},
      }),
    },
  })
  try {
    const pending = auth.usage(async () => ({ type: "api", key: "ms-test" }))
    // let the request arm its timer before the clock is moved
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(8001)
    const u = await pending
    assert.match(u.error, /请求超时/, `a hung body should name the timeout, got: ${u.error}`)
    assert.match(u.error, /8 秒/, `and its length, got: ${u.error}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a request cut short by the hook's own deadline does not say 0 seconds", async () => {
  // The per-request cap is what is left of the hook's budget, so the last
  // request can have a few hundred milliseconds. Rounded, that printed
  // a request-timed-out line of 0 seconds, which says neither which limit
  // was hit nor anything
  // the user could act on.
  //
  // The number is the ceiling of the budget in seconds — 300ms is reported
  // as 1 second,
  // 1001ms as 2. A divisor written 1001 instead of 1000 rounds the same
  // 1001ms down to one second, and every other boundary with it; 300ms alone
  // cannot
  // see that, because both divisors call it one second.
  for (const [left, said] of [
    [300, "1 秒"],
    [1001, "2 秒"],
    [2002, "3 秒"],
  ]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const realNow = Date.now
        // the first read eats almost the whole 18s budget, leaving `left` ms.
        // The clock is pinned to a fixed base, not left tracking real time: a
        // clock that keeps advancing spends this test's margin on whatever the
        // machine takes between the hook's deadline and the second request, and
        // a loaded run starts that request with nothing left — it is never
        // sent, and the hook answers budget exhausted instead of the timeout
        // under
        // test (measured on Node 18: 2 failures in 20 runs, at 350ms and
        // 364ms, the length of the margin). Pinned, the hook's deadline is
        // base + 18_000 and the second read sees base + 18_000 - left whatever
        // the scheduler does: exactly `left` ms, every run.
        const base = realNow()
        Date.now = () => base
        let first = true
        const real = globalThis.fetch
        globalThis.fetch = async (url, init) => {
          if (first) {
            first = false
            Date.now = () => base + 18_000 - left
            return new Response(JSON.stringify({ success: true, data: { available_balance: 5 } }), { status: 200 })
          }
          // the second request's own timer is `left` ms; let it fire
          await new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
            setTimeout(() => init.signal.dispatchEvent?.(new Event("abort")), 0)
          })
          return new Response("{}", { status: 200 })
        }
        try {
          const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
          assert.match(u.error ?? "", /请求超时/, `should name the timeout: ${u.error}`)
          assert.doesNotMatch(u.error ?? "", /0 秒/, `a zero-second timeout says nothing: ${u.error}`)
          assert.ok(
            (u.error ?? "").includes(`请求超时（${said}）`),
            `${left}ms is ${said}, the ceiling of the budget: ${u.error}`,
          )
        } finally {
          globalThis.fetch = real
          Date.now = realNow
        }
      },
    )
  }
})

test("a server that echoes the token back does not put it on the card", async () => {
  // the login answer's own message and the ledger's titles go into the
  // check-in's line verbatim, and plugin-checkin.json keeps that line. A
  // server (or a proxy in front of it) that echoes the session must not have
  // it land there whole — the token is masked like every other place it could
  // appear.
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { success: false, message: `bad session ${token}, sign in again` } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: token }))
      assert.equal(r.outcome, "failed")
      assert.ok(!r.message.includes(token), `the login message echoed the token: ${r.message}`)
      assert.ok(r.message.includes("ms-a…5555"), `the masked token should stand in: ${r.message}`)
    },
  )
  // a ledger row's title is interpolated the same way, on the done and the
  // claimed paths alike
  const row = { gmt_created: today, type: "EARN", rule_key: "daily_active", title: token, total_amount: 200 }
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [row] } } },
      "/api/v1/users/login/info": { body: { success: true, data: { NickName: "Mison" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: token }))
      assert.equal(r.outcome, "done")
      assert.ok(!r.message.includes(token), `the row title echoed the token: ${r.message}`)
      assert.ok(r.message.includes("ms-a…5555"), `the masked token should stand in: ${r.message}`)
    },
  )
})

test("a nickname longer than the cut is not a token's front", async () => {
  // the nickname is cut to 40 before it is compared with the token, so a
  // 44-character token returned as the nickname slipped past `name === token`
  // and its first 40 characters were written to plugin-auth.json as the
  // account's name
  const token = "ms-0123456789abcdef0123456789abcdef012345678"
  assert.ok(token.length > 40)
  const dir = tmpDir("msmoli-longtok-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const hooks = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { success: true, data: { NickName: token } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await hooks.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, `the front of the token was written back: ${JSON.stringify(writes[0]?.body?.accountId)}`)
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
  }
})

test("a balance field that is missing or not a number is a failure, not 0", async () => {
  // data present, available_balance absent/null/renamed/formatted: reading it
  // as 0 is the definite-and-wrong conclusion the data guard above exists to
  // prevent, one field further in.
  //
  // The two wordings are two different causes, and the README names both: the
  // field is not there (absent, null, blank) versus the field is there and is
  // not a number. `v === undefined || v === null` closed to `&&` is never
  // true, so a null or an absent field drops to the second wording — a
  // failure that sends the user looking for a value that was never sent.
  for (const [data, why] of [
    [{ available: 1234 }, "absent"],
    [{ available_balance: null }, "null"],
    // Blank, in every spelling. `rawAvailable === ""` was the only one the
    // guard named, and `Number("   ")` is 0 like `Number("")`, so a field of
    // spaces answered with a zero balance — the same definite wrong 0,
    // wearing
    // whitespace. A tab and a newline are the same field read by an editor
    // that put nothing in it.
    [{ available_balance: "" }, "empty"],
    [{ available_balance: "   " }, "spaces"],
    [{ available_balance: "\t\n" }, "tab and newline"],
    // Number([]) is 0 and Number(true) is 1: both finite, both a definite
    // answer that is wrong. The empty list is the zero-balance answer this
    // guard is for; the boolean is one credit nobody granted.
    [{ available_balance: "1,234" }, "not a number"],
    [{ available_balance: [] }, "not a number"],
    [{ available_balance: true }, "not a number"],
    [{ available_balance: {} }, "not a number"],
  ]) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.ok(u.error, `a balance we cannot read must fail: ${JSON.stringify(data)}`)
        if (why === "not a number") assert.match(u.error, /不是数字/, `${JSON.stringify(data)} is there and is not: ${u.error}`)
        else assert.match(u.error, /没有 available_balance/, `${why}: the field is not there, and the message should say so: ${u.error}`)
        assert.ok(!u.windows, "no card is built from a balance we did not understand")
      },
    )
  }
  // The other side of blankOf: a number with room around it is still the
  // number it says. Refusing every string with a space in it would answer
  // "no card" to a balance magpie can read, and the guard would have traded
  // one wrong answer for a missing one.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: " 251.5 " } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, `a padded number is readable: ${u.error}`)
      assert.equal(u.balance, "251.5 魔粒可用")
    },
  )
})

test("a ledger amount we cannot read fails the read, it does not become 0", async () => {
  // A localized "1,200" (or a format change, or a null) is a body we do not
  // understand. Read as 0 it says it claimed 0 beside a balance that
  // clearly moved,
  // and the check-in answers `inactive` — which settles the day.
  const bad = ["1,200", "１２３", null, {}, true, "", "   ", "\t\n"]
  for (const amount of bad) {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 100 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ total_amount: amount })] } },
        },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.match(u.error ?? "", /total_amount/, `amount ${JSON.stringify(amount)} must fail the read: ${JSON.stringify(u)}`)
        assert.ok(!u.windows, "no card from a ledger we did not understand")
      },
    )
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day({ total_amount: amount })] } },
        },
      },
      async () => {
        const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
        // failed, not `inactive`: the day must stay open for another ask
        assert.equal(r.outcome, "failed", `amount ${JSON.stringify(amount)} must not settle the day: ${JSON.stringify(r)}`)
        assert.match(r.message, /total_amount/)
      },
    )
  }
  // and the growth comparison reads the ledger *after* the touch: a bad
  // amount appearing only there must fail too, not read as "nothing arrived"
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("login/info")) return new Response(JSON.stringify({ Code: 200, Success: true, Data: { NickName: "alice" } }), { status: 200 })
    reads += 1
    const records = reads === 1 ? [] : [day({ total_amount: "1,200" })]
    return new Response(JSON.stringify({ success: true, data: { records } }), { status: 200 })
  }
  try {
    const p = await MsmoliPlugin({ directory: "/tmp", client: { auth: { set: async () => ({ data: true }) } } })
    const r = await p.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "failed", `a bad amount after the touch must not settle the day: ${JSON.stringify(r)}`)
    assert.match(r.message, /total_amount/)
  } finally {
    globalThis.fetch = real
  }
  // a numeric string is a number, and is read as one — padded too, because
  // blankOf only refuses what holds nothing, not what holds a number with
  // room around it
  await withFetch(
    {
      "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 9 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ total_amount: "200" }), spend(" 50.5 ")] } },
      },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done")
      assert.equal(r.credit, 200)
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, `a padded number is readable: ${u.error}`)
      assert.equal(u.windows[0].amount, 50.5, "the padded spend is counted")
    },
  )
})

test("a row of a kind the card does not count does not need an amount", async () => {
  // The rule is that an amount we cannot read fails the read — for the rows
  // whose amounts go into the card. A row of another kind (a ledger that
  // grew an expiry row, say) is counted neither way, and failing the whole
  // card over its amount would hide numbers that are fine.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 100 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: { records: [day({ total_amount: 200 }), { gmt_created: today, type: "EXPIRE" }] },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, `an uncounted kind must not fail the card: ${JSON.stringify(u)}`)
      assert.equal(u.windows[0].limit, 200)
    },
  )
})

test("a nickname that is not a string is not written back", async () => {
  // text() would make "12345" or "[object Object]" of it, and that string
  // was written to plugin-auth.json as the account's name: the card then
  // shows it instead of the key's tail, and an alias keyed by the label
  // stops matching. A directory with no providers.json is a fresh install,
  // where the write is allowed — so a missing write is this guard, not the
  // alias one.
  const dir = tmpDir("msmoli-nick-")
  try {
    for (const nick of [{ weird: 1 }, [1, 2], 12345, true]) {
      const writes = []
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: nick } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
            body: { success: true, data: { records: [day()] } },
          },
        },
        async () => {
          const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (b) => (writes.push(b.body), { data: true }) } } })
          const r = await p.auth.checkin(async () => ({ type: "api", key: "ms-nickname-only-0001" }))
          assert.equal(r.outcome, "done", JSON.stringify(nick))
          assert.deepEqual(writes, [], `nickname ${JSON.stringify(nick)} must not be written back`)
        },
      )
    }
    // a string still is
    const writes = []
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "alice" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
          body: { success: true, data: { records: [day()] } },
        },
      },
      async () => {
        const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (b) => (writes.push(b.body), { data: true }) } } })
        await p.auth.checkin(async () => ({ type: "api", key: "ms-nickname-only-0001" }))
        assert.equal(writes.length, 1)
        assert.equal(writes[0].accountId, "alice")
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a ledger whose data is a list of rows is refused, not read as empty", async () => {
  // `data: [...]` — the rows without their wrapper — parsed as an object and
  // then found no `records`, so it read as an empty day and the check-in
  // answered inactive, which ends the day
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: [{ gmt_created: today, type: "EARN", rule_key: "daily_active", title: "注册并登录", total_amount: 200 }] },
      },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed", `a list under data must not settle the day: ${r.outcome}`)
      assert.match(r.message, /账单格式/)
    },
  )
})

test("a grant that was already there is not reported as this run's claim", async () => {
  // today's aliyun_bindlogin granted by the website, daily_active not yet:
  // the touch grants nothing new, and the old reading counted the pre-existing
  // row as claimed — a claim the host then settles the day on
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: {
            records: [{ gmt_created: today, type: "EARN", rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 }],
          },
        },
      },
      "/api/v1/users/login/info": { body: { success: true, data: { NickName: "Mison" } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "inactive", `nothing new was granted, so nothing was claimed: ${JSON.stringify(r)}`)
    },
  )
})

test("a rule that grows during the touch is this run's claim, with the growth", async () => {
  // rows are aggregated per (day, type, rule_key): a second grant of a rule
  // already on today's page grows its amount instead of adding a row. The
  // claim is that growth, not the row's total — reporting the total would
  // count credits granted before this run.
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    const reply = (body) => ({ status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) })
    if (path === "/api/v1/users/login/info") return reply({ success: true, data: { NickName: "Mison" } })
    reads += 1
    // aliyun_bindlogin, not daily_active: a daily_active already on the page
    // short-circuits to done before the touch
    const row = (amount) => ({ gmt_created: today, type: "EARN", rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: amount })
    return reply({ success: true, data: { records: [reads === 1 ? row(50) : row(100)] } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed", `the growth is a claim: ${JSON.stringify(r)}`)
    assert.equal(r.credit, 50, `the growth, not the row total: ${r.credit}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a growth of one 魔粒 is still this run's claim", async () => {
  // `gain > 0` decides that a rule's growth counts as the claim. As `> 1` a
  // growth of exactly one credit — the smallest grant there is — stops
  // being one: the check-in answers with a no-credit-record message for a
  // grant that landed. The
  // growth test above moves by 50, so the switch's own boundary was untested.
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    const reply = (body) => ({ status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) })
    if (path === "/api/v1/users/login/info") return reply({ success: true, data: { NickName: "Mison" } })
    reads += 1
    const row = (amount) => ({ gmt_created: today, type: "EARN", rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: amount })
    return reply({ success: true, data: { records: [reads === 1 ? row(0) : row(1)] } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(r.outcome, "claimed", `one 魔粒 is a grant: ${JSON.stringify(r)}`)
    assert.equal(r.credit, 1, `the smallest grant there is: ${r.credit}`)
    assert.match(r.message, /领取 1 魔粒/, `the card names it: ${r.message}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a negative grant or a negative balance is not written onto the card as one", async () => {
  // EARN can carry a reversal. Summed as it comes the card reads
  // claimed -50 and the limit is negative; a negative balance must not turn
  // the
  // percentage into NaN.
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 300 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: {
          success: true,
          data: { records: [{ gmt_created: today, type: "EARN", rule_key: "daily_active", title: "冲正", total_amount: -50 }] },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.equal(w.limit, 0, `limit must not be negative: ${w.limit}`)
      assert.ok(!w.display.includes("-"), `the card must not say 领 -50: ${w.display}`)
    },
  )
  // and the balance itself: the reversal direction can put it below zero, and
  // a balance of -5 credits is not a thing the card can show. The clamp
  // stopped at 0 for
  // the grant, but nothing had ever handed it a negative balance to clamp.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: -5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.balance, "0 魔粒可用", `a balance is not a debt: ${u.balance}`)
      assert.ok(!u.windows[0].display.includes("-"), `the card must not say 余额 -5: ${u.windows[0].display}`)
    },
  )
})

test("a balance with a floating-point tail is rounded like every other sum", async () => {
  // earned/spent were rounded; the balance was not, and 0.1 + 0.2 came out
  // as 0.30000000000000004 credits available
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0.1 + 0.2 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.balance, "0.3 魔粒可用")
    },
  )
})

test("a time that carries a zone is not read as Beijing time", async () => {
  // The whole string has to be "2026-10-26 09:13:40": no zone, exactly what
  // ModelScope writes. A reply that grew a zone would match the first 19
  // characters, have its zone ignored and the Beijing shift applied anyway —
  // a countdown 8 hours off, stated with full confidence.
  //
  // The stamps sit a year out, as the range and February tests do: dropped
  // onto a moment in the past, the "still running" filter would take them out
  // before cnTime's answer could show, and the test would pass with the
  // trailing anchor deleted. It carried fixed 2026-10-27 stamps until now and
  // had quietly stopped proving anything the day the clock passed them.
  const nextYear = new Date(Date.now() + 8 * 3600e3 + 365 * 86400e3).getUTCFullYear()
  const F = `${nextYear}-10-05`
  for (const stamp of [
    `${F}T09:13:40Z`, // a zone after a T
    `${F}T09:13:40+00:00`,
    `${F} 09:13:40Z`, // a zone after a space
    `${F} 09:13:40.123`, // fractional seconds: also not the whole string
    `${F} 09:13:40x`, // any trailing junk at all
    ` ${F} 09:13:40`, // and leading junk: the string is anchored at the front too
    `x${F} 09:13:40`,
  ]) {
    const body = { success: true, data: { records: [day({ expire_at: stamp })] } }
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(u.windows[0].resetsAt, "", `${stamp} carries a zone or junk we do not read`)
      },
    )
  }
  // the control: the same stamp with nothing around the seconds is a time, so
  // the loop above is not passing because the fixtures stopped reaching cnTime
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ expire_at: `${F} 09:13:40` })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, `${F}T01:13:40.000Z`, "the bare stamp is a time")
    },
  )
})

test("a February that has no 30th is no time at all", async () => {
  // Date.UTC rolls Feb 30 to March 2. The range check catches month 13 and
  // 99:99:99, but not a day the month does not have. The year is next year so
  // the rolled-over date would still be in the future — otherwise the
  // "still running" filter would drop it for the wrong reason and the test
  // would pass even if cnTime accepted the date.
  const nextYear = new Date(Date.now() + 8 * 3600e3 + 365 * 86400e3).getUTCFullYear()
  const body = { success: true, data: { records: [day({ expire_at: `${nextYear}-02-30 10:00:00` })] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, "", "an impossible date is no date at all")
    },
  )
})

test("a balance with no data at all is a failure, not a card that says 0 left", async () => {
  // Reading the balance as 0 is a definite and wrong conclusion: the card's
  // bar fills up and the gateway takes the account for used up. A response
  // with no data is an unreadable answer, so it has to be retried.
  await withFetch(
    { "/openapi/v1/magicubes/balance": { body: { success: true } } },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error, /没有 data/, `should refuse the shapeless body: ${u.error}`)
      assert.ok(!u.windows, "no card is built from a body we did not understand")
    },
  )
})

test("a relative XDG_CONFIG_HOME is ignored, as magpie itself ignores it", async () => {
  // magpie's appdir only honours a rooted XDG_CONFIG_HOME (env.go's rooted()).
  // Joining a relative one read "./magpie/msmoli.json" against whatever folder
  // the process happened to start in — a file magpie never keeps. The user's
  // real window then did nothing, because the plugin read a different file.
  const cwd = process.cwd()
  const scratch = tmpDir("msmoli-relxdg-")
  const home = tmpDir("msmoli-relhome-")
  const saved = { env: process.env.MAGPIE_MSMOLI_CONFIG, xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME }
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    // a config file that would turn the window off, at the relative path
    mkdirSync(join(scratch, "relative", "path", "magpie"), { recursive: true })
    writeFileSync(join(scratch, "relative", "path", "magpie", "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    // and magpie's real folder, with the default window
    mkdirSync(join(home, ".config", "magpie"), { recursive: true })
    process.chdir(scratch)
    process.env.XDG_CONFIG_HOME = join("relative", "path")
    process.env.HOME = home
    const hooks = await MsmoliPlugin({})
    const realNow = Date.now
    Date.now = () => Date.parse("2026-10-26T02:00:00+08:00") // 02:00, before any window
    try {
      const r = await hooks.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      // the default window's deferral, not the relative file's "off" (which
      // would have gone on to send a request)
      assert.match(r.message, /后自动领取/, `a relative XDG must not be joined: ${r.message}`)
    } finally {
      Date.now = realNow
    }
  } finally {
    process.chdir(cwd)
    if (saved.env === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved.env
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.xdg
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
    rmSync(scratch, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("with no directory, the config comes from XDG_CONFIG_HOME, else the home folder", async () => {
  // the host hands over input.directory, so this path only runs for a plugin
  // loaded without one (a bare import, a test harness): it must still look in
  // magpie's own folder rather than the process's working directory.
  const dir = tmpDir("msmoli-xdg-")
  const saved = { env: process.env.MAGPIE_MSMOLI_CONFIG, xdg: process.env.XDG_CONFIG_HOME }
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    mkdirSync(join(dir, "magpie"), { recursive: true })
    writeFileSync(join(dir, "magpie", "msmoli.json"), JSON.stringify({ checkinWindow: ["09:15", "11:45"] }))
    process.env.XDG_CONFIG_HOME = dir
    const hooks = await MsmoliPlugin({})
    const realNow = Date.now
    Date.now = () => Date.parse("2026-10-25T00:30:00+08:00") // before the window
    try {
      const r = await hooks.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      const m = /^(\d{2}):(\d{2}) 后自动领取/.exec(r.message)
      assert.ok(m, `should be before a window: ${r.message}`)
      const at = +m[1] * 60 + +m[2]
      assert.ok(at >= 9 * 60 + 15 && at < 11 * 60 + 45, `the window should be the one XDG names, got ${m[0]}`)
    } finally {
      Date.now = realNow
    }
  } finally {
    if (saved.env === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved.env
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.xdg
    rmSync(dir, { recursive: true, force: true })
  }
})

test("once the claim is due, the card stops pointing at the moment it was due", async () => {
  // The hint exists for the hours before the window: a bare claim of 0 alone
  // reads like
  // something went wrong. Past the target it is a promise about the past —
  // the claim has already been asked for — so it has to go. The hash decides
  // the target, so the clock goes to the window's own end, past any target it
  // could have picked (the modulo never reaches the end minute).
  const target = await (async () => {
    // read the target this account gets, at a clock before the window opens
    return withWindow(["08:30", "10:00"], `${today} 00:00:00`, () => targetOf(auth.checkin))
  })()
  assert.ok(target.minute >= 8 * 60 + 30 && target.minute < 10 * 60, `target inside the window: ${target.text}`)
  await withWindow(["08:30", "10:00"], `${today} 10:00:00`, async () => {
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-due" }))
        assert.doesNotMatch(u.windows[0].display, /领取/, `past the target, the card must not promise it: ${u.windows[0].display}`)
      },
    )
  })
})

test("a key too short for magpie to hint goes by magpie's label, not one of our own", async () => {
  // magpie builds the label "API key …tail" only when the key is 12 characters
  // or more (host.js's hintOf); anything shorter is shown as plain "API key",
  // which is the string a user's alias is kept under. Reading a shorter key
  // with our own tail would look the alias up under a name nothing carries,
  // find nothing, and write the nickname over the user's own name.
  const dir = tmpDir("msmoli-short-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ providers: [{ id: "msmoli", accountNames: { "api key": "主号" } }] }),
  )
  const token = "ms-short-11"
  assert.equal(token.length, 11, "a key one character under magpie's hint threshold")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, "the user's alias is keyed to magpie's own label, and must be honoured")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token under magpie's hint length is masked whole, never by its ends", async () => {
  // maskToken shows the first and last four characters — that is a hint, and
  // only from 12 characters up, the same threshold as magpie's own hintOf
  // (host.js). An 11-character key shown by its ends is eight of its eleven
  // characters on the card and in magpie's log, which is not a mask at all.
  const token = "ms-short-11"
  assert.equal(token.length, 11, "one character under magpie's hint threshold")
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { success: false, message: `bad session ${token}, sign in again` } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: token }))
      assert.equal(r.outcome, "failed")
      assert.ok(!r.message.includes(token), `the short key reached the card: ${r.message}`)
      assert.ok(!r.message.includes("ms-s"), `its ends are most of it: ${r.message}`)
      assert.ok(r.message.includes("…"), `the whole key is the mask: ${r.message}`)
    },
  )
})

test("a key of exactly magpie's hint length is labelled and masked by its tail", async () => {
  // The other side of the two tests above, and the boundary itself: 12 is the
  // first length magpie's hintOf gives a tail to (host.js), so it is the first
  // length labelOf may call "API key …tail" and the first maskToken may show
  // by its ends. A threshold written `> 12` — or 13 — moves both one key too
  // far: the alias kept under magpie's own label is looked up under the bare
  // "API key", nothing is found, and the nickname is written over the user's
  // name; the echo of the same key is printed whole, since maskToken falls
  // back to the bare "…" only below its threshold.
  const token = "ms-abcdefghi"
  assert.equal(token.length, 12, "the first length magpie hints at")
  const dir = tmpDir("msmoli-hint12-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ providers: [{ id: "msmoli", accountNames: { "api key …fghi": "主号" } }] }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 0, "an alias under magpie's own label must be honoured at the threshold too")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { success: false, message: `bad session ${token}, sign in again` } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: token }))
      assert.equal(r.outcome, "failed")
      assert.ok(!r.message.includes(token), `the key reached the card whole: ${r.message}`)
      assert.match(r.message, /ms-a…fghi/, `its ends are the mask at this length: ${r.message}`)
    },
  )
})

test("an empty accountId is no accountId, and the key's own label is used", async () => {
  // labelOf takes the accountId only when it is a string that carries
  // something: `typeof x === "string" && x` widened to `||` makes "" a label
  // of its own. An empty label is not a name an alias could ever be kept
  // under, so aliasOf answers "could not look" instead of "no alias" and the
  // nickname is never written — on a fresh install the card would show the
  // key's tail for good instead of the account's own name.
  const dir = tmpDir("msmoli-emptyid-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-emptyid-0000-0000-0000-000000000019"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token, accountId: "" }))
        assert.equal(writes.length, 1, "an empty accountId is no accountId, so the nickname is written")
        assert.equal(writes[0].body.accountId, "Mison")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an accountId on the sign-in is the label its alias is kept under", async () => {
  // labelOf takes the accountId when the sign-in already carries one: magpie
  // shows the account by that name, so that is the string a rename in its UI
  // is kept under. Read as `!==` ("a non-string is the label"), the branch
  // never runs for a real accountId, the lookup goes to the key's tail
  // instead, misses the alias, and the nickname is written over it.
  const dir = tmpDir("msmoli-accid-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ providers: [{ id: "msmoli", accountNames: { oldname: "主号" } }] }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-accid-0000-0000-0000-000000000023"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token, accountId: "OldName" }))
        assert.equal(writes.length, 0, "the alias lives under the accountId magpie shows, and must be honoured")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("with no directory there is nowhere to look, so the nickname is not written", async () => {
  // aliasOf's `!dir` half: the host's folder is the only place a user's
  // aliases are known to live. Without one, `!dir && !label` stops guarding
  // (a label always exists) and the lookup reads "providers.json" relative to
  // the process's cwd — a file that is not magpie's, whose absence reads as
  // "fresh install, safe to write". The name is written over a state nobody
  // looked at.
  const cwd = process.cwd()
  const scratch = tmpDir("msmoli-nodir-")
  try {
    writeFileSync(join(scratch, "providers.json"), JSON.stringify({ providers: [{ id: "msmoli" }] }))
    process.chdir(scratch)
    const writes = []
    const p = await MsmoliPlugin({ client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await p.auth.checkin(async () => ({ type: "api", key: "ms-nodir-0000-0000-0000-000000000024" }))
        assert.equal(writes.length, 0, "no directory is having nowhere to look, not 'no alias'")
      },
    )
  } finally {
    process.chdir(cwd)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("an accountNames value that is not a string is not a name to keep", async () => {
  // providers.json is another program's file. `typeof mine === "string" && mine`
  // keeps a name only when it is a non-empty string; read as `||`, a number
  // under the label is returned as the user's name, `!== ""` is true, and the
  // nickname is never written — the card keeps the key's tail for good.
  const dir = tmpDir("msmoli-nonstr-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ providers: [{ id: "msmoli", accountNames: { "api key …0016": 42 } }] }),
  )
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-nonstr-0000-0000-0000-000000000016"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(writes.length, 1, "a number is not a name, so the nickname is written")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an accountNames that is not a map does not take the check-in down with it", async () => {
  // magpie's providers.json is written by another program, and a map with
  // nothing in it can arrive as null (Go marshals a nil map that way). The
  // guard that skips such an entry is `!names || typeof names !== "object"`;
  // narrowed to `&&` it stops guarding null — typeof null is "object" — and
  // `names[key]` then throws out of the check-in, which answers failed and
  // retries forever over a name it was never going to write.
  const dir = tmpDir("msmoli-nullnames-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "msmoli", accountNames: null }] }))
  const token = "ms-null-0000-0000-0000-000000000017"
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const r = await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(r.outcome, "inactive", `a null accountNames is no names, not a broken file: ${r.message}`)
        assert.equal(writes.length, 1, "with no names to honour, the nickname is written")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a nickname a token could hold is refused at 20 characters, and a longer one is not", async () => {
  // unusableName refuses a name of 20+ characters that sits inside the token:
  // a piece that long is the token being echoed, not a person's name. Both
  // halves of that rule are load-bearing and neither was asserted — `>= 20`
  // widened to `>= 21` writes a 20-character slice of the token into
  // plugin-auth.json, and `&&` widened to `||` refuses every nickname of 20+
  // characters, however unrelated. The threshold is the token's own front:
  // whatever its length, a piece of it must be refused at 20 and a name the
  // token does not contain must go through.
  const dir = tmpDir("msmoli-longname-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    // Each case gets its own token: a name is written back once per token
    // (`named`), so one token shared across the loop lets an early passing
    // case consume the write a later one asserts on. The pieces are sliced
    // from the token the case actually signs in with.
    const stranger = "MisonLiangWithALongName"
    for (const [i, slice, want, why] of [
      [0, 20, 0, "a 20-character slice of the token is the token"],
      [1, null, 1, "a long name the token does not hold is a name"],
      // 19 is one short of the rule: that slice is not looked for, and a
      // nickname of a few characters that happens to sit inside a token is a
      // nickname. Tightening `>= 20` to `>= 19` refuses it.
      [2, 19, 1, "a 19-character slice is not met by the rule"],
    ]) {
      const tok = `ms-0123456789abcdef0123456789abcdef012345${i}${i}`
      const nick = slice === null ? stranger : tok.slice(0, slice)
      const writes = []
      const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: nick } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        async () => {
          await withClient.auth.checkin(async () => ({ type: "api", key: tok }))
          assert.equal(writes.length, want, why)
        },
      )
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("usage names an answer it cannot read, at either step and in its own words", async () => {
  // The 401 and 403 tests loop over both steps because the balance read runs
  // first and a fixture that only breaks the ledger never gets past it. The
  // same trap hid the four check lines this test now walks: before it existed,
  // `if (false)` on the ledger step's two (index.mjs) left the whole suite
  // green — those lines never executed at all — and the balance step's and
  // todayEarn's parse branches stayed green because the next line's fallback
  // says almost the same thing (a ledger query failure with HTTP 404 vs a
  // not-JSON response with HTTP 404) and the fixtures only ever matched the
  // status code.
  //
  // Each case keeps its own words — the step's name (balance / ledger) and
  // either
  // the parse failure (which names the HTTP status) or the server's own message
  // — and the assertion cannot pass on the wrong line's fallback. `saidOf` of a
  // body that did not parse is empty, so the *next* line down prints the status
  // too: matching only /HTTP 200/ would stay green under `if (false)`. Requiring
  // the not-JSON wording pins the parse branch; requiring the server's words
  // pins the
  // envelope branch; a body with no message at all pins the `|| HTTP …` arm.
  const okBalance = { body: { success: true, data: { available_balance: 5 } } }
  const okLedger = { body: { success: true, data: { records: [] } } }
  const cases = [
    { at: "balance", bad: { raw: "<html>proxy error</html>" }, want: /余额查询失败：响应不是 JSON.*HTTP 200/ },
    { at: "balance", bad: { body: { success: false, message: "系统繁忙" } }, want: /余额查询失败：系统繁忙/ },
    { at: "balance", bad: { body: { success: false } }, want: /余额查询失败：HTTP 200/ },
    { at: "transactions", bad: { raw: "<html>proxy error</html>" }, want: /账单查询失败：响应不是 JSON.*HTTP 200/ },
    { at: "transactions", bad: { body: { success: false, message: "系统繁忙" } }, want: /账单查询失败：系统繁忙/ },
    { at: "transactions", bad: { body: { success: false } }, want: /账单查询失败：HTTP 200/ },
  ]
  for (const { at, bad, want } of cases) {
    const u = await withFetch(
      {
        "/openapi/v1/magicubes/balance": at === "balance" ? bad : okBalance,
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": at === "transactions" ? bad : okLedger,
      },
      async () => auth.usage(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok(u.error, `${at} with ${JSON.stringify(bad)} must fail`)
    assert.match(u.error, want, `the failure should be this step's own: ${u.error}`)
    assert.equal(u.windows, undefined, `no window from a read we could not understand (${at})`)
  }
  // The check-in path reads the same ledger through todayEarn, which has its
  // own copy of the two lines — mutating either of *those* stayed green while
  // only usage was covered, because usage never calls todayEarn.
  for (const { bad, want } of [
    { bad: { raw: "<html>proxy error</html>" }, want: /账单查询失败：响应不是 JSON.*HTTP 200/ },
    { bad: { body: { success: false, message: "系统繁忙" } }, want: /账单查询失败：系统繁忙/ },
    { bad: { body: { success: false } }, want: /账单查询失败：HTTP 200/ },
  ]) {
    const r = await withFetch({ "/openapi/v1/magicubes/transactions?page=1&page_size=50": bad }, async () =>
      auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.equal(r.outcome, "failed", `check-in with ${JSON.stringify(bad)} must fail`)
    assert.match(r.message, want, `the failure should be the ledger's own: ${r.message}`)
    assert.notEqual(r.signIn, "expired", "a bad answer is not a bad token")
  }
})

test("a data object without a records key is an empty ledger, not an error", async () => {
  // recordsOf's decision (index.mjs): the keys are optional in ModelScope's
  // answers, so a data object with no records is an empty day — while no data
  // at all, or records of the wrong shape, is a failure. Live evidence today:
  // even page 99 of a real ledger answers `records: []` with the key present,
  // so this branch is a mercy for a shape we have not observed, kept because
  // the alternative (throwing) would settle nothing and error every ask. The
  // test pins the decision either way a future edit might flip it.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: {} } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, "an empty ledger is not a failure")
      assert.match(u.windows[0].display, /今日用 0 \/ 领 0/)
    },
  )
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: {} } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.equal(r.outcome, "inactive", "the day is answered on what the empty ledger says")
  // records that is there and null is the same mercy: the null half of the
  // check, dropped, turns it into a records-not-a-list failure — a failure
  // over a shape
  // that carries exactly as much as a missing key does.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: null } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, "a null records is an empty ledger too")
      assert.match(u.windows[0].display, /今日用 0 \/ 领 0/)
    },
  )
})

// ---- Round twenty-three: the spots left by the wide sweep over string
// literals (the six rounds before swept booleans, comparisons and integers).
// Each is a "change this one letter to another and the whole suite stays
// green" case.

test("no request may follow a redirect away from modelscope.cn", async () => {
  // The session cookie is a request header, not a cookie jar: a redirect that
  // is followed asks whatever host the Location names, with the header in
  // hand. Measured against a real two-port loopback pair — the first answering
  // 302 to the second — with "error" the second listener is never asked at
  // all, and with "follow" it is asked twice (the balance and the ledger).
  // Every test here stubs fetch, so nothing had ever looked at the mode: a
  // typo fails closed (the request never goes out) and a stray "follow" fails
  // open, and the suite reads the same either way.
  const inits = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    inits.push(init)
    return reply({ body: { success: true, data: { records: [] } } })
  }
  try {
    await auth.checkin(async () => ({ type: "api", key: "ms-test-0000000000" }))
    await auth.usage(async () => ({ type: "api", key: "ms-test-0000000000" }))
    assert.ok(inits.length >= 2, "requests must have gone out")
    for (const init of inits) {
      assert.equal(init.redirect, "error", "a followed redirect would carry the session cookie off-site")
    }
  } finally {
    globalThis.fetch = real
  }
})

test("an answer in the capital-S envelope counts, with no Code to fall back on", async () => {
  // okOf reads three shapes: {success}, {Success}, {Code:"200"}. Every fixture
  // that carries Success also carries Code, so the second branch has never
  // decided anything on its own: mis-read it, and a ModelScope answer that
  // comes in that envelope is refused as if it were a proxy's error page.
  const u = await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { Success: true, Data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { Success: true, Data: { records: [] } } },
    },
    async () => auth.usage(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.equal(u.error, undefined, `a Success envelope is an answer: ${u.error}`)
  assert.equal(u.balance, "5 魔粒可用")
})

test("a getAuth that rejects as expired marks the sign-in expired, on both hooks", async () => {
  // magpie's own authCopy answers undefined rather than throwing, so these two
  // exits run only for a host that does throw. When it throws and says the
  // session is gone, that has to reach the card: without it magpie sends the
  // user to sign in again for a token it already knows is dead. Both spellings
  // of "gone" are what signedOut reads (signIn:"expired" and a bare .expired).
  const dir = tmpDir("msmoli-getexp-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  const real = globalThis.fetch
  let asked = 0
  globalThis.fetch = async () => {
    asked += 1
    throw new Error("should not have been asked")
  }
  try {
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    for (const shape of [
      Object.assign(new Error("session gone"), { expired: true }),
      Object.assign(new Error("session gone"), { signIn: "expired" }),
    ]) {
      const fail = async () => {
        throw shape
      }
      const u = await p.auth.usage(fail)
      const c = await p.auth.checkin(fail)
      assert.equal(u.signIn, "expired", `usage must say so: ${JSON.stringify(u)}`)
      assert.equal(c.signIn, "expired", `check-in must say so: ${JSON.stringify(c)}`)
    }
    assert.equal(asked, 0, "a failed getAuth must not send a request")
  } finally {
    globalThis.fetch = real
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a runtime that words its own abort still reads as a timeout", { timeout: 8000 }, async (t) => {
  // saidFailure recognises our own abort by identity first (e === signal.reason).
  // Two other shapes reach it only through the word the reason carries: a
  // runtime that raises an error of its own when the abort lands, and one that
  // copies the reason's message into a fresh error. There identity fails and
  // the word in `new Error("timeout")` is all that is left — lose it and the
  // card shows that runtime's English (or a bare "timeout") to the user.
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("The operation was aborted due to timeout")
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.match(u.error ?? "", /请求超时（8 秒）/, `should be our wording, got: ${u.error}`)
  } finally {
    globalThis.fetch = real
  }
  // and the reason's own word, in an error that is not the reason object
  if (!withMockTimers(t)) return
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(init.signal.reason?.message ?? "aborted")), { once: true })
    })
  try {
    const pending = auth.usage(async () => ({ type: "api", key: "ms-test" }))
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(8001)
    const copied = await pending
    assert.match(copied.error ?? "", /请求超时（8 秒）/, `a copied reason must still read as a timeout: ${copied.error}`)
  } finally {
    globalThis.fetch = real
  }
})

test("with no directory and no XDG_CONFIG_HOME, the config comes from ~/.config/magpie", async (t) => {
  // The other half of the sentence the XDG test finishes: an installed magpie
  // keeps its files in ~/.config/magpie when XDG says nothing, and that is the
  // folder the README tells a user to write msmoli.json into. Nothing asserted
  // the name of that folder — read the wrong one, the user's window is
  // silently the default, with their file sitting where they were told.
  // Both spellings of "home" are set because the runtimes read different ones:
  // HOME on POSIX, USERPROFILE on Windows.
  const home = tmpDir("msmoli-homewin-")
  mkdirSync(join(home, ".config", "magpie"), { recursive: true })
  // a window that does not overlap the default 08:30-10:00, so a fall-through
  // to the default is not mistaken for having read the file
  writeFileSync(join(home, ".config", "magpie", "msmoli.json"), JSON.stringify({ checkinWindow: ["02:00", "03:00"] }))
  const saved = { env: process.env.MAGPIE_MSMOLI_CONFIG, xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME, up: process.env.USERPROFILE }
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    process.env.XDG_CONFIG_HOME = ""
    process.env.HOME = home
    process.env.USERPROFILE = home
    // Bun resolves homedir() once at startup and ignores HOME set afterwards,
    // so on that runtime the plugin would read the real user's home whatever
    // this test does. Skipped with the reason, not silently passed.
    if (homedir() !== home) {
      t.skip(`this runtime does not read HOME at call time (homedir() is ${homedir()})`)
      return
    }
    const hooks = await MsmoliPlugin({})
    const realNow = Date.now
    Date.now = () => Date.parse("2026-10-25T00:30:00+08:00")
    try {
      const r = await hooks.auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      const t = targetFrom(r.message)
      assert.ok(
        t.minute >= 2 * 60 && t.minute < 3 * 60,
        `the window should be the one ~/.config/magpie names, got ${t.text}`,
      )
    } finally {
      Date.now = realNow
    }
  } finally {
    if (saved.env === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved.env
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.xdg
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
    if (saved.up === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved.up
    rmSync(home, { recursive: true, force: true })
  }
})

// ── Round twenty-four: operators and set predicates ────────────────────
// The earlier rounds changed booleans, comparisons, integers and string /
// regex constants; `??`↔`||`, `.some`↔`.every`, `+=`↔`-=`, the presence of
// `?.` and of `await` were never touched. Every mutation was run against
// the real module: the cases below are the only places where those mutations
// show.

test("a body that arrives in pieces is put back together byte for byte", async () => {
  // fetch hands the body over in whatever pieces the socket delivered, and a
  // piece boundary lands wherever it lands — inside a multi-byte character as
  // often as not. The pieces are joined by byte offset and decoded once:
  // joined with a decreasing offset (`at -=`) the second piece lands before
  // the first and the read throws "offset is out of bounds"; decoded piece by
  // piece, a multi-byte character becomes two replacement marks and the
  // card's title is rubble.
  const body = { success: true, data: { records: [day({ title: "注册并登录" })] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body, chunkBytes: 3 },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "小明" } }, chunkBytes: 5 },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "done", `a chunked body is still a body: ${r.message}`)
      assert.match(r.message, /注册并登录/, `the title must survive the split: ${r.message}`)
    },
  )
})

test("a getAuth that hands back nothing is a missing sign-in, not a crash", async () => {
  // magpie's authCopy answers undefined for a key that was never stored — the
  // ordinary state of a provider that was added but not signed in. `auth?.type`
  // read as `auth.type` puts "Cannot read properties of undefined" on the card,
  // which reads as the plugin being broken rather than the account being new.
  for (const nothing of [undefined, null]) {
    const u = await auth.usage(async () => nothing)
    assert.equal(u.error, "没有登录信息", `usage: ${u.error}`)
    assert.equal(u.signIn, "")
    const c = await auth.checkin(async () => nothing)
    assert.equal(c.outcome, "failed")
    assert.match(c.message, /没有登录信息/, `checkin: ${c.message}`)
  }
})

test("a getAuth that rejects with null still gets a card, not a TypeError", async () => {
  // `throw null` is a legal rejection, and the host's rejection value is its
  // own to choose. whyOf and signedOut read e?.message / e?.signIn; without the
  // `?.` the catch block itself throws, and the hook rejects where it promised
  // an answer.
  const u = await auth.usage(async () => {
    throw null
  })
  assert.equal(u.error, "用量查询失败")
  assert.equal(u.signIn, "")
  const c = await auth.checkin(async () => {
    throw null
  })
  assert.equal(c.outcome, "failed")
  assert.equal(c.message, "签到失败")
})

test("a null row in the ledger is skipped, not read from", async () => {
  // records is a list the server fills; a null among the rows is not a row.
  // The card and the check-in both walk it with `r?.field`; read as `r.field`
  // one null takes the whole answer down with "Cannot read properties of null"
  // — a card that looks broken because the server sent junk.
  const body = { success: true, data: { records: [null, day()] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 300 } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "" } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.error, undefined, `usage must skip the null row: ${u.error}`)
      assert.equal(u.balance, "300 魔粒可用")
      const c = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(c.outcome, "done", `the check-in must skip it too: ${c.message}`)
    },
  )
})

test("a null entry in providers.json does not stop the name being written back", async () => {
  // providers.json is another program's file and can arrive half-written: a
  // null in the providers list is a row that is not a provider. aliasOf walks
  // every list looking for our id; read as `p.id` the null throws, and the
  // check-in reports "Cannot read properties of null" with the nickname never
  // written back.
  const dir = tmpDir("msmoli-nullprov-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [null, { id: "msmoli", accountNames: {} }] }))
  const token = "ms-null-0000-0000-0000-000000000024"
  const writes = []
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "小明" } } },
      },
      async () => {
        const c = await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(c.outcome, "done", `a junk row is not a failed check-in: ${c.message}`)
        assert.equal(writes.length, 1, "the nickname should still be written back")
        assert.equal(writes[0].body.accountId, "小明")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a config whose provider field is not an object gets a fresh one", async () => {
  // magpie builds config as `{ provider: {}, ...userConfig }`, so a user's own
  // provider field wins — and one that is not an object (a string left by an
  // older version, a number, a boolean) made `provider[ID] = …` a TypeError.
  // The host logs a config hook's error and carries on, so the plugin showed
  // up unnamed with nothing on screen to say why. `??=` replaces null and
  // undefined only.
  for (const junk of ["", 0, false, "旧条目"]) {
    const config = { provider: junk }
    await hooks.config(config)
    assert.deepEqual(config.provider, { msmoli: { name: "ModelScope 魔粒" } }, `provider was ${JSON.stringify(junk)}`)
  }
})

test("a size refusal survives a cancel that fails", async () => {
  // Over the cap the read is abandoned; cancel() closes the socket, and a
  // socket already gone can make it reject. Awaiting it unguarded lets that
  // rejection replace the refusal with the runtime's own words; dropping the
  // await leaves it unobserved, which Node treats as a process-level failure.
  const real = globalThis.fetch
  const unhandled = []
  const watch = (e) => unhandled.push(e)
  process.on("unhandledRejection", watch)
  globalThis.fetch = async (url) => {
    if (!String(url).includes("balance")) return reply({ body: { success: true, data: { records: [] } } })
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let sent = 0
          return {
            async read() {
              sent += 1
              return sent > 300 ? { done: true, value: undefined } : { done: false, value: new Uint8Array(1024) }
            },
            async cancel() {
              throw new Error("socket already gone")
            },
            releaseLock() {},
          }
        },
      },
      text: async () => "",
    }
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.match(u.error ?? "", /过大/, `the refusal is ours to word: ${u.error}`)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(unhandled, [], "the abandoned cancel must not reject unobserved")
  } finally {
    process.off("unhandledRejection", watch)
    globalThis.fetch = real
  }
})

test("a fetch that rejects with nothing is still a sentence, not a TypeError", async () => {
  // the same rule as getAuth one step later: the runtime's rejection value is
  // its own to choose, and `throw null` from fetch is legal. saidFailure reads
  // e?.message and e?.name; without the `?.` the handler throws where the card
  // promised a failure to read.
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    throw null
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(u.error, "用量查询失败", `usage: ${u.error}`)
    assert.equal(u.signIn, "")
    const c = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
    assert.equal(c.outcome, "failed")
    assert.equal(c.message, "签到失败")
  } finally {
    globalThis.fetch = real
  }
})

test("a host with no auth.set still gets its check-in, with the name simply not written", async () => {
  // `!client?.auth?.set` is the guard for a client that cannot write: the
  // host passes a client, not necessarily one with every method. Read as
  // `client?.auth.set`, a client without auth throws on `.set`, and the
  // check-in reports a TypeError instead of claiming. The fixtures that pin
  // the guard's own edges are `{ auth: {} }` (auth there, set not) and
  // `{ auth: { set: 1 } }` (set not callable): both must count as "cannot
  // write" and be walked past — read as `!client?.auth`, the first one calls
  // a non-function and the check-in fails.
  const dir = tmpDir("msmoli-noset-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    for (const client of [{}, { app: {} }, { app: { log: () => {} } }, { auth: {} }, { auth: { set: 1 } }]) {
      const p = await MsmoliPlugin({ directory: dir, client })
      await withFetch(
        {
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "小明" } } },
        },
        async () => {
          const c = await p.auth.checkin(async () => ({ type: "api", key: "ms-noset-0000-0000-000000000009" }))
          assert.equal(c.outcome, "done", `a client without auth.set is not a failed check-in: ${c.message}`)
        },
      )
      // and no doomed write is attempted: the guard returns before the call,
      // so the catch's warn log never fires. Dropped, every check-in on such a
      // host writes a spurious "account name not written back: … is not a
      // function" into magpie's log — a failure report for a client that
      // simply was never able to write.
      const logs = []
      const withLog = await MsmoliPlugin({ directory: dir, client: { ...client, app: { log: (o) => logs.push(o) } } })
      await withFetch(
        {
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "小红" } } },
        },
        async () => {
          await withLog.auth.checkin(async () => ({ type: "api", key: "ms-noset-0000-0000-000000000009" }))
        },
      )
      assert.equal(logs.length, 0, `no write was attempted, so nothing may be logged: ${JSON.stringify(logs)}`)
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the nickname is written back before the hook answers", async () => {
  // rememberAccountFields is awaited on both paths: the host labels the account
  // by the accountId, and a write that is still in flight when the card is
  // answered has not landed anywhere yet. Dropped, the check-in answers first
  // and the write races it — on a host that closes the plugin the moment the
  // answer is in, it never lands at all.
  const dir = tmpDir("msmoli-awaitset-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const client = {
      auth: {
        set: (o) =>
          new Promise((resolve) => {
            setTimeout(() => {
              writes.push(o)
              resolve()
            }, 5)
          }),
      },
      app: { log: () => {} },
    }
    const p = await MsmoliPlugin({ directory: dir, client })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 300 } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "小明" } } },
      },
      async () => {
        const c = await p.auth.checkin(async () => ({ type: "api", key: "ms-await-0000-0000-000000000001" }))
        assert.equal(c.outcome, "done")
        assert.equal(writes.length, 1, "the write must have landed by the time the hook answers")

        // the other path: a check-in whose write failed leaves the name known
        // and the token unwritten, and the next usage retries it. That retry
        // is awaited too — the card must not be answered ahead of it.
        let failNext = true
        client.auth.set = (o) =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              if (failNext) {
                failNext = false
                reject(new Error("host busy"))
              } else {
                writes.push(o)
                resolve()
              }
            }, 5)
          })
        const p2 = await MsmoliPlugin({ directory: dir, client })
        const c2 = await p2.auth.checkin(async () => ({ type: "api", key: "ms-await-0000-0000-000000000002" }))
        assert.equal(c2.outcome, "done", `the failed write is not a failed check-in: ${c2.message}`)
        assert.equal(writes.length, 1, "the failed write left nothing behind")
        const before = writes.length
        const u = await p2.auth.usage(async () => ({ type: "api", key: "ms-await-0000-0000-000000000002" }))
        assert.equal(u.error, undefined, `usage should read: ${u.error}`)
        assert.equal(writes.length, before + 1, "the retried write must have landed by the time usage answers")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a slow name write cannot spend the usage read's budget", async () => {
  // The check-in's write waits until after its answer because the host's
  // auth.set can spend ~20s of its 25s on a lock (see the test above). The
  // usage hook retries a write the check-in failed, and that retry ran before
  // the two reads: a lock held for 30s turned a card whose numbers were one
  // request away into budget exhausted. The write belongs before the answer
  // — the
  // test above pins that — and after the reads.
  const real = Date.now
  let skew = 0
  Date.now = () => real() + skew
  const dir = tmpDir("msmoli-usagelock-")
  // the config lives in this test's own folder (window off, as the suite's
  // neighbors) rather than behind the shared MAGPIE_MSMOLI_CONFIG: a leak that
  // left the variable unset would otherwise put this test on the default
  // 08:30–10:00 window and turn the check-in's answer from inactive to failed
  // for a reason that is not its own.
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  const token = "ms-usagelock-0000-0000-0000-000000000003"
  const writes = []
  let failNext = true
  const client = {
    auth: {
      set: async (o) => {
        if (failNext) {
          failNext = false
          throw new Error("host busy")
        }
        writes.push(o)
        skew += 30_000 // a lock held by another process, waited out synchronously
      },
    },
  }
  try {
    const p = await MsmoliPlugin({ directory: dir, client })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Data: { NickName: "Lock" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      },
      async () => {
        const c = await p.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(c.outcome, "inactive", c.message)
        assert.equal(writes.length, 0, "the failed write left nothing behind")
        const u = await p.auth.usage(async () => ({ type: "api", key: token }))
        assert.equal(u.error, undefined, `the reads must not pay for the write: ${u.error}`)
        assert.equal(u.balance, "5 魔粒可用")
        assert.equal(writes.length, 1, "the retried write still lands before the answer")
      },
    )
  } finally {
    Date.now = real
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a body carrying both envelope spellings is read by the one ModelScope owns", async () => {
  // okOf reads `body.Code ?? body.code`: the capital-Code field is
  // ModelScope's own, and a body that carries both is read by it even when
  // its value is falsy. Read as `||`, a Code of 0 falls through to a
  // lowercase code of "200" and a contradictory answer passes for a success —
  // one field saying "no", the other "yes", and the plugin believing the one
  // the API does not use.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { Code: 0, code: "200", data: { available_balance: 300 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, `Code 0 is not a success: ${JSON.stringify(u)}`)
      assert.match(u.error, /余额查询失败/)
      assert.equal(u.balance, undefined, "a body whose Code says 0 is not a balance to show")
    },
  )
})

test("a timeout or a dead network is recognised however the runtime capitalises it", { timeout: 8000 }, async () => {
  // Both branches of saidFailure match a runtime's own wording with /i:
  // "Timeout" from a runtime that capitalises its sentences, and "Fetch
  // failed" from one that does the same with fetch's own error. The /i is the
  // only thing between the user and that runtime's English on the card, and
  // neither spelling was ever fed to it — every fixture words it in lower case.
  const real = globalThis.fetch
  try {
    for (const [text, want, why] of [
      ["Timeout", /请求超时（8 秒）/, "a capitalised timeout is still a timeout"],
      ["Fetch failed", /请求失败：网络不通、被代理拦截，或遇到了重定向/, "capitalised fetch wording is still the network"],
    ]) {
      globalThis.fetch = async () => {
        throw new Error(text)
      }
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error ?? "", want, `${why}: ${JSON.stringify(u.error)}`)
    }
  } finally {
    globalThis.fetch = real
  }
})

test("a title and a nickname lose the padding around them before the card sees them", async () => {
  // text() trims after the control-character fold: a title the server padded,
  // or a nickname whose answer carried a stray space, otherwise lands on the
  // card still wearing it inside the parentheses and gets written back to
  // plugin-auth.json with the
  // padding still on — the account then reads "  alice  " in magpie's own UI.
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ title: "  首次  " })] } },
      },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "  alice  " } } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.doesNotMatch(r.message, /（\s+首次\s+）/, `the title must arrive trimmed: ${JSON.stringify(r.message)}`)
    },
  )
})

test("a padded nickname is written back trimmed", async () => {
  // the same trim, on the other exit: what goes to auth.set is the account's
  // name in magpie's UI, and "  alice  " is not how a person writes it
  const dir = tmpDir("msmoli-padname-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const writes = []
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "  alice  " } } },
      },
      async () => {
        await p.auth.checkin(async () => ({ type: "api", key: "ms-padname-0000000" }))
      },
    )
    assert.deepEqual(writes.map((w) => w.body.accountId), ["alice"], "the name is written as a person writes it")
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('"OFF" written with spaces around it is still off, not the default window', async () => {
  // a hand-edited config is exactly where padding turns up, and a value that
  // misses the off-test falls through to the window parser, which cannot read
  // it either — so it silently becomes 08:30-10:00 and claims at a time the
  // user did not name, from a setting that says "off".
  for (const off of ["  OFF  ", " off ", "\toff\n"]) {
    assert.equal(windowOf({ checkinWindow: off }), null, `${JSON.stringify(off)} turns the window off`)
  }
})

test("an account label with padding around it still finds the alias kept under it", async () => {
  // aliasOf keyed the lookup on `label.trim().toLowerCase()`: the label is the
  // accountId the host hands over, and a padded one that misses the trim finds
  // no alias — so the nickname is written over the name the user chose.
  const dir = tmpDir("msmoli-padalias-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({ providers: [{ id: "msmoli", accountNames: { "my label": "kept" } }] }),
    )
    const writes = []
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      async () => {
        await p.auth.checkin(async () => ({ type: "api", key: "ms-padalias-000000", accountId: "  my label  " }))
      },
    )
    assert.deepEqual(writes, [], "the user's alias was found, so nothing is written over it")
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a message naming two tokens has both of them masked", async () => {
  // tokenShaped carries /g because the mask is a replace: without it only the
  // first run is rewritten and the second is printed whole — the one promise
  // this tool makes about a token, broken by the message that names two.
  const dir = tmpDir("msmoli-twotok-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const t1 = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
    const t2 = "ms-zzzz9999-yyyy-8888-xxxx-777766665555"
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    const fail = async () => {
      throw new Error(`no key ${t1} for provider; also saw ${t2}`)
    }
    for (const [what, said] of [
      ["usage", (await p.auth.usage(fail)).error],
      ["checkin", (await p.auth.checkin(fail)).message],
    ]) {
      assert.ok(!said.includes(t1), `${what}: the first token reached the card whole: ${JSON.stringify(said)}`)
      assert.ok(!said.includes(t2), `${what}: the second token reached the card whole: ${JSON.stringify(said)}`)
      assert.match(said, /ms-z…5555/, `${what}: the second token should be shown masked: ${JSON.stringify(said)}`)
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a nickname that is a middle slice of the token, or that carries it, is refused", async () => {
  // unusableName's piece test is `token.includes(name)` and its whole-token
  // test is `name.includes(token)`: both are contains, not prefixes. Read as
  // startsWith, a 24-character slice from the middle of the token is written
  // back as the account name, and so is a name with the token inside it — the
  // server is handed its own session back, once removed.
  const dir = tmpDir("msmoli-midname-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    // Two shapes, and each needs a token of its own length: the piece must be
    // under text()'s cut to 40 (a 39-character token leaves no room for a
    // carrying name), and a name that carries the token must fit in 40 too.
    // Each case also gets its own token, so the write-back is not skipped by
    // the module's own "named once" set.
    const long = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
    const middle = long.slice(6, 30)
    assert.ok(middle.length >= 20 && long.includes(middle), "a 24-character piece from the middle of the token")
    assert.ok(!long.startsWith(middle), "and not its front, so a prefix test cannot see it")
    const short = "ms-abcdefgh" // 11 characters: "key " + it still fits under 40
    for (const [token, nick, why] of [
      [long, middle, "a middle slice of the token is the token"],
      [short, "key " + short, "a name carrying the whole token is the token too"],
    ]) {
      assert.ok(nick.length <= 40, `${why}: the fixture must survive text()'s cut`)
      const writes = []
      const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
      await withFetch(
        {
          // unclaimed, so the touch runs and its nickname is what is judged:
          // a claimed day with a name already cached skips the touch
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: nick } } },
        },
        async () => {
          await p.auth.checkin(async () => ({ type: "api", key: token }))
        },
      )
      assert.deepEqual(writes, [], `${why}, so nothing is written back`)
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a nickname of only whitespace falls through to the Name behind it", async () => {
  // `named` tests `v.trim()`: a NickName of spaces is not a name, so the
  // `||` moves on to Name. Read as the bare string, "   " is truthy, wins the
  // `||`, and text() then trims it to "" — the account is left without the
  // name the server did send.
  const dir = tmpDir("msmoli-wsnick-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const writes = []
    const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "   ", Name: "alice" } } },
      },
      async () => {
        await p.auth.checkin(async () => ({ type: "api", key: "ms-wsnick-00000000" }))
      },
    )
    assert.deepEqual(writes.map((w) => w.body.accountId), ["alice"], "the name behind the blank nickname is the name")
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an amount with a third decimal rounds to two, it does not truncate", async () => {
  // yin exists because a sum in binary floating point lands on
  // 0.30000000000000004, and the card must read "0.3". Its Math.round is what
  // makes 0.125 into 0.13: as Math.floor it truncates every amount with a
  // third decimal — 0.125 reads 0.12, 0.335 reads 0.33, and the totals on the
  // card disagree with the ledger they came from.
  const dir = tmpDir("msmoli-yin-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    for (const [amount, want] of [
      [0.125, "0.13"],
      [0.335, "0.34"],
    ]) {
      await withFetch(
        {
          "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
            body: {
              success: true,
              data: {
                records: [{ gmt_created: today, type: "SPEND_CONFIRM", rule_key: "api_inference", model_tier: "a", total_amount: amount, count: 1 }],
              },
            },
          },
        },
        async () => {
          const r = await p.auth.usage(async () => ({ type: "api", key: "ms-test" }))
          assert.match(r.windows?.[0]?.display ?? "", new RegExp(`今日用 ${want.replace(".", "\\.")} `), `${amount} reads as ${want}: ${r.windows?.[0]?.display}`)
        },
      )
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the usage percentage rounds to two decimals on both denominators", async () => {
  // `used` is a percentage the card draws a bar from. Both branches round
  // (`Math.round(x * 10000) / 100`); as Math.floor they truncate: 2 of 3 spends
  // reads 66.66 instead of 66.67, and 2 used out of 201 earned reads 0.99
  // instead of a full 1. The two branches take different inputs, so each needs
  // its own arithmetic.
  const dir = tmpDir("msmoli-pct-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    const cases = [
      // earned > 0: 2 used of 200 + 1 earned
      {
        claim: [day(), day({ rule_key: "aliyun_bindlogin", total_amount: 1 })],
        spends: [0, 2],
        available: 1,
        want: 1,
        why: "2 of 201 is a whole percent",
      },
      // earned == 0: the denominator is used + available
      {
        claim: [],
        spends: [2],
        available: 1,
        want: 66.67,
        why: "2 of 3 rounds up at the second decimal",
      },
      // the switch into that branch is `usedToday + available > 0`; as `> 1`
      // a fractional pair summing to exactly one credit falls through to 100%,
      // so half of a whole spent reads as everything spent
      {
        claim: [],
        spends: [0.5],
        available: 0.5,
        want: 50,
        why: "half of one 魔粒 is half, not all of it",
      },
    ]
    for (const c of cases) {
      const rows = [
        ...c.claim,
        ...c.spends.map((n, i) => ({ gmt_created: today, type: "SPEND_CONFIRM", rule_key: "api_inference", model_tier: `t${i}`, total_amount: n, count: 1 })),
      ]
      await withFetch(
        {
          "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: c.available } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: rows } } },
        },
        async () => {
          const r = await p.auth.usage(async () => ({ type: "api", key: "ms-test" }))
          assert.equal(r.windows?.[0]?.used, c.want, `${c.why}, not ${r.windows?.[0]?.used}`)
        },
      )
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a grant of one 魔粒 is today's grant, not a fall-back to the balance", async () => {
  // The denominator switches on `earnedToday > 0`. As `> 1` an exactly-one
  // grant falls through to the balance denominator, and one credit earned
  // and
  // one spent reads "used 0.4" — a rounding test whose smallest grant is 201
  // never reaches the switch's own boundary.
  const dir = tmpDir("msmoli-one-")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
    const p = await MsmoliPlugin({ directory: dir, client: {} })
    const rows = [day({ total_amount: 1 }), spend(1)]
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 251.5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: rows } } },
      },
      async () => {
        const r = await p.auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(r.windows?.[0]?.used, 100, `one of one is all of it, not ${r.windows?.[0]?.used}`)
        assert.equal(r.windows?.[0]?.limit, 1, "the grant is the limit")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Round twenty-six: the statement-level sweep ────────────────────────
// After a round that changed only expressions (operators, literals, method
// names, regex flags), this round changes whole statements: hollow out a
// one-line guard, drop a return's value, delete a bare call statement. Pinned
// below are the spots where the probes measured a real behaviour difference;
// the few judged equivalent are recorded in each case's comments.

test("a providers.json that parses to an empty object still takes the nickname", async () => {
  // aliasOf puts raw.providers into the candidate list; {} has no providers
  // key, so the list element is undefined. With `if (!Array.isArray(list))
  // continue` hollowed out, for...of over undefined immediately throws "list
  // is not iterable" and the whole check-in answers failed — the user did
  // nothing wrong and the network is fine, yet just because providers.json
  // happens to be an empty object the nickname can never be written back.
  const dir = tmpDir("msmoli-emptyobj-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  writeFileSync(join(dir, "providers.json"), "{}")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
    const token = "ms-emptyobj-0000-0000-0000-000000000028"
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
      },
      async () => {
        const r = await withClient.auth.checkin(async () => ({ type: "api", key: token }))
        assert.equal(r.outcome, "done", `an empty object is a readable file with no alias: ${r.message}`)
        assert.equal(writes.length, 1, "the nickname is still written back")
        assert.equal(writes[0].body.accountId, "Mison")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a claim that landed is answered before the ledger is read a third time", async () => {
  // The second ledger read finds the grant and the answer is claimed. With
  // `if (daily) return …` hollowed out, the code reads a third time — the
  // grant has been written out and the check-in really did succeed, yet the
  // third read's failure flips this card from a claim of 200 credits to
  // failed. The host retries on failed, but what the user sees this round is
  // a false failure; the fact that the ledger has already been written does
  // not change because a re-read failed.
  let reads = 0
  const real = globalThis.fetch
  const grant = { gmt_created: today, type: "EARN", rule_key: "daily_active", title: "注册并登录", total_amount: 200, count: 1 }
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    if (path === "/api/v1/users/login/info") return reply({ body: { Code: 200, Success: true, Data: { NickName: "alice" } } })
    reads += 1
    if (reads === 1) return reply({ body: { success: true, data: { records: [] } } })
    if (reads === 2) return reply({ body: { success: true, data: { records: [grant] } } })
    throw new Error("the third read fails")
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-thirdread" }))
    assert.equal(reads, 2, `two ledger reads decide the answer; the third buys nothing: reads=${reads}`)
    assert.equal(r.outcome, "claimed")
    assert.equal(r.credit, 200)
  } finally {
    globalThis.fetch = real
  }
})

test("a finished request leaves no timer armed behind it", async (t) => {
  // json() arms a limit on the whole request (the fetch and reading the
  // body) with setTimeout, and clears it with clearTimeout in finally. Delete
  // that statement and the timer is still pending after the request ends:
  // polling account by account, every timer holds the plugin's process for
  // the full TIMEOUT_MS before it is released. Counting with a timer probe is
  // steadier than counting getActiveResourcesInfo: node 24 works on this
  // machine and bun 1.4.3 reports an empty array; the probe first self-checks
  // that an armed timer is visible and skips when it is not, never passing
  // silently.
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const armed = new Set()
  const cleared = new Set()
  globalThis.setTimeout = (fn, ms, ...a) => {
    const h = realSet(fn, ms, ...a)
    armed.add(h)
    return h
  }
  globalThis.clearTimeout = (h) => {
    cleared.add(h)
    return realClear(h)
  }
  try {
    // self-check: only a timer the probe can see counts
    const probe = setTimeout(() => {}, 60000)
    const visible = armed.has(probe)
    clearTimeout(probe)
    armed.clear()
    cleared.clear()
    // a runtime where timers are invisible is skipped out loud: a silent
    // return looks just like a pass in CI
    if (!visible) return t.skip("this runtime's timers are not visible to the spy")

    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-timerleft" }))
        assert.ok(u.windows?.length, "the read succeeded, so the timeout was not the answer")
      },
    )
    assert.ok(armed.size > 0, "the request arms its own timeout; without one the answer would hang forever")
    const left = [...armed].filter((h) => !cleared.has(h))
    assert.equal(left.length, 0, `${left.length} of ${armed.size} timers left armed after the work is done`)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})

// cnDay is the Beijing date i days after the one the suite loaded on. The
// check-in target is a hash of the day, so a test about the day has to walk
// real dates rather than assume one.
const cnDay = (i) =>
  new Date(Date.parse(`${today}T00:00:00+08:00`) + i * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10)

test("the request timer is armed with the request's whole budget", async (t) => {
  // json() arms a limit on the whole request (the fetch and reading the
  // body): setTimeout(…, budget). Miss the budget argument and the delay
  // becomes 0 — every request is cut off the moment it is sent, and the card
  // says it timed out after 1 second. The probe records the delay and fires
  // it for real at 0 ms, so the timeout wording is still exercised without
  // waiting the full 8 seconds.
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realFetch = globalThis.fetch
  const delays = []
  globalThis.setTimeout = (fn, ms, ...a) => {
    delays.push(ms)
    return realSet(fn, 0, ...a)
  }
  try {
    // self-check: a runtime where the probe cannot see timers is skipped out
    // loud; a silent return looks like a pass in CI
    let seen = false
    const probe = setTimeout(() => {
      seen = true
    }, 60000)
    await new Promise((r) => realSet(r, 5))
    realClear(probe)
    if (!seen) return t.skip("this runtime's timers are not visible to the spy")
    delays.length = 0

    // a request that never answers on its own: only the timer ends it, the
    // way a real socket does when the signal aborts
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true })
      })
    const r = await withWindow(["08:30", "10:00"], `${today} 10:00:00`, () =>
      auth.checkin(async () => ({ type: "api", key: "ms-armedbudget-0000-0000-0000-0001" })),
    )
    assert.equal(r.outcome, "failed", "the request never answered")
    assert.match(r.message, /请求超时（8 秒）/, `the timeout says the budget it used: ${r.message}`)
    assert.ok(delays.length > 0, "a timer was armed at all")
    assert.ok(
      delays.every((ms) => ms === 8000),
      `every request is armed with the budget, not with no delay at all: ${JSON.stringify(delays)}`,
    )
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    globalThis.fetch = realFetch
  }
})

test("a control character in a name becomes a space, not the word undefined", async () => {
  // text() replaces a control character with a single space. Miss the
  // replacement string and String.replace writes the replacement result as
  // the literal "undefined" — the nickname is written back as
  // "Miundefinedson", and that is what shows on the card and in
  // plugin-auth.json alike.
  const dir = tmpDir("msmoli-cc-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mi\u0007son" } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: "ms-ctrlchar-0000-0000-0000-000001" }))
        assert.equal(writes.length, 1, "the name is still a name worth writing back")
        assert.equal(writes[0].body.accountId, "Mi son")
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a server's own words are cut at the card's 120 characters", async () => {
  // saidOf truncates the server's message to 120: the card line cannot hold
  // more, and magpie renders the message verbatim. Drop this argument and the
  // cut-off falls back to cardText's default of 200, so a proxy error page of
  // two hundred characters is crammed whole into the card.
  const long = "x".repeat(200)
  const r = await withFetch(
    { "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { Message: long } } },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-longmsg-0000-0000-0000-0000001" })),
  )
  assert.equal(r.outcome, "failed")
  assert.ok(r.message.includes("x".repeat(120)), "the server's words survive up to 120 characters")
  assert.ok(!r.message.includes("x".repeat(121)), `the line stops at 120, not at the next cap: ${r.message.length}`)
})

test("the day's claim target moves with the date", async () => {
  // plan()'s target is the hash of "date + account": fixed for the same
  // account on the same day (the half-hourly re-ask has to line up),
  // different across days. Drop the day argument and the hash holds only the
  // account, so it claims at the same minute all year round.
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    await withWindow(["08:30", "10:00"], `${cnDay(i)} 00:00:00`, async () => {
      seen.add((await targetOf(auth.checkin)).text)
    })
  }
  assert.ok(seen.size > 1, `twelve days, one target minute: ${[...seen].join(", ")}`)
})

test("a nickname longer than 40 is cut before it is written back", async () => {
  // What is written back is the account name on magpie's card: anything past
  // forty characters does not fit on one line. Drop this argument and the
  // cut-off falls back to text's default of 120, and a long nickname
  // stretches the card to two lines.
  const dir = tmpDir("msmoli-nm40-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    const writes = []
    const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => writes.push(o) } } })
    await withFetch(
      {
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "n".repeat(60) } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      },
      async () => {
        await withClient.auth.checkin(async () => ({ type: "api", key: "ms-nick40-0000-0000-0000-00000001" }))
        assert.equal(writes.length, 1)
        assert.equal(writes[0].body.accountId, "n".repeat(40))
      },
    )
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a ledger title in the day's list is cut at 40 characters", async () => {
  // Both paths put ledger titles on the card: when the day is already
  // claimed they list the page from before the trigger (beforeDaily), and
  // when the claim has just landed they list the rows the ledger grew
  // (gained). Titles in both places take a card line and are cut to 40; with
  // the cut-off back at 200, a long title squeezes the amount out.
  const claimed = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ title: "t".repeat(60), total_amount: 200 })] } },
      },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-which40a-0000-0000-0000-00001" })),
  )
  assert.equal(claimed.outcome, "done", `the day was already claimed: ${claimed.message}`)
  assert.ok(claimed.message.includes("t".repeat(40)), "the title survives up to 40 characters")
  assert.ok(!claimed.message.includes("t".repeat(41)), `the title stops at 40: ${claimed.message.length}`)

  const realFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path !== "/openapi/v1/magicubes/transactions") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "Mison" } } })
    }
    reads += 1
    // the first is the ledger before the trigger (empty), the third is after
    // the credit landed
    const records =
      reads === 1 ? [] : [day({ rule_key: "aliyun_bindlogin", title: "u".repeat(60), total_amount: 5 })]
    return reply({ body: { success: true, data: { records } } })
  }
  try {
    const gained = await auth.checkin(async () => ({ type: "api", key: "ms-which40b-0000-0000-0000-00001" }))
    assert.equal(gained.outcome, "claimed", `the grant landed: ${gained.message}`)
    assert.ok(gained.message.includes("u".repeat(40)), "the title survives up to 40 characters")
    assert.ok(!gained.message.includes("u".repeat(41)), `the title stops at 40: ${gained.message.length}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("once the budget is spent, the re-read is not sent", async () => {
  // Each request eats 13 seconds, so the 25-second budget runs out after the
  // second: the third ledger read (the confirmation that the credit landed)
  // must not be sent. Drop the deadline argument and it counts as Infinity,
  // so it goes out even with the budget spent — a request still hanging
  // after the hook has timed out.
  const realNow = Date.now
  const realFetch = globalThis.fetch
  let at = Date.parse(`${today}T10:00:00+08:00`)
  let calls = 0
  Date.now = () => at
  globalThis.fetch = async (url) => {
    calls += 1
    at += 13000
    const path = new URL(url).pathname
    if (path === "/api/v1/users/login/info") {
      return reply({ body: { Code: 200, Success: true, Data: { NickName: "Mison" } } })
    }
    return reply({ body: { success: true, data: { records: [] } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-budget-0000-0000-0000-000000001" }))
    assert.equal(r.outcome, "failed")
    assert.match(r.message, /预算已用完/, `the answer names the budget, not the network: ${r.message}`)
    assert.equal(calls, 2, "the third read is past the deadline and must not be sent")
  } finally {
    Date.now = realNow
    globalThis.fetch = realFetch
  }
})

test("the usage card's target moves with the date", async () => {
  // The claim time on the usage card (the "· HH:MM" line) uses the same
  // plan() as the check-in card. Drop day, and an account that did not claim
  // that day keeps showing the same instant on the card forever.
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    await withWindow(["08:30", "10:00"], `${cnDay(i)} 00:00:00`, async () => {
      await withFetch(
        {
          "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        async () => {
          const u = await auth.usage(async () => ({ type: "api", key: "ms-hintday" }))
          const m = /· (\d\d:\d\d) 领取/.exec(u.windows[0].display)
          assert.ok(m, `the hint is on the card: ${u.windows[0].display}`)
          seen.add(m[1])
        },
      )
    })
  }
  assert.ok(seen.size > 1, `twelve days, one target minute: ${[...seen].join(", ")}`)
})

test("a key that is not a string is no key, not the token 'null'", async () => {
  // rawKey's `String(auth.key ?? "")`: for null / undefined `??` gives the
  // empty string (no key). Miss this default and it becomes String(null) =
  // "null" — a token SENDABLE lets through, the plugin requests with it, and
  // the card reports the account is out of the active range instead of no
  // login information. Conversely, 0 / false are values that are not nullish:
  // `??` keeps them, and after String they are "0" / "false", a key that truly
  // can go out; `||` reads them as the empty string and throws a key that has
  // a value away as no login information.
  for (const [key, want] of [
    [null, "none"],
    [undefined, "none"],
    [0, "sent"],
    [false, "sent"],
  ]) {
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return reply({ body: { success: true, data: { records: [] } } })
    }
    try {
      const r = await auth.checkin(async () => ({ type: "api", key }))
      if (want === "none") {
        assert.equal(r.outcome, "failed", `${JSON.stringify(key)} must not check in: ${r.message}`)
        assert.match(r.message, /没有登录信息/, `a nullish key is no sign-in: ${r.message}`)
        assert.equal(calls.length, 0, "and nothing may be sent with it")
      } else {
        assert.equal(r.outcome, "inactive", `${JSON.stringify(key)} is a key: ${r.message}`)
        assert.ok(calls.length > 0, `${JSON.stringify(key)} stringifies to a key that is sent`)
        assert.ok(!calls.some((c) => /undefined|null/.test(c)), `no bogus token on the wire: ${calls[0]}`)
      }
    } finally {
      globalThis.fetch = realFetch
    }
  }
})

test("a response with no headers object is a length we do not know, not a crash", async () => {
  // readBounded reads the length with `res.headers?.get?.(...)`. A response
  // rewritten by a proxy, or built by the host's fetch implementation itself,
  // may have no headers object at all: `?.` reads undefined, the length lands
  // on NaN, and the body is still read to the end. Read as `res.headers.get`
  // it throws a TypeError, which saidFailure catches as a network failure
  // blocked by a proxy — a request that got an answer is reported as a
  // network fault.
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    headers: undefined,
    body: {
      getReader() {
        let done = false
        return {
          async read() {
            if (done) return { done: true, value: undefined }
            done = true
            return { done: false, value: new TextEncoder().encode(JSON.stringify({ success: true, data: { records: [] } })) }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
    text: async () => JSON.stringify({ success: true, data: { records: [] } }),
  })
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-noheaders-0000-0000-0000-0000001" }))
    assert.equal(r.outcome, "inactive", `the body was read, not a network failure: ${r.message}`)
    assert.doesNotMatch(r.message, /网络不通|Cannot read/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a login answer with no data still finishes the check-in", async () => {
  // dataOf's `?? {}`: login/info may return only a { Code: 200 }. Without
  // this default dataOf gives undefined, and `me.NickName` throws "Cannot
  // read properties of undefined" — a claim that already landed is caught as
  // failed. An empty object reads as no nickname, which is a normal
  // completion, not an unreadable answer.
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-nodata-0000-0000-0000-00000001" })),
  )
  assert.equal(r.outcome, "done", `the claim landed despite the empty login: ${r.message}`)
  assert.equal(r.credit, 200)
})

test("a ledger row with no title is not named on the card", async () => {
  // cardText's `String(value ?? "")`: a missing or null title reads as the
  // empty string and the card writes only the amount, listing no
  // "(undefined)". A title of 0 / false is listed as it is — "(0)" is that
  // row's real title, not absence; `||` would swallow them into a bare amount.
  for (const [title, want] of [
    [undefined, "今日已领取 200 魔粒"],
    [null, "今日已领取 200 魔粒"],
    [0, "今日已领取 200 魔粒（0）"],
    [false, "今日已领取 200 魔粒（false）"],
  ]) {
    const row = day()
    if (title === undefined) delete row.title
    else row.title = title
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [row] } } },
        // the already-claimed branch still has to read login/info for the
        // nickname: without it this would be a 404, and the assertion would
        // pin on a login-endpoint failure, nothing to do with title
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
      },
      async () => auth.checkin(async () => ({ type: "api", key: "ms-notitle-0000-0000-0000-00000042" })),
    )
    assert.equal(r.outcome, "done")
    assert.equal(r.message, want, `title=${JSON.stringify(title)}`)
  }
})

test("a data field that is an empty string is not shifted to the other spelling", async () => {
  // dataObjectOf's `body?.data ?? body?.Data`: `??` only looks at the second
  // spelling when data is nullish, while `||` switches over even on an empty
  // data. ModelScope has both spellings (the ledger uses data, login uses
  // Data); with `||` an empty-string data switches over to Data.records — a
  // genuine no-data answer read as not in the active range.
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: "", Data: { records: [] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-dblspell-0000-0000-0000-000000001" })),
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /账单格式不认识：没有 data/, r.message)
})

test("the plugin builds without an input object", async () => {
  // MsmoliPlugin's `input?.directory` / `input?.client`: a call with no
  // argument (an older host, or a shell that calls it right after import)
  // should build a plugin with no directory and no client, each field taking
  // its default. Read as `input.directory` it throws a TypeError in the
  // factory and the whole plugin fails to load — the host logs one line and
  // nothing appears on the card.
  for (const arg of [undefined, {}, null]) {
    const hooks = await MsmoliPlugin(arg)
    assert.equal(typeof hooks.auth.checkin, "function", `input=${JSON.stringify(arg)}`)
    assert.equal(hooks.auth.provider, "msmoli")
  }
})

// ── Round thirty: the fix batch after the full-dimension review (finite but
// huge numbers, truncated echoes, titles across several rows under one key,
// whether the client can write) ─────────────────────────────────────

test("a finite amount too large to render is refused, not turned into Infinity", async () => {
  // Number.isFinite lets 1e307 through: it is finite, but yin's ×100
  // overflows to Infinity and the card would write an Infinity balance — an
  // unreadable response drawn as a definite number. The rule that unreadable
  // means failure has to cover finite but beyond the displayable range.
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: "1e307" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-huge-bal" }))
      assert.match(u.error ?? "", /不是数字|没有 available_balance/, `a finite overflow is still unreadable: ${u.error}`)
      assert.ok(!u.windows, "no card is built from a balance we cannot render")
    },
  )
  // the same door over a ledger row
  const row = day({ total_amount: "1e307" })
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [row] } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-huge-row" }))
      assert.match(u.error ?? "", /total_amount 不是数字/)
      assert.ok(!u.windows)
    },
  )
  // and the check-in, whose credit is summed the same way
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [row] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-huge-chk" })),
  )
  assert.equal(r.outcome, "failed", `an unreadable amount must not read as a claim: ${r.message}`)
  assert.match(r.message, /total_amount 不是数字/)
})

test("a sum that overflows only after adding is refused too", async () => {
  // Each row on its own is readable (1e306 times 100 is still finite), but
  // the two together cross the threshold and yin overflows at the summing
  // step. The guard has to sit on yin (the sum) as well as on amountOf (one
  // row).
  const rows = [
    day({ total_amount: 1e306 }),
    day({ rule_key: "aliyun_bindlogin", title: "绑定", total_amount: 1e306 }),
  ]
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: rows } } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-sum-over" }))
      assert.ok(u.error, `a sum we cannot render is a failure: ${JSON.stringify(u.windows)}`)
      assert.ok(!u.windows)
    },
  )
})

test("a percentage that overflows is left unsaid, not shown as not-started", async () => {
  // Both quantities are readable, but their ratio can be large enough to
  // overflow at ×10000. The host reads a non-finite used as 0 (num only
  // accepts finite numbers), so almost-all-used-up is drawn as untouched.
  // When it cannot be computed, omit used (the host reads that as not
  // stated); the text line still writes the real quantities.
  const rows = [day({ total_amount: 0.5 }), spend(1e305)]
  const u = await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: rows } } },
    },
    async () => auth.usage(async () => ({ type: "api", key: "ms-pct-over" })),
  )
  assert.equal(u.error, undefined, "the numbers themselves are readable")
  const w = u.windows[0]
  assert.equal(w.used, null, `an unrenderable share is omitted, not 0: ${w.used}`)
  assert.match(w.display, /今日用 1e\+305 \/ 领 0\.5/, "the amounts are still shown")
})

test("a rule whose first row has no title is still named by a later row", async () => {
  // The ledger aggregates by (day, type, rule_key, model_tier), so one key
  // can have several rows. Taking the first row's title, if that row happens
  // to be the one the server left untitled, writes the claim's information
  // as "+50" and drops the name entirely — while another row plainly carries
  // the name.
  const gained = [
    day({ rule_key: "aliyun_bindlogin", title: "", total_amount: 50 }),
    day({ rule_key: "aliyun_bindlogin", title: "绑定阿里云账号", total_amount: 50 }),
  ]
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    const p = u.pathname + u.search
    if (p === "/api/v1/users/login/info") return reply({ body: { Code: 200, Success: true, Data: { NickName: "Mison" } } })
    reads += 1
    return reply({ body: { success: true, data: { records: reads === 1 ? [] : gained } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-title-later" }))
    assert.equal(r.outcome, "claimed")
    assert.match(r.message, /绑定阿里云账号/, `the name must come from the row that has one: ${r.message}`)
    assert.doesNotMatch(r.message, /^领取 \d+ 魔粒：\+/, `no nameless entry: ${r.message}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a rule with no title on any row is shown by its amount alone", async () => {
  // When no row has a name, the information reads "+100" and not " +100" —
  // no blank slot in front.
  const gained = [day({ rule_key: "aliyun_bindlogin", title: "", total_amount: 100 })]
  let reads = 0
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname + new URL(url).search
    if (p === "/api/v1/users/login/info") return reply({ body: { Code: 200, Success: true, Data: { NickName: "Mison" } } })
    reads += 1
    return reply({ body: { success: true, data: { records: reads === 1 ? [] : gained } } })
  }
  try {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-title-none" }))
    assert.equal(r.outcome, "claimed")
    assert.match(r.message, /领取 100 魔粒：\+100/, `no leading space where the name would be: ${JSON.stringify(r.message)}`)
  } finally {
    globalThis.fetch = real
  }
})

test("a fragment of the token echoed back is masked, not just the whole one", async () => {
  // When the server (or the proxy in front of it) echoes the session it may
  // expose only the first half, the middle, or a prefixed fragment; that no
  // longer equals the token itself, and split() walks past it. cardText's
  // maskEchoes masks the fragment too, by "contiguous substring, length ≥
  // MIN_ECHO".
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  for (const [what, frag] of [
    ["中段", token.slice(6, 30)],
    ["尾段", token.slice(-16)],
    ["前段", token.slice(0, 18)],
  ]) {
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        "/api/v1/users/login/info": { body: { success: false, message: `bad session ${frag}, sign in again` } },
      },
      async () => auth.checkin(async () => ({ type: "api", key: token })),
    )
    assert.equal(r.outcome, "failed")
    assert.ok(!r.message.includes(frag), `${what}的片段回到了卡片上: ${r.message}`)
    assert.match(r.message, /ms-a…5555/, `${what}应被整串掩码替代: ${r.message}`)
  }
  // the same holds on the ledger-title path
  const frag = token.slice(6, 30)
  const row = { gmt_created: today, type: "EARN", rule_key: "daily_active", title: frag, total_amount: 200 }
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [row] } } },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Mison" } } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: token })),
  )
  assert.ok(!r.message.includes(frag), `标题里的片段回到了卡片上: ${r.message}`)
})

test("a token-shaped run with a character outside the id alphabet is masked", async () => {
  // The old form /ms-[A-Za-z0-9][A-Za-z0-9-]{10,}/ missed characters such
  // as underscores, dots and tildes, while the plugin's SENDABLE allows them
  // (any printable ASCII will do). When a token that really carries an
  // underscore is echoed elsewhere, the shape rule cannot recognise it and
  // lets it through verbatim. The character set has to line up with SENDABLE.
  const foreign = "ms-other_key-1234-5678-9012"
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { body: { success: false, message: `no key ${foreign} for provider` } },
    },
    async () => auth.checkin(async () => ({ type: "api", key: "ms-session-0000-0000-0000-0000000001" })),
  )
  assert.ok(!r.message.includes(foreign), `带下划线的令牌形状没被认出来: ${r.message}`)
  assert.match(r.message, /ms-o…9012/, `它该按形状被掩码: ${r.message}`)
})

// ── Round thirty-one: the review batch (the proxy's errors, a fetch that
// does not listen to signal, echoes cut by invisible characters, the
// afternoon's inactive, the touch when already claimed, write-back timing
// and cooldown, the usage denominator) ───────────────────────────────

// withNameDir runs fn with a plugin that reads its config from a fresh folder
// (window off, no providers.json: aliasOf answers "no alias") and records what
// it writes back.
const withNameDir = async (prefix, fn) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  try {
    return await withDirectory(dir, async () => {
      const writes = []
      const p = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      return await fn(p, writes, dir)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a proxy that will not connect is named as the proxy, not as a timeout", async () => {
  // With a proxy configured magpie uses its own fetch; a proxy failure throws
  // an ordinary Error (Go's own words "proxyconnect tcp: …"), not a
  // TypeError: the card carries one plain English sentence; the i/o timeout
  // kind is taken by /timeout/ as a request timed out after 8 seconds, sending
  // the user to check the network.
  const real = globalThis.fetch
  try {
    for (const why of ["dial tcp 127.0.0.1:7890: i/o timeout", "dial tcp 127.0.0.1:7890: connect: connection refused"]) {
      globalThis.fetch = async () => {
        throw new Error(`proxyconnect tcp: ${why}`)
      }
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.match(u.error, /代理连不上/, `usage: ${u.error}`)
      assert.doesNotMatch(u.error, /超时|proxyconnect/, `usage: ${u.error}`)
      const c = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(c.outcome, "failed")
      assert.match(c.message, /代理连不上/, `checkin: ${c.message}`)
    }
  } finally {
    globalThis.fetch = real
  }
})

test("a fetch that never listens to its signal still gives up at the cap", { timeout: 8000 }, async (t) => {
  // The host's proxy fetch dials CONNECT on its own timer and ignores the
  // signal the plugin passes in. On signal alone the hook waits on it forever:
  // the 8-second per-request cap does not hold on this path.
  if (!withMockTimers(t)) return
  const real = globalThis.fetch
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  globalThis.fetch = () => new Promise(() => {})
  try {
    const pending = auth.usage(async () => ({ type: "api", key: "ms-test" }))
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(8001)
    const u = await pending
    assert.match(u.error ?? "", /请求超时（8 秒）/, JSON.stringify(u))
  } finally {
    globalThis.fetch = real
  }
})

test("an echoed token cut by an invisible character is masked whole on the card", async () => {
  // maskEchoes finds fragments as contiguous substrings; a zero-width space
  // or \x01 cuts the echoed token into two pieces, the front piece under
  // MIN_ECHO; text() then turns that character into a space, and the front
  // piece of the token lands on the card. The exit with no token in hand
  // (hostText) is the same: once the shape is cut apart it is not recognised.
  const token = "ms-cut00000-1111-2222-3333-444455556666"
  for (const cut of ["​", "\x01", "﻿"]) {
    const echoed = `${token.slice(0, 11)}${cut}${token.slice(11)}`
    const u = await withFetch(
      { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: `bad session ${echoed}` } } },
      () => auth.usage(async () => ({ type: "api", key: token })),
    )
    assert.ok(!u.error.includes(token.slice(0, 11)), `${JSON.stringify(cut)}: ${u.error}`)
    assert.match(u.error, /bad session ms-c…6666/, `${JSON.stringify(cut)}: ${u.error}`)
    const h = await auth.usage(async () => {
      throw new Error(`no key ${echoed} for provider`)
    })
    assert.ok(!h.error.includes(token.slice(0, 11)), `hostText ${JSON.stringify(cut)}: ${h.error}`)
    assert.match(h.error, /no key ms-c…6666 for provider/, `hostText: ${h.error}`)
  }
  // a line break still ends a token: the line after it is not swallowed
  const two = await withFetch(
    { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: `${token}\nms-notatoken` } } },
    () => auth.usage(async () => ({ type: "api", key: token })),
  )
  assert.match(two.error, /ms-c…6666 ms-notatoken/, two.error)
})

test("an afternoon inactive asks once more in half an hour, then settles", async () => {
  // From 12 o'clock the host settles an inactive as the day's outcome and
  // stops the tentative re-ask: in an afternoon window a ledger written a few
  // seconds late gets the day recorded as an account perhaps outside the
  // active range. The plugin asks for one re-ask half an hour later itself
  // via until; only one — an account really outside the range still has to be
  // settled that day.
  const empty = {
    "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: {} } },
  }
  await withWindow(false, `${today} 14:00:00`, async () => {
    const at = Date.now()
    const first = await withFetch(empty, () => auth.checkin(async () => ({ type: "api", key: "ms-afternoon-0001" })))
    assert.equal(first.outcome, "inactive")
    assert.equal(Date.parse(first.until), at + 30 * 60 * 1000, `until is half an hour on: ${first.until}`)
    assert.match(first.message, /半小时后再核对/)
    const second = await withFetch(empty, () => auth.checkin(async () => ({ type: "api", key: "ms-afternoon-0001" })))
    assert.equal(second.outcome, "inactive")
    assert.equal(second.until, undefined, "the second inactive settles the day")
    assert.match(second.message, /账号可能不在活动范围/)
  })
  // before noon the host's own provisional asks again: no until is said
  await withWindow(false, `${today} 11:59:00`, async () => {
    const r = await withFetch(empty, () => auth.checkin(async () => ({ type: "api", key: "ms-afternoon-0002" })))
    assert.equal(r.outcome, "inactive")
    assert.equal(r.until, undefined, "the host's provisional covers the morning")
  })
})

test("a day already claimed does not touch login/info again once the name is known", async () => {
  // Before 12 o'clock the host re-asks every half hour a done that never saw
  // a claim; with the touch ahead of the already-claimed check, every ask
  // records another login — an account claimed on the website picks up a
  // dozen extra logins in one morning.
  const token = "ms-claimedskip-0000-0000-000000000001"
  const responses = {
    "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
    "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Alice" } } },
  }
  const first = await withFetch(responses, async (fetch) => {
    const r = await auth.checkin(async () => ({ type: "api", key: token }))
    return { r, touched: fetch.calls.some((c) => c.includes("login/info")) }
  })
  assert.equal(first.r.outcome, "done")
  assert.ok(first.touched, "the first ask touches: the name is not known yet")
  const again = await withFetch(responses, async (fetch) => {
    const r = await auth.checkin(async () => ({ type: "api", key: token }))
    return { r, touched: fetch.calls.some((c) => c.includes("login/info")) }
  })
  assert.equal(again.r.outcome, "done")
  assert.equal(again.r.credit, 200)
  assert.equal(again.touched, false, "claimed and named: nothing left for the touch to do")
})

test("the name write-back waits for the answer, so its lock cannot spend the budget", async () => {
  // The host's auth.set takes the plugin-auth.json lock synchronously
  // (lockAuth, up to about 20 seconds while held). When the write-back is
  // wedged between the touch and the reconciliation, that wait counts against
  // the 25-second budget, and a check-in that already landed is answered
  // budget exhausted.
  const real = Date.now
  let skew = 0
  Date.now = () => real() + skew
  try {
    await withNameDir("msmoli-lockwait-", async (_, writes, dir) => {
      const order = []
      let txns = 0
      const real2 = globalThis.fetch
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname
        order.push(path)
        if (path.endsWith("login/info")) return reply({ body: { Code: 200, Success: true, Data: { NickName: "Lock" } } })
        txns++
        return reply({ body: { success: true, data: { records: txns === 1 ? [] : [day()] } } })
      }
      const client = await MsmoliPlugin({
        directory: dir,
        client: {
          auth: {
            set: async (o) => {
              order.push("auth.set")
              writes.push(o)
              skew += 30_000 // a lock held by another process, waited out synchronously
            },
          },
        },
      })
      try {
        const r = await client.auth.checkin(async () => ({ type: "api", key: "ms-lockwait-0000-0000-000000000001" }))
        assert.equal(r.outcome, "claimed", `the claim landed and is answered: ${r.message}`)
        assert.equal(writes.length, 1, "the name is still written back")
        assert.equal(order.at(-1), "auth.set", `the write comes after every read: ${order.join(" → ")}`)
      } finally {
        globalThis.fetch = real2
      }
    })
  } finally {
    Date.now = real
  }
})

test("a sign-in that lost its accountId gets the name again, after a cool-down", async () => {
  // The write-back record is a process-wide already-written flag: sign out
  // and back in with the same token and the new login has no accountId, yet
  // the plugin never writes again and the card keeps showing "API key …"
  // until magpie restarts. Changed to time-based: no rewrite within an hour,
  // then write again after that.
  const real = Date.now
  let skew = 0
  Date.now = () => real() + skew
  try {
    await withNameDir("msmoli-cooldown-", async (p, writes) => {
      const token = "ms-cooldown-0000-0000-000000000001"
      const responses = {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "Bob" } } },
      }
      const ask = () => withFetch(responses, () => p.auth.checkin(async () => ({ type: "api", key: token })))
      await ask()
      assert.equal(writes.length, 1)
      await ask()
      assert.equal(writes.length, 1, "within the hour nothing is written again")
      skew += 61 * 60 * 1000
      await ask()
      assert.equal(writes.length, 2, "an hour on, a sign-in still without the name gets it again")
      assert.equal(writes[1].body.accountId, "Bob")
    })
  } finally {
    Date.now = real
  }
})

test("spending yesterday's leftover is not drawn as overspent while the balance holds", async () => {
  // The daily grant expires after 24 hours: one claimed yesterday at 15:00
  // only lapses today at 15:00. The denominator counts only today's claims,
  // so yesterday's 250 plus today's 250 with 300 used this morning is drawn
  // as a 120% overage with a balance of 200 beside it.
  const u = await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 200 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day(), day({ rule_key: "aliyun_bindlogin", total_amount: 50 }), spend(300)] } },
      },
    },
    () => auth.usage(async () => ({ type: "api", key: "ms-test" })),
  )
  const w = u.windows[0]
  assert.equal(w.amount, 300)
  assert.equal(w.limit, 250)
  assert.equal(w.used, 60, `300 of the 500 at hand today: ${w.used}`)
})

test("a body that never arrives and ignores the signal still gives up at the cap", { timeout: 8000 }, async (t) => {
  // the read is raced against the abort as the request is: a response whose
  // stream neither delivers nor listens held the hook past 8 seconds
  if (!withMockTimers(t)) return
  const real = globalThis.fetch
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
  } catch {
    t.mock.timers.enable(["setTimeout"])
  }
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) },
  })
  try {
    const pending = auth.usage(async () => ({ type: "api", key: "ms-test" }))
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(8001)
    const u = await pending
    assert.match(u.error ?? "", /请求超时（8 秒）/, JSON.stringify(u))
  } finally {
    globalThis.fetch = real
  }
})

test("a key echoed across a line break is still the key, and a shape does not run on past one", async () => {
  // maskEchoes recognises fragments of the real token: an echo cut in two by
  // a newline, neither half reaching MIN_ECHO, is still that token. The shape
  // test only recognises shapes and does not cross lines — crossing lines
  // would swallow the next line's characters into the mask.
  const token = "ms-split000-1111-2222-3333-444455556666"
  const u = await withFetch(
    { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: `a ${token.slice(0, 11)}\n${token.slice(11, 22)} b` } } },
    () => auth.usage(async () => ({ type: "api", key: token })),
  )
  assert.ok(!u.error.includes(token.slice(0, 11)) && !u.error.includes(token.slice(11, 22)), `split echo leaked: ${u.error}`)
  const h = await auth.usage(async () => {
    throw new Error("ms-shortone\nabcdefghijklmnop end")
  })
  assert.match(h.error, /ms-shortone abcdefghijklmnop end/, `a short ms- word and the next line are not a token: ${h.error}`)
})

test("a body full of control characters is masked in one pass, not one pass per character", async () => {
  // Round thirty-one's code-point scan, on an invisible character, advanced
  // only the end and not the start; when no match could be assembled the
  // start moved only one step, so every position in a run of invisible
  // characters rescanned itself. 256 KiB of newlines (a proxy error page, a
  // server echo) takes minutes, and inside a 25-second-budget hook the host's
  // event loop stalls with it.
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  for (const ch of ["\n", "​", "\x01"]) {
    const at = Date.now()
    const u = await withFetch(
      { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: `${ch.repeat(100_000)}${token}` } } },
      () => auth.usage(async () => ({ type: "api", key: token })),
    )
    const ms = Date.now() - at
    assert.ok(ms < 5000, `${JSON.stringify(ch)}×100000 用了 ${ms}ms：扫描又变成按位置重扫了`)
    assert.doesNotMatch(u.error, /ms-aaaa/, `${JSON.stringify(ch)}: 令牌没被掩掉`)
  }
})

test("masking a long echo keeps every character in place, invisible ones included", async () => {
  // Rebuilding character by character (rather than joining slices) is where
  // this goes wrong most easily: dropped invisible characters, merged line
  // structure, text one character short before or after the token — all of
  // them show up here.
  const token = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const cases = [
    ["all", `${token}`],
    ["framed", `a ${token} b`],
    ["zwsp", `a ${token.slice(0, 11)}​${token.slice(11)} b`],
    ["ctrl", `a ${token.slice(0, 11)}\x01${token.slice(11)} b`],
    ["lines", `x ${token.slice(0, 20)}\n${token.slice(20)} y`],
    ["three", `x ${token.slice(0, 11)}\n${token.slice(11, 22)}\x01${token.slice(22)} y`],
    ["twice", `${token} and ${token}`],
    ["short-run kept", `ms-dos and ${token.slice(0, 5)} tail`],
  ]
  for (const [name, msg] of cases) {
    const u = await withFetch(
      { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: msg } } },
      () => auth.usage(async () => ({ type: "api", key: token })),
    )
    const out = u.error
    assert.ok(!/ms-aaaa1111/.test(out), `${name}: 令牌前段漏了 ${out}`)
    // the text around it survives, read as one line by the card
    for (const keep of msg.replace(/[\p{Cc}\p{Cf}]/gu, " ").match(/[a-z]+/g) ?? []) {
      if (["ms", "aaaa", "bbbb", "cccc", "msdos"].includes(keep)) continue
      assert.ok(out.includes(keep), `${name}: 周围文字 ${keep} 丢了：${JSON.stringify(out)}`)
    }
  }
  const two = await withFetch(
    { "/openapi/v1/magicubes/balance": { status: 500, body: { success: false, message: `${token} and ${token}` } } },
    () => auth.usage(async () => ({ type: "api", key: token })),
  )
  assert.match(two.error, /ms-a…5555 and ms-a…5555/, `两处各掩一次: ${two.error}`)
})

// ── Round thirty-four: other vendors' keys on the card ────────────────

// the longest contiguous substring that appears verbatim in the text; the 12
// shares mask's threshold
const longestKeptIn = (text, secret) => {
  let best = ""
  for (let i = 0; i < secret.length; i++)
    for (let j = i + 1; j <= secret.length; j++) {
      const piece = secret.slice(i, j)
      if (text.includes(piece) && piece.length > best.length) best = piece
    }
  return best
}

test("a key the plugin does not hold is masked on the card too", async () => {
  // Of cardText's three gates, the first two revolve around this account's
  // token and the third only recognises the ms- shape. So when the ledger
  // title (server-controlled) carries another vendor's key, all of it goes
  // on the card: measured, ghp kept 34/40, AWS 34/40, AKIA 20/20, hex 32/32.
  // The card's promise is that keys do not go on the card, and another
  // vendor's key is a key too.
  const foreign = {
    ghp: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    aws: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    // assembled from pieces: GitHub's push protection would take the whole
    // string for a real Slack token and block the push.
    xoxb: "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    akia: "AKIAIOSFODNN7EXAMPLE",
    hex: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    // 16 characters is exactly where the mixed-case rule starts: one shorter
    // and it is a word, one longer and the floor proves nothing
    sixteen: "AbCdEfGhIjKlMnOp",
  }
  for (const [name, key] of Object.entries(foreign)) {
    const ledger = { success: true, data: { records: [day({ title: `bonus ${key}` })], total: 1 } }
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    const msg = r.message ?? r.error ?? ""
    const kept = longestKeptIn(msg, key)
    assert.ok(kept.length < 12, `${name}：卡片上原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${msg}`)
    assert.match(msg, /bonus /, `${name}：卡片该只剩标题，别把整条吞了：${msg}`)
  }
})

test("a real ledger title is not mistaken for a key", async () => {
  // The reverse: a criterion wide enough to mask an AWS secret must not be so
  // narrow that it masks ordinary titles too. These are shapes that really
  // occur in ModelScope ledgers (Chinese titles, rule_key, model names,
  // dates).
  const titles = [
    "每日签到",
    "社区任务奖励",
    "daily_active",
    "api_inference",
    "Qwen3-Max 调用返还",
    "限时活动：ModelScope 周年庆",
    "gift_infocomplement_daily",
    "退款：重复扣费 12.5 魔粒",
    "bonus for uid 12345678",
  ]
  for (const title of titles) {
    const ledger = { success: true, data: { records: [day({ title })], total: 1 } }
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r.message ?? "").includes(title), `真实标题被误掩：${title} → ${r.message}`)
  }
  // A value starting with / is a path, not a key, even carrying two 12+
  // mixed-case components: the end of the path stays readable as before (when
  // the whole string is taken for a key, all that is left is "/Use…Name").
  // The card cuts titles to 40 code points, so use a short path that fits
  // whole
  const pathy = "/SomeLongDirName/AnotherLongNm"
  const ledger = { success: true, data: { records: [day({ title: pathy })], total: 1 } }
  const r = await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  assert.ok((r.message ?? "").includes("/AnotherLongNm"), `以 / 起头的值不该整串被掩：${r.message}`)
  // drive letters and UNC count as path starts too (PATHY's other two arms)
  for (const [v, keep] of [["C:\\SomeLongDirName\\AnotherLongNm", "AnotherLongNm"], ["\\\\srv\\SomeLongDirName\\AnotherLongNm", "AnotherLongNm"]]) {
    const led = { success: true, data: { records: [day({ title: v })], total: 1 } }
    const r2 = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: led },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r2.message ?? "").includes(keep), `${v} 是路径起头，不该整串被掩：${r2.message}`)
  }
  // The server's own error wording goes through the same gate: these are
  // phrasings magpie carries onto the card verbatim, none of them is key
  // shaped, and not one character should be masked
  for (const said of [
    "系统繁忙，请稍后重试",
    "请求过于频繁",
    "invalid token",
    "user not found: mison",
    "daily limit exceeded for account 12345678",
    "Unusual activity detected, please try again later",
  ]) {
    const r3 = await withFetch({ "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { message: said } } }, () =>
      auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r3.message ?? "").includes(said), `服务端原话被误掩：${said} → ${r3.message}`)
  }
})

// ── Round thirty-five: keys split into short pieces by separators, and keys
// framed inside text ───────────────────────────────────────────────

test("a key split into short pieces is masked on the card too", async () => {
  // keyShaped judges by contiguous runs of letters and digits: a key split
  // by - _ . into pieces each under 16 characters has no qualifying piece and
  // the whole key goes on the card (measured 42/42, 35/35). Judge it as a
  // whole: after stripping the separators the whole is long enough and mixes
  // case, or it is a hex digest carrying separators.
  const keys = [
    "nUJqxrpd9Bc7-GvG7J--onUJqxrpd9Bc7-GvG7J--o",
    "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
    "deadbeef-cafebabe-0123456789abcdef",
    "9f8e7d6c5b4a3928-1706f5e4d3c2b1a0",
    "56b3f97586dedd63",
    "a1b2c3d4e5f6g7h8i9j0k1l2-o3p4q5r6s7t8u9v0w1",
  ]
  // A 16-character lowercase alphanumeric string that is not all hex (the
  // modelscope20261031 kind) is not among them: indistinguishable from a
  // provider id's date shape, since round thirty-two it is treated as a name,
  // and the reverse test pins that
  for (const key of keys) {
    for (const title of [`bonus ${key}`, `bonus: ${key}.`, key]) {
      const ledger = { success: true, data: { records: [day({ title })], total: 1 } }
      const r = await withFetch(
        {
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
        },
        () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
      )
      const msg = r.message ?? r.error ?? ""
      const kept = longestKeptIn(msg, key)
      assert.ok(kept.length < 12, `${JSON.stringify(title.slice(0, 24))}…：卡片上原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${msg}`)
    }
  }
})

test("a UUID inside a larger word is masked by the run and UUID pass, not left whole", async () => {
  // maskKeys has a third gate for words that are not a key: a key-like run
  // inside a word and an embedded UUID are each masked on their own. The two
  // earlier tests give standalone UUID words, which take the whole-word
  // isKeyWord path, and the third gate was never reached. Wrap the UUID in a
  // word with /: / is not in the identity alphabet, the whole word does not
  // count as a key, and so the UUID_ANY pass actually runs (measured: that
  // branch hit once).
  const U = "550e8400-e29b-41d4-a716-446655440000"
  for (const title of [`path/${U}`, `ref/${U}.json`, `${U}/${U}`]) {
    const ledger = { success: true, data: { records: [day({ title })], total: 1 } }
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    const msg = r.message ?? r.error ?? ""
    assert.ok(!msg.includes(U), `${JSON.stringify(title)}：UUID 整串留在了卡片上：${msg}`)
    assert.match(msg, /550e…0000/, `${JSON.stringify(title)}：UUID 该被掩成 550e…0000：${msg}`)
  }
})

test("a server's key=value words are not masked on the card", async () => {
  // Same rule as bin/sync.mjs: "contains +/= so the whole word counts as a
  // key" would mask whole words like retry=true and id=12345, leaving only a
  // "…" on the card. A key's base64 body carries a 16+ character run and is
  // unaffected.
  for (const said of [
    "request failed: retry=true, id=12345, host=https://www.modelscope.cn",
    "bonus: retry=true.",
    "quota for id=88888 used up",
    "bonus for id=1234567890 today",
  ]) {
    const r3 = await withFetch({ "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { message: said } } }, () =>
      auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r3.message ?? "").includes(said), `服务端原话被误掩：${r3.message}`)
  }
})

test("a short base64 key is masked on the card, a query's = is not", async () => {
  // Same rule as base64y in bin/sync.mjs: short keys under 16 characters
  // that show themselves by + or = (AbCdEfGh+IjKlMnOp, dGhpc2lzYQ==) must not
  // stay verbatim on the card either; and retry=true / id=1234567890 in the
  // server's wording carry a bare =, and must not be masked whole into a
  // "…".
  const masks = ["AbCdEfGh+IjKlMnOp", "AbCdEf+GhIjKl=", "abcdefghij0123456789=", "dGhpc2lzYQ=="]
  for (const key of masks) {
    for (const title of [`bonus ${key}`, `bonus: ${key}.`, `优惠码 ${key}，谢谢`]) {
      const ledger = { success: true, data: { records: [day({ title })], total: 1 } }
      const r = await withFetch(
        {
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
        },
        () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
      )
      const msg = r.message ?? r.error ?? ""
      const kept = longestKeptIn(msg, key)
      assert.ok(kept.length < 12, `${JSON.stringify(title.slice(0, 24))}…：卡片上原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${msg}`)
    }
  }
  for (const said of ["bonus: retry=true.", "id=1234567890 used", "code=ENOENT today", "foo+bar+baz+qux+quux+corge", "key=value+with+plus", "tel:+1-555-123-4567", "1+2+3+4+5+6+7+8+9"]) {
    const r3 = await withFetch({ "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { message: said } } }, () =>
      auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r3.message ?? "").includes(said), `服务端原话被误掩：${r3.message}`)
  }
})

test("a hyphenated provider name survives the card's glued arm", async () => {
  // The combined arm changed from has-both-cases-after-stripping-separators
  // to at-least-two-segments-alternating-case-within-the-segment: a name
  // capitalises each segment and does not flip inside one, so at most one
  // segment qualifies. Provider ids / model names like
  // Qwen3-Coder-480B-A35B-Instruct or MyProvider-Prod-Edition-2026 must not
  // be masked.
  const names = [
    "Qwen3-Coder-480B-A35B-Instruct",
    "MyProvider-Prod-Edition-2026",
    "DeepSeek-V3-2-Chat-Preview",
    "some-long-file-name-WithCaps",
  ]
  for (const name of names) {
    const ledger = { success: true, data: { records: [day({ title: `签到奖励：${name}` })], total: 1 } }
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    const msg = r.message ?? r.error ?? ""
    assert.ok(msg.includes(name), `${name} 被误掩：${msg}`)
  }
})

test("a card title of nothing but punctuation does not stall maskKeys", async () => {
  // maskKeys used to strip trailing punctuation with
  // `word.slice(lead).match(/[^…]*$/)`: the anchored-star backtracking on a
  // word that starts with a letter, ends with a letter and is all punctuation
  // in between retried from every start until exhausted — 200,000 characters
  // in one match measured 117 seconds, and the ledger's title is
  // server-controlled. Changed to one linear inward move at each end, it is
  // 0.3ms. An all-punctuation word does not blow up: it matches at the first
  // start, where the old implementation got through in 0.6ms
  const bomb = "a" + "!".repeat(200_000) + "a"
  const ledger = { success: true, data: { records: [day({ title: bomb })], total: 1 } }
  const t0 = performance.now()
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
      "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
    },
    () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
  )
  const ms = performance.now() - t0
  assert.ok(ms < 3000, `病态标点标题耗时 ${ms.toFixed(0)}ms，判定为二次回溯未修`)
})

test("a nickname that is another vendor's key is not written back as the account name", async () => {
  // The server's NickName is written verbatim into plugin-auth.json's
  // accountId (plain text on disk, where the card's masking cannot reach):
  // measured, writing ghp_16C7… as the account name, and an sk-ant body cut
  // to 40 characters still gets written. Once unusableName applies the card's
  // own criterion (per-word isKeyWord), a key-shaped nickname is not written
  // back; an ordinary nickname (including the mixed-case Qwen3-Coder) still
  // is.
  const dir = tmpDir("msmoli-nickkey-")
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    // one token per case: a name is written back only once per token (the
    // named cooldown), and a shared token would let the case that passes
    // first eat the write a later case asserts
    let n = 0
    const run = async (nick) => {
      n += 1
      const token = `ms-nickkey-0000-0000-0000-00000000${String(n).padStart(4, "0")}`
      const writes = []
      const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: nick } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        () => withClient.auth.checkin(async () => ({ type: "api", key: token })),
      )
      return writes
    }
    for (const nick of [
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "sk-ant-api03-Eyai1pkJrF_KbwtQm3Z8Vd2Nc7Rt5Hs",
      "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
      "9f8e7d6c5b4a3928-1706f5e4d3c2b1a0",
      "AbCdEf0123456789+/xYzAbCdEf0123456789==",
    ]) {
      const w = await run(nick)
      assert.equal(w.length, 0, `论键形状的昵称不该写回：${JSON.stringify(nick)} → accountId=${JSON.stringify(w[0]?.body?.accountId)}`)
    }
    for (const nick of ["Mison", "alice", "魔搭用户", "Qwen3-Coder", "my_name"]) {
      const w = await run(nick)
      assert.equal(w.length, 1, `普通昵称该写回：${JSON.stringify(nick)}`)
      assert.equal(w[0].body.accountId, nick)
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a vendor key with one case flip is masked on the card", async () => {
  // After the combined criterion changed from at-least-two alternating
  // segments to a total count of [a-z][A-Z] in the whole word of at least
  // two, sk-ant-api03-Eyai1pkJrF_Kbwt (Ey and Kw, two places) is masked on
  // the card too — it had slipped through after 9aa0bcd. Names are as
  // before: a capitalised segment start with no inner flip counts one place
  // each.
  const keys = [
    "sk-ant-api03-Eyai1pkJrF_Kbwt",
    "sk-ant-api03-Eyai1pkJrF_KbwtQm3Z8Vd2Nc7Rt5Hs",
    "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
  ]
  for (const key of keys) {
    for (const title of [`bonus ${key}`, `bonus: ${key}.`, key]) {
      const ledger = { success: true, data: { records: [day({ title })], total: 1 } }
      const r = await withFetch(
        {
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
        },
        () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
      )
      const msg = r.message ?? r.error ?? ""
      const kept = longestKeptIn(msg, key)
      assert.ok(kept.length < 12, `${JSON.stringify(title.slice(0, 30))}…：卡片上原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${msg}`)
    }
  }
  for (const name of ["MyProvider-Prod-Edition-2026", "DeepSeek-V3-2-Chat-Preview", "some-long-file-name-WithCaps"]) {
    const ledger = { success: true, data: { records: [day({ title: `签到：${name}` })], total: 1 } }
    const r = await withFetch(
      {
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: ledger },
        "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: "alice" } } },
      },
      () => auth.checkin(async () => ({ type: "api", key: "ms-test" })),
    )
    assert.ok((r.message ?? "").includes(name), `${name} 被误掩：${r.message}`)
  }
})

test("a non-ms key cut by an invisible character is masked whole on the card", async () => {
  // Same rule as GLUE in bin/sync.mjs: a secret not shaped like ms- split
  // down the middle by a zero-width space or \x01, each half below the
  // word-level threshold, leaves the later piece on the card (measured: a
  // 14-character ghp_ and a 12-character sk-ant).
  for (const key of ["ghp_16C7e42F292c6912E7710c8", "sk-ant-api03-Eyai1pkJrF_Kbwt", "abcdefghij0123456789="]) {
    for (const cut of ["​", "\x01", "﻿"]) {
      const at = Math.floor(key.length / 2)
      const said = `request failed for ${key.slice(0, at)}${cut}${key.slice(at)}`
      const r = await withFetch({ "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 500, body: { message: said } } }, () =>
        auth.checkin(async () => ({ type: "api", key: "ms-test" })),
      )
      const msg = r.message ?? ""
      const kept = longestKeptIn(msg, key)
      assert.ok(kept.length < 12, `${JSON.stringify(key)} 夹 ${JSON.stringify(cut)}：卡片上原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${msg}`)
    }
  }
})

test("no test creates a temp folder outside the tracked helper", async () => {
  // Every test's temp directory has to be registered through tmpDir, and the
  // after hook deletes them all. A batch of tests used to create temp
  // directories without rmSync, and $TMPDIR accumulated 200,000+ msmoli-*
  // directories. This guard reads this file's own source: any directory-
  // creating call with a literal prefix that bypasses tmpDir registration is
  // a shape that would leak again; only helper definitions with a variable
  // prefix are allowed (tmpDir and withNameDir, the latter cleans up after
  // itself).
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8")
  const raw = self.match(/mkdtempSync\(join\(tmpdir\(\), "/g) ?? []
  assert.equal(raw.length, 0, `有 ${raw.length} 处直接用字面量前缀建临时目录，未经 tmpDir 登记，会泄漏`)
})
