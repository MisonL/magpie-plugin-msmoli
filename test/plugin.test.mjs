// The plugin's pure logic, tested without the network: what each endpoint's
// answer means, how a day's ledger is read, and how ModelScope's times are
// parsed. Run with: node --test test/

import assert from "node:assert/strict"
import { test } from "node:test"

import { MsmoliPlugin } from "../index.mjs"

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

const spend = (amount, count = 1) => ({
  gmt_created: today,
  type: "SPEND_CONFIRM",
  rule_key: "api_inference",
  model_tier: "ultra",
  total_amount: amount,
  count,
})

// reply is what fetch gives back: the plugin reads the body as a stream, so
// a fake answers in kind. `raw` stands in for a body that isn't JSON, and
// `bytes` for one that is too large to read.
const reply = (hit) => {
  const text = hit.raw !== undefined ? hit.raw : JSON.stringify(hit.body ?? {})
  const bytes = hit.bytes !== undefined ? hit.bytes : new TextEncoder().encode(text)
  return {
    status: hit.status ?? 200,
    headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(bytes.length) : null) },
    body: {
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

test("checkin without a sign-in fails instead of asking", async () => {
  const r = await auth.checkin(async () => ({}))
  assert.equal(r.outcome, "failed")
})

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

test("usage without a sign-in says so", async () => {
  await assert.rejects(() => auth.usage(async () => ({})))
})

test("a request that hangs gives up instead of holding the host", { timeout: 8000 }, async (t) => {
  const real = globalThis.fetch
  t.mock.timers.enable({ apis: ["setTimeout"] })
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
  await withFetch(
    {
      "/openapi/v1/magicubes/transactions?page=1&page_size=50": { status: 403, body: { success: false, code: "RiskControl" } },
    },
    async () => {
      const u = await auth.usage(async () => ({ type: "api", key: "ms-test" }))
      assert.ok(u.error, "usage should report the refusal")
      assert.equal(u.signIn, "", "a 403 must not mark the sign-in expired")
    },
  )
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
