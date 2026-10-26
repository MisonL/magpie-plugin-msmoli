// The plugin's pure logic, tested without the network: what each endpoint's
// answer means, how a day's ledger is read, and how ModelScope's times are
// parsed. Run with: node --test test/

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MsmoliPlugin, windowOf } from "../index.mjs"

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
            let sent = false
            return {
              async read() {
                if (sent) return { done: true, value: undefined }
                sent = true
                return { done: false, value: bytes }
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
  // it expired would sign out an account that is perfectly fine
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body: { success: true, data: { records: [] } } },
      "/api/v1/users/login/info": { status: 403, body: { success: false, code: "RiskControl" } },
    },
    async () => {
      const r = await auth.checkin(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(r.outcome, "failed")
      assert.match(r.message, /风控/)
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

test("a whole check-in gives up at its own budget, not per request", { timeout: 8000 }, async (t) => {
  // magpie runs every provider's check-ins under one two-minute context, one
  // account at a time: four 8-second requests inside one hook would take 32s
  // and starve the accounts after it. The hook's own 25s budget is what keeps
  // one slow account from doing that.
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
  const real = globalThis.fetch
  // Node 20.4 took the object form ({ apis: […] }); 18 only knows the array
  // form, and the array form on 20+ mocks setImmediate too, which the wait
  // below needs. Try the newer shape, fall back for 18.
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
        assert.match(u.error, /风控|403/, `${at}: the message should name the refusal`)
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
  // Number("1e400") is Infinity: it must not show as "Infinity 魔粒可用" or
  // make a window's used/limit non-finite
  const body = { success: true, data: { records: [day({ total_amount: "1e400" })] } }
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: "1e400" } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { body },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      const w = u.windows[0]
      assert.ok(Number.isFinite(w.used), `used was ${w.used}`)
      assert.ok(Number.isFinite(w.amount), `amount was ${w.amount}`)
      assert.ok(Number.isFinite(w.limit), `limit was ${w.limit}`)
      assert.doesNotMatch(JSON.stringify(u), /Infinity|NaN/)
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
  // budget left is answered after the hook the host already gave up on. Here
  // the balance read takes longer than the whole budget, so the ledger read
  // must not go out.
  const realFetch = globalThis.fetch
  const realNow = Date.now
  let clock = Date.parse(`${today} 10:30:00`.replace(" ", "T") + "+08:00")
  Date.now = () => clock
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(new URL(url).pathname)
    clock += 60_000 // this one answer outlasts the hook's whole budget
    return reply({ body: { success: true, data: { available_balance: 300 } } })
  }
  try {
    const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
    assert.ok(u.error, "usage must fail rather than answer")
  } finally {
    globalThis.fetch = realFetch
    Date.now = realNow
  }
  assert.deepEqual(asked, ["/openapi/v1/magicubes/balance"], "no request may go out with the budget gone")
})

// ── 时段解析：直接读 windowOf，别依赖当天的哈希落点 ────────────────────────
// 目标时刻是「日 + 账号」的哈希，端到端测 LAST 截断只在哈希恰好落进
// 23:00 以后的那些日子才生效（实测约一半的日期会放过回归）。截断本身是
// 纯函数，直接断言它。
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
  for (const bad of [["10:00", "08:30"], ["24:00", "25:00"], ["08:60", "10:00"], ["8:30", "10:00"], ["nope", "10:00"], [], null, 7]) {
    assert.deepEqual(windowOf({ checkinWindow: bad }), { start: 8 * 60 + 30, end: 10 * 60 }, `${JSON.stringify(bad)} falls back to the default`)
  }
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
  // magpie keeps removed plugins' providers under pluginLeft; an account
  // installed to the plugin sidebar has its alias there
  const dir = mkdtempSync(join(tmpdir(), "msmoli-left-"))
  writeFileSync(join(dir, "msmoli.json"), JSON.stringify({ checkinWindow: false }))
  const token = "ms-left-0000-0000-0000-000000000015"
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({
      providers: [{ id: "openai" }],
      pluginLeft: [{ plugin: "msmoli", provider: [{ id: "msmoli", accountNames: { "api key …0015": "主号" } }] }],
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

test("the pre-window wait is worded like a person would say it", async () => {
  // "596 分钟后" reads like a dump; the card shows "9 小时 56 分钟". The
  // target is a hash, but any target in the default window is at least an
  // hour away from 07:00, so the hour form is what has to appear.
  await withWindow(["08:30", "10:00"], `${today} 07:00:00`, async () => {
    const r = await auth.checkin(async () => ({ type: "api", key: "ms-words" }))
    assert.match(r.message, /约 (\d+ 小时( \d+ 分钟)?|\d+ 分钟)后/)
    assert.doesNotMatch(r.message, /约 \d{3,} 分钟后/, "three-digit minutes must not appear")
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
      assert.match(r.message, /登录接口/)
    },
  )
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
  // says so
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
  for (const [i, broken] of ["{ not json", "", "null", "[1,2,3"].entries()) {
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
  // user believes they still have.
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
              day({ rule_key: "aliyun_bindlogin", total_amount: 50, expire_at: `${today} 13:05:10` }),
              day({ rule_key: "daily_active", total_amount: 200, expire_at: `${tomorrow} 00:00:24` }),
            ],
          },
        },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, new Date(`${today}T13:05:10+08:00`).toISOString())
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
  for (const thrown of [{ code: 42 }, "gone"]) {
    const r = await auth.checkin(async () => {
      throw thrown
    })
    assert.equal(r.outcome, "failed")
    assert.doesNotMatch(r.message, /object Object/, `a non-Error leaked through: ${r.message}`)
    assert.match(r.message, /签到失败|gone/, `should give a usable message, got: ${r.message}`)
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
    text: async () =>
      String(url).includes("login/info")
        ? JSON.stringify({ Code: 200, Data: { NickName: "Mison" } })
        : JSON.stringify({ success: true, data: { records: [] } }),
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
  await withFetch(
    {
      "/openapi/v1/magicubes/balance": { body: { success: true, data: { available_balance: 5 } } },
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": {
        body: { success: true, data: { records: [day({ expire_at: "2026-13-45 99:99:99" })] } },
      },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.equal(u.windows[0].resetsAt, "", "an impossible time is no time at all")
    },
  )
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
  } finally {
    globalThis.fetch = real
  }
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
