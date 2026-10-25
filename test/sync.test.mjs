import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  findConfigDir,
  findMagpieBin,
  isMain,
  main,
  looksLikeMagpie,
  mask,
  planToPlugin,
  planToPreset,
  pluginAccounts,
  presetCandidates,
  readJson,
} from "../bin/sync.mjs"

// 假令牌：形状对，但明显不是真的（README 里的样例也是这个形状）
const A = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
const B = "ms-bbbb1111-cccc-2222-dddd-333344445555"

const presetOf = (key = A, id = "modelscope") => ({ id, preset: "modelscope", key })

test("mask keeps only the ends, as magpie's own display does", () => {
  assert.equal(mask(A), "ms-a…5555")
  // under 12 characters there is nothing to show without showing it all
  assert.equal(mask("12345678"), "（8 字符）")
  assert.equal(mask("12345678901"), "（11 字符）")
  assert.equal(mask("123456789012"), "1234…9012", "12 is the first length with ends to show")
  assert.equal(mask(""), "（不可用）")
  assert.equal(mask(undefined), "（不可用）")
})

test("presetCandidates finds the preset by id or by preset name", () => {
  const ps = [
    { id: "openai", key: "sk-x" },
    { id: "modelscope", preset: "modelscope", key: A },
  ]
  assert.equal(presetCandidates(ps).length, 1)
  assert.equal(presetCandidates(ps)[0].id, "modelscope")
  // --from 指定别的 id 时不去猜
  assert.equal(presetCandidates(ps, "nope").length, 0)
})

test("presetCandidates falls back to the inference host for a hand-made vendor", () => {
  const ps = [
    { id: "mine", chat: "https://api-inference.modelscope.cn/v1", key: B },
    { id: "other", chat: "https://api.openai.com/v1", key: "sk-y" },
  ]
  assert.deepEqual(presetCandidates(ps).map((p) => p.id), ["mine"])
})

test("--from disambiguates by id, even between two preset=modelscope rows", () => {
  // a second provider that also declares preset: modelscope — the default
  // search finds both, and --from has to pick one by id, not by preset again
  const ps = [
    { id: "modelscope", preset: "modelscope", key: A },
    { id: "relaychat", preset: "modelscope", key: B },
  ]
  assert.equal(presetCandidates(ps).length, 2, "default search is ambiguous on purpose here")
  assert.deepEqual(presetCandidates(ps, "relaychat").map((p) => p.id), ["relaychat"])
  assert.deepEqual(presetCandidates(ps, "modelscope").map((p) => p.id), ["modelscope"])
  assert.deepEqual(presetCandidates(ps, "nosuch"), [], "--from matches nothing if there is no such id")
})

test("presetCandidates ignores a provider with no key", () => {
  assert.deepEqual(presetCandidates([{ id: "modelscope", preset: "modelscope" }]), [])
})

test("pluginAccounts picks the main key and its extra accounts, nothing else", () => {
  const auth = {
    msmoli: { type: "api", key: A },
    "msmoli#abc123": { type: "api", key: B },
    qoder: { type: "api", key: "q" },
    msmoli2: { type: "api", key: "trap" },
  }
  assert.deepEqual(pluginAccounts(auth).map((a) => a.name), ["msmoli", "msmoli#abc123"])
  assert.deepEqual(pluginAccounts(null), [])
  assert.deepEqual(pluginAccounts({}), [])
})

test("planToPlugin does nothing when both sides already share the token", () => {
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: A }], force: false })
  assert.equal(p.action, "noop")
  assert.equal(p.cmds.length, 0)
})

test("planToPlugin logs in when the plugin has no account yet", () => {
  const p = planToPlugin({ preset: presetOf(A), accounts: [], force: false })
  assert.equal(p.action, "run")
  assert.equal(p.cmds.length, 1)
  assert.deepEqual(p.cmds[0].argv, ["plugin", "login", "msmoli"])
  assert.equal(p.cmds[0].stdin, `${A}\n`)
})

test("planToPlugin refuses a different token untouched: login would add an account", () => {
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: false })
  assert.equal(p.action, "refuse")
  assert.equal(p.cmds.length, 0)
  assert.ok(p.lines.join("\n").includes("--force"))
})

test("planToPlugin with --force replaces only when a single account exists", () => {
  const one = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true })
  assert.equal(one.action, "run")
  assert.deepEqual(one.cmds.map((c) => c.argv.join(" ")), ["plugin logout msmoli", "plugin login msmoli"])

  const two = planToPlugin({
    preset: presetOf(A),
    accounts: [
      { name: "msmoli", token: B },
      { name: "msmoli#abc123", token: "ms-cccc1111-dddd-2222-eeee-333344445555" },
    ],
    force: true,
  })
  assert.equal(two.action, "refuse", "logout would sign out every account of the provider")
})

test("planToPreset refuses without --force: the preset's key is what chat uses", () => {
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: false })
  assert.equal(p.action, "refuse")
  assert.equal(p.cmds.length, 0)
})

test("planToPreset writes the main account's key with --force", () => {
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true })
  assert.equal(p.action, "run")
  assert.deepEqual(p.cmds[0].argv, ["provider", "key", "modelscope", B])
})

test("planToPreset sends the main account, not whichever is first", () => {
  const p = planToPreset({
    preset: presetOf(A),
    accounts: [
      { name: "msmoli#abc123", token: "ms-cccc1111-dddd-2222-eeee-333344445555" },
      { name: "msmoli", token: B },
    ],
    force: true,
  })
  assert.equal(p.cmds[0].argv.at(-1), B)
})

test("planToPreset needs a plugin sign-in and a preset to write into", () => {
  assert.equal(planToPreset({ preset: presetOf(A), accounts: [], force: true }).action, "refuse")
  assert.equal(planToPreset({ preset: null, accounts: [{ name: "msmoli", token: B }], force: true }).action, "refuse")
})

test("planToPreset is a no-op when both sides share the token", () => {
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: A }], force: true })
  assert.equal(p.action, "noop")
})

test("no plan ever prints a whole token", () => {
  const plans = [
    planToPlugin({ preset: presetOf(A), accounts: [], force: false }),
    planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: false }),
    planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true }),
    planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true }),
  ]
  for (const p of plans) {
    const text = p.lines.join("\n")
    assert.ok(!text.includes(A), `a line leaked the preset token:\n${text}`)
    assert.ok(!text.includes(B), `a line leaked the plugin token:\n${text}`)
  }
})

// ---- detection

test("findMagpieBin looks where each OS installs it", () => {
  const seen = []
  const exists = (p) => {
    seen.push(p)
    return p.includes("magpie.app")
  }
  const got = findMagpieBin({ os: "darwin", env: {}, home: "/h", exists })
  assert.equal(got, "/Applications/magpie.app/Contents/MacOS/magpie")
  assert.ok(seen.includes("/Applications/magpie.app/Contents/MacOS/magpie"))
  // a Homebrew install is looked for too, when no .app is there
  const brew = findMagpieBin({ os: "darwin", env: {}, home: "/h", exists: (p) => p === "/opt/homebrew/bin/magpie" })
  assert.equal(brew, "/opt/homebrew/bin/magpie")

  const win = findMagpieBin({ os: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u", exists: (p) => p.endsWith("magpie.exe") })
  assert.ok(win.endsWith("magpie.exe"))

  const lin = findMagpieBin({ os: "linux", env: {}, home: "/h", exists: (p) => p === "/usr/local/bin/magpie" })
  assert.equal(lin, "/usr/local/bin/magpie")

  assert.equal(findMagpieBin({ os: "linux", env: {}, home: "/h", exists: () => false }), "")
})

// Windows 下 Node 把 "/" 开头的参数翻成 "C:\..."，所以探测层的断言全部走
// join()/pathToFileURL 生成期望值，而不是写死 POSIX 字面量——这些测试在
// Linux/macOS 上跑出同样的值，在 Windows 上跑出各自的值。
test("findConfigDir reads XDG_CONFIG_HOME, then ~/.config, and nothing that isn't magpie's", () => {
  const xdgBase = pathToFileURL("/xdg").pathname.replace(/\/$/, "")
  const homeBase = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const files = new Set([join(xdgBase, "magpie", "providers.json")])
  const exists = (p) => files.has(p)
  assert.equal(
    findConfigDir({ env: { XDG_CONFIG_HOME: xdgBase }, home: homeBase, os: "linux", exists }),
    join(xdgBase, "magpie"),
  )

  const home = new Set([join(homeBase, ".config", "magpie", "plugin-auth.json")])
  assert.equal(
    findConfigDir({ env: {}, home: homeBase, os: "linux", exists: (p) => home.has(p) }),
    join(homeBase, ".config", "magpie"),
  )

  assert.equal(findConfigDir({ env: {}, home: homeBase, os: "linux", exists: () => false }), "", "an empty folder is not magpie's")
})

test("findConfigDir takes a portable install's data folder beside the executable", () => {
  const base = pathToFileURL("/opt/magpie").pathname.replace(/\/$/, "")
  const files = new Set([join(base, "data", "providers.json")])
  const exists = (p) => files.has(p)
  assert.equal(findConfigDir({ env: {}, home: "/h", os: "linux", binPath: join(base, "magpie"), exists }), join(base, "data"))
})

test("findConfigDir reads a Mac app's portable folder beside the .app, not inside it", () => {
  const app = "/Applications/magpie.app"
  const dataDir = join("/Applications", "data")
  const files = new Set([join(dataDir, "providers.json")])
  const exists = (p) => files.has(p)
  const got = findConfigDir({ env: {}, home: "/h", os: "darwin", binPath: `${app}/Contents/MacOS/magpie`, exists })
  assert.equal(got, dataDir, "a data folder inside the bundle would break its signature")
})

test("looksLikeMagpie wants one of magpie's files", () => {
  const base = pathToFileURL("/x").pathname.replace(/\/$/, "")
  assert.equal(looksLikeMagpie(base, (p) => p === join(base, "plugin-auth.json")), true)
  assert.equal(looksLikeMagpie(base, () => false), false)
})

// ---- the CLI as a command (the shape npm and npx run it in)

const bin = fileURLToPath(new URL("../bin/sync.mjs", import.meta.url))
const run = (args, opts = {}) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 30_000, ...opts })

test("runs when node is handed the file directly", () => {
  const r = run(["--help"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /magpie-plugin-msmoli — 把 magpie/)
})

test("runs through a symlink, the way npm's .bin and npx invoke it", () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bin-"))
  try {
    const link = join(dir, "magpie-plugin-msmoli")
    try {
      symlinkSync(bin, link)
    } catch {
      return // Windows without the symlink privilege: nothing to exercise
    }
    const r = spawnSync(link, ["--help"], { encoding: "utf8", timeout: 30_000 })
    // the shebang is what decides this when exec'd by name; skip where the
    // platform can't run it (no executable bit through the link)
    if (r.error) return
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /magpie-plugin-msmoli — 把 magpie/, "a symlinked invocation must still reach main()")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--help exits 0 and every other exit is a number", () => {
  assert.equal(run(["--help"]).status, 0)
  const bad = run(["--nope"])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /不认识的参数/)
})

test("says so, rather than guessing, when there is no magpie config", () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-empty-"))
  try {
    const r = spawnSync(process.execPath, [bin, "--dir", dir], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: dir, HOME: dir },
      timeout: 30_000,
    })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /没有 magpie 的配置文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bare run reports the plan and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bare-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    let called = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        called = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0)
    assert.equal(called, false, "npx with no flags must not sign anything in")
    assert.match(out.join("\n"), /未执行|请显式指定方向/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a --from that matches nothing fails clean, not with a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-typo-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--from", "typo", "--status", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.match(text, /typo/)
    assert.doesNotMatch(text, /Cannot read properties/, "a mistyped --from must not reach a null preset")
    assert.doesNotMatch(text, /undefined/, "no leaked undefined in the message")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing preset is refused before planning, both directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nopreset-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    for (const to of ["--to-plugin", "--to-preset"]) {
      const out = []
      const code = await main({
        argv: ["--dir", dir, to, "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          throw new Error("must not run anything without a preset")
        },
      })
      assert.equal(code, 1, `${to} on an empty providers.json`)
      assert.match(out.join("\n"), /没有|provider add/, `${to}: user gets guidance, not a crash`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the failure partway through the two-step replace

test("a failed login after a successful logout says how to recover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-half-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const wrote = []
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        wrote.push(argv.join(" "))
        // the real logout clears the account; the login then fails as a
        // dropped network would
        if (argv.includes("logout")) {
          writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
          return { status: 0, stdout: "✓ signed out", stderr: "" }
        }
        return { status: 7, stdout: "", stderr: "network down (simulated)" }
      },
    })
    assert.equal(code, 1)
    assert.deepEqual(wrote, ["plugin logout msmoli", "plugin login msmoli"])
    const text = out.join("\n")
    assert.match(text, /已被登出/)
    assert.match(text, /重新运行/, "the user has to be told the account is now signed out")
    assert.equal(readFileSync(join(dir, "plugin-auth.json"), "utf8"), "{}", "the account is gone, as the fixture says")

    // the recovery really is the same command again: no account is left, so
    // it plans the plain login and needs no --force
    const out2 = []
    const code2 = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out2.push(s),
      spawn: (_cmd, argv) => {
        assert.ok(!argv.includes("logout"), "nothing to log out of any more")
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: "✓ signed in", stderr: "" }
      },
    })
    assert.equal(code2, 0)
    assert.match(out2.join("\n"), /完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- files magpie itself tolerates

test("a providers.json with a BOM reads as JSON, not as nothing", () => {
  // Windows editors (and magpie's own #1821) write a BOM; Go strips it, so
  // must the tool, or the preset would read as "未配置". The test goes
  // through readJson — the tool's own reader — rather than stripping the BOM
  // itself, which would only prove the test can.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bom-"))
  try {
    writeFileSync(join(dir, "providers.json"), "﻿" + JSON.stringify({ providers: [presetOf(A)] }))
    const file = join(dir, "providers.json")
    const raw = readJson(file)
    assert.ok(raw && typeof raw === "object", "a BOM must not make the file unreadable")
    assert.deepEqual(presetCandidates(raw.providers).map((p) => p.id), ["modelscope"])

    // and the whole tool sees it: a BOM'd config is not "未配置"
    const r = run(["--dir", dir, "--status"])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /未配置/, "a BOM must not hide the preset")
    assert.match(r.stdout, /modelscope/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readJson tells 'not there' from 'there but unreadable'", () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-readjson-"))
  try {
    assert.equal(readJson(join(dir, "nope.json")), undefined, "a missing file is undefined")
    const broken = join(dir, "broken.json")
    writeFileSync(broken, "{ not json")
    assert.equal(readJson(broken), null, "a file that will not parse is null, not undefined")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a broken providers.json is refused, not crashed on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-broken-"))
  try {
    writeFileSync(join(dir, "providers.json"), "{ not json")
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        throw new Error("must not run with an unreadable providers.json")
      },
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /没有|provider add/)
    assert.doesNotMatch(out.join("\n"), /SyntaxError|at /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the findings of the second review round

test("a failing magpie command never prints the token", async () => {
  // the failure path used to put the child's raw stderr into the error before
  // any masking; a magpie that echoes the key it was handed would leak it
  const dir = mkdtempSync(join(tmpdir(), "msmoli-failmask-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `no key ${A} for provider` }),
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.ok(!text.includes(A), `the token leaked into the failure output:\n${text}`)
    assert.match(text, /no key/, "the rest of the message still gets through")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no magpie binary means no run, not a PATH lookup", async () => {
  // `magpie` resolved through PATH can be a file the user never installed
  // (npx puts the project's node_modules/.bin first); the tool must refuse
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nobin-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin"],
      log: (s) => out.push(s),
      // only the fixture's own files exist, so findMagpieBin finds nothing
      exists: (p) => p === join(dir, "providers.json") || p === join(dir, "plugin-auth.json"),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false, "nothing may be spawned without a known binary")
    assert.match(out.join("\n"), /--magpie/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unreadable plugin-auth.json is a refusal, not 'not signed in'", async () => {
  // a file that exists and doesn't parse may be mid-write or briefly locked;
  // reading it as "nobody signed in" would let a run add a second account
  // over one it couldn't see
  const dir = mkdtempSync(join(tmpdir(), "msmoli-brokenauth-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), "{ broken")
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false, "a write decision must not rest on an unreadable file")
    assert.match(out.join("\n") + String(code), /读不出来/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a timeout in the second step of a replace still says how to recover", async () => {
  // spawnSync surfaces a timeout as error + status null, not status != 0 —
  // and that branch used to skip the "you are signed out" message
  const dir = mkdtempSync(join(tmpdir(), "msmoli-timeout-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        if (argv.includes("logout")) {
          writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
          return { status: 0, stdout: "✓ signed out", stderr: "" }
        }
        return { error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "", stderr: "" }
      },
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.match(text, /ETIMEDOUT/)
    assert.match(text, /已被登出/, "the account is gone; the user must be told")
    assert.match(text, /重新运行/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the replaced token is masked in the logout step's output too", async () => {
  // the token being signed out is as real as the one being signed in; a
  // magpie that echoes the account in its logout error must not put the
  // whole old key on the terminal
  const dir = mkdtempSync(join(tmpdir(), "msmoli-logoutmask-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        if (argv.includes("logout")) {
          return { status: 5, stdout: "", stderr: `signed out msmoli (key ${B}) failed` }
        }
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.ok(!text.includes(B), `the replaced token leaked:\n${text}`)
    assert.match(text, /ms-b…5555/, "the masked form still tells the user which account")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the host fallback matches the exact hostname, not a substring", () => {
  // "api-inference.modelscope.cn.evil.tld" contains the real host as a
  // substring; writing the real token into it would ship it to a stranger
  const evil = [{ id: "relay", chat: "https://api-inference.modelscope.cn.evil.tld/v1", key: B }]
  assert.deepEqual(presetCandidates(evil), [])
  const good = [{ id: "relay", chat: "https://api-inference.modelscope.cn/v1", key: B }]
  assert.deepEqual(presetCandidates(good).map((p) => p.id), ["relay"])
  const notAUrl = [{ id: "relay", chat: "api-inference.modelscope.cn", key: B }]
  assert.deepEqual(presetCandidates(notAUrl), [], "a chat that is not a URL is not a match")
})

test("a provider id shaped like a flag is refused before provider key runs", async () => {
  // `provider key --help <token>` would be read as the CLI's own flag
  const dir = mkdtempSync(join(tmpdir(), "msmoli-flagid-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "--help", preset: "modelscope", key: A }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false)
    assert.match(out.join("\n"), /形状/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an id or name with control characters is printed as text, not as terminal input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-esc-"))
  try {
    const esc = "ms\u001b[2Jcope"
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: esc, preset: "modelscope", key: A }] }))
    const out = []
    await main({
      argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
    })
    const text = out.join("\n")
    assert.ok(!text.includes("\u001b"), "an escape sequence reached the terminal")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- --dry-run: the whole point is that nothing runs

test("--dry-run prints the command and spawns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-dry-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--dry-run", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0)
    assert.equal(spawned, false, "--dry-run must not run anything")
    const text = out.join("\n")
    assert.match(text, /plugin login msmoli/, "the command it would run is still shown")
    assert.match(text, /--dry-run：未执行/, "and it says so")
    assert.ok(!text.includes(A), "even a dry run keeps the token masked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--dry-run after a --force plans both steps and runs neither", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-dry2-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--dry-run", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0)
    assert.equal(spawned, false)
    const text = out.join("\n")
    assert.match(text, /plugin logout msmoli/)
    assert.match(text, /plugin login msmoli/)
    assert.match(text, /--dry-run：未执行/)
    // the folder still holds what it held: a dry run writes nothing
    assert.match(readFileSync(join(dir, "plugin-auth.json"), "utf8"), /ms-bbbb1111/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- main-level guards the unit tests on the pure functions cannot reach

test("two candidates stop the run and ask which, rather than picking one", async () => {
  // the default search matches preset: modelscope, and two providers can
  // declare it. Picking the first would write the token into whichever
  // happened to be listed first — possibly the wrong one.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-amb-"))
  try {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: A }, { id: "relaychat", preset: "modelscope", key: B }] }),
    )
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false, "an ambiguous preset must not be guessed at")
    assert.match(out.join("\n"), /候选|--from/)

    // and --from resolves it
    const out2 = []
    const code2 = await main({
      argv: ["--dir", dir, "--to-plugin", "--from", "relaychat", "--magpie", "/nonexistent"],
      log: (s) => out2.push(s),
      spawn: (_c, argv) => {
        if (argv.includes("login")) writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code2, 0, out2.join("\n"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a magpie that exits 0 without writing is caught by the read-back", async () => {
  // the CLI can report success and leave the file untouched (a stale daemon,
  // a no-op shim). The read-back is what tells the difference.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-noop-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      // exits 0 but writes nothing — the login never landed
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1, "a silent no-op must not be reported as done")
    const text = out.join("\n")
    assert.match(text, /回读|没找到/)
    assert.doesNotMatch(text, /✓ 完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the preset direction's read-back checks the preset, not the plugin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-rb-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      // writes something else than what was asked for
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.match(text, /回读|没找到/)

    // this time the write really lands
    const out2 = []
    const code2 = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out2.push(s),
      spawn: () => {
        writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: B }] }))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code2, 0, out2.join("\n"))
    assert.match(out2.join("\n"), /完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- isMain: the entry has to be recognised by what it is, not its spelling

test("isMain tells the entry file from any other file", () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-main-"))
  try {
    const entry = join(dir, "sync.mjs")
    writeFileSync(entry, "//\n")
    const other = join(dir, "other.mjs")
    writeFileSync(other, "//\n")
    const self = pathToFileURL(entry).href
    assert.equal(isMain(entry, self), true)
    assert.equal(isMain(other, self), false, "a different file is not the entry")
    assert.equal(isMain("", self), false)
    assert.equal(isMain(join(dir, "missing.mjs"), self), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("isMain answers true for another spelling of the same file where the volume folds case", () => {
  // A case-insensitive volume resolves /D/X.mjs and /d/x.mjs to one file while
  // realpath keeps the caller's spelling. String comparison then says "not
  // main" and the CLI exits 0 having done nothing. The identity check is the
  // inode; on a case-sensitive volume the flipped path does not resolve, and
  // there is nothing to assert.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-maincase-"))
  try {
    const entry = join(dir, "SyncCase.mjs")
    writeFileSync(entry, "//\n")
    const flipped = join(dir, "SYNCCASE.MJS")
    let resolves = true
    try {
      // no file identity on this volume (ino 0): nothing to compare by
      if (statSync(flipped).ino === 0) return
    } catch {
      resolves = false
    }
    if (!resolves) return // case-sensitive volume: no second spelling to check
    assert.equal(isMain(flipped, pathToFileURL(entry).href), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the smaller findings of the review rounds

test("a wrapper script as --magpie gets a hint that helps, not one that repeats", async () => {
  // spawnSync cannot hand stdin to a .cmd/.bat (Windows: EINVAL). The old
  // message said "use --magpie" to a user who had just used --magpie.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-cmd-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "C:\\tools\\magpie.cmd"],
      log: (s) => out.push(s),
      spawn: () => ({ error: new Error("spawnSync EINVAL"), status: null, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /magpie\.exe/, "it should point at the real binary")
    assert.doesNotMatch(text, /用 --magpie 指定完整路径/, "not the advice they already followed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing binary keeps the plain hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nohint-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/no/such/magpie"],
      log: (s) => out.push(s),
      spawn: () => ({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /--magpie/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a macOS install in ~/.local/bin is found too", () => {
  const seen = []
  const got = findMagpieBin({
    os: "darwin",
    env: {},
    home: "/h",
    exists: (p) => {
      seen.push(p)
      return p === "/h/.local/bin/magpie"
    },
  })
  assert.equal(got, "/h/.local/bin/magpie")
  assert.ok(seen.includes("/Applications/magpie.app/Contents/MacOS/magpie"), "the app bundle is still tried first")
})

test("--status on a runnable plan reports it and stops short of running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-status-run-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--status", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0)
    assert.equal(spawned, false, "--status must not run anything")
    const text = out.join("\n")
    assert.match(text, /plugin login msmoli/, "the plan is still stated")
    assert.match(text, /--status：以上是计划，未执行/)
    assert.doesNotMatch(text, /✓ 完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--status beats --dry-run when both are given, and neither runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-status-dry-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    let spawned = false
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--status", "--dry-run", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0)
    assert.equal(spawned, false)
    assert.match(out.join("\n"), /未执行/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a .portable marker beside the executable is enough, even before data/ fills up", () => {
  const base = pathToFileURL("/opt/magpie").pathname.replace(/\/$/, "")
  const marker = join(base, ".portable")
  const exists = (p) => p === marker
  assert.equal(
    findConfigDir({ env: {}, home: "/h", os: "linux", binPath: join(base, "magpie"), exists }),
    join(base, "data"),
    "the marker says portable even when data/ has no files yet",
  )
})

test("findMagpieBin checks Program Files as well as LocalAppData on Windows", () => {
  // expected paths are built with join() the way the code builds them, so the
  // test runs the same on Windows and on a POSIX host
  const local = "C:\\Users\\u\\AppData\\Local"
  const pf = "C:\\Program Files"
  const want = join(pf, "magpie", "magpie.exe")
  const seen = []
  const got = findMagpieBin({
    os: "win32",
    env: { LOCALAPPDATA: local, ProgramFiles: pf },
    home: "C:\\Users\\u",
    exists: (p) => {
      seen.push(p)
      return p === want
    },
  })
  assert.equal(got, want)
  assert.equal(seen[0], join(local, "Programs", "magpie", "magpie.exe"), "LOCALAPPDATA is tried first")
})
