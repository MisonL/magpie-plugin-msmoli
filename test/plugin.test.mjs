// The plugin's pure logic, tested without the network: what each endpoint's
// answer means, how a day's ledger is read, and how ModelScope's times are
// parsed. Run with: node --test test/

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { MsmoliPlugin, testables } from "../index.mjs"

const { windowOf } = testables

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
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 1.5, total_balance: 1.5, frozen_amount: 0 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async (fetch) => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.equal(w.name, "魔粒")
      assert.equal(w.amount, 330)
      assert.equal(w.limit, 250)
      // 330 spent of 250 granted: over 100 means overspent, not capped
      assert.ok(w.used > 100, `used should exceed 100, got ${w.used}`)
      // and the exact number is the ratio to two decimals — 33000/250, the
      // scale written `* 10001` reads 132.01 next to the same 330 and 250
      assert.equal(w.used, Math.round((330 / 250) * 10000) / 100)
      // the window runs a day; span written 86401 drifts a second a day
      assert.equal(w.span, 86400, "the window's span is the day it runs")
      assert.match(w.display, /余额 1\.5/)
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

// ── 签到时段 ──────────────────────────────────────────────────────────────
// failed 是宿主唯一会重试的结果：没到点的回答必须是它，别的都会让当天不再
// 被问。没到点的那一次不该发出任何请求。
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-portable-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bad-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-late-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-two-"))
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
      await two.auth.checkin(async () => ({ type: "api", key: A }))
      const ua = await two.auth.usage(async () => ({ type: "api", key: A }))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nm-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-fnauth-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-al-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-aliasbom-"))
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
        assert.match(u.windows[0].display, /· 0[89]:\d\d 领取/)
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

// ── 审查第二轮：不可见字符、令牌伪装昵称、非有限数字 ─────────────────────
test("invisible characters in a nickname never reach the written-back name", async () => {
  // U+200B/200D (zero-width), U+2060 (word joiner), U+061C (ALM) and the tag
  // characters U+E0000–E007F all survived the earlier sanitizer: two accounts
  // could be made to look identical on the card, and tags can carry hidden data
  const dir = mkdtempSync(join(tmpdir(), "msmoli-zw-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-tokname-"))
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
  // and it must not show as "Infinity 魔粒可用" or "0 魔粒可用" either
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
  // not understand: read as 0 it would say "领 0" beside a balance that moved
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
  // card would read "今日用 -50 / 领 200" with a negative percentage.
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

// ── 时段解析：直接读 windowOf，别依赖当天的哈希落点 ────────────────────────
// 目标时刻是「日 + 账号」的哈希，端到端测 LAST 截断只在哈希恰好落进
// 23:00 以后的那些日子才生效（实测约一半的日期会放过回归）。截断本身是
// 纯函数，直接断言它。
test("the module exports no bare function the host would take for a plugin", async () => {
  // magpie's servers() takes every exported function as a plugin entry when
  // `default` is a function (which it is here), calls it with the plugin input
  // and reads hooks off the answer. A helper exported for the tests runs as a
  // second plugin that way; today it answers an object with no hooks and
  // nothing happens, but a throw from it is caught by the loader's per-plugin
  // try/catch and the whole package is reported as failed to load. Helpers
  // live on `testables`, which the loader skips because it is an object.
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
    entries.map((f) => f.name),
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
  // reads "NaN:NaN 后自动领取". Widening either guard to `>` survives every
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
  // target's own minute answers "09:28 后自动领取" while the clock reads
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
  // matching a ledger row stamped today — the card would say 领 0 next to a
  // balance that had just moved, and the check-in would answer `inactive`,
  // which settles the day — and minuteCN() falls back to 00:30, so a window
  // that should be long due answers "后自动领取" again. Every other test
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-wbfail-"))
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
        assert.ok(logged.includes("account name not written back"), "the failure is logged")
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-wbobj-"))
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
    const dir = mkdtempSync(join(tmpdir(), "msmoli-proto-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-left-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-leftjunk-"))
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
  // hour later. A relative "约 8 分钟后" is false for most of that time;
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
      // The parse branch's own words, not just "登录接口": the next line down
      // also says "登录接口失败" (with `HTTP 200` for a body that did not
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
  // test on this path asserted /登录接口/, which the server's own message
  // ("登录接口失败：请先绑定手机号") satisfies, so `|| `HTTP ${res.status}``
  // could be deleted and an empty "登录接口失败：" shipped unnoticed.
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

test("the name cache is bounded: the oldest account's name falls out", async () => {
  // login/info is the claim, so the name is only ever read at check-in; the
  // cache is capped so a long-lived host does not grow one entry per account
  // seen forever. Ten accounts, so at least one has to be gone.
  const tokens = Array.from({ length: 10 }, (_, i) => `ms-lru-0000-0000-0000-000000000${String(i).padStart(2, "0")}`)
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
    },
    async () => {
      for (const [i, token] of tokens.entries()) {
        globalThis.fetch = fakeFetch({
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: `user${i}` } } },
        })
        await auth.checkin(async () => ({ type: "api", key: token }))
      }
      globalThis.fetch = fakeFetch({
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      })
      const first = await auth.usage(async () => ({ type: "api", key: tokens[0] }))
      const last = await auth.usage(async () => ({ type: "api", key: tokens[9] }))
      assert.equal(last.user, "user9", "the newest name is still there")
      assert.equal(first.user, "", "the oldest must have been evicted")
    },
  )
})

test("a usage read that meets a dead token marks the sign-in expired, at either step", async () => {
  // usage touches balance first, then the ledger; a 401 at either one means
  // the token is no good, and magpie only signs the account out if the hook
  // says so. The card's wording is the same at both steps and says the status
  // code, which is what the README's troubleshooting row promises — the
  // ledger path used to answer a bare "HTTP 401" while the check-in said
  // "令牌失效或不属于国内站（HTTP 401）", so the one condition had two texts.
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
    const dir = mkdtempSync(join(tmpdir(), "msmoli-badalias-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-noalias-"))
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
  // non-200 carries "HTTP 403" too — so the branch that says 风控 was never
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
  // message claimed the body "响应不是 JSON" for both. A 429 or a 500 from the
  // vendor, or from a proxy that explains itself in JSON, parses perfectly
  // well: reporting it as a parse failure throws away the server's own words
  // ("请求过于频繁", "系统繁忙") and sends the reader to look at the network.
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
  // own words was reported as "响应不是 JSON" and those words thrown away.
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
  // the inactive path and settled the day as "账号可能不在活动范围" — a
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
  // card showed "领 200" from a request the vendor never completed. A 202
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-once-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-getauth-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-hostsahpe-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-card-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-logthrow-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-logreject-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-cut-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bom-"))
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
  // page that changed between the two reads answer "今日已领取 0 魔粒".
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

test("a day whose grants were reversed does not claim a negative credit", async () => {
  // An EARN row can be a reversal (冲正), and a day netting below zero is a
  // real state. magpie clamps `credit` itself (host.js's num: Math.max(0, v))
  // but passes `message` through verbatim (checkin.go renders it under the
  // card's row), so the card read "今日已领取 -50 魔粒": a claim of a negative
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
  // "今日用 348.5 / 领 0" says the bar did not move while the text says it did.
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
  // the key is present, just unusable (a newline from a paste). "没有登录信息"
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
  // "请求超时（0 秒）", which says neither which limit was hit nor anything
  // the user could act on.
  //
  // The number is the ceiling of the budget in seconds — 300ms is "1 秒",
  // 1001ms is "2 秒". A divisor written 1001 instead of 1000 rounds the same
  // 1001ms down to "1 秒" and every other boundary with it; 300ms alone cannot
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
        // sent, and the hook answers "预算已用完" instead of the timeout under
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-longtok-"))
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
    // spaces answered "0 魔粒可用" — the same definite wrong 0, wearing
    // whitespace. A tab and a newline are the same field read by an editor
    // that put nothing in it.
    [{ available_balance: "" }, "empty"],
    [{ available_balance: "   " }, "spaces"],
    [{ available_balance: "\t\n" }, "tab and newline"],
    // Number([]) is 0 and Number(true) is 1: both finite, both a definite
    // answer that is wrong. The empty list is the "0 魔粒可用" this guard is
    // for; the boolean is one 魔粒 nobody granted.
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
  // understand. Read as 0 it says "领 0" beside a balance that clearly moved,
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nick-"))
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

test("a negative grant or a negative balance is not written onto the card as one", async () => {
  // EARN can carry a reversal. Summed as it comes the card reads
  // "领 -50" and the limit is negative; a negative balance must not turn the
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
})

test("a balance with a floating-point tail is rounded like every other sum", async () => {
  // earned/spent were rounded; the balance was not, and 0.1 + 0.2 came out
  // as 0.30000000000000004 魔粒可用
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
  for (const stamp of ["2026-10-27T00:00:24Z", "2026-10-27T00:00:24+00:00", "2026-10-27 00:00:24Z", "2026-10-27 00:00:24.123"]) {
    const body = { success: true, data: { records: [day({ expire_at: stamp })] } }
    await withFetch(
      {
        "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
        "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
      },
      async () => {
        const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
        assert.equal(u.windows[0].resetsAt, "", `${stamp} carries a zone we do not read`)
      },
    )
  }
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
  // 余额读成 0 是一个确定又错误的结论：卡片的进度条会满格、gateway 会把
  // 这个账号当用尽。响应里没有 data 是「没读懂」，得重试。
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
  const scratch = mkdtempSync(join(tmpdir(), "msmoli-relxdg-"))
  const home = mkdtempSync(join(tmpdir(), "msmoli-relhome-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-xdg-"))
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
  // The hint exists for the hours before the window: "领 0" alone reads like
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-short-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-hint12-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-emptyid-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-accid-"))
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
  const scratch = mkdtempSync(join(tmpdir(), "msmoli-nodir-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nonstr-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nullnames-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-longname-"))
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-0123456789abcdef0123456789abcdef012345678"
  const piece = token.slice(0, 20)
  const stranger = "MisonLiangWithALongName"
  assert.equal(piece.length, 20, "exactly the threshold")
  assert.ok(stranger.length > 20 && !token.includes(stranger), "a long name the token does not hold")
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    for (const [nick, want, why] of [
      [piece, 0, "a 20-character slice of the token is the token"],
      [stranger, 1, "a long name the token does not hold is a name"],
    ]) {
      const writes = []
      const withClient = await MsmoliPlugin({ directory: dir, client: { auth: { set: async (o) => { writes.push(o) } } } })
      await withFetch(
        {
          "/api/v1/users/login/info": { body: { Code: 200, Success: true, Data: { NickName: nick } } },
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
        },
        async () => {
          await withClient.auth.checkin(async () => ({ type: "api", key: token }))
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
  // says almost the same thing ("账单查询失败：HTTP 404" vs "…响应不是
  // JSON（HTTP 404）") and the fixtures only ever matched the status code.
  //
  // Each case keeps its own words — the step's name ("余额" / "账单") and either
  // the parse failure (which names the HTTP status) or the server's own message
  // — and the assertion cannot pass on the wrong line's fallback. `saidOf` of a
  // body that did not parse is empty, so the *next* line down prints the status
  // too: matching only /HTTP 200/ would stay green under `if (false)`. Requiring
  // "不是 JSON" pins the parse branch; requiring the server's words pins the
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
})

// ---- 第二十三轮：字符串字面量的宽扫（前六轮扫的是布尔、比较与整数）留下的
// 位点。每条都是「把这一个字改一个字母，整套测试全绿」的写法。

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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-getexp-"))
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
  const home = mkdtempSync(join(tmpdir(), "msmoli-homewin-"))
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

// ── 第二十四轮：操作符与集合判断 ─────────────────────────────────────────
// 前几轮把布尔、比较、整数和字符串/正则常量都改过一遍，`??`↔`||`、
// `.some`↔`.every`、`+=`↔`-=`、`?.` 的有无、`await` 的有无一直没动。
// 每条变异都在真模块上跑过：下面这些用例是那些变异唯一说得出口的地方。

test("a body that arrives in pieces is put back together byte for byte", async () => {
  // fetch hands the body over in whatever pieces the socket delivered, and a
  // piece boundary lands wherever it lands — inside a multi-byte character as
  // often as not. The pieces are joined by byte offset and decoded once:
  // joined with a decreasing offset (`at -=`) the second piece lands before
  // the first and the read throws "offset is out of bounds"; decoded piece by
  // piece, 魔 becomes two replacement marks and the card's title is rubble.
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nullprov-"))
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
  // check-in reports a TypeError instead of claiming.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-noset-"))
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const saved = process.env.MAGPIE_MSMOLI_CONFIG
  delete process.env.MAGPIE_MSMOLI_CONFIG
  try {
    for (const client of [{}, { app: {} }, { app: { log: () => {} } }]) {
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
    }
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_MSMOLI_CONFIG
    else process.env.MAGPIE_MSMOLI_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the nickname is written back before the hook answers", async () => {
  // rememberAccountName is awaited on both paths: the host labels the account
  // by the accountId, and a write that is still in flight when the card is
  // answered has not landed anywhere yet. Dropped, the check-in answers first
  // and the write races it — on a host that closes the plugin the moment the
  // answer is in, it never lands at all.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-awaitset-"))
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
      ["Fetch failed", /请求失败：网络不通、被代理拦截，或被重定向到了别的站点/, "capitalised fetch wording is still the network"],
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
  // card as "（  首次  ）" and gets written back to plugin-auth.json with the
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-padname-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-padalias-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-twotok-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-midname-"))
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
          "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [day()] } } },
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-wsnick-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-yin-"))
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
  const dir = mkdtempSync(join(tmpdir(), "msmoli-pct-"))
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

// ── 第二十六轮：语句级宽扫 ──────────────────────────────────────────────
// 一轮只改表达式（运算符、字面量、方法名、正则标志）的扫描之后，这一轮改的是
// 整条语句：掏空一条一行守卫、删掉 return 的值、删掉一条纯调用语句。下面钉住的
// 是探针测出真实行为差异的那些位点；判为等价的几个记录在各条注释里。

test("a providers.json that parses to an empty object still takes the nickname", async () => {
  // aliasOf 把 raw.providers 放进候选列表；{} 里没有 providers 键，列表元素
  // 是 undefined。`if (!Array.isArray(list)) continue` 被掏空后，for...of
  // undefined 立刻抛 "list is not iterable"，整次签到回答 failed——用户没做错
  // 任何事，网也通，只因为 providers.json 恰好是个空对象，昵称就永远写不回来。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-emptyobj-"))
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
  // 第二次读账本读到发放，回答 claimed。`if (daily) return …` 被掏空后，代码会
  // 再读第三次——发放已经写出来、签到确实成功，而第三次读的失败把这张卡从
  // 「领取 200 魔粒」翻成 failed。宿主看到 failed 会重试，但用户这一轮看到的是
  // 一次假失败；账本已经写出来的事实不因重读的失败而改变。
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
  // json() 用 setTimeout 给整个请求（fetch 与读完 body）装上限时，finally 里
  // clearTimeout。删掉那条语句，请求结束后计时器还挂着：逐个账号轮询时，每个
  // 计时器都把插件的进程按满 TIMEOUT_MS 才放行。用计时器探针数，比数
  // getActiveResourcesInfo 稳：本机 node 24 可用、bun 1.4.3 报空数组，探针
  // 先自检「装了计时器看得见」，看不见就跳过，不会静默假绿。
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
    // 自检：探针看得见的计时器才算数
    const probe = setTimeout(() => {}, 60000)
    const visible = armed.has(probe)
    clearTimeout(probe)
    armed.clear()
    cleared.clear()
    // 看不见计时器的运行时明说跳过：静默 return 在 CI 里和通过长得一样
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
  // json() 给整个请求（fetch 与读完 body）装上限时：setTimeout(…, budget)。
  // 漏掉 budget 这个实参，延时就成了 0——每个请求都在发出去的同时被自己掐断，
  // 卡片写「请求超时（1 秒）」。探针记下延时，并用 0 毫秒把它真触发一次，
  // 这样不用等满 8 秒，超时那条文案也照样走到。
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realFetch = globalThis.fetch
  const delays = []
  globalThis.setTimeout = (fn, ms, ...a) => {
    delays.push(ms)
    return realSet(fn, 0, ...a)
  }
  try {
    // 自检：探针看不见计时器的运行时明说跳过，静默 return 在 CI 里和通过一样
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
    assert.deepEqual(delays, [8000], "the timer is armed with the budget, not with no delay at all")
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    globalThis.fetch = realFetch
  }
})

test("a control character in a name becomes a space, not the word undefined", async () => {
  // text() 把控制字符替换成一个空格。漏掉替换串，String.replace 会把替换结果
  // 写成字面量 "undefined"——昵称原样写回成「Miundefinedson」，卡片和
  // plugin-auth.json 里都是这个。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-cc-"))
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
  // saidOf 把服务端的 message 截到 120：卡片那一行放不下更多，而 magpie 原样
  // 渲染 message。丢掉这个实参，截断点退回 cardText 的默认 200，一段两百字的
  // 代理错误页会整段挤进卡片。
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
  // plan() 的 target 是「日期 + 账号」的哈希：同一天同一个账号固定（半小时
  // 一次的追问要对得上），不同天不同。丢掉 day 这个实参，哈希里就只剩账号，
  // 一年到头都在同一分钟领取。
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    await withWindow(["08:30", "10:00"], `${cnDay(i)} 00:00:00`, async () => {
      seen.add((await targetOf(auth.checkin)).text)
    })
  }
  assert.ok(seen.size > 1, `twelve days, one target minute: ${[...seen].join(", ")}`)
})

test("a nickname longer than 40 is cut before it is written back", async () => {
  // 写回的是 magpie 卡片上的账号名：一行放不下四十个字符以外的部分。丢掉
  // 这个实参，截断点退回 text 的默认 120，一个长昵称会把卡片撑成两行。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nm40-"))
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
  // 两条路径都把账本标题放进卡片：今天已经领过时列的是触发前那一页
  // （beforeDaily），刚领到时列的是账本长出来的那几行（gained）。两处的
  // 标题都占卡片一行，都截到 40；截断点退回 200，长标题会把金额挤出去。
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
    // 第一次是触发前的账本（空的），第三次是到账后的
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
  // 每次请求吃掉 13 秒，25 秒的预算在第二次之后就用完了：第三次账本读取
  // （到账确认）不该再发出去。丢掉 deadline 这个实参，它按 Infinity 算，
  // 预算用完也照样发——钩子超时之后还挂着一个请求。
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
  // 用量卡片上「· HH:MM 领取」和签到卡是同一个 plan()。丢掉 day，这一天
  // 里没领到的账号会在卡片上永远写着同一个时刻。
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
