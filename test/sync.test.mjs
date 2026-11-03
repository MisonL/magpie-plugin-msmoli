import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
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
  sameFolder,
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

test("every install location is probed, not only the first one on each OS", () => {
  // Each candidate is a place a user really has magpie. A typo in one of them
  // is invisible while only the first is asserted: the probe answers "no
  // magpie here" and the tool tells a MacPorts or ~/.local user to install it.
  const probes = (os, env = {}, home = "/h") => {
    const seen = []
    findMagpieBin({ os, env, home, exists: (p) => (seen.push(p), false) })
    return seen
  }
  const mac = probes("darwin")
  for (const p of [
    "/Applications/magpie.app/Contents/MacOS/magpie",
    "/Applications/Magpie.app/Contents/MacOS/magpie",
    "/opt/homebrew/bin/magpie",
    "/usr/local/bin/magpie",
    "/opt/local/bin/magpie",
    join("/h", ".local", "bin", "magpie"),
  ]) {
    assert.ok(mac.includes(p), `darwin should probe ${p}: ${mac.join(", ")}`)
  }
  const lin = probes("linux")
  for (const p of ["/usr/local/bin/magpie", "/usr/bin/magpie", join("/h", ".local", "bin", "magpie")]) {
    assert.ok(lin.includes(p), `linux should probe ${p}: ${lin.join(", ")}`)
  }
  const win = probes("win32", { LOCALAPPDATA: "C:\\u\\Local", ProgramFiles: "C:\\Program Files" }, "C:\\u")
  assert.equal(win.length, 2, `both Windows locations: ${win.join(", ")}`)
  assert.ok(win.some((p) => p.startsWith("C:\\u\\Local")), win.join(", "))
  assert.ok(win.some((p) => p.startsWith("C:\\Program Files")), win.join(", "))
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
  // the folder itself counts, as os.Stat(data) does in appdir.Resolve: a
  // data folder magpie made and has not written into yet is still its own
  const files = new Set([join(base, "data"), join(base, "data", "providers.json")])
  const exists = (p) => files.has(p)
  assert.equal(findConfigDir({ env: {}, home: "/h", os: "linux", binPath: join(base, "magpie"), exists }), join(base, "data"))
})

test("findConfigDir reads a Mac app's portable folder beside the .app, not inside it", () => {
  const app = "/Applications/magpie.app"
  const dataDir = join("/Applications", "data")
  const files = new Set([dataDir, join(dataDir, "providers.json")])
  const exists = (p) => files.has(p)
  const got = findConfigDir({ env: {}, home: "/h", os: "darwin", binPath: `${app}/Contents/MacOS/magpie`, exists })
  assert.equal(got, dataDir, "a data folder inside the bundle would break its signature")
})

test("a folder only shaped like a bundle is not one: MacOSX and .appX stay inside", () => {
  // The two anchors that make the folder a bundle both end in `$`. Dropped,
  // `Contents/MacOS` matches `Contents/MacOSX` and `\.app` matches
  // `Magpie.appX`, and a data folder that lives inside the bundle's own
  // folder is read as the one beside it — magpie's real data folder is then
  // never found and the tool reports "not signed in" on a working install.
  const dataDir = join("/Applications", "data")
  const files = new Set([dataDir, join(dataDir, "providers.json")])
  const exists = (p) => files.has(p)
  for (const binPath of [
    "/Applications/Magpie.app/Contents/MacOSX/magpie",
    "/Applications/Magpie.appX/Contents/MacOS/magpie",
    "/Applications/Magpie.appx/Contents/MacOS/magpie",
  ]) {
    const got = findConfigDir({ env: {}, home: "/h", os: "darwin", binPath, exists })
    assert.equal(got, "", `${binPath} is not inside a bundle: ${JSON.stringify(got)}`)
  }
  // the control: the same shape with the real ending is a bundle, so the loop
  // above is not passing because the fixture never reached the bundle test
  const got = findConfigDir({ env: {}, home: "/h", os: "darwin", binPath: "/Applications/Magpie.app/Contents/MacOS/magpie", exists })
  assert.equal(got, dataDir, "the real bundle keeps its data folder beside the .app")
})

test("findConfigDir follows the executable's symlink, as appdir.Resolve does", () => {
  // /usr/local/bin/magpie and /opt/homebrew/bin/magpie are what findMagpieBin
  // itself names, and both are usually links into the app. appdir.Resolve
  // runs filepath.EvalSymlinks on the executable first, so the data folder
  // magpie uses is the one beside the file it really runs from; looking
  // beside the link answers "no magpie folder" for a portable install and
  // the tool then reads ~/.config/magpie, which magpie is not writing.
  const target = "/Applications/magpie.app/Contents/MacOS/magpie"
  const link = "/usr/local/bin/magpie"
  const files = new Set([join("/Applications", "data"), join("/Applications", "data", "providers.json")])
  const exists = (p) => files.has(p)
  const got = findConfigDir({ env: {}, home: "/h", os: "darwin", binPath: link, exists, real: (p) => (p === link ? target : p) })
  assert.equal(got, join("/Applications", "data"))
})

test("a data folder in a shared folder is not magpie's when the installed folder has magpie's files", () => {
  // appdir's #989: a "data" folder in /Applications, the home folder,
  // Downloads, Desktop or Documents is as likely another app's or the user's
  // own. magpie takes it only when it holds magpie's files and the installed
  // folder holds none; a tool that takes it anyway reads a folder magpie
  // never writes, and the write goes to the folder it does.
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const base = join(home, "Downloads")
  const data = join(base, "data")
  const installed = join(home, ".config", "magpie")
  const bin = join(base, "magpie")

  // data holds magpie's files, and so does the installed folder: magpie runs
  // installed, and the tool must agree
  const both = new Set([data, join(data, "providers.json"), join(installed, "providers.json")])
  assert.equal(
    findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => both.has(p) }),
    installed,
    "the installed folder wins, as it does in appdir.Resolve",
  )

  // the same data folder with no installed files is the portable one
  const onlyData = new Set([data, join(data, "providers.json")])
  assert.equal(findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => onlyData.has(p) }), data)

  // an empty data folder in a shared folder is not magpie's either
  const empty = new Set([data])
  assert.equal(findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => empty.has(p) }), "")
})

test("a .portable file makes a shared folder portable, and a directory of that name does not", () => {
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const base = join(home, "Downloads")
  const marker = join(base, ".portable")
  const data = join(base, "data")
  // a stat that knows only what it is told, and throws ENOENT for the rest,
  // as the real one does for a path that is not there
  const statOf = (kinds) => (p) => {
    const kind = kinds[p]
    if (!kind) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    return { isFile: () => kind === "file", isDirectory: () => kind === "dir" }
  }
  const exists = () => false
  assert.equal(
    findConfigDir({
      env: {},
      home,
      os: "linux",
      binPath: join(base, "magpie"),
      exists,
      stat: statOf({ [marker]: "file" }),
    }),
    data,
    "the marker says portable even when data/ has no files yet",
  )
  assert.equal(
    findConfigDir({
      env: {},
      home,
      os: "linux",
      binPath: join(base, "magpie"),
      exists,
      stat: statOf({ [marker]: "dir" }),
    }),
    "",
    "a folder named .portable is not the marker (appdir checks !IsDir)",
  )
})

test("a FILE named data is not a portable magpie", () => {
  // appdir.Resolve asks os.Stat for a directory; a plain file of that name
  // is not one, and treating it as the config folder makes every read fail
  // with EISDIR far from the cause. exists() says yes here — only the stat
  // knows better, which is why Resolve asks it.
  const base = pathToFileURL("/opt/magpie").pathname.replace(/\/$/, "")
  const data = join(base, "data")
  const installed = join("/h", ".config", "magpie")
  const stat = (p) => {
    if (p === data) return { isFile: () => true, isDirectory: () => false }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  }
  const exists = (p) => p === data || p === join(installed, "providers.json")
  assert.equal(
    findConfigDir({ env: {}, home: "/h", os: "linux", binPath: join(base, "magpie"), exists, stat }),
    installed,
    "the file named data is not it; the installed folder is",
  )
})

test("the portable decision reads appdir's own files, not the tool's", () => {
  // appdir's hasFiles asks for providers.json, logins.json or settings.json.
  // plugin-auth.json and plugins.json are what this tool reads, but a data
  // folder holding only those is not one magpie calls its own — and the
  // shared-folder rule must ask the same question magpie asks.
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const base = join(home, "Downloads")
  const data = join(base, "data")
  const bin = join(base, "magpie")
  for (const only of ["plugin-auth.json", "plugins.json"]) {
    const files = new Set([data, join(data, only)])
    assert.equal(
      findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => files.has(p) }),
      "",
      `a data folder holding only ${only} is not magpie's in a shared folder`,
    )
  }
  for (const own of ["providers.json", "logins.json", "settings.json"]) {
    const files = new Set([data, join(data, own)])
    assert.equal(
      findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => files.has(p) }),
      data,
      `a data folder holding ${own} is`,
    )
  }
})

test("an AppImage's data folder is beside the .AppImage file, not the mount", () => {
  // appdir.Beside: a magpie run from an AppImage keeps its data beside the
  // .AppImage the user has, not in the mount it is unpacked into for the run
  const apps = pathToFileURL("/opt/apps").pathname.replace(/\/$/, "")
  const img = join(apps, "magpie.AppImage")
  // the mount is a host folder too, and "/tmp/.mount…" is not the string
  // join() makes of the same path on Windows: the fixture, the executable's
  // folder and the expectation all have to be spelled the host's way
  const mount = join(pathToFileURL("/tmp").pathname.replace(/\/$/, ""), ".mount_magpieXX")
  const files = new Set([join(apps, "data"), join(apps, "data", "providers.json")])
  const got = findConfigDir({
    env: { APPIMAGE: img, APPDIR: mount },
    home: "/h",
    os: "linux",
    binPath: join(mount, "magpie"),
    exists: (p) => files.has(p),
  })
  assert.equal(got, join(apps, "data"))
})

test("an AppImage outside its own mount is not taken for one", () => {
  // appdir's within(): APPIMAGE and APPDIR are inherited by every program the
  // AppImage starts, so a magpie run from somewhere else must not be moved
  // beside a .AppImage that is not the one it runs from
  const img = "/opt/apps/magpie.AppImage"
  const elsewhere = pathToFileURL("/usr/local").pathname.replace(/\/$/, "")
  const got = findConfigDir({
    env: { APPIMAGE: img, APPDIR: "/tmp/.mount_magpieXX" },
    home: "/h",
    os: "linux",
    binPath: join(elsewhere, "magpie"),
    exists: (p) => p === join(elsewhere, "data"),
  })
  assert.equal(got, join(elsewhere, "data"), "the executable's own folder, not the AppImage's")
  // an APPIMAGE with no APPDIR (or a relative one) is not a mount to test
  const noDir = findConfigDir({
    env: { APPIMAGE: img },
    home: "/h",
    os: "linux",
    binPath: join(elsewhere, "magpie"),
    exists: (p) => p === join(elsewhere, "data"),
  })
  assert.equal(noDir, join(elsewhere, "data"))
})

test("looksLikeMagpie wants one of magpie's files", () => {
  const base = pathToFileURL("/x").pathname.replace(/\/$/, "")
  // each of the three names, alone: a folder magpie has written only one of
  // (a fresh install writes providers.json first, a plugin-only install
  // plugin-auth.json) is still magpie's folder
  for (const name of ["providers.json", "plugins.json", "plugin-auth.json"]) {
    assert.equal(looksLikeMagpie(base, (p) => p === join(base, name)), true, `${name} alone is enough`)
  }
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
  // the usage page names where an installed magpie keeps its files: a user who
  // reads it to find the folder must be sent to the real one, and the file
  // magpie itself reads is the one under ~/.config/magpie
  assert.ok(r.stdout.includes("~/.config/magpie"), `the usage should name the installed folder: ${r.stdout}`)
})

test("the shebang is the one npm's bin symlink execs", () => {
  // npm points its .bin/<name> symlink at this file and the OS runs it by its
  // shebang, so a typo there breaks `npx magpie-plugin-msmoli` while
  // `node bin/sync.mjs` — what every other test does — keeps working. The
  // symlink test below skips when it cannot exec, which is exactly what a
  // broken shebang looks like, so it cannot catch this on its own.
  const first = readFileSync(bin, "utf8").split("\n")[0]
  assert.equal(first, "#!/usr/bin/env node", `npm execs this file by its first line: ${JSON.stringify(first)}`)
})

test("runs through a symlink, the way npm's .bin and npx invoke it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bin-"))
  try {
    const link = join(dir, "magpie-plugin-msmoli")
    try {
      symlinkSync(bin, link)
    } catch {
      // Windows without the symlink privilege. Said out loud rather than
      // returned silently: a test that skips itself reads as a pass in CI, and
      // this one covers the invocation npm actually uses on POSIX.
      t.skip("symlinks are not available here")
      return
    }
    const r = spawnSync(link, ["--help"], { encoding: "utf8", timeout: 30_000 })
    // the shebang is what decides this when exec'd by name; skip where the
    // platform can't run it (no executable bit through the link, or a Windows
    // spawn that only looks for .exe)
    if (r.error) {
      t.skip(`cannot execute a symlinked script here: ${r.error.code ?? r.error.message}`)
      return
    }
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
    // the id is the one thing this line exists to say: the next line repeats
    // it in the advice, so a message that lost it still reads fine to a
    // regex looking only for the word
    assert.match(text, /id 为 "typo" 的 provider/, `the message must name what was looked for: ${text}`)
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

test("without --force, two different tokens are refused before anything runs", async () => {
  // --force is the CLI's permission to log the user out and back in; the
  // plan functions honour it, but who hands it to them is parseArgs. A
  // `force: true` default there turned a plain `--to-plugin` into a replace
  // with no question asked — the one destructive step this tool can take.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-noforce-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    for (const to of ["--to-plugin", "--to-preset"]) {
      let spawned = false
      const out = []
      const code = await main({
        argv: ["--dir", dir, to, "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      // both directions refuse, and neither may run anything: the plan
      // functions honour --force, but whose hand it is in is parseArgs
      assert.equal(code, 1, `${to} on two different tokens`)
      assert.equal(spawned, false, `${to}: nothing may run without --force`)
      assert.match(out.join("\n"), /--force/, `${to}: the user is told how to go through with it`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

    // the strip is anchored at the front: a U+FEFF inside a value is the
    // value's own character, not a BOM to remove. As `/﻿/` (unaligned)
    // the first one found anywhere is deleted, and a provider whose id holds
    // one is silently renamed.
    writeFileSync(file, '{"providers":[{"id":"model﻿scope","preset":"modelscope","key":"ms-a…"}]}')
    assert.equal(readJson(file).providers[0].id, "model﻿scope", "a BOM in the middle is not a BOM")
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
    // "there but unreadable" must not be reported as "not configured": that
    // sends the user off to add a provider that is already there
    assert.match(out.join("\n"), /读不出来/)
    // and the line has to name the file it means: two of the five messages in
    // this block point at one of magpie's files, and "a file is unreadable" is
    // not something the user can act on
    assert.match(out.join("\n"), /providers\.json 存在但读不出来/, out.join("\n"))
    assert.doesNotMatch(out.join("\n"), /未配置|provider add/, "a damaged file is not an absent one")
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
    assert.match(out.join("\n"), /plugin-auth\.json 存在但读不出来/, "the message must name the file it means")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the real spawn receives the token on stdin and the output decoded as text", () => {
  // Every other test injects `spawn`, so the options object handed to
  // spawnSync itself was never exercised: rename `input` to anything else and
  // magpie's login reads EOF, a typo in `encoding` makes spawnSync throw, and
  // the suite stayed green either way. Here the injected spawn still calls the
  // real spawnSync with the options object exactly as run() built it — only
  // the program is swapped for a child that reports what it read.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-stdin-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const child = join(dir, "child.mjs")
    writeFileSync(
      child,
      'let data = ""\nprocess.stdin.on("data", (c) => (data += c))\nprocess.stdin.on("end", () => {\n  process.stdout.write(`收到：${data.trim()}\\n`)\n  process.exit(7)\n})\n',
    )
    const out = []
    let sawOptions
    const code = main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_bin, _argv, opts) => {
        sawOptions = opts
        return spawnSync(process.execPath, [child], opts)
      },
    })
    return Promise.resolve(code).then((rc) => {
      const text = out.join("\n")
      assert.equal(rc, 1, text)
      assert.equal(sawOptions.encoding, "utf8", "the child's output must be decoded as utf8 text")
      assert.equal(sawOptions.input, `${A}\n`, "the token goes in on stdin, exactly as the plan says")
      // the child read the token back, and the failure line masks it
      assert.match(text, /收到：ms-a…5555/, `the child must have received the token on stdin: ${text}`)
      assert.doesNotMatch(text, /Unknown encoding|ERR_UNKNOWN_ENCODING/, "the spawn options must be valid")
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that cannot read the file says so by name, not 'not found'", async () => {
  // The write ran; the file came back unparseable (a half-write, a lock). The
  // token may well have landed, so the user must be sent to the file, not to
  // "is magpie running?" — and the line names which file. Both directions.
  for (const [direction, file] of [
    ["--to-preset", "providers.json"],
    ["--to-plugin", "plugin-auth.json"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-rbnull-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
      const out = []
      const code = await main({
        argv: ["--dir", dir, direction, "--force", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          // the write "succeeded" and left the file unreadable
          writeFileSync(join(dir, file), "{ broken")
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      const text = out.join("\n")
      assert.equal(code, 1, text)
      assert.match(text, new RegExp(`${file.replace(".", "\\.")} 读不出来`), `the read-back must name ${file}: ${text}`)
      assert.match(text, /写入已执行/, `and say the write may have landed: ${text}`)
      assert.doesNotMatch(text, /没找到目标/, "unreadable is not 'the token is not there'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    // the branch's whole job: tell the user it was a timeout, and of what
    // length. "ETIMEDOUT" itself is the runtime's word, carried in by
    // r.error.message — the hint is the only part written for the user.
    assert.match(text, /超过 120 秒没有结束/, `the timeout hint must say how long: ${text}`)
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

test("a provider id with a space or slash is refused, not written as an argument", () => {
  // The id is the first argument to `provider key`. The regex's `$` is what
  // keeps the check to the whole id: dropped, a prefix that starts well
  // ("a b" starts with "a") passes, and the tool writes the key under an id
  // magpie never stores — a success message for a write that did not happen.
  for (const id of ["a b", "a/b", "modelscope/../../x", "a\nb"]) {
    const p = planToPreset({ preset: { id, preset: "modelscope", key: A }, accounts: [{ name: "msmoli", token: B }], force: true })
    assert.equal(p.action, "refuse", `${JSON.stringify(id)} is not a provider id: ${p.action}`)
    assert.equal(p.cmds.length, 0, "nothing runs with a malformed id")
  }
  // the control: the same plan with a well-formed id runs — including the
  // shortest one there is. `[A-Za-z0-9._-]+` instead of `*` demands a second
  // character and refuses a provider id of one, which magpie accepts.
  for (const id of ["modelscope", "x", "0"]) {
    const ok = planToPreset({ preset: presetOf(A, id), accounts: [{ name: "msmoli", token: B }], force: true })
    assert.equal(ok.action, "run", `${JSON.stringify(id)} is a plain id`)
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
  // message said "use --magpie" to a user who had just used --magpie. All
  // three wrapper spellings are checked: the pattern is what decides, and a
  // class narrowed to cmd|bat leaves a .ps1 user with the advice they already
  // followed.
  for (const wrapper of ["magpie.cmd", "magpie.bat", "magpie.ps1", "MAGPIE.CMD"]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-cmd-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
      const out = []
      const code = await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", `C:\\tools\\${wrapper}`],
        log: (s) => out.push(s),
        spawn: () => ({ error: new Error("spawnSync EINVAL"), status: null, stdout: "", stderr: "" }),
      })
      assert.equal(code, 1)
      const text = out.join("\n")
      assert.match(text, /magpie\.exe/, `${wrapper}: it should point at the real binary`)
      assert.doesNotMatch(text, /用 --magpie 指定完整路径/, `${wrapper}: not the advice they already followed`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // and the ending is the whole test: a file that merely CONTAINS ".cmd" is
  // not a wrapper. "magpie.cmd.bak" is a renamed something — the wrapper hint
  // would point a user at a magpie.exe that does not exist next to it. As
  // /\.(cmd|bat|ps1)/ (no $) every one of these is read as a wrapper.
  for (const notWrapper of ["magpie.cmd.bak", "magpie.batt", "magpied.ps1x"]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-cmdbak-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
      const out = []
      await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", `C:\\tools\\${notWrapper}`],
        log: (s) => out.push(s),
        spawn: () => ({ error: new Error("spawnSync EINVAL"), status: null, stdout: "", stderr: "" }),
      })
      assert.doesNotMatch(out.join("\n"), /包装脚本/, `${notWrapper} is not a wrapper script`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a machine with no magpie binary is told where to point --magpie", async () => {
  // The branch itself was never reached: the only test naming it asserted it
  // was NOT printed, on a --dry-run that is allowed to go without a binary.
  // The advice is the whole value of the message — a path that is not where
  // magpie installs sends the user to a file that is not there.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nobin-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin"],
      log: (s) => out.push(s),
      env: {},
      home: dir,
      // the folder holds the two config files but no magpie binary anywhere:
      // a portable magpie that has never been downloaded beside its data, or
      // an install this tool does not know the path of
      exists: (p) => p.startsWith(dir) && !/magpie(\.exe)?$/.test(p),
      spawn: () => {
        throw new Error("no binary means nothing to spawn")
      },
    })
    const text = out.join("\n")
    assert.equal(code, 1, text)
    assert.match(text, /没找到 magpie 可执行文件/, `should name the problem: ${text}`)
    assert.match(text, /\/Applications\/magpie\.app\/Contents\/MacOS\/magpie/, `should name a real install path: ${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a folder with none of magpie's files is told which files it looked for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nofiles-"))
  try {
    const out = []
    const code = await main({ argv: ["--dir", dir], log: (s) => out.push(s), spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
    const text = out.join("\n")
    assert.equal(code, 1, text)
    for (const name of ["providers.json", "plugins.json", "plugin-auth.json"]) {
      assert.ok(text.includes(name), `the message should name ${name}: ${text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a machine with no config folder is told the two places it tried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nodir-"))
  try {
    const out = []
    const code = await main({ argv: [], log: (s) => out.push(s), env: {}, home: dir, exists: () => false, spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
    const text = out.join("\n")
    assert.equal(code, 1, text)
    assert.match(text, /没找到 magpie 的配置目录/, `should name the problem: ${text}`)
    assert.match(text, /\$XDG_CONFIG_HOME\/magpie/, `should name the XDG place: ${text}`)
    assert.match(text, /~\/\.config\/magpie/, `should name the home place: ${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a bare --magpie name is refused instead of looked up on PATH", async () => {
  // spawnSync resolves a bare name through PATH, but exists("magpie") does
  // not, so the write guard saw "no binary" and skipped itself — and the
  // token went to whatever PATH answered first. Reproduced with a fake magpie
  // ahead on PATH that read the token off stdin whole.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bare-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    for (const name of ["magpie", "magpie.exe"]) {
      const out = []
      let spawned = false
      const code = await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", name],
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      assert.equal(code, 1, `${name} must be refused`)
      assert.equal(spawned, false, `${name} must never reach a spawn`)
      const text = out.join("\n")
      assert.match(text, /裸名/, `${name} should say a bare name is not taken: ${text}`)
      // and the advice names a real install path — a typo there sends the
      // user to a file that is not there
      assert.match(text, /\/Applications\/magpie\.app\/Contents\/MacOS\/magpie/, `the advice names a real path: ${text}`)
      assert.doesNotMatch(text, /magpie-plugin-msmoli: /, "said as a message, not a crash")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a relative --magpie path is a path, not a lookup, and runs", async () => {
  // "./magpie" and "data/../magpie" are not looked up on PATH by spawnSync (a
  // name with a separator is resolved against the working folder), and
  // existsSync resolves them the same way — so the write guard works and
  // there is no hole to refuse. They are also exactly what a user in a
  // portable magpie's folder types.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-rel-"))
  const was = process.cwd()
  try {
    writeFileSync(join(dir, "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    mkdirSync(join(dir, "data"))
    writeFileSync(join(dir, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({}))
    process.chdir(dir)
    for (const name of ["./magpie", "data/../magpie"]) {
      writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({}))
      const out = []
      const spawned = []
      const code = await main({
        argv: ["--dir", "data", "--to-plugin", "--magpie", name],
        env: {},
        home: dir,
        log: (s) => out.push(s),
        // the write magpie would make, so the read-back can confirm it
        spawn: (_bin, argv) => {
          spawned.push(argv.join(" "))
          if (argv[0] === "plugin" && argv[1] === "login") {
            writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
          }
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      assert.equal(code, 0, `${name} must run: ${out.join("\n")}`)
      assert.deepEqual(spawned, ["plugin login msmoli"], `${name} must reach the login it planned`)
      assert.doesNotMatch(out.join("\n"), /不同的配置目录/, `${name} names the binary's own folder`)
    }
  } finally {
    process.chdir(was)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token pasted into --from, or as a bare argument, is not echoed whole", async () => {
  // Both sites print the value back verbatim. A token in the wrong position
  // is still a token, and the tool promises it never appears in the output.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-echo-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    // --from with a key where an id belongs
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--from", A, "--status"],
      log: (s) => out.push(s),
    })
    assert.equal(code, 1)
    assert.ok(!out.join("\n").includes(A), `the token was echoed: ${out.join("\n")}`)
    assert.match(out.join("\n"), /ms-a…5555/, "it should be shown masked")
    // a bare token argument (parsed before main, so through the CLI)
    const r = run([A])
    assert.equal(r.status, 1)
    assert.ok(!r.stderr.includes(A), `the token was echoed: ${r.stderr}`)
    assert.ok(!r.stdout.includes(A), `the token was echoed: ${r.stdout}`)
    assert.match(`${r.stdout}${r.stderr}`, /ms-a…5555/)
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
  // expected path via join(), as the code builds it: a hard-coded POSIX
  // literal would not match on Windows
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const want = join(home, ".local", "bin", "magpie")
  const seen = []
  const got = findMagpieBin({
    os: "darwin",
    env: {},
    home,
    exists: (p) => {
      seen.push(p)
      return p === want
    },
  })
  assert.equal(got, want)
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

test("a token with a control character at either end prints no control character", async () => {
  // the ends are the only part of a key this tool ever shows, and they come
  // from a file: a key pasted with a trailing newline, or a providers.json
  // someone else wrote, would put that character straight on the terminal
  for (const t of [
    "ms-aaaa1111-bbbb-2222-abcd\n",
    "ms-aaaa1111-bbbb-2222-abcd\r\n",
    "ms-\u001b[31maaaa-1111-2222-3333",
    "ms-aaaa1111-bbbb-2222-\u001b[2Jzzzz",
  ]) {
    const out = mask(t)
    assert.doesNotMatch(out, /[\p{Cc}\p{Cf}]/u, `mask(${JSON.stringify(t)}) = ${JSON.stringify(out)}`)
  }
  // and the normal case still shows both ends
  assert.equal(mask(A), "ms-a…5555")
})

// ---- the third review round's findings

test("--from cannot reach a provider that is not ModelScope's", async () => {
  // --from is a disambiguator, not an override: short-circuiting it before the
  // host check let `--from openai --to-plugin` hand OpenAI's key to the
  // sign-in plugin, and `--from openai --to-preset` write the ms token over a
  // third-party provider. Neither is what "sync my ModelScope key" means.
  const ps = [
    { id: "openai", key: "sk-openai", chat: "https://api.openai.com/v1" },
    { id: "modelscope", preset: "modelscope", key: A },
    { id: "relay", key: B, chat: "https://api-inference.modelscope.cn/v1" },
  ]
  assert.deepEqual(presetCandidates(ps, "openai"), [], "a third-party provider is never a candidate")
  assert.deepEqual(presetCandidates(ps, "relay").map((p) => p.id), ["relay"], "a ModelScope-hosted relay still is")
  assert.deepEqual(presetCandidates(ps, "modelscope").map((p) => p.id), ["modelscope"])
})

test("a missing value for --dir/--magpie is an error, not a silent fallback", async () => {
  // `--dir ""` used to read as "not given" and fall back to the machine's own
  // magpie: a credential written to a target the user never named
  for (const argv of [["--dir", ""], ["--dir"], ["--dir", "--dry-run"], ["--magpie"], ["--from"]]) {
    const spawned = []
    let code
    let err
    try {
      code = await main({ argv, log: () => {}, spawn: (...a) => { spawned.push(a); return { status: 0, stdout: "", stderr: "" } } })
    } catch (e) {
      err = e
    }
    assert.ok(err || code === 1, `${JSON.stringify(argv)} must not fall through to a run`)
    assert.equal(spawned.length, 0, `${JSON.stringify(argv)} must not spawn anything`)
  }
})

test("--dry-run works on a machine with no magpie binary to find", async () => {
  // dry-run spawns nothing, so requiring a binary made it fail exactly where a
  // preview is most useful: before magpie is installed
  const dir = mkdtempSync(join(tmpdir(), "msmoli-dry-nobin-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--dry-run"],
      log: (s) => out.push(s),
      exists: (p) => p.startsWith(dir),
      spawn: () => {
        throw new Error("dry run must not spawn")
      },
    })
    assert.equal(code, 0)
    const text = out.join("\n")
    assert.match(text, /plugin login msmoli/, "the command is still shown")
    assert.match(text, /--dry-run：未执行/)
    assert.doesNotMatch(text, /没找到 magpie 可执行文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a logout that exits 0 without signing out is caught, not reported as done", async () => {
  // the tool refuses to --force more than one account because logout signs
  // them all out; a logout that reports success and leaves the old account
  // behind makes login add a second one, and "an account holds the token"
  // is still true — so the read-back has to count them
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nologout-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_c, argv) => {
        if (argv.includes("logout")) return { status: 0, stdout: "", stderr: "" } // exits 0, deletes nothing
        // login appends rather than replaces, the way a host keyed by accountId does
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B }, "msmoli#a1b2c3": { type: "api", key: A } }))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    const text = out.join("\n")
    assert.equal(code, 1, "two accounts is not success")
    assert.doesNotMatch(text, /✓ 完成/)
    assert.match(text, /2 个账号/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that cannot parse says so, not 'check magpie is running'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-rbbroken-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        // the write landed, but the file it landed in is not parseable now
        writeFileSync(join(dir, "plugin-auth.json"), "{ partial")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.match(text, /读不出来/, "name the real problem")
    assert.doesNotMatch(text, /检查 magpie 是否在正常运行/, "the write did land; that advice is wrong here")
    assert.ok(!text.includes(A), "still no whole token")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("giving both directions is an error, not a silent last-one-wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bothdirs-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    let spawned = false
    let code
    let err
    try {
      code = await main({
        argv: ["--dir", dir, "--to-plugin", "--to-preset", "--status"],
        log: () => {},
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
    } catch (e) {
      err = e
    }
    assert.ok(err, "conflicting directions should be refused outright")
    assert.match(String(err.message), /只能给一个/)
    assert.equal(spawned, false)
    void code
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--status alone reports the plan instead of asking for a direction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-statusonly-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({ argv: ["--dir", dir, "--status"], log: (s) => out.push(s), spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
    const text = out.join("\n")
    assert.equal(code, 0)
    assert.match(text, /--status：以上是计划，未执行/)
    assert.doesNotMatch(text, /要执行请显式指定方向/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a --from value with control characters is printed as text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-fromesc-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    await main({ argv: ["--dir", dir, "--from", "x\u001b[2Jy", "--status"], log: (s) => out.push(s), spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
    const text = out.join("\n")
    assert.ok(!text.includes("\u001b"), "an escape sequence reached the terminal")
    assert.match(text, /x\s*\[2J\s*y|xy/, "the value is still recognisable, with the escape shown as space")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--to-preset --dry-run prints the command with the token masked", async () => {
  // the preset direction is the one that puts a token in argv, so it is the
  // one whose echoed command can print it whole. Both --dry-run tests used to
  // go through --to-plugin, where the token arrives on stdin and never shows —
  // so hidden() could be deleted and the suite stayed green.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-drypreset-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--dry-run"],
      log: (s) => out.push(s),
      spawn: () => {
        throw new Error("--dry-run must not spawn")
      },
    })
    const text = out.join("\n")
    assert.equal(code, 0)
    assert.match(text, /^\$ magpie provider key modelscope /m, `the command should be echoed:\n${text}`)
    assert.ok(!text.includes(B), `the dry-run echo leaked the token whole:\n${text}`)
    assert.ok(text.includes(mask(B)), "the echo shows the token masked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("isMain falls back to the resolved path when the volume reports no identity", () => {
  // exFAT/FAT sticks and some SMB shares report ino 0. The inode branch can't
  // decide there, and with nothing in its place isMain answers false for the
  // entry file itself — the CLI prints nothing and exits 0, which reads as a
  // successful sync. A volume with st_ino stubbed to 0 is the only way to
  // reach that branch, hence the injected stat; a symlink gives the second
  // spelling the href comparison is meant to miss.
  const zero = (p) => ({ ino: 0, dev: 1, isFile: () => statSync(p).isFile() })
  const dir = mkdtempSync(join(tmpdir(), "msmoli-mainino-"))
  try {
    const entry = join(dir, "sync.mjs")
    writeFileSync(entry, "//\n")
    writeFileSync(join(dir, "other.mjs"), "//\n")
    const link = join(dir, "sync-link.mjs")
    try {
      symlinkSync(entry, link)
    } catch {
      return // no symlinks on this machine: nothing to spell differently
    }
    assert.notEqual(pathToFileURL(link).href, pathToFileURL(entry).href, "the spellings should differ as strings")
    assert.equal(isMain(link, pathToFileURL(entry).href, zero), true, "the same file is the entry even with no inode")
    assert.equal(isMain(join(dir, "other.mjs"), pathToFileURL(entry).href, zero), false, "a different file still is not")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no config anywhere is told apart from a wrong --dir", () => {
  // two different refusals: a --dir that holds no magpie files (previous
  // test) and no folder to look in at all. The second one is the one that
  // names the places it tried, and it had no test.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nodir-"))
  try {
    const r = spawnSync(process.execPath, [bin], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: dir, HOME: dir },
      timeout: 30_000,
    })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /没找到 magpie 的配置目录/, r.stdout)
    assert.match(r.stdout, /--dir/, "should say how to name one")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the review's findings, pinned

test("the preset direction keeps the replaced key out of a failure's output", async () => {
  // `provider key` replaces the preset's key; a host that says what it
  // replaced ("cannot use key ms-… for modelscope") echoes a real credential.
  // --to-plugin's logout step has always kept its outgoing token a secret;
  // the preset direction did not, and one of the two keys is enough to leak.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-oldkey-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 9, stdout: "", stderr: `cannot replace key ${A} for modelscope` }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.ok(!text.includes(A), `the replaced key reached the terminal: ${text}`)
    assert.match(text, /ms-a…5555/, "the masked key stands in for it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token pasted with a trailing newline is masked and read back as the same token", async () => {
  // the check-in plugin trims the key (tokenOf), so a key written with a
  // newline is the same credential to it. The tool compared and scrubbed the
  // raw string: the host echoed the trimmed one, scrub missed it, and the
  // read-back compared the stored trimmed token against the untrimmed want —
  // a write that landed read as a failure.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-trim-"))
  const key = `${A}\n`
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    assert.equal(presetCandidates(JSON.parse(readFileSync(join(dir, "providers.json"), "utf8")).providers)[0].key, A, "the key is trimmed where it is read")
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        // what magpie does: trim what it read, save it, say so on a failure
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: `signed in as ${A}`, stderr: "" }
      },
    })
    assert.equal(code, 0, `a write that landed must read back: ${out.join("\n")}`)
    assert.ok(!out.join("\n").includes(A), "the token never reaches the terminal")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a plugin-auth.json of the wrong shape is not 'nobody signed in'", async () => {
  // an array, a string or a bare null parses fine and says nothing about the
  // accounts magpie has: login over it would add a second account over one we
  // could not see. The same goes for providers.json one level in.
  for (const [file, body] of [
    ["plugin-auth.json", "[]"],
    ["plugin-auth.json", '"hello"'],
    ["providers.json", "[]"],
    ["providers.json", '{"providers":{}}'],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-shape-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
      writeFileSync(join(dir, file), body)
      const spawned = []
      const out = []
      const code = await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: (_b, a) => {
          spawned.push(a.join(" "))
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      assert.equal(code, 1, `${file} = ${body} must be refused`)
      assert.deepEqual(spawned, [], `${file} = ${body} must not reach a login`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a run that writes is stopped when --dir and --magpie disagree", async () => {
  // magpie's CLI has no --dir: the write lands in the binary's own config.
  // Reading a fixture while writing the real magpie is how a rehearsal signed
  // a test token into the user's own plugin-auth.json.
  const real = mkdtempSync(join(tmpdir(), "msmoli-binown-"))
  const fixture = mkdtempSync(join(tmpdir(), "msmoli-fixture-"))
  try {
    writeFileSync(join(real, "plugin-auth.json"), JSON.stringify({}))
    writeFileSync(join(real, "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(fixture, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(fixture, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    let spawned = false
    const code = await main({
      argv: ["--dir", fixture, "--to-plugin", "--magpie", join(real, "magpie")],
      env: {},
      home: real,
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false, "nothing may be written to a folder the user did not name")
    const text = out.join("\n")
    assert.match(text, /不同的配置目录/)
    assert.match(text, /--dir/)
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("one folder is one folder, however the shell spelled it", async (t) => {
  // A shell completes a directory with its trailing slash, "/private/tmp" and
  // "/tmp" are one folder on a Mac, and "data/." is "data". Comparing the two
  // arguments as strings refused all of these, telling a user their arguments
  // disagreed when they named the same place — and the refusal reads as if
  // they had made a mistake.
  const real = mkdtempSync(join(tmpdir(), "msmoli-same-"))
  const link = `${real}-link`
  try {
    // a portable magpie: the binary and the data folder it owns
    mkdirSync(join(real, "data"))
    writeFileSync(join(real, "plugin-auth.json"), JSON.stringify({}))
    writeFileSync(join(real, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(real, "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(real, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(real, "data", "plugin-auth.json"), JSON.stringify({}))
    const spellings = [join(real, "data"), join(real, "data") + "/", join(real, "data", "."), join(real, "data", "..", "data")]
    // a symlinked spelling is the fifth, where the machine can make one:
    // Windows without the symlink privilege cannot, and the four above cover
    // the same decision without it
    try {
      symlinkSync(join(real, "data"), link)
      spellings.push(link)
    } catch {
      t.diagnostic("symlinks are not available here; five spellings become four")
    }
    const bin = join(real, "magpie")
    // the same folder, however it is spelled
    for (const spelling of spellings) {
      const out = []
      let spawned = false
      const code = await main({
        argv: ["--dir", spelling, "--to-plugin", "--magpie", bin],
        env: {},
        home: real,
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      assert.equal(spawned, true, `${spelling} names the binary's own folder and must be allowed`)
      assert.doesNotMatch(out.join("\n"), /不同的配置目录/, `${spelling} is the same folder: ${out.join("\n")}`)
    }
  } finally {
    rmSync(link, { force: true })
    rmSync(real, { recursive: true, force: true })
  }
})

test("two different folders are still two, and a missing one is not another's", () => {
  const a = mkdtempSync(join(tmpdir(), "msmoli-a-"))
  const b = mkdtempSync(join(tmpdir(), "msmoli-b-"))
  try {
    assert.equal(sameFolder(a, a), true)
    assert.equal(sameFolder(a, b), false, "two real folders are not one")
    // "" is what findConfigDir answers when the binary has no magpie folder
    assert.equal(sameFolder("", a), false, "a folder magpie has not made is not the one named")
    assert.equal(sameFolder(a, ""), false)
    assert.equal(sameFolder("", ""), false, "two unknown folders are never taken for one another")
    // two folders that do not exist are not the same place either
    assert.equal(sameFolder(join(a, "nope"), join(b, "nope")), false)
    assert.equal(sameFolder(join(a, "nope"), join(a, "nope")), false, "nothing to resolve is not a match")
    // a stat that fails after both sides resolved (a folder removed between
    // the read and the identity check, a permission wall) is not a match
    assert.equal(
      sameFolder(a, b, (p) => p, () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      }),
      false,
    )
    // and a volume that reports ino 0 for everything (exFAT, some SMB shares)
    // has no identity to compare: the resolved strings decided above, and the
    // ino check must not turn their 0 === 0 into "one folder". As `!== -1`
    // the guard passes ino 0 through and two different folders are one.
    const noIno = () => ({ ino: 0, dev: 1 })
    assert.equal(sameFolder(a, b, (p) => p, noIno), false, "ino 0 is no identity to compare")
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test("a child killed by a signal is not reported as an exit code of null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-sig-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /SIGKILL/, `should name the signal: ${text}`)
    assert.doesNotMatch(text, /退出码 null/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed login after a successful logout does not claim a logout on the first step", async () => {
  // e.recover is set for every step but the first: the first step is what
  // FAILED, so nothing has run yet and "前面的步骤已经执行，现有登录已被登出"
  // would be a lie that reads as "your sign-in is gone". As `i > -1` every
  // step carries it. The two-step tests above assert the line's presence on
  // later steps; nothing asserted its absence on the first.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-step0-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      // the logout is step 0 and fails: nothing has run
      spawn: (_cmd, argv) => (argv.includes("logout") ? { status: 2, stdout: "", stderr: "boom" } : { status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.doesNotMatch(text, /已被登出/, `nothing has run yet, no logout to report: ${text}`)
    assert.doesNotMatch(text, /重新运行/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the outgoing token is scrubbed from the login step's output too", async () => {
  // the secret list is built from every command up to and including the
  // current one. `slice(0, i)` drops the current one, and the login step's
  // `secret` is the new token — but its output can echo the OLD one the
  // logout just removed, which only the slice's own tail still covers.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-loginmask-"))
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
        // the login step fails, and its output names the token that was just
        // signed out — the old key, which only the slice of earlier commands
        // knows about
        return { status: 2, stdout: "", stderr: `cannot sign in, still holding ${B}` }
      },
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.ok(!text.includes(B), `the outgoing token must not reach the terminal: ${text}`)
    assert.match(text, /ms-b/, `it is masked instead: ${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a first login that leaves two accounts is not a failed logout", async () => {
  // the two-account read-back check guards the logout→login sequence: there,
  // two accounts means the logout never really deleted. A plan with one
  // command had no logout at all, so `plan.cmds.length > 1` keeps the check
  // away from it; as `> 0` a fresh login that finds two accounts is reported
  // as a failed logout — a diagnosis that is wrong and an exit code of 1 for
  // a write that landed.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-oneplan-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      // no logout is planned: the plugin has no account, so this is one
      // login that (per the stub's own file) leaves two accounts behind
      spawn: () => {
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A }, "msmoli#abc123": { type: "api", key: A } }))
        return { status: 0, stdout: "✓ signed in", stderr: "" }
      },
    })
    assert.equal(code, 0, `the token landed, the run is a success: ${out.join("\n")}`)
    assert.doesNotMatch(out.join("\n"), /旧账号没被登出/, "no logout happened to have failed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an output too large for the buffer is not 'the binary would not run'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-enobufs-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const err = Object.assign(new Error("spawnSync /x ENOBUFS"), { code: "ENOBUFS" })
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ error: err, status: null, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /输出过大/, `should say the output was too large: ${text}`)
    assert.doesNotMatch(text, /用 --magpie 指定完整路径/, "not advice they already followed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--to-preset refuses a token the plugin itself could not send", async () => {
  // tokenOf refuses a key with a space in it: it would go out in an
  // Authorization header. Writing it into the preset would break chat while
  // the tool reported success.
  const bad = "ms-bbbb1111-cccc-2222-ddd d-333344445555"
  const plan = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: bad }], force: true })
  assert.equal(plan.action, "refuse")
  assert.deepEqual(plan.cmds, [])
})

test("--to-plugin refuses a key the plugin itself could not send", async () => {
  // The same rule, the other direction: the plugin refuses a key with
  // anything but visible ASCII in it (tokenOf), so logging one in signs the
  // account in and leaves every check-in saying "令牌内容无法识别" — a
  // success the tool reports for a key that cannot work.
  for (const bad of ["ms-bbbb1111-cccc-2222-ddd d-333344445555", "ms-bbbb1111-cccc-2222-ddd​d-333344445555"]) {
    const plan = planToPlugin({ preset: presetOf(bad), accounts: [], force: false })
    assert.equal(plan.action, "refuse", JSON.stringify(bad))
    assert.deepEqual(plan.cmds, [], "nothing may be logged in")
  }
  // and the ordinary key still goes through
  assert.equal(planToPlugin({ preset: presetOf(A), accounts: [], force: false }).action, "run")
})

test("--help wins over an argument it does not know", () => {
  for (const argv of [["--help", "--nope"], ["--nope", "--help"]]) {
    const r = spawnSync(process.execPath, [bin, ...argv], { encoding: "utf8", timeout: 30_000 })
    assert.equal(r.status, 0, `${argv.join(" ")} should print the page`)
    assert.match(r.stdout, /用法/, `argv ${argv.join(" ")} must show usage`)
  }
})

test("a flag is not a value, for single dashes too", () => {
  // `--dir -x` must not look in a folder named "-x"; -h anywhere means help
  const r = spawnSync(process.execPath, [bin, "--dir", "-x"], { encoding: "utf8", timeout: 30_000 })
  assert.notEqual(r.status, 0)
  assert.match(`${r.stdout}${r.stderr}`, /缺少值/)
  const h = spawnSync(process.execPath, [bin, "--dir", "-h"], { encoding: "utf8", timeout: 30_000 })
  assert.equal(h.status, 0)
  assert.match(h.stdout, /用法/, "-h still means help")
})

test("a long --status list through a pipe arrives whole, not cut at the buffer", () => {
  // process.exit() while stdout is a pipe drops what is still buffered: the
  // tool printed ~130 KB for 4000 accounts and delivered 122993 of 246197
  // bytes, tail (including the ✓ line) gone, exit 0. The exit code is set
  // instead, so the writes drain first.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-pipe-"))
  try {
    const accounts = {}
    for (let i = 0; i < 4000; i++) accounts[`msmoli#${i}`] = { type: "api", key: `ms-key-${String(i).padStart(20, "0")}` }
    // the main account holds the preset's key, so the plan is a noop and the
    // run exits 0 — the long list is what is under test
    accounts.msmoli = { type: "api", key: A }
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(accounts))
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const r = spawnSync(process.execPath, [bin, "--dir", dir, "--status"], { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
    assert.equal(r.status, 0)
    // the last account's row is the tail that used to be dropped
    assert.match(r.stdout, /msmoli#3999/, "the last account's row must arrive")
    // the tail the old code dropped: the plan's own last line
    assert.match(r.stdout.trim().split("\n").at(-1), /以上是计划|无需操作|请显式指定方向/, `the report was cut at the pipe buffer: ${r.stdout.length} bytes`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a rooted XDG_CONFIG_HOME is magpie's folder even before magpie writes into it", () => {
  // magpie keeps its files under $XDG_CONFIG_HOME/magpie whenever that is set
  // and rooted (appdir's installed()). Falling through to ~/.config when the
  // XDG folder is empty reads a folder magpie is not using, and the tool then
  // writes somewhere other than where it read.
  const xdg = pathToFileURL("/xdg").pathname.replace(/\/$/, "")
  const homeBase = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const old = new Set([join(homeBase, ".config", "magpie", "providers.json")])
  assert.equal(
    findConfigDir({ env: { XDG_CONFIG_HOME: xdg }, home: homeBase, os: "linux", exists: (p) => old.has(p) }),
    "",
    "an old ~/.config must not stand in for the folder magpie uses",
  )
  // a relative one is not honoured, exactly as magpie's own rooted() says
  assert.equal(
    findConfigDir({ env: { XDG_CONFIG_HOME: "rel" }, home: homeBase, os: "linux", exists: (p) => old.has(p) }),
    join(homeBase, ".config", "magpie"),
  )
})

test("the key-shape refusal names the provider the user has, not the preset's default id", () => {
  // A vendor found by --from or by its chat host is called "my-ms", not
  // "modelscope". The refusal used to print `magpie provider key modelscope`,
  // which on that machine either names nothing or — worse, when both exist —
  // the wrong provider.
  const p = planToPlugin({ preset: { id: "my-ms", preset: "modelscope", key: "ms-bad key-1234567890" }, accounts: [], force: false })
  assert.equal(p.action, "refuse")
  const text = p.lines.join("\n")
  assert.match(text, /provider key my-ms /)
  assert.doesNotMatch(text, /provider key modelscope /)
})

test("a token pasted into the provider id is masked in the echoed command too", async () => {
  // providers.json is user-edited; a token dropped into the id field passes
  // the id-shape check, and the `$ magpie …` echo printed arguments verbatim
  // while the plan line above it went through show(). That echo was the leak.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-echo-id-"))
  const id = "ms-abcdefghijklmnop"
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id, preset: "modelscope", key: A }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--dry-run"],
      log: (s) => out.push(s),
      spawn: () => {
        throw new Error("--dry-run must not spawn")
      },
    })
    const text = out.join("\n")
    assert.equal(code, 0)
    assert.ok(!text.includes(id), `the echoed command leaked the token-shaped id:\n${text}`)
    assert.ok(text.includes(mask(id)), "the echo shows it masked, as the plan line does")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a folder named providers.json is not magpie's file, as appdir's hasFiles says", () => {
  // appdir.go's hasFiles stats each name and takes only a non-directory. The
  // tool asked exists(), which answers true for a directory — a data folder
  // holding a folder called providers.json then looked like magpie's, and the
  // portable decision went the other way from magpie's own.
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const base = join(home, "Downloads")
  const data = join(base, "data")
  const bin = join(base, "magpie")
  // stat answers only for the fixture; anything else throws, as it does on a
  // real machine for a path that is not there (the exists() fallback then
  // answers, and it must not turn the installed folder into magpie's).
  const dirs = new Set([data, join(data, "providers.json")])
  const stat = (p) => {
    if (!dirs.has(p)) throw new Error("ENOENT")
    return { isDirectory: () => true, isFile: () => false }
  }
  assert.equal(
    findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => dirs.has(p), stat }),
    "",
    "a directory named providers.json is not a magpie file, so the data folder is not taken",
  )
  // and the control: the same name as a regular entry is magpie's file
  const files = new Set([data, join(data, "providers.json")])
  const statFile = (p) => {
    if (p === data) return { isDirectory: () => true, isFile: () => false }
    if (p === join(data, "providers.json")) return { isDirectory: () => false, isFile: () => true }
    throw new Error("ENOENT")
  }
  assert.equal(
    findConfigDir({ env: {}, home, os: "linux", binPath: bin, exists: (p) => files.has(p), stat: statFile }),
    data,
  )
})

test("--to-preset is a no-op when a second account already holds the preset's token", () => {
  // The state a forced replace leaves behind: only msmoli#xxxxxx exists, and
  // its token is the one the preset already has. --to-plugin answers 无需操作
  // for the same pair of files; --to-preset used to refuse with "主账号没有
  // 登录", which reads as "your plugin is signed out".
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli#abc123", token: A }], force: false })
  assert.equal(p.action, "noop")
  assert.match(p.lines.join("\n"), /无需操作/)
})

test("a provider that is ours but has no key is told to fill it in, not to add it again", async () => {
  // providers.json keeps providers without keys (magpie writes its own plugin
  // providers that way). "添加 ModelScope" names one the user already has, and
  // with --from the old message said the chat host was not ModelScope's —
  // about a provider whose chat points at exactly that host.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-keyless-"))
  try {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", chat: "https://api-inference.modelscope.cn/v1", key: "" }] }),
    )
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const run = async (argv) => {
      const out = []
      const code = await main({ argv: [...argv, "--dir", dir, "--magpie", "/nonexistent"], log: (s) => out.push(s), spawn: () => {
        throw new Error("must not run anything without a key")
      } })
      return { code, text: out.join("\n") }
    }
    const bare = await run(["--to-preset"])
    assert.equal(bare.code, 1)
    assert.match(bare.text, /还没有 key/)
    assert.match(bare.text, /provider key modelscope/)
    assert.doesNotMatch(bare.text, /供应商」页添加/)

    const byId = await run(["--from", "modelscope", "--to-preset"])
    assert.equal(byId.code, 1)
    assert.match(byId.text, /还没有 key/)
    assert.match(byId.text, /"modelscope" 在，但还没有 key/, `the message must name the provider: ${byId.text}`)
    assert.doesNotMatch(byId.text, /不是 ModelScope/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--from on a provider that is not ours still says so, not 'no key'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-notours-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "openai", chat: "https://api.openai.com/v1", key: "" }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({ argv: ["--from", "openai", "--dir", dir, "--magpie", "/nonexistent"], log: (s) => out.push(s), spawn: () => 0 })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /不是 ModelScope/)
    assert.match(text, /"openai" 在，但它不是 ModelScope/, `the message must name the provider: ${text}`)
    assert.doesNotMatch(text, /还没有 key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--from insists on the exact host too, not one that contains it", async () => {
  // Round six moved the host check to the parsed hostname because includes()
  // takes "api-inference.modelscope.cn.evil.tld" for ModelScope's own. The
  // default search path was pinned then; --from runs the same test through a
  // separate line of the same function and was left unpinned, so a regression
  // there would pass the suite. Measured: with the substring form, --from
  // relay --to-preset --force answers `provider key relay <the plugin token>`
  // — the user's real credential handed to a stranger's provider.
  const evil = [{ id: "relay", chat: "https://api-inference.modelscope.cn.evil.tld/v1", key: B }]
  assert.deepEqual(presetCandidates(evil, "relay"), [], "a lookalike host is not ours, with --from or without")
  const real = [{ id: "relay", chat: "https://api-inference.modelscope.cn/v1", key: B }]
  assert.deepEqual(presetCandidates(real, "relay").map((p) => p.id), ["relay"])
  // and the whole run refuses the lookalike instead of writing to it
  const dir = mkdtempSync(join(tmpdir(), "msmoli-evil-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: evil }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
    const out = []
    const ran = []
    const code = await main({
      argv: ["--from", "relay", "--to-preset", "--force", "--dir", dir, "--magpie", "/nonexistent/magpie"],
      log: (s) => out.push(s),
      spawn: (bin, argv) => {
        ran.push(argv.join(" "))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(ran.length, 0, `nothing may be written to a lookalike host: ${ran.join(" / ")}`)
    assert.ok(!out.join("\n").includes(A), "the plugin's token must not reach the output either")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two spellings of one folder on a case-folding volume are one folder", () => {
  // The --dir guard runs on sameFolder. On a case-insensitive volume the shell
  // can hand back the same folder under two spellings; realpath keeps the
  // caller's case, so the strings disagree and only the inode settles it. Get
  // that wrong and the guard stops a sync that was fine — the failure the
  // comment above promises not to repeat.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-case-"))
  try {
    const sub = join(dir, "data")
    mkdirSync(sub)
    const flipped = sub.replace(/data$/, "DATA")
    let folds = true
    try {
      if (statSync(flipped).ino !== statSync(sub).ino) folds = false
    } catch {
      folds = false
    }
    if (!folds) return // case-sensitive volume: no second spelling exists to check
    assert.equal(sameFolder(sub, flipped), true, "one folder, two spellings")
    assert.equal(sameFolder(flipped, sub), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 第 18 轮：宽变异扫描在 bin/sync.mjs 上留下 27 个存活位点，以下钉住其中
// 确认真实差异的那些（等价变异的判定见各条注释）

test("a token-shaped run is masked whatever its first character and length", async () => {
  // show() masks token-shaped runs so a key pasted where an id belongs never
  // reaches the terminal whole. The pattern's first character class has to
  // take a digit: every real ModelScope token is ms-<hex>, and a third of them
  // start with 2-9. Narrowing the class to [A-Za-z0-10] left `ms-5df…`
  // printed in full in the message that says there is no such id. The 10
  // is the shortest tail a token can have; 11 lets a 13-character one through.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-maskshape-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    // a 2-9 opening digit (every real token is ms-<hex>, so a third of them
    // start this way) and a short 13-character one
    for (const tok of ["ms-5abc1234-dead-beef-0000-123456789abc", "ms-a1234567890"]) {
      const out = []
      await main({ argv: ["--dir", dir, "--from", tok, "--status", "--magpie", "/nonexistent"], log: (s) => out.push(s) })
      const text = out.join("\n")
      assert.ok(!text.includes(tok), `the token was echoed whole: ${text}`)
    }
    // and the other side of the boundary: the pattern's minimum is ms- plus
    // one plus ten, so a 13-character run is below it and is not a token. Pinned
    // so the boundary cannot drift in either direction — one character wider
    // and a real token of that length would be printed whole.
    const short = "ms-abcdefghij" // 13 characters
    const out = []
    await main({ argv: ["--dir", dir, "--from", short, "--status", "--magpie", "/nonexistent"], log: (s) => out.push(s) })
    assert.ok(out.join("\n").includes(short), `a 13-character run is below the pattern and is shown whole: ${out.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a provider id with digits 2-9 is a legal id", () => {
  // The id-shape check is what keeps `provider key --help <token>` from being
  // read as a flag. Narrowed to [A-Za-z0-10] it refuses `5relay` — a name
  // magpie itself accepts — and the refusal text tells the user their id is
  // not a shape anyone uses.
  for (const id of ["relay2", "5relay", "a8", "my-ms_3", "relay-z", "z9"]) {
    const r = planToPreset({ preset: { id, key: B }, accounts: [{ name: "msmoli", token: A }], force: true })
    assert.equal(r.action, "run", `${id} must be a legal provider id: ${r.lines.join(" / ")}`)
  }
  // and the flag-shaped control is still refused
  const bad = planToPreset({ preset: { id: "--help", key: B }, accounts: [{ name: "msmoli", token: A }], force: true })
  assert.equal(bad.action, "refuse", "a leading dash is still a flag, not an id")
})

test("a second account holding a different token is not 'the same token'", () => {
  // planToPreset's no-op branch is for the state a forced replace leaves: some
  // account already holds the preset's token. Written `a.token || a.token ===
  // preset.key`, any account with any token answers yes, and the tool reports
  // 无需操作 naming an account whose token is not the preset's — while the
  // user's actual plugin sign-in is missing.
  const p = planToPreset({
    preset: { id: "modelscope", preset: "modelscope", key: A },
    accounts: [{ name: "msmoli#abc123", token: B }],
    force: false,
  })
  assert.equal(p.action, "refuse", `a different token is not a match: ${p.lines.join(" / ")}`)
  assert.match(p.lines.join("\n"), /没有登录/)
})

test("a providers.json of the wrong shape is refused as unreadable, not read as 'no preset'", async () => {
  // The two shape guards are what keep the tool from planning on state it
  // cannot see. Fallen through, a top-level array or a providers that is not
  // a list reads as "there is no ModelScope preset" — and the advice becomes
  // "add one", over a file that is there and damaged.
  for (const [content, want] of [
    // the file is named in the message, not just "a file": that is the one
    // thing the user has to go and look at
    ["[1,2,3]", /providers\.json 存在但不是 magpie 写的形状/],
    [JSON.stringify({ providers: { a: 1 } }), /providers\.json 的 providers 不是列表/],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-shape-"))
    try {
      writeFileSync(join(dir, "providers.json"), content)
      const out = []
      const code = await main({ argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"], log: (s) => out.push(s) })
      assert.equal(code, 1)
      const text = out.join("\n")
      assert.match(text, want, `${content}: ${text}`)
      assert.doesNotMatch(text, /没有带 key 的 ModelScope 预设/, "unreadable is not 'not configured'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("two candidates whose ids differ are told to use --from; the same id is named as the reason", async () => {
  // The advice flips with `ids.size === 1`. Inverted, the tool tells a user
  // whose two providers are called differently that --from cannot separate
  // them, and sends them to delete a provider that is not a duplicate.
  const cases = [
    {
      providers: [
        { id: "modelscope", preset: "modelscope", key: A },
        { id: "my-ms", preset: "modelscope", key: B },
      ],
      wantFrom: true,
    },
    {
      providers: [
        { id: "modelscope", preset: "modelscope", key: A },
        { id: "modelscope", chat: "https://api-inference.modelscope.cn/v1", key: B },
      ],
      wantFrom: false,
    },
  ]
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-ids-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: c.providers }))
      const out = []
      const code = await main({ argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"], log: (s) => out.push(s) })
      assert.equal(code, 1)
      const text = out.join("\n")
      assert.match(text, /候选/)
      if (c.wantFrom) {
        assert.match(text, /--from/, "different ids are what --from is for")
        assert.doesNotMatch(text, /同一个 id/, "they are not the same id")
      } else {
        assert.match(text, /同一个 id/, "same id is why --from cannot help")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a provider that is ours by id alone is still ours, and one that is not ours is never named", async () => {
  // oursOf is an OR of three signs (id, preset, chat host). Read as `&&` on
  // any pair, a provider the user added as id=modelscope stops being ours and
  // the tool tells them to add ModelScope over the one they have. And `bare`'s
  // `oursOf && blankKey` read as `||` names any keyless provider — an OpenAI
  // one — as "内置侧的 openai 在，但还没有 key".
  const ours = mkdtempSync(join(tmpdir(), "msmoli-ours-"))
  const notOurs = mkdtempSync(join(tmpdir(), "msmoli-notours2-"))
  try {
    writeFileSync(join(ours, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", chat: "https://example.com/v1", key: "" }] }))
    const a = []
    await main({ argv: ["--dir", ours, "--status", "--magpie", "/nonexistent"], log: (s) => a.push(s) })
    assert.match(a.join("\n"), /还没有 key/, `an id-only match is still ours: ${a.join("\n")}`)

    writeFileSync(join(notOurs, "providers.json"), JSON.stringify({ providers: [{ id: "openai", chat: "https://api.openai.com/v1", key: "" }] }))
    const b = []
    await main({ argv: ["--dir", notOurs, "--status", "--magpie", "/nonexistent"], log: (s) => b.push(s) })
    const text = b.join("\n")
    assert.match(text, /没有带 key 的 ModelScope 预设/, `a stranger's keyless provider is not ours: ${text}`)
    assert.doesNotMatch(text, /openai 在，但还没有 key/, "the tool must not name a provider that is not ModelScope's")
  } finally {
    rmSync(ours, { recursive: true, force: true })
    rmSync(notOurs, { recursive: true, force: true })
  }
})

test("a key that is not a string does not take the check-in down with it", async () => {
  // providers.json is user-edited and magpie writes numbers as numbers. The
  // blankKey guard is `typeof key === "string" && key.trim()`; `!==` there
  // calls .trim() on the number and the run dies with
  // "p.key.trim is not a function".
  const dir = mkdtempSync(join(tmpdir(), "msmoli-numkey-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "my-ms", chat: "https://api-inference.modelscope.cn/v1", key: 123 }] }))
    const out = []
    const code = await main({ argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"], log: (s) => out.push(s) })
    const text = out.join("\n")
    assert.doesNotMatch(text, /is not a function/, "an internal error reached the user")
    assert.equal(code, 1)
    assert.match(text, /还没有 key/, `a numeric key is no key: ${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a --to-plugin --force that lands one account is a success, not a second account", async () => {
  // The read-back counts accounts only when the plan had more than one step
  // *and* the file now holds more than one — both, because either alone is
  // normal. Read as `||`, every successful forced sync reports "回读发现插件
  // 现在有 1 个账号" and exits 1.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-readback-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: B }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (bin, argv) => {
        if (argv[0] === "plugin" && argv[1] === "logout") writeFileSync(join(dir, "plugin-auth.json"), "{}")
        if (argv[0] === "plugin" && argv[1] === "login") writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 0, `a one-account result is the normal one: ${out.join("\n")}`)
    assert.doesNotMatch(out.join("\n"), /个账号/, "one account is not a second account")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a rooted XDG path is rooted on every spelling: drive-letter on POSIX, UNC on Windows", () => {
  // rooted() takes a drive-letter path on every host and a \\ or / prefixed
  // one on Windows. Both are inherited from appdir's installed(): falling
  // through to ~/.config when XDG points elsewhere reads a folder magpie is
  // not using. Neither spelling was pinned — the existing test drives only
  // /xdg and "rel".
  const want = (base) => join(base, "magpie")
  const on = (xdg, os, base) =>
    findConfigDir({ env: { XDG_CONFIG_HOME: xdg }, home: os === "win32" ? "C:\\u" : "/h", os, exists: (p) => p === join(base, "providers.json") })
  // C:\ on a POSIX host is still a path someone named, not a name to look up
  assert.equal(on("C:\\x", "linux", want("C:\\x")), want("C:\\x"), "a drive-letter XDG is rooted on POSIX")
  // UNC and slash-rooted on Windows
  assert.equal(on("\\\\srv\\share", "win32", want("\\\\srv\\share")), want("\\\\srv\\share"), "a UNC XDG is rooted on Windows")
  assert.equal(on("/srv/xdg", "win32", want("/srv/xdg")), want("/srv/xdg"), "a slash-rooted XDG is rooted on Windows")
  // and a relative one is not rooted anywhere
  assert.equal(on("rel", "win32", join("C:\\u", ".config", "magpie")), join("C:\\u", ".config", "magpie"), "a relative XDG is ignored on Windows too")
  // every drive letter, not just the ones an example happens to use: z: is as
  // much a drive as C:, and a class that stops at "y" reads it as a relative
  // path and falls through to ~/.config. Windows drive letters are
  // case-insensitive, so both spellings are real.
  for (const drive of ["Z:", "z:", "c:", "D:"]) {
    assert.equal(on(`${drive}\\x`, "linux", want(`${drive}\\x`)), want(`${drive}\\x`), `${drive} is a rooted path`)
  }
})

test("a data folder spelled with a trailing separator is still the shared folder", () => {
  // fold strips trailing separators before comparing, because `home` can
  // arrive spelled "/Users/me/" the way a shell completes it. Without the
  // strip, /Users/me/ is not equal to /Users/me, the shared-folder rule says
  // "not shared", and an empty data folder there is taken as magpie's — and
  // the write lands somewhere magpie never looks.
  // The executable has to sit directly in home for this: join() irons the
  // trailing slash out of any path it builds, so a data folder one level down
  // is spelled the same either way. The fixture is spelled with the platform's
  // own separator, the way dirname(exe) spells it, or the two would differ on
  // Windows for a reason that has nothing to do with this rule.
  const home = join(tmpdir(), "msmoli-fold-fixture")
  const data = join(home, "data")
  const installed = join(home, ".config", "magpie")
  const files = new Set([data, join(data, "providers.json"), join(installed, "providers.json")])
  assert.equal(
    findConfigDir({ env: {}, home: home + sep, os: "linux", binPath: join(home, "magpie"), exists: (p) => files.has(p) }),
    installed,
    "a home with a trailing separator names the same shared folder",
  )
})

test("the shared folders are the platform's own: /Applications only on a Mac", () => {
  // sharedFolders decides whether a data folder beside the executable is
  // magpie's portable folder or every-app-for-itself territory. Fliping the
  // darwin test puts /Applications and ~/Applications in Linux's list: a
  // portable-looking /Applications/data then stops being magpie's, and on a
  // Mac the same folder starts being treated as shared.
  // The exists() fixtures and the expectations are built with join(): on
  // Windows the probe asks for "\\Applications\\data", and a POSIX literal
  // there would answer "no data folder" — red on a platform this rule does
  // not differ on. binPath stays the literal "/Applications/magpie" on
  // purpose: dirname() keeps the leading "/", which is the very spelling the
  // rule itself compares against, and join() would iron it into "\\".
  const drive = (os) =>
    findConfigDir({
      env: {},
      home: "/h",
      os,
      binPath: "/Applications/magpie",
      exists: (p) => p === join("/Applications", "data"),
      stat: () => ({ isFile: () => false }),
    })
  assert.equal(drive("linux"), join("/Applications", "data"), "on Linux /Applications is just a folder")
  assert.equal(drive("darwin"), "", "on a Mac /Applications is shared, so an empty data there is not magpie's")
  // ~/Applications is the same rule one level down, and needs its own drive:
  // a portable magpie living there is somebody's home folder on Linux.
  const underHome = (os) =>
    findConfigDir({
      env: {},
      home: "/h",
      os,
      binPath: join("/h", "Applications", "magpie"),
      exists: (p) => p === join("/h", "Applications", "data"),
      stat: () => ({ isFile: () => false }),
    })
  assert.equal(underHome("linux"), join("/h", "Applications", "data"), "on Linux ~/Applications is just a folder")
  assert.equal(underHome("darwin"), "", "on a Mac ~/Applications is shared too")
})

test("a data folder on the Desktop or in Documents is as much a stranger's as one in Downloads", () => {
  // sharedFolders is the list appdir.go's #989 calls out: Downloads, Desktop
  // and Documents are where a user unpacks an archive, and an empty "data"
  // there is as likely the user's own. Only Downloads had a test; with the
  // other two misspelled, a portable-looking folder on the Desktop is taken
  // as magpie's and the write lands where magpie never looks.
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const installed = join(home, ".config", "magpie")
  for (const name of ["Downloads", "Desktop", "Documents"]) {
    const base = join(home, name)
    const data = join(base, "data")
    const files = new Set([data, join(data, "providers.json"), join(installed, "providers.json")])
    assert.equal(
      findConfigDir({ env: {}, home, os: "linux", binPath: join(base, "magpie"), exists: (p) => files.has(p) }),
      installed,
      `a data folder in ~/${name} is not magpie's when the installed folder has files`,
    )
    // and with nothing installed, the same data folder is the portable one
    const only = new Set([data, join(data, "providers.json")])
    assert.equal(
      findConfigDir({ env: {}, home, os: "linux", binPath: join(base, "magpie"), exists: (p) => only.has(p) }),
      data,
      `with nothing installed, ~/${name}/data is the portable folder`,
    )
  }
})

test("the shared-folder rule looks in the XDG folder when one is set", () => {
  // installedDir, not findConfigDir's own return: the same "where does an
  // installed magpie keep its files" question, answered with XDG_CONFIG_HOME
  // when it is rooted. Misspelled there, the rule finds an empty folder and
  // takes a data folder in Downloads as portable — and the tool then writes
  // to a folder magpie is not using.
  const home = pathToFileURL("/h").pathname.replace(/\/$/, "")
  const xdg = pathToFileURL("/xdg").pathname.replace(/\/$/, "")
  const base = join(home, "Downloads")
  const data = join(base, "data")
  const installed = join(xdg, "magpie")
  const files = new Set([data, join(data, "providers.json"), join(installed, "providers.json")])
  assert.equal(
    findConfigDir({ env: { XDG_CONFIG_HOME: xdg }, home, os: "linux", binPath: join(base, "magpie"), exists: (p) => files.has(p) }),
    installed,
    "the XDG folder is the installed one; ~/Downloads/data is not magpie's",
  )
})

// ── 第二十四轮：操作符与集合判断 ─────────────────────────────────────────

test("the preset direction's read-back fails when the list it reads is empty", async () => {
  // `every` on an empty list is vacuously true. A write that lands but leaves
  // providers.json without a candidate — an emptied list, a provider that was
  // renamed away — then passed the read-back and printed ✓ 完成 with nothing
  // written, the one outcome this check exists to prevent.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-emptyback-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        // exits 0, and the write it "made" leaves no candidate to compare
        writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [] }))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1, "an empty read-back is not a success")
    const text = out.join("\n")
    assert.match(text, /回读|没找到/)
    assert.doesNotMatch(text, /✓ 完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a providers list with a null entry is read past, not tripped over", async () => {
  // providers.json is another program's file and can arrive half-written: a
  // null in the list is a row that is not a provider. presetCandidates and
  // main's own advice both walk it; read as `p.id` / `p.key` the null throws,
  // and the tool dies with a stack trace where it had an answer to give.
  assert.deepEqual(presetCandidates([null, presetOf(A)]), [presetOf(A)])
  assert.deepEqual(presetCandidates([null, presetOf(A)], "modelscope"), [presetOf(A)])
  assert.deepEqual(pluginAccounts({ msmoli: null, "msmoli#x": { type: "api", key: B } }), [
    { name: "msmoli", token: "" },
    { name: "msmoli#x", token: B },
  ])

  // and through main: a provider of ours that has no key, next to a null row
  const dir = mkdtempSync(join(tmpdir(), "msmoli-nullrow-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [null, { id: "modelscope", preset: "modelscope" }] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /还没有 key/, "the advice should still name the provider that is there")

    // --from looks for the id in the same list
    const out2 = []
    const code2 = await main({
      argv: ["--dir", dir, "--to-plugin", "--from", "nope", "--magpie", "/nonexistent"],
      log: (s) => out2.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code2, 1)
    assert.match(out2.join("\n"), /没有 id 为 "nope" 的 provider/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a plugin-only install (no providers.json yet) is told what to add, not left with a stack trace", async () => {
  // a fresh magpie that has only ever signed in a plugin has no providers.json.
  // looksLikeMagpie accepts any one of the three files, so this folder is a
  // magpie folder — and `providersRaw?.providers` is what turns "the file is
  // not there" into "there is nothing configured". Read as `providersRaw
  // .providers`, the missing file is a TypeError before any advice is printed.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-onlyplugin-"))
  try {
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--status"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /没有带 key 的 ModelScope 预设|provider add/)
    assert.doesNotMatch(text, /Cannot read properties/, "a missing file is not a crash")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a providers.json that disappears during the write is 'not found', not a crash", async () => {
  // the write is magpie's: it can replace the file, or fail and leave nothing
  // (a half-done .bak restore). The preset read-back reads it again, and a
  // file that is no longer there is "the key is not in it" — the same answer
  // an empty list gets. Read as `raw.providers`, the missing file is a
  // TypeError from inside main, past every message the user could act on.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-gone-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        rmSync(join(dir, "providers.json"))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /回读|没找到/)
    assert.doesNotMatch(text, /Cannot read properties/, "a file that is gone is not a crash")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a relative XDG_CONFIG_HOME is not rooted just because it holds a separator", () => {
  // rooted() takes a drive-letter path on any host, and on win32 also a path
  // that *begins* with a separator. Read as `includes`, "data\\magpie" and
  // "data/magpie" — an XDG_CONFIG_HOME written as a relative path, which
  // magpie itself ignores — are taken for rooted, and the tool reads a folder
  // magpie never writes while reporting it as the config dir.
  for (const rel of ["data\\magpie", "data/magpie"]) {
    const got = findConfigDir({
      env: { XDG_CONFIG_HOME: rel },
      home: "C:\\Users\\q",
      os: "win32",
      exists: (p) => p.includes("magpie"),
      real: (p) => p,
      stat: () => ({ isFile: () => false, isDirectory: () => false, ino: 1, dev: 1 }),
    })
    // the wrong answer is exactly join(rel, "magpie") — naming it, rather
    // than testing for a prefix, keeps the assertion the same on Windows
    assert.notEqual(got, join(rel, "magpie"), `${JSON.stringify(rel)} is relative and must be ignored: ${got}`)
  }
  // the rooted spellings that do count still count
  const rooted = findConfigDir({
    env: { XDG_CONFIG_HOME: "\\xdg" },
    home: "C:\\Users\\q",
    os: "win32",
    exists: (p) => p.includes("magpie"),
    real: (p) => p,
    stat: () => ({ isFile: () => false, isDirectory: () => false, ino: 1, dev: 1 }),
  })
  assert.equal(rooted, join("\\xdg", "magpie"), "a path that begins with a separator is rooted")
})

test("a mount folder that merely starts with the AppImage's is not inside it", () => {
  // within() is a folder test, not a substring test: /tmp/.mount_X and
  // /tmp/.mount_XY are two different mounts, and reading the second as inside
  // the first sends a magpie running from its own folder to a data folder
  // beside somebody else's AppImage.
  const apps = pathToFileURL("/opt/apps").pathname.replace(/\/$/, "")
  const img = join(apps, "magpie.AppImage")
  const mount = join(pathToFileURL("/tmp").pathname.replace(/\/$/, ""), ".mount_X")
  const sibling = mount + "Y"
  const files = new Set([join(sibling, "data"), join(sibling, "data", "providers.json")])
  const got = findConfigDir({
    env: { APPIMAGE: img, APPDIR: mount },
    home: "/h",
    os: "linux",
    binPath: join(sibling, "magpie"),
    real: (p) => p,
    exists: (p) => files.has(p),
    stat: (p) => ({ isFile: () => false, isDirectory: () => p.endsWith("data"), ino: 1, dev: 1 }),
  })
  assert.equal(got, join(sibling, "data"), "its own folder's data, not the AppImage's")

  // the other shape of a substring test: the mount's name somewhere in the
  // middle of the path, with the separator too, so neither `includes(dir)`
  // nor `includes(dir + sep)` can tell it from being inside
  const under = pathToFileURL("/home/tmp").pathname.replace(/\/$/, "")
  const nested = join(under, ".mount_X")
  const nestedFiles = new Set([join(nested, "data"), join(nested, "data", "providers.json")])
  const got2 = findConfigDir({
    env: { APPIMAGE: img, APPDIR: mount },
    home: "/h",
    os: "linux",
    binPath: join(nested, "magpie"),
    real: (p) => p,
    exists: (p) => nestedFiles.has(p),
    stat: (p) => ({ isFile: () => false, isDirectory: () => p.endsWith("data"), ino: 1, dev: 1 }),
  })
  assert.equal(got2, join(nested, "data"), "a folder named like the mount, elsewhere, is not inside it")
})

test("the .app ending is read whatever its case", () => {
  // a Mac volume that folds case lets the bundle be spelled MAGPIE.APP, and
  // the .app test decides which folder is the base for a portable install.
  // Without the /i the bundle is not recognised, and the data folder is
  // looked for inside Contents/MacOS instead of beside the bundle — where
  // writing one would break its signature.
  const data = join("/Applications", "data")
  const got = findConfigDir({
    env: {},
    home: "/Users/q",
    os: "darwin",
    exists: () => false,
    binPath: "/Applications/MAGPIE.APP/Contents/MacOS/magpie",
    real: (p) => p,
    stat: (p) => {
      // the installed folder holds none of magpie's files, so the bundle's
      // own folder is magpie's; spelled with join() so it holds on Windows too
      if (p.includes(join(".config", "magpie"))) throw new Error("ENOENT")
      return { isFile: () => false, isDirectory: () => p.endsWith("data"), ino: 1, dev: 1 }
    },
  })
  assert.equal(got, data, "the bundle's own folder, not the folder inside it")
})

test("a shared folder is recognised whatever its case", () => {
  // shared() compares the base against /Applications, ~/Downloads and the
  // rest after folding both to lower case — a case-insensitive volume gives
  // the same folder either spelling. Without the fold the comparison misses,
  // the shared-folder rule never fires, and a data folder that belongs to
  // another app is read as magpie's.
  const got = findConfigDir({
    env: {},
    home: "/Users/q",
    os: "darwin",
    exists: (p) => p.endsWith("magpie") || p.endsWith("providers.json"),
    binPath: "/applications/Magpie.app/Contents/MacOS/magpie",
    real: (p) => p,
    stat: (p) => ({ isFile: () => false, isDirectory: () => p.endsWith("data"), ino: 1, dev: 1 }),
  })
  assert.equal(got, join("/Users/q", ".config", "magpie"), "a shared folder in another case is still shared")
})

test("every token-shaped run in the plan is masked, not only the first", () => {
  // show()'s tokenShaped carries /g because the mask is a replace. Without it
  // a provider id that happens to carry two token-shaped runs prints the
  // second one whole — and a poisoned providers.json can put anything there.
  const t1 = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const t2 = "ms-zzzz9999-yyyy-8888-xxxx-777766665555"
  const plan = planToPlugin({ preset: { key: A, id: `${t1} ${t2}` }, accounts: [], force: false })
  const text = plan.lines.join("\n")
  assert.ok(!text.includes(t1), `the first token printed whole:\n${text}`)
  assert.ok(!text.includes(t2), `the second token printed whole:\n${text}`)
  assert.match(text, /ms-z…5555/, `the second should be masked:\n${text}`)
})

test("the hostname comparison folds case for every scheme, not only the ones URL folds", () => {
  // new URL() lower-cases the host of a special scheme (http, https, ws, ftp,
  // file) but leaves a non-special one as written; hostOf's .toLowerCase() is
  // what makes the comparison hold for both. For http and https — every chat
  // URL a real provider carries — the parser has already folded the host, so
  // the call is invisible there; this is the one shape that shows it working.
  // A provider it stops recognising is one the tool then tells the user to
  // add, so the difference is the wrong advice, not a silent no-op.
  const mixed = presetCandidates([{ id: "mine", chat: "https://Api-Inference.ModelScope.Cn/v1", key: A }])
  assert.equal(mixed.length, 1, "a special scheme is folded by the URL parser itself")
  const upper = presetCandidates([{ id: "mine", chat: "foo://API-INFERENCE.MODELSCOPE.CN/v1", key: A }])
  assert.equal(upper.length, 1, "a non-special scheme keeps its case, so the fold is hostOf's own")
})

test("a key of only spaces is not a key", () => {
  // keyedOf trims before it tests: a key pasted with a trailing newline is the
  // same key, and a key of nothing but spaces is no key at all. Read without
  // the trim, a providers.json entry with "   " for its key counts as signed
  // in, and the tool offers to sync a token that cannot work.
  assert.deepEqual(presetCandidates([{ id: "modelscope", preset: "modelscope", key: "   " }]), [])
})

test("an account key that merely contains msmoli# is not one of ours", () => {
  // pluginAccounts takes the main key and msmoli#…; anything else in the file
  // belongs to another provider. Read as `includes`, "xmsmoli#1" is taken for
  // a second account of this plugin — and a --force run then counts a solvable
  // state as ambiguous.
  const auth = { "xmsmoli#1": { type: "api", key: B }, msmoli: { type: "api", key: A }, "msmoli#2": { type: "api", key: B } }
  assert.deepEqual(pluginAccounts(auth).map((a) => a.name), ["msmoli", "msmoli#2"])
})

test("a token read out of plugin-auth.json loses the padding around it", () => {
  // a token pasted with a trailing newline is the same token; the key is
  // trimmed where it is read so every comparison and every read-back below
  // sees the one spelling. Read untrimmed, the same credential compares
  // unequal to itself and the read-back reports a write that did land.
  const [acct] = pluginAccounts({ msmoli: { type: "api", key: ` ${A}\n` } })
  assert.equal(acct.token, A)
})

test("a child's output is trimmed at its edges before it is echoed or quoted", async () => {
  // run() trims the combined output once, and echoes only the lines with
  // something in them. Without the outer trim a padded answer keeps its
  // padding in the log and in the error, and a leading blank line pushes the
  // line the user needs out of the three the error quotes.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-outtrim-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "  hello  \n", stderr: "" }),
    })
    assert.ok(out.includes("  hello"), `the echoed line is trimmed: ${JSON.stringify(out)}`)

    const failOut = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => failOut.push(s),
      spawn: () => ({ status: 1, stdout: "", stderr: "\n  \nboom\n" }),
    })
    const text = failOut.join("\n")
    assert.match(text, /：\nboom$/, `the quoted failure is trimmed at both ends: ${JSON.stringify(text)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a line of only spaces in the child's output is not echoed as a line", async () => {
  // the echo skips a line with nothing in it; read as `if (line)` only a
  // genuinely empty one is skipped, and a padded line prints as the indent
  // plus the padding — on a terminal that reads as a blank line in the middle
  // of magpie's answer, with no way to tell it from a step that said nothing.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-blankline-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "alpha\n\n   \nbeta\n", stderr: "" }),
    })
    // the child's lines come after the "$ magpie …" echo and before the
    // read-back's refusal; the report above them also indents by two, so only
    // that window says what the echo did
    const at = out.findIndex((l) => l.startsWith("$ magpie"))
    assert.ok(at > 0, `the command echo should be there: ${JSON.stringify(out)}`)
    const echoed = []
    for (const line of out.slice(at + 1)) {
      if (line.startsWith("✗")) break
      echoed.push(line)
    }
    assert.deepEqual(echoed, ["  alpha", "  beta"], `only the lines with text are echoed: ${JSON.stringify(out)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 第二十六轮：语句级宽扫 ──────────────────────────────────────────────
// 与 plugin.test.mjs 同一轮：整条语句被掏空/删掉。下面是探针测出真实差异的
// 位点；等价变异记录在各条注释里。

test("sameFolder's resolved match decides before the volume is asked", () => {
  // 两边 realpath 之后字符串相等时，第一条守卫直接答 true，根本不去 stat。
  // 掏空它，每一对相等的路径都落到 inode 比较；报 ino=0 的卷（exFAT、部分
  // SMB）上没有身份可比，同一个文件夹会被判成两个——正是 --dir 守卫承诺
  // 不再犯的那个错。
  // 两处拼写都解析成同一串：identity real 配一条把 "X/." 折成 "X" 的规则，
  // 平台无关——真机上的 /tmp 与 /private/tmp 是同一形状（macOS 才有）。
  const real = (p) => (p.endsWith("/.") ? p.slice(0, -2) : p)
  const statThrows = () => {
    throw new Error("EACCES")
  }
  assert.equal(sameFolder("/a", "/a", real, statThrows), true, "resolved twins need no inode")
  assert.equal(sameFolder("/a", "/a/.", real, statThrows), true, "two spellings that resolve equal are one folder")
  const statZero = () => ({ ino: 0, dev: 1 })
  assert.equal(sameFolder("/a", "/a", real, statZero), true, "an ino=0 volume still has one folder under one spelling")
})

test("a folder the volume cannot resolve is never another folder's match", () => {
  // 第二条守卫在任一边解析失败（""）时直接答 false。掏空它，"" 也会被送去
  // stat；注入的 stat 若对空路径也给一个身份，两个无从解析的路径就被当成
  // 同一个文件夹——工具会往 magpie 从未建过的目录里写。
  const real = (p) => (p.startsWith("/nope") ? "" : p)
  const stat = () => ({ ino: 42, dev: 1 })
  assert.equal(sameFolder("/nope", "/tmp", real, stat), false, "missing vs real is not one folder")
  assert.equal(sameFolder("/tmp", "/nope", real, stat), false)
  assert.equal(sameFolder("/nope", "/nope2", real, stat), false, "two unresolvable paths are never one")
})

test("isMain's URL match decides before the volume is asked", () => {
  // 解析后的入口与 import.meta.url 逐字相等时直接答 true，不问 stat。掏空它，
  // 一个 stat 抛错的卷（权限墙、掉线的共享）会让 catch 把「这是入口」翻成
  // 「不是」——整个 sync.mjs 静默跳过，不打印任何东西、退出码 0，用户以为
  // 同步成功了。
  const real = (p) => p
  // 用 join 与 pathToFileURL 自己造入口与它的 URL：Windows 上盘符与分隔符
  // 都不同，写死的 "/x/bin/sync.mjs" 在那边根本对不上
  const entry = join("x", "bin", "sync.mjs")
  const self = pathToFileURL(entry).href
  const statZero = () => ({ ino: 0, dev: 1 })
  assert.equal(isMain(entry, self, statZero, real), true, "the entry's own URL is main with no inode")
  assert.equal(isMain(join("x", "bin", "other.mjs"), self, statZero, real), false, "a different file is still not main")
  const statThrows = () => {
    throw new Error("EACCES")
  }
  assert.equal(isMain(entry, self, statThrows, real), true, "a stat that throws must not flip a URL match")
})

test("a chat that is not a string does not make a provider ours", () => {
  // hostOf 先要求 chat 是字符串再交给 new URL。掏空这条守卫后，new URL 会先
  // 把数组 / String 对象转成字符串：["https://api-inference.modelscope.cn/v1"]
  // 转出来正好是那个地址，于是一个 chat 字段形状不对的 provider 被当成内置的
  // ModelScope 预设——--to-plugin 会把它的 key 当成 ms 令牌登录给插件。
  assert.deepEqual(presetCandidates([{ id: "evil", key: A, chat: ["https://api-inference.modelscope.cn/v1"] }]), [])
  assert.deepEqual(
    presetCandidates([{ id: "evil", key: A, chat: new String("https://api-inference.modelscope.cn/v1") }]),
    [],
  )
  assert.equal(
    presetCandidates([{ id: "evil", key: A, chat: "https://api-inference.modelscope.cn/v1" }]).length,
    1,
    "a real string is still ours",
  )
})

test("planToPlugin's refusal spells out both sides, not one", () => {
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: false })
  assert.equal(p.action, "refuse")
  assert.deepEqual(p.lines, [
    `  插件现有：msmoli（${mask(B)}）`,
    `  内置预设：modelscope（${mask(A)}）`,
    `✗ 两边令牌不同，未做改动。`,
    `  直接 login 会新增第二个账号（宿主按令牌分账号），logout 会登出该 provider 的全部账号，`,
    `  两个默认动作都不是你要的。确认要换成内置那把，加 --force 重跑。`,
  ])
})

test("planToPlugin refuses a multi-account force with the reason --force cannot help", () => {
  const p = planToPlugin({
    preset: presetOf(A),
    accounts: [
      { name: "msmoli", token: B },
      { name: "msmoli#abc123", token: "ms-cccc1111-dddd-2222-eeee-333344445555" },
    ],
    force: true,
  })
  assert.equal(p.action, "refuse")
  assert.deepEqual(p.lines, [
    `  插件现有：msmoli（${mask(B)}）、msmoli#abc123（ms-c…5555）`,
    `  内置预设：modelscope（${mask(A)}）`,
    `✗ 插件有 2 个账号，--force 不适用：替换要先 logout，那会一次登出全部账号。`,
    `  请先在 magpie 里删掉多余账号，或手动执行。`,
  ])
})

test("planToPlugin's forced replace says what it will log out and redo", () => {
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true })
  assert.equal(p.action, "run")
  assert.deepEqual(p.lines, [
    `  插件现有：msmoli（${mask(B)}）`,
    `  内置预设：modelscope（${mask(A)}）`,
    `→ 将先 logout（登出 msmoli）再 login 内置那把。当天已签到的记录会重来，昵称下次签到时写回。`,
  ])
})

test("planToPlugin refuses a preset key the plugin could not send", () => {
  const BAD = "ms-bad key 0000-0000-0000-000000000000"
  const p = planToPlugin({ preset: presetOf(BAD), accounts: [], force: false })
  assert.equal(p.action, "refuse")
  assert.deepEqual(p.lines, [
    `✗ 内置预设的 key 含空格、换行或非 ASCII 字符，插件发不出去，不登录。`,
    `  先修好内置那边的 key（magpie provider key modelscope <key>）。`,
  ])
})

test("planToPreset's refusals name the account and where the preset comes from", () => {
  const noMain = planToPreset({ preset: presetOf(A), accounts: [], force: false })
  assert.equal(noMain.action, "refuse")
  assert.deepEqual(noMain.lines, [
    `✗ 插件主账号（msmoli）没有登录，没有可同步的令牌。`,
    `  先用 magpie plugin login msmoli 登录，或用 --to-plugin 从内置预设同步。`,
  ])
  // main() 先把缺预设拦下，但 planToPreset 是导出的，direct 调用不能少这两行
  const noPreset = planToPreset({ preset: null, accounts: [{ name: "msmoli", token: A }], force: false })
  assert.equal(noPreset.action, "refuse")
  assert.deepEqual(noPreset.lines, [
    `✗ 内置还没有 ModelScope 预设，没有可写的地方。`,
    `  要加的话：magpie provider add modelscope <key>（工具不代建 provider）。`,
  ])
})

test("planToPreset says there is nothing to do when both sides already match", () => {
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: A }], force: false })
  assert.equal(p.action, "noop")
  assert.deepEqual(p.lines, [`✓ 内置预设已用同一把令牌（${mask(A)}），无需操作。`])
})

test("planToPreset's replace plan names both tokens and the command", () => {
  const noForce = planToPreset({ preset: presetOf(B), accounts: [{ name: "msmoli", token: A }], force: false })
  assert.equal(noForce.action, "refuse")
  assert.deepEqual(noForce.lines, [
    `  插件主账号：msmoli（${mask(A)}）`,
    `  内置预设：modelscope，现有 key（${mask(B)}）会被整条替换。`,
    `✗ 内置这把 key 是聊天请求正在用的，替换会让那边跟着换。确认的话加 --force 重跑。`,
  ])
  const forced = planToPreset({ preset: presetOf(B), accounts: [{ name: "msmoli", token: A }], force: true })
  assert.equal(forced.action, "run")
  assert.deepEqual(forced.lines, [
    `  插件主账号：msmoli（${mask(A)}）`,
    `  内置预设：modelscope，现有 key（${mask(B)}）会被整条替换。`,
    `→ 将执行 magpie provider key modelscope（令牌是该命令的参数，进程列表里短暂可见）。`,
  ])
})

test("planToPreset refuses a plugin token the CLI could not send", () => {
  const BAD = "ms-bad key 0000-0000-0000-000000000000"
  const p = planToPreset({ preset: presetOf(B), accounts: [{ name: "msmoli", token: BAD }], force: true })
  assert.equal(p.action, "refuse")
  assert.deepEqual(p.lines, [
    `  插件主账号：msmoli（${mask(BAD)}）`,
    `  内置预设：modelscope，现有 key（${mask(B)}）会被整条替换。`,
    `✗ 插件里那把令牌含空格、换行或非 ASCII 字符，发不出去，不写进内置预设。`,
    `  先修好插件那边的登录（magpie plugin login msmoli）。`,
  ])
})

test("a file that is there but unreadable is refused with the don't-guess line", async () => {
  // 每个「存在但读不出来」的分支都是两行：哪一行文件坏了，以及「别猜它的
  // 内容」。只留第一行，用户会自己去猜——而猜错就是覆盖一份可能还救得回来
  // 的状态。四种形状共用第二行，各自走各自的守卫。
  const cases = [
    { name: "providers.json 不解析", prov: "{ not json", auth: JSON.stringify({ msmoli: { type: "api", key: B } }) },
    { name: "plugin-auth.json 不解析", prov: JSON.stringify({ providers: [presetOf(A)] }), auth: "{ broken" },
    { name: "providers.json 不是对象", prov: "[]", auth: JSON.stringify({ msmoli: { type: "api", key: B } }) },
    { name: "providers 不是列表", prov: JSON.stringify({ providers: {} }), auth: JSON.stringify({ msmoli: { type: "api", key: B } }) },
  ]
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-unreadable-"))
    try {
      writeFileSync(join(dir, "providers.json"), c.prov)
      writeFileSync(join(dir, "plugin-auth.json"), c.auth)
      const out = []
      const code = await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          throw new Error(`nothing may run on an unreadable file: ${c.name}`)
        },
      })
      assert.equal(code, 1, c.name)
      // 报头（配置目录）在前面，拒绝自己是最后两行
      const tail = out.slice(-2)
      assert.equal(tail.length, 2, `${c.name}: both lines, got ${JSON.stringify(out)}`)
      assert.match(tail[0], /存在但读不出来|存在但|不是列表/, `${c.name}: the first line says which file and why`)
      assert.match(tail[1], /不猜它的内容：先确认 magpie 正常，或备份后重试。/, `${c.name}: the second line says not to guess`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("the report names the folder it read and both sides of the pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-hdr-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 0)
    assert.equal(out[0], `magpie 配置目录：${dir}`, "the first line names the folder it read")
    assert.equal(out[1], `  内置 ModelScope：modelscope（${mask(A)}）`, "the preset side is named with its token's ends")
    assert.equal(out[2], `  签到插件 msmoli：msmoli（${mask(A)}）`, "the plugin side is named with its token's ends")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("more than one candidate refuses with the count and the way out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msmoli-cands-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A), presetOf(B)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /✗ 内置侧有 2 个候选（modelscope、modelscope），不确定用哪个。/, `the count and the doubt are one line: ${text}`)
    assert.match(
      text,
      /它们用的是同一个 id（modelscope），--from 也分不开；请在 magpie 里删掉多余的那个 provider。/,
      `same-id candidates say --from cannot split them: ${text}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--from and a bare run each say what to do next", async () => {
  const run = async (providers, argv) => {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-from-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
      const out = []
      const code = await main({
        argv: ["--dir", dir, "--status", "--magpie", "/nonexistent", ...argv],
        log: (s) => out.push(s),
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      })
      return { code, text: out.join("\n") }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // --from 指向一个我们自己的、但还没有 key 的 provider
  let r = await run([{ id: "modelscope", preset: "modelscope" }], ["--from", "modelscope"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ "modelscope" 在，但还没有 key，没有可同步的令牌。/)
  assert.match(r.text, /  用 magpie provider key modelscope <key> 写入。/, "and names the command that fills it in")
  // --from 指向一个存在但不是我们的 provider
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], ["--from", "openai"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ "openai" 在，但它不是 ModelScope：chat 不指向 api-inference\.modelscope\.cn，id\/preset 也不是 modelscope。/)
  assert.match(r.text, /  这个工具只同步内置的 ModelScope 预设与插件登录态之间的令牌。/, "and says what the tool does sync")
  // --from 什么都没匹配到
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], ["--from", "typo"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ 内置侧没有 id 为 "typo" 的 provider。/)
  assert.match(r.text, /  用 --status 看现有的，或先 magpie provider add typo <key>。/)
  // 不带 --from，内置侧一个我们的都没有
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], [])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ 内置侧没有带 key 的 ModelScope 预设。/)
  assert.match(r.text, /  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add modelscope <key>。/)
})

test("--dir and --magpie pointing at different folders names both", async () => {
  // 读一个目录、写另一个目录，正是这条守卫存在的理由；三行里的每一行都是
  // 用户对齐两个参数所需要的信息：读的是哪个、magpie 会写到哪个、为什么
  // 不能用 --dir 让它跟过来。
  const home = mkdtempSync(join(tmpdir(), "msmoli-home-"))
  const dir = mkdtempSync(join(tmpdir(), "msmoli-misdir-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const fakebin = join(home, "magpie")
    writeFileSync(fakebin, "")
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", fakebin],
      env: {},
      home,
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /✗ --dir 与 --magpie 指向不同的配置目录，而写入只会落在 magpie 自己的那个。/)
    assert.ok(text.includes(`  读的是：${dir}`), `the folder that was read is named: ${text}`)
    assert.match(text, /  magpie 会写到：它自己的默认目录（这里找不到现成的）/, `the folder magpie would write is named: ${text}`)
    assert.match(text, /  magpie 的命令行没有 --dir。两处用同一个目录，或去掉 --magpie 让它自动探测。/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that finds two accounts says the old one was not logged out", async () => {
  // logout 退出码 0 却没真删时，login 会把新令牌加成第二个账号；「有一个
  // 账号拿着目标令牌」照样成立，但那正是 planToPlugin 说 --force 不适用的
  // 状态。回读要数账号，并说清是怎么变成两个的。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-dbl-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        if (argv.includes("login")) {
          writeFileSync(
            join(dir, "plugin-auth.json"),
            JSON.stringify({ msmoli: { type: "api", key: B }, "msmoli#extra": { type: "api", key: A } }),
          )
        }
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /✗ 回读发现插件现在有 2 个账号（msmoli、msmoli#extra）。/)
    assert.match(text, /  旧账号没被登出，login 追加了一个。请在 magpie 里删掉多余账号后重试。/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that cannot be read says which page to check", async () => {
  // 读不动是「写入成功了但没法确认」，不是「没找到令牌」——后者会把人推去查
  // magpie 是否在运行。两个方向看的页面不同，所以 where 也要对。
  let dir = mkdtempSync(join(tmpdir(), "msmoli-rb-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        if (argv.includes("login")) writeFileSync(join(dir, "plugin-auth.json"), "{ broken")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /^\? 写入已执行，但回读时 .*plugin-auth\.json 读不出来，无法确认（ms-a…5555）。$/m)
    assert.match(text, /  先确认 magpie 正常，再看一眼插件列表里那把 key 在不在。/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = mkdtempSync(join(tmpdir(), "msmoli-rb2-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(B)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        writeFileSync(join(dir, "providers.json"), "{ broken")
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    const text = out.join("\n")
    assert.match(text, /^\? 写入已执行，但回读时 .*providers\.json 读不出来，无法确认（ms-a…5555）。$/m)
    assert.match(text, /  先确认 magpie 正常，再看一眼供应商列表里那把 key 在不在。/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--help answers with a success code", async () => {
  // 掏空 `return 0` 后 main 返回 undefined；isMain 那段把它塞进 exitCode，
  // 生产里仍是 0，但 main 的返回值就是它对调用方的契约，每条路径都该是数字。
  const code = await main({ argv: ["--help"], log: () => {} })
  assert.equal(code, 0)
})

test("a bare --dry-run says both that it needs a direction and that nothing ran", async () => {
  // 不带 --to-* 时只报计划：第一行说方向，第二行（只在 --dry-run 时）说没有
  // 执行。第二行被删掉，一次 --dry-run 的裸跑看起来就像跑过了——用户带着
  // 「已经同步」的印象离开。两条都要在。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-baredry-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--dry-run", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        throw new Error("a dry run must not spawn anything")
      },
    })
    assert.equal(code, 0)
    assert.match(out.join("\n"), /\(要执行请显式指定方向：--to-plugin 或 --to-preset\)/)
    assert.match(out.join("\n"), /\(--dry-run：未执行\)/, "a dry run has to say it did not run")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a root-relative XDG_CONFIG_HOME is rooted when the OS is simulated as win32", () => {
  // rooted() 的 os 参数是给「在 mac 上测 windows」用的：真 windows 上
  // path.isAbsolute("\\rel") 本来就是 true，这一条让模拟走同一条路。少了
  // 它，模拟出来的 win32 把 \rel 当成相对路径，转去读 ~/.config，判定
  // 便携 data 文件夹归属时问错了目录。
  const home = sep === "\\" ? "C:\\u" : "/home/u"
  const xdg = "\\rel"
  const data = join(home, "data")
  const files = new Set([join(data, "providers.json"), join(xdg, "magpie", "providers.json")])
  const got = findConfigDir({
    env: { XDG_CONFIG_HOME: xdg },
    home,
    os: "win32",
    exists: (p) => files.has(p),
    stat: (p) => (p === data ? { isDirectory: () => true } : (() => { throw new Error("ENOENT") })()),
    real: (p) => p,
    binPath: join(home, "magpie"),
  })
  assert.equal(got, join(xdg, "magpie"))
})

test("two install locations say which one wins", () => {
  // 搜索顺序就是优先顺序：两个位置都装了 magpie 时用的是排在前面的那个。
  // 交换前两个候选，Intel Homebrew 的 /usr/local/bin 会让给 /usr/bin 上
  // 那个来路不明的二进制——令牌在它手上。
  const both = new Set(["/usr/local/bin/magpie", "/usr/bin/magpie"])
  assert.equal(
    findMagpieBin({ os: "linux", env: {}, home: "/h", exists: (p) => both.has(p) }),
    "/usr/local/bin/magpie",
  )
})

test("the read-back checks the provider it wrote to, not any provider holding the key", async () => {
  // --to-preset 写的是 --from 指名的那个 provider。回读如果按默认规则找
  // （任意 ModelScope 预设），另一个恰好拿着同一把 key 的 provider 就能让
  // 一次没落地的写入报「✓ 完成」——用户以为同步好了，实际没换。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-rbid-"))
  try {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({ providers: [presetOf(A, "alt"), presetOf(B, "other")] }),
    )
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--from", "alt", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      // 写入没落地：magpie 退出码 0 却没动手，alt 上还是 A
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1, "the write did not land, and the tool must say so")
    assert.match(out.join("\n"), /回读没找到目标 key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the config files are read through the exists main was given", async () => {
  // exists 是 main 的注入点：一个 stat 得到、读却读不动的文件（正在被写、
  // 权限被收紧）走的正是这条缝。它决定「有但读不出来」。丢了这个实参，
  // 同一个文件成了「没配置」——把人引去新建一个已经存在的 provider。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-seam1-"))
  try {
    // providers.json 不在盘上，exists 说在：读不动
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      exists: (p) => p === join(dir, "providers.json") || p === join(dir, "plugin-auth.json"),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /providers\.json 存在但读不出来/, out.join("\n"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const dir2 = mkdtempSync(join(tmpdir(), "msmoli-seam2-"))
  try {
    // providers.json 在，plugin-auth.json 不在盘上而 exists 说在
    writeFileSync(join(dir2, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    const code = await main({
      argv: ["--dir", dir2, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      exists: (p) => p === join(dir2, "providers.json") || p === join(dir2, "plugin-auth.json"),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /plugin-auth\.json 存在但读不出来/, out.join("\n"))
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test("the read-back asks the same exists the pre-check did", async () => {
  // 写入之后 magpie 可能正在重写文件：exists 说在、读却读不动。回读这时要
  // 说「写入已执行，但没法确认」，不是「没找到令牌」——后者会把人送去查
  // magpie 为什么没运行，而写入其实已经落地。丢了这个实参，回读改用
  // existsSync，两句就换了个说法。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-seam3-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      exists: (p) => p === join(dir, "providers.json") || p === join(dir, "plugin-auth.json"),
      spawn: (_cmd, argv) => {
        // login 之后文件短暂不在盘上；exists 仍然答「在」，读就是读不动
        if (argv.includes("login")) rmSync(join(dir, "plugin-auth.json"))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /回读时 .*plugin-auth\.json 读不出来，无法确认/, out.join("\n"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const dir2 = mkdtempSync(join(tmpdir(), "msmoli-seam4-"))
  try {
    writeFileSync(join(dir2, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir2, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir2, "--to-preset", "--force", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      exists: (p) => p === join(dir2, "providers.json") || p === join(dir2, "plugin-auth.json"),
      spawn: () => {
        rmSync(join(dir2, "providers.json"))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.match(out.join("\n"), /回读时 .*providers\.json 读不出来，无法确认/, out.join("\n"))
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test("a path that is not given is not the folder named 'undefined'", () => {
  // norm 的 `String(p ?? "")`：undefined/null 读成空串，norm 早退成 ""，
  // `sameFolder(undefined, undefined)` 因此是 false——两个「没给路径」不是
  // 同一个文件夹，正是注释里那条「不存在的两个文件夹永不相等」。漏掉默认
  // 值，String(undefined) = "undefined" 成了一个非空串，两边都解析成同一个
  // 词，方法说「是同一个」。
  const identity = (p) => p
  const stat = () => ({ ino: 1, dev: 1 })
  assert.equal(sameFolder(undefined, undefined, identity, stat), false)
  assert.equal(sameFolder(null, null, identity, stat), false)
  assert.equal(sameFolder(undefined, "undefined", identity, stat), false)
  assert.equal(sameFolder("undefined", undefined, identity, stat), false)
  // 两个都写着 "undefined" 的字符串仍然是同一个（这是两个真实的词）
  assert.equal(sameFolder("undefined", "undefined", identity, stat), true)
  // 0 / false 不是 nullish：`??` 保留它们，String 之后是 "0" / "false"，两个
  // 同一个值仍是同一个文件夹；`||` 会把它们读成空串，一对相等的东西变成
  // 「都没给路径」。
  assert.equal(sameFolder(0, 0, identity, stat), true)
  assert.equal(sameFolder(false, false, identity, stat), true)
})

test("a provider with no id is not displayed as 'undefined'", async () => {
  // show 的 `String(s ?? "")`：providers.json 里一条没有 id 的预设，状态行
  // 该写「内置 ModelScope：（ms-a…5555）」，不是「undefined（…）」。`||` 那侧
  // 是数字 0/false 的 id：它们是真值，`String(0)` = "0" 应当显示出来。
  for (const [id, want] of [
    [undefined, "内置 ModelScope：（ms-a…0000）"],
    [null, "内置 ModelScope：（ms-a…0000）"],
    [0, "内置 ModelScope：0（ms-a…0000）"],
    [false, "内置 ModelScope：false（ms-a…0000）"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-noid-"))
    try {
      const entry = { preset: "modelscope", key: "ms-ablate-0000" }
      if (id !== undefined) entry.id = id
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [entry] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
      const out = []
      await main({
        argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      })
      const line = out.find((l) => l.includes("内置 ModelScope"))
      assert.equal(line, `  ${want}`, `id=${JSON.stringify(id)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ── 第三十轮：与插件同一批修复（账号类型规则、空令牌拒绝、片段掩码）──────

test("a plugin account is one the plugin could actually read: type api, key a string", () => {
  // 插件自己（index.mjs 的 rawKey）只认 type === "api" 的 key。本工具少这一条
  // 时，一份把令牌放错类型或位置的 plugin-auth.json 会让它说「已用同一把令牌、
  // 无需操作」，而插件读不到、卡片永远显示未登录——一个静默的错误状态。
  const auth = {
    msmoli: { type: "api", key: A },
    "msmoli#oauth": { type: "oauth", key: B },
    "msmoli#nostr": { type: "api", key: 12345 },
  }
  assert.deepEqual(pluginAccounts(auth), [
    { name: "msmoli", token: A },
    { name: "msmoli#oauth", token: "" },
    { name: "msmoli#nostr", token: "" },
  ])
})

test("a plugin entry whose token cannot be read is a refusal, not 'tokens differ'", () => {
  // 全部条目都读不出令牌时，「两边令牌不同」是一句我们说不出的话——插件那一侧
  // 根本没读到。--force 也帮不上：问题在文件，不在选择。
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: "" }], force: false })
  assert.equal(p.action, "refuse")
  assert.match(p.lines.join("\n"), /条目读不出令牌/)
  assert.equal(p.cmds.length, 0)
  // 只要有一个能读，其余照旧走「不同」那条
  const mixed = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: "" }, { name: "msmoli#x", token: B }], force: false })
  assert.match(mixed.lines.join("\n"), /两边令牌不同/)
})

test("a fragment of a secret in the child's output is masked too", async () => {
  // 子进程（或它背后的厂商）回显时可能只带令牌的一段，那不再等于整串，split()
  // 走过去了。scrub 的 maskEchoes 按「连续子串、长度 ≥ MIN_ECHO」把片段掩掉。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-fragmask-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const frag = A.slice(6, 26)
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `still holding ${frag}!` }),
    })
    const text = out.join("\n")
    assert.equal(code, 1)
    assert.ok(!text.includes(frag), `片段漏到了终端:\n${text}`)
    assert.match(text, /ms-a…5555/, `片段该被整串掩码替代:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token-shaped run with an underscore in the child's output is masked", async () => {
  // 老写法 /ms-[A-Za-z0-9][A-Za-z0-9-]{10,}/ 漏掉下划线、点、波浪号；而插件
  // 的 SENDABLE 允许可打印 ASCII 全部。形状规则要对齐，否则一个真带下划线的
  // 令牌被 magpie 回显时原样放行。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-underscore-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const foreign = "ms-foreign_key-1234-5678-9012"
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `no key ${foreign} for provider` }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(foreign), `带下划线的形状没被认出来:\n${text}`)
    assert.match(text, /ms-f…9012/, `它该按形状被掩码:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a secret echoed as a run of the text keeps the lines around it intact", async () => {
  // scrub 之前整段过 show()，而 show 的控制字符替换会把 \n 也换成空格，两次
  // 调用都靠 split("\n") 分行回显/引用。改成逐行 show，行结构不能坏。
  const dir = mkdtempSync(join(tmpdir(), "msmoli-lines-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: `line one\n  \nline two\n`, stderr: "" }),
    })
    assert.ok(out.includes("  line one"), `first line echoed: ${JSON.stringify(out)}`)
    assert.ok(out.includes("  line two"), `second line echoed: ${JSON.stringify(out)}`)
    assert.ok(!out.includes("  line one   line two"), "the lines must not be joined by the mask pass")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a secret that is not ms-shaped is masked in the echoed command too", async () => {
  // hidden() 的 `secret && a === secret` 是掩码用的那一支：只有按位置相等才掩。
  // 把它拿掉，剩下的 show(a) 只认 ms-… 的形状，一个不以 ms- 开头的真凭据
  // （--to-preset 写进 argv 的那把，来自插件里存着的任何 key）就原样打印。
  // 这条是 hidden() 的 secret 分支在「形状规则帮不上忙」时的唯一覆盖。
  const plain = "plainsecretvalue1234567890"
  const dir = mkdtempSync(join(tmpdir(), "msmoli-plainsecret-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: plain } }))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--dry-run"],
      log: (s) => out.push(s),
      spawn: () => {
        throw new Error("--dry-run must not spawn")
      },
    })
    const text = out.join("\n")
    assert.equal(code, 0)
    assert.ok(!text.includes(plain), `非 ms 形状的凭据被原样打印:\n${text}`)
    assert.match(text, /plai…7890/, `它该被掩码成自己的两端:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 第三十一轮：复查批次（不可见字符切开令牌、运行时报错回显路径、写入守卫
// 在 Windows 扩展名下跳过、非 ms 形状的值、回读的形状、重复参数）──────────

// both files written: tests that stub exists() say they are there
const fixture = (prefix, providers = [presetOf(A)], auth = {}) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  return dir
}

test("a token cut by an invisible character is still masked where it is printed", async () => {
  // show() 先把控制/格式字符换成空格、再按形状掩码：零宽空格（聊天软件复制
  // 令牌时常夹带）或 \x01 把令牌切成两段，每段都不够长度下限，整串原样上终端。
  const dir = fixture("msmoli-zwsp-")
  try {
    for (const cut of ["\u200b", "\x01", "\u2060"]) {
      const pasted = A.slice(0, 13) + cut + A.slice(13)
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", pasted], log: (s) => out.push(s) })
      const text = out.join("\n")
      for (const piece of [A.slice(0, 13), A.slice(13)]) {
        assert.ok(!text.includes(piece), `${JSON.stringify(cut)} 切开的令牌，片段 ${piece} 上了终端:\n${text}`)
      }
      assert.match(text, /ms-a…5555/, `它该被整串掩码:\n${text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a secret echoed with an invisible character inside it is masked whole", async () => {
  // scrub 的 maskEchoes 按连续子串找片段：子进程回显里令牌中间夹一个 \x01，
  // 前 11 个字符不到 MIN_ECHO，原样留下。不可见字符要被跨过。
  const dir = fixture("msmoli-echocut-")
  try {
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `key ${A.slice(0, 11)}\u0001${A.slice(11)} rejected\nnext line` }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(A.slice(0, 11)), `令牌前段上了终端:\n${text}`)
    assert.match(text, /key ms-a…5555 rejected/, `整串该掩成一处:\n${text}`)
    assert.match(text, /\nnext line/, `换行仍然分行，不被跨过:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the runtime's own failure message is masked like the child's output", async () => {
  // spawnSync 的 ENOENT 把整条路径写进 message（"spawnSync <path> ENOENT"），
  // 那半句没过 show()：一个带斜杠的令牌形路径整串上了终端，控制字符也照发。
  const dir = fixture("msmoli-enoent-")
  try {
    // no run in common with the preset's A: maskEchoes would mask a shared
    // tail as a piece of A, which hides the shape test this is about
    const foreign = "ms-ZZZZ9999yyyy8888xxxx777766661234"
    const tokenPath = `/tmp/${foreign}`
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", tokenPath],
      log: (s) => out.push(s),
      exists: (p) => p.startsWith(dir),
      spawn: (b) => ({ error: Object.assign(new Error(`spawnSync ${b} ENOENT\x1b[2J`), { code: "ENOENT" }) }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(foreign), `运行时报错把令牌形路径整串打出来了:\n${text}`)
    assert.ok(!text.includes("\x1b"), "运行时报错里的控制字符不该到终端")
    assert.match(text, /spawnSync \/tmp\/ms-Z…1234 ENOENT/, `其余照常:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the outgoing key is masked in a spawn failure that names it too", async () => {
  // --to-preset 的 provider key 会替换掉预设现有的 key：旧的那把也是真凭据，
  // 被换掉时一条主机报错可能回显它。它是自建 vendor 的 key，不是 ms- 形状——
  // 形状测试认不出它，运行时的报错路径此前又只滤当步的 secret，整串漏出去。
  const old = "ghs_zzzz9999yyyy8888xxxx77776666"
  const dir = fixture("msmoli-alsofail-", [{ id: "modelscope", preset: "modelscope", key: old }], { msmoli: { type: "api", key: B } })
  try {
    const out = []
    await main({
      argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
      exists: (p) => p.startsWith(dir),
      spawn: () => ({ error: Object.assign(new Error(`spawnSync /x/${old} ENOENT`), { code: "ENOENT" }) }),
      log: (s) => out.push(s),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(old), `被替换掉的旧 key 在运行时报错里漏了:\n${text}`)
    assert.ok(!text.includes(B), `当步的 key 也漏了:\n${text}`)
    assert.match(text, /spawnSync \/x\/ghs_…6666 ENOENT/, `其余照常:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a key that is not ms-shaped is masked where a typed value is echoed", async () => {
  // show() 只认 ms- 形状。粘错位置的别家 key（ghs_…、sk-…）在 --from、
  // 未知参数、裸 --magpie 三处被整串回显。一段 16 位以上、字母数字都有的
  // 串，就是生成出来的 key 的样子，provider id 不长这样。
  const dir = fixture("msmoli-nonms-")
  const key = "ghs_abcdefghijklmnopqrstuvwxyz012345"
  try {
    for (const argv of [["--dir", dir, "--status", "--from", key], ["--dir", dir, "--magpie", key]]) {
      const out = []
      await main({ argv, log: (s) => out.push(s) })
      const text = out.join("\n")
      assert.ok(!text.includes(key), `${argv.join(" ")} 把 key 整串回显了:\n${text}`)
      assert.match(text, /ghs_…2345/, `它该被掩码:\n${text}`)
    }
    await assert.rejects(main({ argv: [key], log: () => {} }), (e) => !e.message.includes(key) && /ghs_…2345/.test(e.message))
    // --dir's echo too, on both lines that print it: the "no config files
    // here" one, and the one after the folder is accepted
    const dirOut = []
    await main({ argv: ["--dir", key, "--status"], log: (s) => dirOut.push(s) })
    assert.ok(!dirOut.join("\n").includes(key), `--dir 把 key 整串回显了:\n${dirOut.join("\n")}`)
    assert.match(dirOut.join("\n"), /ghs_…2345 里没有 magpie 的配置文件/)
    const okOut = []
    await main({
      argv: ["--dir", key, "--status"],
      exists: (p) => p === join(key, "providers.json"),
      log: (s) => okOut.push(s),
    })
    assert.ok(!okOut.join("\n").includes(key), `配置目录行把 key 整串回显了:\n${okOut.join("\n")}`)
    assert.match(okOut.join("\n"), /magpie 配置目录：ghs_…2345/)
    // 一个真 id 照样读得出来：带连字符的名字、纯字母的长名字都不像 key
    // （modelscope20261031 这类的 16 位小写字母数字串也一样：它就是一个 id，
    //  第三十二轮就这么定了——下限之下的纯小写串是名字，不是 key）
    for (const id of ["modelscope-backup-2025", "my-modelscope-provider", "abcdefghijklmnopqrstuvwxyz", "modelscope20261031"]) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", id], log: (s) => out.push(s) })
      assert.ok(out.join("\n").includes(id), `provider id ${id} 不该被当成 key 掩掉`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("on Windows, a --magpie path without .exe is still checked against --dir", async () => {
  // spawnSync 在 Windows 上把没有扩展名的路径补成 .exe 去跑，existsSync 不补。
  // 守卫只认 exists(bin) 时就跳过了自己：读的是夹具，写的是真 magpie 的目录。
  const dir = fixture("msmoli-winext-")
  try {
    const exe = "C:\\Tools\\magpie"
    const calls = []
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", exe],
      os: "win32",
      env: {},
      home: "C:\\Users\\u",
      exists: (p) => p.startsWith(dir) || p === exe + ".exe",
      spawn: (...a) => (calls.push(a), { status: 0, stdout: "", stderr: "" }),
      log: (s) => out.push(s),
    })
    assert.equal(code, 1)
    assert.deepEqual(calls, [], "不同目录时一条命令都不该发")
    assert.match(out.join("\n"), /--dir 与 --magpie 指向不同的配置目录/)
    // 一个真不存在的二进制照旧放过守卫：它跑不起来，写不了任何地方
    const none = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent/magpie"],
      exists: (p) => p.startsWith(dir),
      spawn: (...a) => (none.push(a), { error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }) }),
      log: () => {},
    })
    assert.equal(none.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that is the wrong shape is 'cannot read', not 'not found'", async () => {
  // 写前的检查认形状（[]、"x"、null 都算读不出来），回读只认 null：一份变成
  // [] 的 plugin-auth.json 被报成「没找到目标令牌，检查 magpie 是否在运行」。
  for (const [to, file, junk, auth] of [
    ["--to-plugin", "plugin-auth.json", [], {}],
    ["--to-preset", "providers.json", "x", { msmoli: { type: "api", key: B } }],
  ]) {
    const dir = fixture("msmoli-rbshape-", [presetOf(A)], auth)
    try {
      const out = []
      const code = await main({
        argv: ["--dir", dir, to, "--force", "--magpie", "/nonexistent"],
        exists: (p) => p.startsWith(dir),
        spawn: () => (writeFileSync(join(dir, file), JSON.stringify(junk)), { status: 0, stdout: "", stderr: "" }),
        log: (s) => out.push(s),
      })
      const text = out.join("\n")
      assert.equal(code, 1)
      assert.match(text, new RegExp(`${file.replace(".", "\\.")} 读不出来`), `${to}:\n${text}`)
      assert.doesNotMatch(text, /没找到目标/, `${to}:\n${text}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a value flag given twice is refused, and --flag=value is read", async () => {
  // 两个方向同时给会被拒，三个带值的参数却静默以后者为准：--magpie A
  // --magpie B 写进了 B。--dir=x 之前被当成未知参数。
  for (const argv of [
    ["--dir", "/a", "--dir", "/b"],
    ["--magpie", "/a/magpie", "--magpie", "/b/magpie"],
    ["--from", "x", "--from=y"],
  ]) {
    await assert.rejects(main({ argv, log: () => {} }), /只能给一次/, argv.join(" "))
  }
  await assert.rejects(main({ argv: ["--dir="], log: () => {} }), /缺少值/)
  const dir = fixture("msmoli-eqflag-")
  try {
    const out = []
    const code = await main({ argv: [`--dir=${dir}`, "--status"], log: (s) => out.push(s) })
    assert.equal(code, 0, out.join("\n"))
    assert.match(out.join("\n"), new RegExp(`magpie 配置目录：.*${dir.split(sep).pop()}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a path is never taken for a key, and a secret split across lines is masked", async () => {
  // 路径是用户自己的，照样可读：一条带长串字母数字的路径不是 key。被换行切开
  // 的回显仍是那把令牌，每半不够 MIN_ECHO 也要整串掩掉。
  const path = "/tmp/abcdefgh12345678ijklmnop/x"
  await assert.rejects(main({ argv: [path], log: () => {} }), (e) => e.message.includes(path))
  const dir = fixture("msmoli-splitecho-")
  try {
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `got ${A.slice(0, 11)}\n${A.slice(11, 22)} end` }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(A.slice(0, 11)) && !text.includes(A.slice(11, 22)), `被换行切开的令牌漏了:\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 第三十二轮：复查批次（逐段掩码、密钥形状补齐、两行一致、空白值）──────

test("a key of any shape is masked in a typed value, and a path keeps its shape", async () => {
  // 第三十一轮的形状只认「不含路径分隔符、且有 16+ 位字母数字混排」，于是
  // 含 / 的 AWS secret、xoxb、UUID 整串漏出；而 path 里嵌的令牌也一样。
  const dir = fixture("msmoli-shapes-")
  try {
    const keys = [
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      // 拆开拼：GitHub 的推送保护会把整串当成真 Slack 令牌拦下推送。
      "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      "550e8400-e29b-41d4-a716-446655440000",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "sk-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2",
      "AKIAIOSFODNN7EXAMPLE",
      // 自造且已过期（exp 2018，sub=fixture）：密钥扫描服务会把 JWT 形状当成真
      // 凭据报警，而它们在过期令牌上没有可报的东西；这里要的只是「三段长串」。
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmaXh0dXJlIiwiZXhwIjoxNTE2MjM5MDIyfQ.c3ludGhldGljLWZpeHR1cmUtc2lnbmF0dXJlLW5vdC1hLWNyZWRlbnRpYWw",
      "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "AbCdEf0123456789+/xYzAbCdEf0123456789==",
      "/tmp/ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "/var/data/550e8400-e29b-41d4-a716-446655440000",
    ]
    for (const k of keys) {
      for (const argv of [["--dir", dir, "--status", "--from", k], ["--dir", dir, "--magpie", k], [k]]) {
        const out = []
        await main({ argv, log: (s) => out.push(s) }).catch((e) => out.push(e.message))
        const text = out.join("\n")
        // 每一段「像密钥」的连续串都不该整段出现
        for (const run of k.match(/[A-Za-z0-9]{16,}/g) ?? []) {
          assert.ok(!text.includes(run), `${k} 的 ${run} 漏了：\n${text}`)
        }
        assert.ok(!text.includes(k), `${k} 整串漏了：\n${text}`)
      }
    }
    // 一个路径读出的是路径：掩掉的是其中像密钥的那一段，目录本身照旧
    const out = []
    await main({ argv: ["--dir", dir, "--status", "--from", "/tmp/ghp_16C7e42F292c6912E7710c838347Ae178B4a"], log: (s) => out.push(s) })
    assert.match(out.join("\n"), /\/tmp\/ghp_16C7…8B4a/, `路径形状保留：\n${out.join("\n")}`)
    // 正常 id 与路径照旧可读
    for (const good of ["modelscope20261031", "modelscope-backup-2025-east", "C:\\Tools\\magpie", "/tmp/msmoli-fixtures"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", good], log: (s) => o.push(s) })
      assert.ok(o.join("\n").includes(good), `${good} 不该被掩：\n${o.join("\n")}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the folder the report names is masked the same way on every line it names it", async () => {
  // 配置目录行走的是 arg()，两行后的「读的是」「会写到」却曾是 show()：同一个
  // 值一处掩、一处整串。让 --dir 与 --magpie 的目录错开来，才走得到那两行。
  const home = mkdtempSync(join(tmpdir(), "msmoli-home-"))
  const parent = mkdtempSync(join(tmpdir(), "msmoli-two-line-"))
  const keyed = join(parent, "ghs_abcdefghijklmnopqrstuvwxyz012345")
  try {
    mkdirSync(keyed)
    writeFileSync(join(keyed, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(keyed, "plugin-auth.json"), JSON.stringify({}))
    const fakebin = join(home, "magpie")
    writeFileSync(fakebin, "")
    const out = []
    await main({
      argv: ["--dir", keyed, "--to-plugin", "--magpie", fakebin],
      env: {},
      home,
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes("ghs_abcdefghijklmnopqrstuvwxyz012345"), `某一整行漏了整串：\n${text}`)
    assert.match(text, /读的是：.*ghs_abcd…2345/, `读的是那行也掩：\n${text}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})

test("a value of nothing but spaces is a missing value, not a folder named ' '", async () => {
  // `--dir " "` 被当成合法值，报错行变成「✗   里没有…」，读起来像 bug。
  for (const argv of [["--dir", " ", "--status"], ["--from", "  "], ["--dir=  ", "--status"]]) {
    await assert.rejects(main({ argv, log: () => {} }), /缺少值/, argv.join(" "))
  }
})

test("a child's echo of a key that is not the one this run holds is still masked", async () => {
  // scrub 结尾的 show() 只认 ms- 形状：magpie 报错里回显别家令牌（ghp_…）时
  // 原样上终端。逐段掩码把已知形状之外的长串也盖上。第三十五轮起，一个词就是
  // 一把 key 时按整词掩，露出的是它自己的两端（ghp_…8B4a），不再是那一段长串的
  // 两端——少露了中间那 4 个字符。
  const dir = fixture("msmoli-otherkey-")
  try {
    const foreign = "ghp_16C7e42F292c6912E7710c838347Ae178B4a"
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `bad key ${foreign} refused` }),
    })
    const text = out.join("\n")
    assert.ok(!text.includes(foreign), `别家令牌整串漏了：\n${text}`)
    assert.match(text, /ghp_…8B4a/, `该按形状掩掉：\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a child's output of a hundred thousand control characters is scrubbed in one pass", async () => {
  // 第三十一轮把 maskEchoes 改成「逐位跳过不可见字符」，在成串的控制字符上
  // 退化成 O(n²)：20 000 个 \x01 要 79 秒，子进程一句脏输出就能拖死整轮。
  // 两段式（先收集可见字符，在可见序列上扫一遍，再映射回原串）是线性的。
  const dir = fixture("msmoli-scrubperf-")
  try {
    const body = "\x01".repeat(100_000) + A
    const t0 = performance.now()
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: `bad ${body} refused` }),
    })
    const ms = performance.now() - t0
    assert.ok(ms < 5000, `一次扫描就该扫完，实际 ${ms.toFixed(0)}ms`)
    const text = out.join("\n")
    assert.ok(!text.includes(A), `令牌漏了：\n${text.slice(0, 300)}`)
    assert.match(text, /ms-a…5555/, `令牌该被掩：\n${text.slice(0, 300)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 第三十三轮：id 字段里粘进来的别家 key ──────────────────────────────

test("a provider id that is another vendor's key is masked wherever it is named", async () => {
  // id 与账号名同样来自本机文件、也会被回显，但它们此前只过 show()：show 只认 ms-
  // 形状，一把 ghp_/AWS/xoxb 形状的 key 粘进 id 字段就会被整串打印（--status 的
  // 「内置 ModelScope：」那行、计划行、以及 provider key 命令回显）。
  const foreign = "ghp_16C7e42F292c6912E7710c838347Ae178B4a"
  const dir = fixture("msmoli-idkey-", [{ id: foreign, preset: "modelscope", key: A }], { msmoli: { type: "api", key: B } })
  try {
    for (const argv of [["--dir", dir, "--status"], ["--dir", dir, "--to-plugin", "--dry-run"]]) {
      const out = []
      await main({ argv, log: (s) => out.push(s) })
      const text = out.join("\n")
      assert.ok(!text.includes(foreign), `${argv.join(" ")}：id 整串上了终端：\n${text}`)
      assert.match(text, /ghp_…8B4a/, `${argv.join(" ")}：id 该按形状掩掉：\n${text}`)
    }
    const out = []
    await main({ argv: ["--dir", dir, "--to-preset", "--force", "--dry-run"], log: (s) => out.push(s) })
    const text = out.join("\n")
    assert.ok(!text.includes(foreign), `--to-preset：id 整串上了终端：\n${text}`)
    assert.match(text, /provider key ghp_…8B4a/, `命令回显也该掩：\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // 正常形状的 id 与路径照旧可读
  const dir2 = fixture("msmoli-okid-", [{ id: "modelscope-backup-2025-east", preset: "modelscope", key: A }])
  try {
    const o = []
    await main({ argv: ["--dir", dir2, "--status"], log: (s) => o.push(s) })
    const t = o.join("\n")
    assert.ok(t.includes("modelscope-backup-2025-east"), `正常 id 不该被掩：\n${t}`)
    assert.ok(t.includes(dir2), `配置目录不该被掩：\n${t}`)
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test("an id that is another vendor's key is masked in the ambiguity, bare and read-back lines too", async () => {
  // 同一个缺陷的另外三个出口：候选歧义提示（两个候选共用同一个 id）、自有 provider
  // 但还没有 key 的提示、以及回读发现多账号时把账号名排出来那一行。id 与账号名
  // 都来自本机文件，粘进去的别家 key 在这里同样只能是掩过的。
  const foreign = "ghp_16C7e42F292c6912E7710c838347Ae178B4a"
  const second = "ghp_ZZZZ9999yyyy8888xxxx777766661111"
  const dir = fixture("msmoli-idkey2-", [
    { id: foreign, preset: "modelscope", key: A },
    { id: foreign, preset: "modelscope", key: B },
  ])
  try {
    const out = []
    await main({ argv: ["--dir", dir, "--status"], log: (s) => out.push(s) })
    const text = out.join("\n")
    assert.match(text, /多个候选/, `该走到歧义分支：\n${text}`)
    assert.ok(!text.includes(foreign), `歧义提示里 id 整串上了终端：\n${text}`)
    assert.match(text, /ghp_…8B4a/, `该按形状掩：\n${text}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const bare = fixture("msmoli-idkey3-", [{ id: foreign, preset: "modelscope", key: "" }])
  try {
    const out = []
    await main({ argv: ["--dir", bare, "--status"], log: (s) => out.push(s) })
    const text = out.join("\n")
    assert.match(text, /还没有 key/, `该走到「还没有 key」分支：\n${text}`)
    assert.ok(!text.includes(foreign), `「还没有 key」那行 id 整串上了终端：\n${text}`)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
  const dir2 = fixture("msmoli-idkey4-", [{ id: "modelscope", preset: "modelscope", key: A }], {
    msmoli: { type: "api", key: B, accountId: foreign },
  })
  try {
    const out = []
    await main({
      // --magpie /nonexistent 让 runnable 为假、跳过「--dir 与 --magpie 目录不一致」
      // 那道守卫；不给它则会先撞上本机真实的 magpie 目录（实测就是死在那一行）
      argv: ["--dir", dir2, "--to-plugin", "--force", "--magpie", "/nonexistent"],
      spawn: (b, a) => {
        if (a[0] === "plugin" && a[1] === "login") {
          writeFileSync(
            join(dir2, "plugin-auth.json"),
            JSON.stringify({
              msmoli: { type: "api", key: A, accountId: foreign },
              "msmoli#dup": { type: "api", key: B, accountId: second },
            }),
          )
        }
        return { status: 0, stdout: "", stderr: "" }
      },
      log: (s) => out.push(s),
    })
    const text = out.join("\n")
    assert.match(text, /回读发现插件现在有 2 个账号/, `该走到回读多账号分支：\n${text}`)
    assert.ok(!text.includes(foreign), `回读那行的账号名整串上了终端：\n${text}`)
    assert.ok(!text.includes(second), `第二个账号名也整串上了终端：\n${text}`)
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

// ── 第三十四轮：含分隔符的密钥（AWS secret 形状）────────────────────────

// 最长「原样出现在输出里」的连续子串。判据用 12，与 mask/min 的门槛同源：
// 短于 12 的偶然重合不算泄漏，12 及以上就是有人能拿到的实料。
const longestKept = (text, secret) => {
  let best = ""
  for (let i = 0; i < secret.length; i++)
    for (let j = i + 1; j <= secret.length; j++) {
      const piece = secret.slice(i, j)
      if (text.includes(piece) && piece.length > best.length) best = piece
    }
  return best
}

test("a secret with separators in it is masked whole, not just its longest run", async () => {
  // 判据只按「连续的字母数字段」掩码，于是 AWS secret（wJalr…/K7MDENG/bPxRfi…）
  // 里只有 18 字符那段被掩，前 26 个字符原样上终端——而它的分段只有 13/7/18 位，
  // 「16+ 位的段」整条断言看不见。凡是分段成词、又不是路径形状的值，整串掩掉。
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  const dir = fixture("msmoli-sepkey-")
  try {
    for (const argv of [
      ["--dir", dir, "--status", "--from", aws],
      ["--dir", dir, "--to-plugin", "--dry-run", "--magpie", aws],
      ["--dir", dir, "--from=" + aws, "--status"],
    ]) {
      const out = []
      await main({ argv, log: (s) => out.push(s), exists: (p) => p.startsWith(dir) }).catch((e) => out.push(e.message))
      const text = out.join("\n")
      const kept = longestKept(text, aws)
      assert.ok(kept.length < 12, `${argv.join(" ")}：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}：\n${text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a value that starts like a path keeps its shape even when its parts are long", async () => {
  // 反向：带分隔符不等于密钥。以 / ~ . 、盘符或 UNC 起头的值是路径，保留形状、
  // 只掩其中像密钥的那一段——否则 --dir 一类的回显会变成 "Docu…oject"。
  const dir = fixture("msmoli-tilde-")
  try {
    // 路径本身可读（组件都在 16 位以下、不混大小写）；里面像密钥的那一段仍被掩
    const readable = [
      "/Users/mison/Documents/NewProject",
      "~/.config/magpie",
      "./relative/dir/name",
      "C:\\Users\\QDM\\AppData",
      "/var/folders/hq/q19jry150l16mrrbkh7wm0_m0000gn/T/msmoli-shapes-OTapSg",
      "Documents/NewProject",
      "work/magpie-plugin-msmoli",
      "data",
    ]
    for (const p of readable) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => out.push(s) })
      assert.ok(out.join("\n").includes(p), `${p} 的路径形状被掩掉了：\n${out.join("\n")}`)
    }
    // PATHY 那一臂自身：以 / 起头的值就算有两段 12+ 位混合大小写的组件，也是
    // 路径不是密钥（去掉 !PATHY 后这两条会变成 "（N 字符）"）
    for (const p of ["/Documents/NewProject", "/SomeLongDirectoryName/AnotherLongName"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => o.push(s) })
      const text = o.join("\n")
      // 路径的结构在：最后一个组件整段可读，只有前面那个长 camelCase 组件按
      // 既有规则被掩。整串被当成 key 时整个值只剩 "/Som…Name"，两个组件都看不见。
      assert.ok(text.includes("/" + p.split("/").at(-1)), `${p} 以 / 起头，后一个组件该可读：\n${text}`)
    }
    // 普通词组成的相对路径：两段都长（12+），但不混大小写，不该被当成密钥
    for (const p of ["documents/mynewprojectfolder", "photographs/vacationphotos", "microservices/documentation"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => o.push(s) })
      assert.ok(o.join("\n").includes(p), `${p} 是小写路径组件，不该被掩：\n${o.join("\n")}`)
    }
    // 嵌在路径里的令牌：路径留着，令牌那段掩掉
    const withToken = "/tmp/ghp_16C7e42F292c6912E7710c838347Ae178B4a"
    const o = []
    await main({ argv: ["--dir", dir, "--status", "--from", withToken], log: (s) => o.push(s) })
    assert.match(o.join("\n"), /\/tmp\/ghp_16C7…8B4a/, `路径里的令牌该只掩那一段：\n${o.join("\n")}`)
    // 已知边界（第三十二轮就有的取舍）：一个 16+ 位、大小写混排的单个路径组件
    // 与一把 key 的「一段」无法区分，会被掩。这里钉住它，免得将来当成新缺陷。
    const camel = "/Users/mison/Documents/SomeLongDirectoryName"
    const c = []
    await main({ argv: ["--dir", dir, "--status", "--from", camel], log: (s) => c.push(s) })
    assert.match(c.join("\n"), /Some…Name/, `camеlCase 组件按既有规则被掩：\n${c.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 第三十五轮：带空白的值与被分隔符拆成短段的 key ──────────────────────

test("a key pasted with a trailing space, or quoted inside a line, is masked whole", async () => {
  // 判据跑在整个值上，isKey 一见到空白就返回 false：「key 后面粘了个空格」
  // （从终端或聊天窗口复制最常见的样子）于是整串掉进按段掩码，只有够长的那
  // 一段被掩，前面 sk-ant-api03-Eyai1pkJrF 这 28 个字符原样上终端。子进程那句
  // "no key … for provider" 同理。逐词判据：那个词就是 key，整词掩掉。
  const dir = fixture("msmoli-wordkey-")
  const keys = [
    "sk-ant-api03-Eyai1pkJrF_KbwtQm3Zx8Vd2Nc7Rt5Hs9Lg4Pf6Ba1Ue0YjXLkIhGwSnTvMoDrQpCsAzBxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    // 拆开拼：GitHub 的推送保护会把整串当成真凭据拦下推送。
    "xoxb-" + "435186639673-1944724303225-OQaLmNbVcXzAsDwErTyUiOp",
    "github_pat_11ABCDEFG0123456789_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrSt",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    // 拆开拼：GitHub 的推送保护会把整串当成真凭据拦下推送。
    "sk_live_" + "51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ]
  try {
    for (const key of keys) {
      for (const value of [key, `${key} `, `${key}\n`, `no key ${key} for provider`, `"${key}"`]) {
        const out = []
        await main({ argv: ["--dir", dir, "--status", "--from", value], log: (s) => out.push(s) })
        const kept = longestKept(out.join("\n"), key)
        assert.ok(kept.length < 12, `${JSON.stringify(value.slice(0, 30))}…：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
      }
    }
    // 子进程把 key 夹在一句话里回显时，走的是同一道门（arg 逐词）
    for (const key of [keys[0], keys[1]]) {
      const out = []
      await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => ({ status: 7, stdout: "", stderr: `magpie: no key ${key} for provider` }),
      })
      const kept = longestKept(out.join("\n"), key)
      assert.ok(kept.length < 12, `子进程回显：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a key split into short pieces by separators is masked whole", async () => {
  // 判据按「连续的字母数字段」掩码：一把被 - _ . 拆成几段、每段都不够 16 位的
  // key（nUJqxrpd9Bc7-GvG7J--o…、AbCdEfGh.IjKlMnOp.…、9f8e7d6c5b4a3928-1706…）
  // 没有任何一段合格，整串原样上终端（裸参数位实测 42/42、35/35、33/33）。
  const dir = fixture("msmoli-fragkey-")
  const keys = [
    "nUJqxrpd9Bc7-GvG7J--onUJqxrpd9Bc7-GvG7J--o",
    "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
    "deadbeef-cafebabe-0123456789abcdef",
    "9f8e7d6c5b4a3928-1706f5e4d3c2b1a0",
    // 一段 16 位纯 hex（字母与数字都有）：摘要、会话 id。跟 provider id 的日期
    // 形状（modelscope20261031）不同，它整段都在 0-9a-f 里
    "56b3f97586dedd63",
    // 32 位以上、小写字母加数字、被分隔符拆开，每一段都不到 32——只按段看哪段
    // 都不合格（不是 hex，也没有大写），合起来才是一把
    "a1b2c3d4e5f6g7h8i9j0k1l2-o3p4q5r6s7t8u9v0w1",
  ]
  // 一段 16 位、小写字母与数字混排、不全是 hex 的串不在里面：它与 provider id
  // 的日期形状（modelscope20261031）在字符上无法区分，下限之下是名字——第三十二
  // 轮定下的取舍，反向测试钉着它。这里测的是被分隔符拆开、自身每一段都不够格
  // 的那种，以及整段落在 hex 字母表里的那种
  try {
    for (const key of keys) {
      for (const value of [key, `${key} `, `no key ${key} refused`, `"${key}"`]) {
        const out = []
        await main({ argv: ["--dir", dir, "--status", "--from", value], log: (s) => out.push(s) })
        const kept = longestKept(out.join("\n"), key)
        assert.ok(kept.length < 12, `${JSON.stringify(value.slice(0, 30))}…：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
      }
      // 裸参数位（不认识的参数那条）
      await assert.rejects(
        main({ argv: [key], log: () => {} }),
        (e) => !e.message.includes(key) && longestKept(e.message, key).length < 12,
        `裸参数位整串回显了 key\n${key}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the new whole-word floor still leaves ordinary names readable", async () => {
  // 反向：判据从「一段」换成「整词去分隔符」，可能把普通词也带进来。这些是
  // provider id / 目录名 / 服务端措辞里真会出现的形状，一个字都不该被掩。
  const dir = fixture("msmoli-wordok-")
  try {
    const good = [
      "modelscope-backup-2025-east",
      "modelscope20261031",
      "my-modelscope-provider",
      "abcdefghijklmnopqrstuvwxyz",
      "magpie-plugin-msmoli",
      "Qwen3-Max",
      "daily_active",
      "api_inference",
      "Documents/NewProject",
      "documents/mynewprojectfolder",
      "feature/MSMOLI-1234-fix-checkin",
      "work/magpie-plugin-msmoli",
      "1.2.3-beta.4",
    ]
    for (const value of good) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", value], log: (s) => out.push(s) })
      assert.ok(out.join("\n").includes(value), `${value} 不该被当成 key 掩掉：\n${out.join("\n")}`)
    }
    // 路径里的长组件照旧只掩那一段：路径形状保留
    const p = "/Users/mison/Documents/SomeLongDirectoryName"
    const out = []
    await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => out.push(s) })
    assert.match(out.join("\n"), /Some…Name/, `路径组件该按段掩：\n${out.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a child's plain key=value words are not masked, and a base64 body still is", async () => {
  // 「含 +/= 就是 key」单独成一条时，子进程的 host=https://… 这种词被整词掩成
  // 「（10 字符）」，--from 的 v1.2.3+sha.abc 同理。base64 本体没有被放过：
  // 它带着 16+ 位的字母数字长串，那一段本身就合格，而且整词仍按形状掩。
  const dir = fixture("msmoli-eqword-")
  try {
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => ({ status: 7, stdout: "", stderr: "Error: host=https://www.modelscope.cn retry=true id=12345 code=ENOENT" }),
    })
    const text = out.join("\n")
    for (const keep of ["host=https://www.modelscope.cn", "retry=true", "id=12345", "code=ENOENT"]) {
      assert.ok(text.includes(keep), `${keep} 被误掩：\n${text}`)
    }
    for (const v of ["v1.2.3+sha.abc", "id=12345", "id=1234567890", "retry=true"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", v], log: (s) => o.push(s) })
      assert.ok(o.join("\n").includes(v), `${v} 被误掩：\n${o.join("\n")}`)
    }
    // 而一段带 +/= 的 base64 本体仍是 key 的形状
    const b64 = "AbCdEf0123456789+/xYzAbCdEf0123456789=="
    const o = []
    await main({ argv: ["--dir", dir, "--status", "--from", b64], log: (s) => o.push(s) })
    const shown = o.join("\n")
    assert.ok(longestKept(shown, b64).length < 12, `base64 本体漏了 ${JSON.stringify(longestKept(shown, b64))}:\n${shown}`)
    assert.ok(shown.includes("AbCd…89=="), `base64 该整词掩：\n${shown}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a short key carrying a base64 symbol is masked, and a query's = is not", async () => {
  // 第三十五轮把旧的 [+=] 那一臂撤了（它把子进程的 retry=true、id=12345 整词掩成
  // 「（10 字符）」），撤得过头：低于 16 位下限、靠 + 或 = 才现形的短 key
  // （AbCdEfGh+IjKlMnOp、dGhpc2lzYQ==）跟着漏了。新的一臂只认「整词全在 key
  // 字母表里、>=12 位、且带 + 或以 = 结尾」：查询里的 retry=true、id=1234567890
  // 带着裸 =，code=ENOENT 两样都没有，v1.2.3+sha.abc 的点不在字母表里，都不掩。
  const dir = fixture("msmoli-b64word-")
  try {
    const masks = [
      "AbCdEfGh+IjKlMnOp",
      "AbCdEf+GhIjKl=",
      "abcdefghij0123456789=",
      "AbCdEf-GhIjKl+MnOpQr",
      "dGhpc2lzYQ==",
    ]
    for (const key of masks) {
      for (const value of [key, `${key} `, `token ${key} here`, `"${key}"`]) {
        const out = []
        await main({ argv: ["--dir", dir, "--status", "--from", value], log: (s) => out.push(s) })
        const kept = longestKept(out.join("\n"), key)
        assert.ok(kept.length < 12, `${JSON.stringify(value)}：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
      }
    }
    const keeps = ["retry=true", "id=12345", "id=1234567890", "code=ENOENT", "host=https://www.modelscope.cn", "v1.2.3+sha.abc", "ab=", "foo+bar+baz+qux+quux+corge", "key=value+with+plus", "a+b=c+d=e+f=g+h", "+1-555-123-4567", "1+2+3+4+5+6+7+8+9", "100+200+300+400", "mnbvcxzlkjh+1234"]
    for (const v of keeps) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", v], log: (s) => out.push(s) })
      assert.ok(out.join("\n").includes(v), `${v} 被误掩：\n${out.join("\n")}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the glued arm asks two pieces to alternate, so a hyphenated name survives", async () => {
  // 合体那一臂原来是「去掉分隔符后 >=20 位、且大小写都有」：provider id
  // MyProvider-Prod-Edition-2026 去掉连字符后大小写都有，于是被掩成「MyPr…2026」；
  // Qwen3-Coder-480B-A35B-Instruct 被掩成「Qwen…ruct」。改成按大小写交替判：
  // 一开始数「段内交替的段数 >= 2」，这把 sk-ant-api03-Eyai1pkJrF_Kbwt 漏了——
  // 它只有 Ey 一处段内交替（其余段 k 前是分隔符或已是小写），整串可读。那是我
  // 在 9aa0bcd 引入的回归，r35（5f38d60）本来是掩的。改成数「整词里 [a-z][A-Z]
  // 出现的总次数」：sk-ant-api03-Eyai1pkJrF_Kbwt 有 Ey 与 Kw 两处，判为 key；
  // 名字段落首字母大写、段内不再翻转，DeepSeek-V3-2-Chat-Preview 的
  // 「Preview」以后没有小写接大写，MyProvider-… 的「MyPr」以后也没有，各只算一处。
  const dir = fixture("msmoli-glueword-")
  try {
    const keys = [
      "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
      "nUJqxrpd9Bc7-GvG7J--onUJqxrpd9Bc7-GvG7J--o",
      "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY",
      // 单处段内交替的厂商密钥：这一条是 9aa0bcd 的回归，缺了它那次的改动不会红
      "sk-ant-api03-Eyai1pkJrF_Kbwt",
      "sk-ant-api03-Eyai1pkJrF_KbwtQm3Z8Vd2Nc7Rt5Hs",
    ]
    for (const key of keys) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", key], log: (s) => out.push(s) })
      const kept = longestKept(out.join("\n"), key)
      assert.ok(kept.length < 12, `${key}：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
    }
    const names = [
      "Qwen3-Coder-480B-A35B-Instruct",
      "MyProvider-Prod-Edition-2026",
      "DeepSeek-V3-2-Chat-Preview",
      "some-long-file-name-WithCaps",
      "modelscope-backup-2025-east",
      "sk-anti-fraud-review-team",
    ]
    for (const v of names) {
      const out = []
      await main({ argv: ["--dir", dir, "--status", "--from", v], log: (s) => out.push(s) })
      assert.ok(out.join("\n").includes(v), `${v} 被误掩：\n${out.join("\n")}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a word of nothing but punctuation does not stall maskKeys", async () => {
  // maskKeys 原先用 `word.slice(lead).match(/[^…]*$/)` 找回尾部的标点：锚尾的
  // 星号式回溯在一个字母开头、字母结尾、中间全是标点的词上，从每个起点重试一遍
  // 直到穷尽，20 万字符一次匹配实测 117 秒，而服务端能把这样的串放进名字。
  // 改成两头各一次线性内移后是 0.3ms。全标点的词不行——它在第一个起点就匹配成功，
  // 旧实现 0.6ms 就过，那样测不出东西
  const dir = fixture("msmoli-punct-")
  try {
    const bomb = "a" + "!".repeat(200_000) + "a"
    const out = []
    const t0 = performance.now()
    await main({ argv: ["--dir", dir, "--status", "--from", bomb], log: (s) => out.push(s) })
    const ms = performance.now() - t0
    assert.ok(ms < 2000, `病态标点词耗时 ${ms.toFixed(0)}ms，判定为二次回溯未修`)
    assert.ok(out.join("\n").includes(bomb), `病态标点词该原样保留`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a non-ms key cut by an invisible character is still masked whole", async () => {
  // 第 31 轮只给 ms- 形状做了「跨不可见字符」（tokenShaped 的 INV*）。别的形状
  // 没有：一把 27 位的 ghp_ 令牌被零宽空格切成 13+14，两半都低于 16 位下限，
  // 词级判据都不认，后 14 位原样上终端（实测「92c6912E7710c8」）；sk-ant 本体
  // 同样留下 12 位。GLUE 在 show() 之前，把「两侧都是 key 字母表字符」的不可见
  // 字符去掉——真正应算分隔的空格、换行、逗号不在两侧，不受影响。
  const dir = fixture("msmoli-gluecut-")
  try {
    const keys = [
      "ghp_16C7e42F292c6912E7710c8",
      "sk-ant-api03-Eyai1pkJrF_Kbwt",
      "AbCdEfGh.IjKlMnOp.QrStUvWx",
      "abcdefghij0123456789=",
    ]
    for (const key of keys) {
      for (const cut of ["​", "\x01", "⁠", "﻿"]) {
        const at = Math.floor(key.length / 2)
        const pasted = key.slice(0, at) + cut + key.slice(at)
        const out = []
        await main({ argv: ["--dir", dir, "--status", "--from", pasted], log: (s) => out.push(s) })
        const kept = longestKept(out.join("\n"), key)
        assert.ok(kept.length < 12, `${JSON.stringify(key)} 夹 ${JSON.stringify(cut)}：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
      }
    }
    // 真正该分隔的地方不被粘：两段普通词之间夹不可见字符仍是两段
    const o = []
    await main({ argv: ["--dir", dir, "--status", "--from", "alpha​beta"], log: (s) => o.push(s) })
    assert.ok(o.join("\n").includes("alpha"), "普通词不受影响")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
