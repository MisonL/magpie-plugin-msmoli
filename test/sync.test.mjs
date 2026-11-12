import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  arg,
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
  scrub,
} from "../bin/sync.mjs"

// Fake token: the shape is right, but it is obviously not real (the sample in the README has the same shape)
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
  // when --from names a different id, do not guess
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

test("planToPlugin refuses a key both sides share but the plugin cannot send", () => {
  // "the same token" and "a token that works" are different questions: a key
  // with a space in it is identical on both sides and unusable — the plugin
  // would answer every check-in with a token it cannot recognise. Reporting
  // noop would say everything is fine.
  const bad = "ms-aaaa 1111-bbbb"
  const p = planToPlugin({ preset: presetOf(bad), accounts: [{ name: "msmoli", token: bad }], force: false })
  assert.equal(p.action, "refuse", p.lines.join("\n"))
  assert.match(p.lines.join("\n"), /发不出去/)
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

// On Windows, Node turns an argument starting with "/" into "C:\...", so every
// assertion in the probing layer builds its expected value with
// join()/pathToFileURL instead of hard-coding a POSIX literal—these tests
// produce the same values on Linux/macOS and each platform's own values on Windows.
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

test("--version answers the package's own version, beside a stray argument too", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
  for (const args of [["--version"], ["-v"], ["--nope", "--version"]]) {
    const r = run(args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    assert.equal(r.stdout.trim(), `magpie-plugin-msmoli ${pkg.version}`, `the version drifted from package.json: ${r.stdout}`)
  }
  assert.match(run(["--help"]).stdout, /--version/, "the usage page names the flag")
})

test("a key typed as wipe-unknown-argument is masked in every spelling", () => {
  // The final review typed the key into a position the parser does not know.
  // The error prints the value through arg(), and the value has no job here:
  // there is no secret known before the store is read, and each spelling beat
  // a different arm. Split every 8 characters: each piece under every floor.
  // Upper-cased: the shape is ASCII-case sensitive. Full-width: NFKC is what
  // turns it back into the key, and it is folded one code point at a time.
  const T = "ms-" + "0123456789abcdef".repeat(2)
  const groups = T.match(/.{1,8}/g).join(" ")
  const wide = T.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
  for (const [name, v] of [["groups", groups], ["wide", wide], ["upper", T.toUpperCase()]]) {
    const r = run([v])
    assert.equal(r.status, 1, `${name}: an unknown argument is an error`)
    const text = `${r.stdout}${r.stderr}`
    assert.ok(!text.includes("0123456789abcdef0123456789abcdef"), `${name}: the key body reached the terminal:\n${text}`)
    assert.ok(!text.includes(T) && !text.includes(v), `${name}: the key reached the terminal:\n${text}`)
  }
  // the shapes an ordinary word has must survive: this tool must not turn
  // every argument into a mask
  const benign = run(["ms-dos"])
  assert.equal(benign.status, 1)
  assert.match(`${benign.stdout}${benign.stderr}`, /ms-dos/, "a product name is not a key")
})

test("a vendor key cut into pieces is masked in arg(), and ordinary text is not", () => {
  // Round 10: arg() reads the whitespace routes of a value and masks what it
  // finds (a run of words, a pair either side of a line break). Measured
  // without them: a 40-character ghp_ token cut into four went out whole, a
  // foreign ms- key cut the same way, and an sk-proj key in eighths. The same
  // pass must leave the frames alone — a sentence, a path, a provider id.
  const creds = [
    "ghp_1234AbCd5678EfGh9012IjKl3456MnOp7890",
    "sk-ant-api03-Eyai1pkJrF_Kbwt",
    "ms-foreign-0123456789abcdef0123456789abcdef",
    "sk-proj-AbCdEf123456GhIjK7890LmNoPqRs",
  ]
  const cuts = {
    three: (x) => x.match(/.{1,3}/g).join(" "),
    four: (x) => x.match(/.{1,4}/g).join(" "),
    line: (x) => x.match(/.{1,4}/g).join("\n"),
    line3: (x) => x.match(/.{1,3}/g).join("\n"),
    line1: (x) => x.match(/.{1,1}/g).join("\n"),
    eight: (x) => x.match(/.{1,8}/g).join(" "),
    twelve: (x) => x.match(/.{1,12}/g).join(" "),
    one: (x) => x.match(/.{1,1}/g).join(" "),
    middot: (x) => x.match(/.{1,4}/g).join("\u00b7"),
    middot3: (x) => x.match(/.{1,3}/g).join("\u00b7"),
    middot1: (x) => x.match(/.{1,1}/g).join("\u00b7"),
  }
  for (const c of creds) {
    // a no-break space and an ideographic one are the same cut (a copy out of
    // a Chinese IME, a web page): the run reading joins across them, or the
    // pieces were too short each to be judged and the key went out whole
    const gaps = { ...cuts, nbsp: (x) => x.match(/.{1,4}/g).join("\u00a0"), ideographic: (x) => x.match(/.{1,4}/g).join("\u3000") }
    for (const [how, f] of Object.entries(gaps)) {
      for (const line of [f(c), `--from ${f(c)}`, `no key ${f(c)} for provider`]) {
        const out = arg(line)
        // the separators go with the whitespace: a middot between the pieces
        // is a cut's spelling too, and a key left whole with its middots in
        // place is just as readable
        assert.ok(!out.replace(/[^A-Za-z0-9]/g, "").includes(c.replace(/[^A-Za-z0-9]/g, "")), `${c.slice(0, 12)} cut ${how}: ${JSON.stringify(out)}`)
      }
    }
  }
  for (const t of ["see ms-dos and ms-word now", "the package manager told us to check", "sk-preset-20261031 is a provider id", "/Users/mison/documents/notes"]) {
    const out = arg(t)
    assert.ok(out.includes(t), `ordinary text was masked: ${JSON.stringify(t)} → ${JSON.stringify(out)}`)
  }
})

test("a key cut into pieces by spaces is masked whole, however it was cut", () => {
  // The final review's remaining CLI leak: eight-character groups, one
  // character per word, and a key whose body already had hyphens all printed
  // their pieces back, because every piece sat under the per-word floor and
  // the whole-value test demanded alphanumeric pieces only. The words are now
  // joined before the test — that join is what tells a key apart from a
  // sentence (a sentence does not begin with ms-).
  const T = "ms-" + "0123456789abcdef".repeat(2)
  const wide = (v) => v.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
  const cases = {
    groups: "--" + T.match(/.{1,8}/g).join(" "),
    every_char: [...T].join(" "),
    hyphen_pieces: "--" + T.match(/.{1,8}/g).map((p, i) => (i % 2 ? p.replace(/(.{4})(.{4})/, "$1-$2") : p)).join(" "),
    real_spaced: "ms-aaaa1111 bbbb-2222-cccc-333344445555",
    wide_in_path: "/tmp/" + wide(T),
    wide_groups: wide(T).match(/.{1,8}/g).join(" "),
  }
  for (const [name, v] of Object.entries(cases)) {
    const r = run([v])
    assert.equal(r.status, 1, `${name}: an unknown argument is an error`)
    const text = `${r.stdout}${r.stderr}`.normalize("NFKC")
    const flat = text.replace(/\s/g, "")
    assert.ok(!flat.includes(T.replace(/\s/g, "")), `${name}: the key reached the terminal whole:\n${text}`)
    const body = T.slice(3)
    assert.ok(!flat.includes(body), `${name}: the key body reached the terminal:\n${text}`)
    for (const piece of body.match(/.{8}/g)) {
      assert.ok(!flat.includes(piece), `${name}: an 8-character piece reached the terminal:\n${text}`)
    }
  }
  // and the words this must not eat: a sentence, a list of paths, ordinary
  // text about the product
  for (const v of ["please check --from msmoli --to preset", "--dir /tmp/foo /tmp/bar", "ms-dos is old"]) {
    const r = run([v])
    const text = `${r.stdout}${r.stderr}`
    assert.ok(text.includes(v), `a benign argument was masked: ${JSON.stringify(v)}\n${text}`)
  }
})

test("a key behind a flag prefix, and in capitals, is masked the same way", () => {
  // A review found the pieces an echo writes behind a prefix ("--token=ms-…")
  // and an upper-cased AWS secret printed whole: the first because the front's
  // position in the value was computed from the joined string alone, the second
  // because isKey compared ASCII cases. Both go through the same two doors now.
  const T = "ms-" + "0123456789abcdef".repeat(2)
  const cases = {
    flag_prefix: "--token=" + T,
    flag_prefix_spaced: "--token=" + T.match(/.{1,8}/g).join(" "),
    uppercase_aws: "x AKIAIOSFODNN7EXAMPLE y",
    uppercase_aws_solo: "AKIAIOSFODNN7EXAMPLE",
    newline_inside: "ms-01234567\n89abcdef0123456789abcdef",
    crlf_inside: "ms-01234567\r\n89abcdef0123456789abcdef",
  }
  for (const [name, v] of Object.entries(cases)) {
    const r = run([v])
    assert.equal(r.status, 1, `${name}: an unknown argument is an error`)
    const text = `${r.stdout}${r.stderr}`
    for (const piece of T.slice(3).match(/.{8}/g)) {
      assert.ok(!text.includes(piece), `${name}: a key run reached the terminal:\n${text}`)
    }
  }
  // and the prose around a masked key is printed as it was written, so the
  // host's "no key … for provider" wording keeps its frame
  const prose = run(["no key ms-aaaa1111 bbbb-2222-cccc-333344445555 for provider"])
  assert.equal(prose.status, 1)
  const ptext = `${prose.stdout}${prose.stderr}`
  assert.match(ptext, /no key .* for provider（/, `the frame was lost: ${ptext}`)
  assert.ok(!ptext.includes("aaaa1111") && !ptext.includes("333344445555"), `a piece reached the terminal: ${ptext}`)
})

test("a two-space gap ends the key run, and a version number is not a piece of one", () => {
  // A two-space frame on the key's own alphabet lets the tail leak.
  // A product name with a version after it ("ms-access 2019") was read as
  // a key cut into pieces and masked, which is the kind of over-masking
  // that makes the tool look broken.
  for (const v of ["the ms-cli version 2026.11.9 installed", "Microsoft ms-access 2019 document", "our ms-outlook 365 account"]) {
    const r = run([v])
    const text = `${r.stdout}${r.stderr}`
    assert.ok(text.includes(v), `a product name was masked as a key: ${JSON.stringify(v)}\n${text}`)
  }
  // and the pieces a key is really cut into still mask: the 8-character groups
  // and the one-character-per-word spelling both keep their digits in the
  // first pieces, so the version rule cannot reach them
  const T = "ms-" + "0123456789abcdef".repeat(2)
  for (const v of [T.match(/.{1,8}/g).join(" "), [...T].join(" ")]) {
    const r = run([v])
    const text = `${r.stdout}${r.stderr}`
    for (const piece of T.slice(3).match(/.{8}/g)) {
      assert.ok(!text.includes(piece), `a key piece reached the terminal: ${piece}\n${text}`)
    }
  }
})

test("two token-shaped runs in one value are each masked, not joined into one", () => {
  // The join above must not run across two separate keys: a poisoned provider
  // id carrying both would be masked as one string, hiding both ends. One ms-
  // front means one key; two means the per-word pass, which masks each run.
  const t1 = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const t2 = "ms-zzzz9999-yyyy-8888-xxxx-777766665555"
  const plan = planToPlugin({ preset: { key: A, id: `${t1} ${t2}` }, accounts: [], force: false })
  const text = plan.lines.join("\n")
  assert.ok(!text.includes(t1) && !text.includes(t2), `a token printed whole:\n${text}`)
  assert.match(text, /ms-z…5555/, `the second should be masked by its own ends:\n${text}`)
})

test("a same-but-unsendable key is refused on the reverse noop too", () => {
  // F8: with no main account and a secondary one carrying the preset's key,
  // planToPreset answered noop before SENDABLE ran — the one reverse exit that
  // called a key with a space in it "nothing to do". Both directions must
  // refuse it, whichever side is named.
  const bad = "ms-" + "01234567 89abcdef".repeat(2)
  const plan = planToPreset({
    preset: { id: "modelscope", preset: "modelscope", key: bad },
    accounts: [{ name: "msmoli#abc123", token: bad }],
    force: false,
  })
  assert.equal(plan.action, "refuse", `a same-but-unsendable key was called done: ${JSON.stringify(plan.lines)}`)
  assert.ok(!plan.lines.join("\n").includes(bad), "the key itself is printed in the refusal")
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
  // must the tool, or the preset would read as "not configured". The test goes
  // through readJson — the tool's own reader — rather than stripping the BOM
  // itself, which would only prove the test can.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-bom-"))
  try {
    writeFileSync(join(dir, "providers.json"), "﻿" + JSON.stringify({ providers: [presetOf(A)] }))
    const file = join(dir, "providers.json")
    const raw = readJson(file)
    assert.ok(raw && typeof raw === "object", "a BOM must not make the file unreadable")
    assert.deepEqual(presetCandidates(raw.providers).map((p) => p.id), ["modelscope"])

    // and the whole tool sees it: a BOM'd config is not "not configured"
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

test("a launcher script is followed to the binary it execs, where the write will land", async () => {
  // A shim with a data/ folder beside it passes a guard that reads the shim's
  // own folder: the write goes to the exec target's config, and the read-back
  // then blames "magpie 是否在正常运行". appdir.Resolve judges the process as
  // it really is (the final binary after the exec chain), so the guard follows
  // the exec lines — one hop or several — and refuses when the target's folder
  // is not the one named.
  const real = mkdtempSync(join(tmpdir(), "msmoli-shim-real-"))
  const shim = mkdtempSync(join(tmpdir(), "msmoli-shim-own-"))
  try {
    // the portable install the shim finally runs: .portable makes its data/
    // folder the config dir, whatever else is around
    mkdirSync(join(real, "bin", "data"), { recursive: true })
    writeFileSync(join(real, "bin", ".portable"), "")
    writeFileSync(join(real, "bin", "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    // the shim's own lookalike: a data/ folder with the same files, which is
    // what made the old guard pass
    writeFileSync(join(shim, ".portable"), "")
    writeFileSync(join(shim, "magpie"), `#!/bin/sh\nexec ${join(real, "bin", "magpie")} "$@"\n`, { mode: 0o755 })
    for (const folder of [join(shim), join(real, "bin")]) {
      mkdirSync(join(folder, "data"), { recursive: true })
      writeFileSync(join(folder, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(folder, "data", "plugin-auth.json"), JSON.stringify({}))
    }
    const out = []
    let spawned = false
    const code = await main({
      argv: ["--dir", join(shim, "data"), "--to-plugin", "--magpie", join(shim, "magpie")],
      env: {},
      home: shim,
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false, "the write would land in the exec target's folder, not the one named")
    const text = out.join("\n")
    assert.match(text, /不同的配置目录/)
    assert.match(text, new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal names the folder the write would land in")
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(shim, { recursive: true, force: true })
  }
})

test("a launcher chain is followed to the end, not just one hop", async () => {
  // shimA execs shimB (by a relative name, as a sibling shim is written),
  // shimB execs the real binary. os.Executable() answers at the end of the
  // chain, so the guard must too: stopping at the first hop would compare the
  // write target against shimB's folder, which magpie never keeps files in.
  const real = mkdtempSync(join(tmpdir(), "msmoli-chain-real-"))
  const shimA = mkdtempSync(join(tmpdir(), "msmoli-chain-a-"))
  const shimB = mkdtempSync(join(tmpdir(), "msmoli-chain-b-"))
  try {
    mkdirSync(join(real, "bin", "data"), { recursive: true })
    writeFileSync(join(real, "bin", ".portable"), "")
    writeFileSync(join(real, "bin", "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(shimA, ".portable"), "")
    writeFileSync(join(shimA, "magpie"), `#!/bin/sh\nexec ${join(shimB, "magpie")} "$@"\n`, { mode: 0o755 })
    writeFileSync(join(shimB, ".portable"), "")
    writeFileSync(join(shimB, "magpie"), `#!/bin/sh\nexec ${join(real, "bin", "magpie")} "$@"\n`, { mode: 0o755 })
    for (const folder of [shimA, shimB, join(real, "bin")]) {
      mkdirSync(join(folder, "data"), { recursive: true })
      writeFileSync(join(folder, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(folder, "data", "plugin-auth.json"), JSON.stringify({}))
    }
    const out = []
    let spawned = false
    const code = await main({
      argv: ["--dir", join(shimA, "data"), "--to-plugin", "--magpie", join(shimA, "magpie")],
      env: {},
      home: shimA,
      log: (s) => out.push(s),
      spawn: () => {
        spawned = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(code, 1)
    assert.equal(spawned, false)
    assert.match(out.join("\n"), /不同的配置目录/)
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(shimA, { recursive: true, force: true })
    rmSync(shimB, { recursive: true, force: true })
  }
})

test("a launcher whose exec target's own folder is the one named runs, and one it cannot follow says so", async () => {
  // Following the chain must not over-refuse: when the exec target's config
  // folder IS the one named, the write lands where the user pointed, and the
  // run goes ahead. A launcher we cannot follow (its exec names a target that
  // does not exist as a path) has no folder to confirm, so the guard falls
  // back to the script's own folder — and if the read-back then finds no
  // token, the failure says a wrapper was involved rather than blaming only
  // "magpie 是否在正常运行".
  const real = mkdtempSync(join(tmpdir(), "msmoli-shim-same-"))
  const shim = mkdtempSync(join(tmpdir(), "msmoli-shim-lost-"))
  try {
    mkdirSync(join(real, "bin", "data"), { recursive: true })
    writeFileSync(join(real, "bin", ".portable"), "")
    writeFileSync(join(real, "bin", "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(shim, ".portable"), "")
    // the followable one: target's folder is the --dir, so the run goes ahead
    writeFileSync(join(shim, "magpie"), `#!/bin/sh\nexec ${join(real, "bin", "magpie")} "$@"\n`, { mode: 0o755 })
    // the untraceable one: the named target is nowhere
    writeFileSync(join(shim, "lost"), `#!/bin/sh\nexec ${join(shim, "nowhere")} "$@"\n`, { mode: 0o755 })
    for (const folder of [shim, join(real, "bin")]) {
      mkdirSync(join(folder, "data"), { recursive: true })
      writeFileSync(join(folder, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(folder, "data", "plugin-auth.json"), JSON.stringify({}))
    }
    // the followable launcher writes where the user named: mock does the write
    // the real login would, so the read-back finds the token
    const out = []
    const code = await main({
      argv: ["--dir", join(real, "bin", "data"), "--to-plugin", "--force", "--magpie", join(shim, "magpie")],
      env: {},
      home: shim,
      log: (s) => out.push(s),
      spawn: (_cmd, argv) => {
        writeFileSync(join(real, "bin", "data", "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: argv.includes("logout") ? "✓ signed out" : "✓ signed in", stderr: "" }
      },
    })
    assert.equal(code, 0, out.join("\n"))
    assert.doesNotMatch(out.join("\n"), /包装脚本/, "a followable launcher needs no wrapper note")

    // without --dir the default folder is the exec target's, not the shim's:
    // reading the shim's own folder would sync against a config magpie never
    // writes to, and the write would land in the target's folder anyway
    const out3 = []
    const code3 = await main({
      argv: ["--to-plugin", "--force", "--magpie", join(shim, "magpie")],
      env: {},
      home: shim,
      log: (s) => out3.push(s),
      spawn: (_cmd, argv) => {
        writeFileSync(join(real, "bin", "data", "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: argv.includes("logout") ? "✓ signed out" : "✓ signed in", stderr: "" }
      },
    })
    assert.equal(code3, 0, out3.join("\n"))
    assert.match(out3.join("\n"), new RegExp(join(real, "bin", "data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), out3.join("\n"))

    // the untraceable one is refused before anything runs: its exec names a
    // target that exists nowhere, so where a write would land cannot be said —
    // and a token written into a magpie the user did not name is the one thing
    // the guard exists to prevent
    const out2 = []
    let spawned2 = false
    const code2 = await main({
      argv: ["--dir", join(shim, "data"), "--to-plugin", "--force", "--magpie", join(shim, "lost")],
      env: {},
      home: shim,
      log: (s) => out2.push(s),
      spawn: () => {
        spawned2 = true
        return { status: 0, stdout: "✓ signed in", stderr: "" }
      },
    })
    assert.equal(code2, 1)
    assert.equal(spawned2, false, "an unfollowable launcher must not reach the write")
    assert.match(out2.join("\n"), /包装脚本/, out2.join("\n"))
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(shim, { recursive: true, force: true })
  }
})

test("a launcher chain that does not bottom out is not followed, and says so", async () => {
  // The hop bound and the cycle check keep a pathological chain from being
  // walked forever — and an unresolvable chain is exactly the case the
  // read-back wrapper note exists for. Neither had a test: deleting the cycle
  // check left the whole suite green. Pinned: a two-shim ring, a shim that
  // execs itself, and a chain one hop past the bound all stay unresolvable
  // (the guard falls back to the script's own folder, the run goes ahead, and
  // a failed read-back says a wrapper was involved), while a chain inside the
  // bound still resolves.
  const shimOf = (dir, line) => {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, ".portable"), "")
    writeFileSync(join(dir, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({}))
    writeFileSync(join(dir, "magpie"), line, { mode: 0o755 })
    return join(dir, "magpie")
  }
  const dirs = []
  const T = (n) => `msmoli-chain-${n}-`
  const ringA = mkdtempSync(join(tmpdir(), T("ra")))
  const ringB = mkdtempSync(join(tmpdir(), T("rb")))
  const selfRing = mkdtempSync(join(tmpdir(), T("self")))
  dirs.push(ringA, ringB, selfRing)
  shimOf(ringA, `#!/bin/sh\nexec ${join(ringB, "magpie")} "$@"\n`)
  shimOf(ringB, `#!/bin/sh\nexec ${join(ringA, "magpie")} "$@"\n`)
  shimOf(selfRing, `#!/bin/sh\nexec ${join(selfRing, "magpie")} "$@"\n`)

  // eight files each execing the next, the last naming a target that exists
  // too — the bound stops the walk one file before it could answer "the
  // bottom of this chain"
  const chainDirs = []
  for (let i = 0; i < 8; i++) {
    const dir = mkdtempSync(join(tmpdir(), T(`h${i}`)))
    chainDirs.push(dir)
    dirs.push(dir)
    shimOf(dir, "") // placeholder, real line written below
  }
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(chainDirs[i], "magpie"), `#!/bin/sh\nexec ${join(chainDirs[i + 1], "magpie")} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(join(chainDirs[7], "magpie"), `#!/bin/sh\nexec ${join(chainDirs[7], "next")} "$@"\n`, { mode: 0o755 })
  writeFileSync(join(chainDirs[7], "next"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

  // seven shims and a plain bottom: eight reads, the most the bound allows,
  // so a chain that fits inside it still resolves (one hop fewer and the
  // bound itself would be untested — the walk would stop before the bottom)
  const shortDirs = []
  for (let i = 0; i < 8; i++) {
    const dir = mkdtempSync(join(tmpdir(), T(`s${i}`)))
    shortDirs.push(dir)
    dirs.push(dir)
    shimOf(dir, "")
  }
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(shortDirs[i], "magpie"), `#!/bin/sh\nexec ${join(shortDirs[i + 1], "magpie")} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(join(shortDirs[7], "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

  for (const [tag, bin] of [
    ["ring", join(ringA, "magpie")],
    ["self", join(selfRing, "magpie")],
    ["eight", join(chainDirs[0], "magpie")],
  ]) {
    const out = []
    const code = await main({
      argv: ["--dir", join(dirname(bin), "data"), "--to-plugin", "--force", "--magpie", bin],
      env: {},
      home: dirname(bin),
      log: (s) => out.push(s),
      spawn: () => ({ status: 0, stdout: "✓ signed in", stderr: "" }),
    })
    assert.equal(code, 1, `${tag}: the read-back fails because nothing was written`)
    assert.match(out.join("\n"), /包装脚本/, `${tag}: the failure names the wrapper`)
  }

  // a chain inside the bound still resolves to the bottom, so the run goes
  // ahead and the read-back finds the token the mock wrote
  const bottom = join(shortDirs[7], "data", "plugin-auth.json")
  const out = []
  const code = await main({
    argv: ["--dir", join(shortDirs[7], "data"), "--to-plugin", "--force", "--magpie", join(shortDirs[0], "magpie")],
    env: {},
    home: shortDirs[7],
    log: (s) => out.push(s),
    spawn: (_cmd, argv) => {
      writeFileSync(bottom, JSON.stringify({ msmoli: { type: "api", key: A } }))
      return { status: 0, stdout: argv.includes("logout") ? "✓ signed out" : "✓ signed in", stderr: "" }
    },
  })
  assert.equal(code, 0, out.join("\n"))
  assert.doesNotMatch(out.join("\n"), /包装脚本/, "a resolved chain needs no wrapper note")
  try {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  } catch {}
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
  // FAILED, so nothing has run yet, and the line saying the earlier steps ran
  // and the existing sign-in was logged out would be a lie that reads as "your
  // sign-in is gone". As `i > -1` every step carries it. The two-step tests
  // above assert the line's presence on later steps; nothing asserted its
  // absence on the first.
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
  // account in and leaves every check-in saying the token content is
  // unrecognized — a success the tool reports for a key that cannot work.
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
  // its token is the one the preset already has. --to-plugin answers "nothing
  // to do" for the same pair of files; --to-preset used to refuse saying the
  // main account was not signed in, which reads as "your plugin is signed out".
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli#abc123", token: A }], force: false })
  assert.equal(p.action, "noop")
  assert.match(p.lines.join("\n"), /无需操作/)
})

test("a provider that is ours but has no key is a destination for --to-preset, and told so for --to-plugin", async () => {
  // providers.json keeps providers without keys (magpie writes its own plugin
  // providers that way). A bare one is exactly what --to-preset can fill —
  // refusing it here meant the reverse sync could never populate a preset the
  // user had already added. --to-plugin still needs a key to read, so it keeps
  // telling the user to fill it in; "Add ModelScope" would name one they
  // already have.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-keyless-"))
  try {
    writeFileSync(
      join(dir, "providers.json"),
      JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", chat: "https://api-inference.modelscope.cn/v1", key: "" }] }),
    )
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const run = async (argv, onSpawn = () => {
      throw new Error("must not run anything here")
    }) => {
      const out = []
      const code = await main({ argv: [...argv, "--dir", dir, "--magpie", "/nonexistent"], log: (s) => out.push(s), spawn: onSpawn })
      return { code, text: out.join("\n") }
    }
    // the forward direction has no token to read
    const forward = await run(["--to-plugin"])
    assert.equal(forward.code, 1)
    assert.match(forward.text, /还没有 key/)
    assert.match(forward.text, /provider key modelscope/)
    assert.doesNotMatch(forward.text, /供应商」页添加/)

    // the reverse direction fills it: an empty preset has no key to replace,
    // so --force (the permission to replace one chat may be using) is not
    // asked for here
    const bare = await run(["--to-preset"], (_cmd, argv) => {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: argv.at(-1) }] }))
      return { status: 0, stdout: "ok", stderr: "" }
    })
    assert.equal(bare.code, 0, bare.text)
    assert.match(bare.text, /还没有 key/) // the status line says the preset is keyless
    assert.match(bare.text, /现在没有 key，会被填上/)
    assert.equal(bare.text.includes(A), false, "no line may print a token")

    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: "" }] }))
    const forced = await run(["--to-preset", "--force"], (_cmd, argv) => {
      // magpie writes the key into providers.json; the read-back then finds it
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: argv.at(-1) }] }))
      return { status: 0, stdout: "ok", stderr: "" }
    })
    assert.equal(forced.code, 0, forced.text)
    assert.equal(forced.text.includes(A), false, "no line may print a token")

    // back to the keyless state for the --from spelling
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: "" }] }))
    const byId = await run(["--from", "modelscope", "--to-preset"], (_cmd, argv) => {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key: argv.at(-1) }] }))
      return { status: 0, stdout: "ok", stderr: "" }
    })
    assert.equal(byId.code, 0, byId.text)
    assert.match(byId.text, /现在没有 key，会被填上/, `--from must find the bare provider as a destination: ${byId.text}`)
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

// ---- Round 18: the wide mutation sweep on bin/sync.mjs left 27 surviving
// sites; the ones below pin down those confirmed to make a real difference
// (how equivalent mutants are judged is in each comment)

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
  // "nothing to do" naming an account whose token is not the preset's — while the
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
  // one — as "the built-in side has openai, but no key yet".
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
  // normal. Read as `||`, every successful forced sync reports that the
  // read-back found 1 account in the plugin now and exits 1.
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

// ── Round 24: operators and set checks ──────────────────────────────────

test("the preset direction's read-back fails when the list it reads is empty", async () => {
  // `every` on an empty list is vacuously true. A write that lands but leaves
  // providers.json without a candidate — an emptied list, a provider that was
  // renamed away — then passed the read-back and printed "✓ done" with nothing
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
    { name: "msmoli", token: "", site: "" },
    { name: "msmoli#x", token: B, site: "" },
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

// ── Round 26: statement-level wide sweep ────────────────────────────────
// The same round as plugin.test.mjs: whole statements hollowed out or deleted.
// Below are the sites where the probes measured a real difference; equivalent
// mutants are recorded in each comment.

test("sameFolder's resolved match decides before the volume is asked", () => {
  // When the two realpath strings are equal, the first guard answers true
  // outright and never stats at all. Hollow it out and every pair of equal
  // paths falls through to the inode comparison; on volumes that report ino=0
  // (exFAT, some SMB) there is no identity to compare, and one folder is
  // judged as two—exactly the mistake the --dir guard promises not to repeat.
  // Both spellings resolve to the same string: identity real plus a rule that
  // folds "X/." into "X", platform-independent—on a real machine /tmp and
  // /private/tmp have the same shape (macOS only).
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
  // The second guard answers false outright when either side fails to resolve
  // (""). Hollow it out and "" is sent to stat too; if the injected stat gives
  // an identity even to an empty path, two paths that cannot be resolved are
  // taken for the same folder—the tool would write into a directory magpie
  // never created.
  const real = (p) => (p.startsWith("/nope") ? "" : p)
  const stat = () => ({ ino: 42, dev: 1 })
  assert.equal(sameFolder("/nope", "/tmp", real, stat), false, "missing vs real is not one folder")
  assert.equal(sameFolder("/tmp", "/nope", real, stat), false)
  assert.equal(sameFolder("/nope", "/nope2", real, stat), false, "two unresolvable paths are never one")
})

test("isMain's URL match decides before the volume is asked", () => {
  // When the resolved entry is literally equal to import.meta.url it answers
  // true outright, without asking stat. Hollow it out and, on a volume where
  // stat throws (a permission wall, a dropped share), the catch turns "this is
  // the entry" into "it is not"—the whole sync.mjs is silently skipped, prints
  // nothing, exits 0, and the user believes the sync succeeded.
  const real = (p) => p
  // Build the entry and its URL with join and pathToFileURL ourselves: on
  // Windows both the drive letter and the separator differ, and a hard-coded
  // "/x/bin/sync.mjs" would not match there at all
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
  // hostOf first requires chat to be a string before handing it to new URL.
  // Hollow out that guard and new URL stringifies the array / String object
  // first: ["https://api-inference.modelscope.cn/v1"] stringifies to exactly
  // that address, so a provider whose chat field has the wrong shape is taken
  // for the built-in ModelScope preset—--to-plugin would log its key in to
  // the plugin as an ms token.
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
  // main() stops on a missing preset first, but planToPreset is exported, so a direct call must not be missing these two lines
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
    `✗ 插件里那把令牌含空格、换行或非 ASCII 字符，发不出去，不写进内置预设。`,
    `  先修好插件那边的登录（magpie plugin login msmoli）。`,
  ])
})

test("a file that is there but unreadable is refused with the don't-guess line", async () => {
  // Every "present but unreadable" branch is two lines: which file is broken,
  // and "do not guess its content". Keep only the first line and the user
  // will guess on their own—and guessing wrong overwrites a state that might
  // still have been recoverable. All four shapes share the second line, each
  // through its own guard.
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
      // the header (the config folder) comes first; the refusal itself is the last two lines
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
  // --from names one of ours that has no key yet
  let r = await run([{ id: "modelscope", preset: "modelscope" }], ["--from", "modelscope"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ "modelscope" 在，但还没有 key，没有可同步的令牌。/)
  assert.match(r.text, /  用 magpie provider key modelscope <key> 写入。/, "and names the command that fills it in")
  // --from names a provider that exists but is not ours
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], ["--from", "openai"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ "openai" 在，但它不是 ModelScope：chat 不指向 api-inference\.modelscope\.cn，id\/preset 也不是 modelscope。/)
  assert.match(r.text, /  这个工具只同步内置的 ModelScope 预设与插件登录态之间的令牌。/, "and says what the tool does sync")
  // --from matched nothing
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], ["--from", "typo"])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ 内置侧没有 id 为 "typo" 的 provider。/)
  assert.match(r.text, /  用 --status 看现有的，或先 magpie provider add typo <key>。/)
  // no --from, and the built-in side has none of ours
  r = await run([{ id: "openai", preset: "openai", key: "sk-x" }], [])
  assert.equal(r.code, 1)
  assert.match(r.text, /✗ 内置侧没有带 key 的 ModelScope 预设。/)
  assert.match(r.text, /  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add modelscope <key>。/)
})

test("--dir and --magpie pointing at different folders names both", async () => {
  // Reading one folder and writing another is precisely why this guard
  // exists; every one of the three lines is information the user needs to
  // align the two arguments: which one was read, which one magpie will write
  // to, and why --dir cannot make it follow.
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
  // When logout exits 0 without really deleting, login adds the new token as a
  // second account; "one account holds the target token" still holds, but that
  // is exactly the state planToPlugin says --force does not apply to. The
  // read-back must count accounts and say how it became two.
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
  // Unreadable means "the write succeeded but cannot be confirmed", not "the
  // token was not found"—the latter sends people to check whether magpie is
  // running. The page to look at differs by direction, so where must be right too.
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
  // Hollow out `return 0` and main returns undefined; the isMain block puts
  // that into exitCode, so production is still 0, but main's return value is
  // its contract with the caller, and every path should be a number.
  const code = await main({ argv: ["--help"], log: () => {} })
  assert.equal(code, 0)
})

test("a bare --dry-run says both that it needs a direction and that nothing ran", async () => {
  // Without --to-* it only reports the plan: the first line says the
  // direction, the second (only under --dry-run) says nothing ran. Delete the
  // second line and a bare --dry-run looks as if it ran—the user leaves with
  // the impression that it already synced. Both lines must be there.
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
  // rooted()'s os parameter exists for "testing Windows on a Mac": on real
  // Windows path.isAbsolute("\\rel") is already true, and this lets the
  // simulation take the same path. Without it, the simulated win32 treats
  // \rel as a relative path, goes off to read ~/.config, and asks the wrong
  // directory when deciding which portable data folder it belongs to.
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
  // Search order is priority order: when magpie is installed in both places,
  // the one listed first wins. Swap the first two candidates and Intel
  // Homebrew's /usr/local/bin yields to the binary of unknown origin in
  // /usr/bin—and the token is in its hands.
  const both = new Set(["/usr/local/bin/magpie", "/usr/bin/magpie"])
  assert.equal(
    findMagpieBin({ os: "linux", env: {}, home: "/h", exists: (p) => both.has(p) }),
    "/usr/local/bin/magpie",
  )
})

test("the read-back checks the provider it wrote to, not any provider holding the key", async () => {
  // --to-preset writes to the provider --from named. If the read-back uses
  // the default rule (any ModelScope preset), another provider that happens to
  // hold the same key can make a write that never landed report "✓ done"—the
  // user thinks it synced, but nothing changed.
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
      // the write did not land: magpie exited 0 but did nothing, and alt still has A
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 1, "the write did not land, and the tool must say so")
    assert.match(out.join("\n"), /回读没找到目标 key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the config files are read through the exists main was given", async () => {
  // exists is main's injection point: a file stat can see but cannot be read
  // (being written, permissions tightened) goes through exactly this seam. It
  // decides "present but unreadable". Drop this argument and the same file
  // becomes "not configured"—sending the user to create a provider that
  // already exists.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-seam1-"))
  try {
    // providers.json is not on disk, but exists says it is: unreadable
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
    // providers.json is there; plugin-auth.json is not on disk but exists says it is
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
  // After the write magpie may be rewriting the file: exists says it is there,
  // the read cannot read it. The read-back must then say "the write ran but
  // cannot be confirmed", not "the token was not found"—the latter sends people
  // to check why magpie is not running, when the write actually landed. Drop
  // this argument, the read-back falls back to existsSync, and the two
  // sentences say something else.
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
        // right after login the file is briefly not on disk; exists still answers "yes", so the read cannot read it
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
  // norm's `String(p ?? "")`: undefined/null read as the empty string, norm
  // returns "" early, and `sameFolder(undefined, undefined)` is therefore
  // false—two "no path given" values are not the same folder, exactly the
  // "two nonexistent folders are never equal" rule in the comment. Miss the
  // default and String(undefined) = "undefined" becomes a non-empty string,
  // both sides resolve to the same word, and the method says "they are the same".
  const identity = (p) => p
  const stat = () => ({ ino: 1, dev: 1 })
  assert.equal(sameFolder(undefined, undefined, identity, stat), false)
  assert.equal(sameFolder(null, null, identity, stat), false)
  assert.equal(sameFolder(undefined, "undefined", identity, stat), false)
  assert.equal(sameFolder("undefined", undefined, identity, stat), false)
  // two strings both spelled "undefined" are still the same (these are two real words)
  assert.equal(sameFolder("undefined", "undefined", identity, stat), true)
  // 0 / false are not nullish: `??` keeps them, and String makes them "0" /
  // "false", so two of the same value are still the same folder; `||` would
  // read them as the empty string and turn a pair of equals into "no path was
  // given".
  assert.equal(sameFolder(0, 0, identity, stat), true)
  assert.equal(sameFolder(false, false, identity, stat), true)
})

test("a provider with no id is not displayed as 'undefined'", async () => {
  // show's `String(s ?? "")`: for a preset row in providers.json with no id,
  // the status line should read "built-in ModelScope: (ms-a…5555)", not
  // "undefined (…)". The `||` side is numeric 0/false ids: they are truthy,
  // and `String(0)` = "0" should be displayed.
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

// ── Round 30: same batch of fixes as the plugin (account-type rule, empty-token refusal, fragment masking) ──

test("a plugin account is one the plugin could actually read: type api, key a string", () => {
  // The plugin itself (rawKey in index.mjs) only accepts keys with
  // type === "api". Without that rule the tool, given a plugin-auth.json
  // whose token sits in the wrong type or place, would say "already using the
  // same token, nothing to do" while the plugin cannot read it and the card
  // shows signed out forever—a silently wrong state.
  const auth = {
    msmoli: { type: "api", key: A },
    "msmoli#oauth": { type: "oauth", key: B },
    "msmoli#nostr": { type: "api", key: 12345 },
  }
  // site is the origin the plugin recorded after its own probe; an account
  // that never had one carries "" (the site check below reads only a filled
  // one)
  assert.deepEqual(pluginAccounts(auth), [
    { name: "msmoli", token: A, site: "" },
    { name: "msmoli#oauth", token: "", site: "" },
    { name: "msmoli#nostr", token: "", site: "" },
  ])
})

test("a plugin entry whose token cannot be read is a refusal, not 'tokens differ'", () => {
  // When no entry yields a token, "the tokens differ" is something we cannot
  // say—the plugin side was not read at all. --force does not help either: the
  // problem is the file, not the choice.
  const p = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: "" }], force: false })
  assert.equal(p.action, "refuse")
  assert.match(p.lines.join("\n"), /条目读不出令牌/)
  assert.equal(p.cmds.length, 0)
  // as long as one can be read, the rest still take the "differ" branch
  const mixed = planToPlugin({ preset: presetOf(A), accounts: [{ name: "msmoli", token: "" }, { name: "msmoli#x", token: B }], force: false })
  assert.match(mixed.lines.join("\n"), /两边令牌不同/)
})

test("a fragment of a secret in the child's output is masked too", async () => {
  // When the child (or the vendor behind it) echoes back only a fragment of
  // the token, it no longer equals the whole string and split() walks past it.
  // scrub's maskEchoes masks fragments by "contiguous substring, length >= MIN_ECHO".
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

test("an echo with a letter dropped in between its pieces is masked, and the words around it are not", async () => {
  // The pieces a child is given can be under MIN_ECHO each while their sum is
  // the key, with a letter of the child's own text between them. One such
  // letter is stepped over always; more than one only once the run already
  // carries MIN_ECHO characters, so "said: aaaa1111-b" stays readable. The
  // mask replaces the run only, and the frame around it ("no key … for
  // provider") is printed as it was.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-echo-filler-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    const body = A.slice(3).replace(/-/g, "")
    const cases = [
      ["one filler, the whole key behind it", `no key ms-aaaa1111x ${A.slice(3)} for provider`, /^no key ms-a…5555 for provider$/],
      ["two fillers, both pieces over the floor", `the log said ${body.slice(0, 10)}x ${body.slice(10, 20)}x ${body.slice(20)} end`, /^the log said ms-a…5555 end$/],
    ]
    for (const [name, line, want] of cases) {
      for (const where of ["stdout", "stderr"]) {
        const out = []
        await main({
          argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
          log: (s) => out.push(s),
          spawn: () => ({ status: 7, stdout: where === "stdout" ? line : "", stderr: where === "stderr" ? line : "" }),
        })
        const shown = out.join("\n").split("\n").filter((l) => l.startsWith(line.slice(0, 4))).pop() ?? ""
        assert.match(shown, want, `${name} (${where}): 一行输出被读成了 ${JSON.stringify(shown)}，原文 ${JSON.stringify(out.join("\n"))}`)
        for (const piece of body.match(/.{10}/g)) {
          assert.ok(!shown.includes(piece), `${name} (${where}): 一段 key 漏了: ${piece}\n${shown}`)
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a token-shaped run with an underscore in the child's output is masked", async () => {
  // The old pattern /ms-[A-Za-z0-9][A-Za-z0-9-]{10,}/ missed underscores,
  // dots and tildes; the plugin's SENDABLE allows all printable ASCII. Shape
  // rules have to line up, or a real token with an underscore goes through
  // verbatim when magpie echoes it.
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
  // Before, scrub passed the whole block through show(), and show's control-
  // character replacement turns \n into a space too; both calls rely on
  // split("\n") to echo/quote line by line. Switch to per-line show, and the
  // line structure must not break.
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
  // hidden()'s `secret && a === secret` is the masking branch: mask only on
  // positional equality. Remove it and the remaining show(a) only recognises
  // the ms-… shape, so a real credential not starting with ms- (the one
  // --to-preset puts into argv, any key stored in the plugin) is printed
  // verbatim. This is the only coverage for hidden()'s secret branch when
  // shape rules cannot help.
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

// ── Round 31: review batch (invisible characters splitting a token, runtime
// errors echoing a path, the write guard skipped under the Windows extension,
// non-ms-shaped values, read-back shapes, repeated arguments) ──────────────

// both files written: tests that stub exists() say they are there
const fixture = (prefix, providers = [presetOf(A)], auth = {}) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  return dir
}

test("a token cut by an invisible character is still masked where it is printed", async () => {
  // show() first replaces control/format characters with spaces, then masks
  // by shape: a zero-width space (often carried along when a token is copied
  // from a chat app) or \x01 splits the token into two pieces, each below the
  // length floor, and the whole string reaches the terminal verbatim.
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
  // scrub's maskEchoes finds fragments as contiguous substrings: when the
  // child's echo has a \x01 inside the token, the first 11 characters are
  // below MIN_ECHO and stay as they are. Invisible characters must be skipped over.
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
  // spawnSync's ENOENT writes the whole path into message ("spawnSync <path>
  // ENOENT"), and that half never went through show(): a token-shaped path
  // with a slash reached the terminal whole, control characters and all.
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
  // --to-preset's provider key replaces the preset's existing key: the old
  // one is a real credential too, and a host error may echo it when it is
  // replaced. It is a self-hosted vendor's key, not ms-shaped—the shape test
  // does not recognise it, and the runtime error path used to filter only the
  // current step's secret, so the whole string leaked out.
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
  // show() only knows the ms- shape. Another vendor's key pasted in the wrong
  // place (ghs_…, sk-…) was echoed whole in three places: --from, an unknown
  // argument, and a bare --magpie. A string of 16+ alphanumerics with letters
  // and digits is what a generated key looks like; a provider id does not.
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
    // a real id still reads through: hyphenated names and long all-letter names
    // do not look like keys (the same goes for a 16-character lowercase
    // alphanumeric run like modelscope20261031: it is just an id—round 32
    // settled that—a pure lowercase run below the floor is a name, not a key)
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
  // On Windows spawnSync appends .exe to a path with no extension before
  // running it; existsSync does not. When the guard only consulted exists(bin)
  // it skipped itself: reading the fixture while writing the real magpie folder.
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
    // a truly nonexistent binary still passes the guard: it cannot run, so it cannot write anywhere
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

test("a reader that closes the pipe early is not a crash", async () => {
  // `sync --status | head -1` closes stdout after one line. Without a handler
  // the next write raised an unhandled EPIPE and the terminal showed Node's
  // stack instead of the plan. The tool must leave quietly; the pipeline's own
  // reader carries the verdict.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-epipe-"))
  try {
    const providers = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, chat: `https://example${i}.com`, key: `k${i}` }))
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const cli = fileURLToPath(new URL("../bin/sync.mjs", import.meta.url))
    const r = await new Promise((resolve) => {
      const p = spawnSync(process.execPath, [cli, "--dir", dir, "--status"], { encoding: "utf8", timeout: 30_000 })
      resolve(p)
    })
    // spawnSync captures all output, so EPIPE needs a reader that goes away:
    // run it through a shell pipeline instead
    const out = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${cli}" --dir "${dir}" --status | head -1`], {
      encoding: "utf8",
      timeout: 30_000,
    })
    assert.equal(out.status, 0, `the pipeline failed: ${JSON.stringify(out.stderr)}`)
    assert.ok(!/EPIPE|Unhandled 'error'/.test(out.stderr ?? ""), `the crash trace reached stderr: ${out.stderr}`)
    assert.ok(r.status === 0 || r.status === 1, "the direct run is sane")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a read-back that is the wrong shape is 'cannot read', not 'not found'", async () => {
  // The pre-write check recognises shapes ([], "x" and null all count as
  // unreadable); the read-back only recognises null: a plugin-auth.json that
  // became [] was reported as "target token not found, check whether magpie is
  // running".
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
  // Giving both directions at once is refused, but the three value-carrying
  // parameters silently take the latter: --magpie A --magpie B wrote B.
  // --dir=x used to be treated as an unknown argument.
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
  // The path is the user's own and stays readable: a path with a long run of
  // alphanumerics is not a key. An echo split by a newline is still the token,
  // and each half below MIN_ECHO must be masked whole too.
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

// ── Round 32: review batch (per-segment masking, key shapes completed, the two lines agreeing, blank values) ──

test("a key of any shape is masked in a typed value, and a path keeps its shape", async () => {
  // Round 31's shape only recognised "no path separator, and a 16+ mix of
  // letters and digits", so an AWS secret containing /, xoxb and UUIDs leaked
  // whole; a token embedded in a path did too.
  const dir = fixture("msmoli-shapes-")
  try {
    const keys = [
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      // split and concatenated: GitHub's push protection would take the whole string for a real Slack token and block the push.
      "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      "550e8400-e29b-41d4-a716-446655440000",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "sk-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2",
      "AKIAIOSFODNN7EXAMPLE",
      // self-made and already expired (exp 2018, sub=fixture): secret-scanning
      // services flag the JWT shape as a real credential, but there is nothing
      // to report on an expired token; all this needs is "three long segments".
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
        // no contiguous "key-like" run may appear whole
        for (const run of k.match(/[A-Za-z0-9]{16,}/g) ?? []) {
          assert.ok(!text.includes(run), `${k} 的 ${run} 漏了：\n${text}`)
        }
        assert.ok(!text.includes(k), `${k} 整串漏了：\n${text}`)
      }
    }
    // a path reads out as a path: only the key-like segment inside is masked, the directory itself stays
    const out = []
    await main({ argv: ["--dir", dir, "--status", "--from", "/tmp/ghp_16C7e42F292c6912E7710c838347Ae178B4a"], log: (s) => out.push(s) })
    assert.match(out.join("\n"), /\/tmp\/ghp_16C7…8B4a/, `路径形状保留：\n${out.join("\n")}`)
    // normal ids and paths stay readable
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
  // The config-dir line goes through arg(), but the two lines after it—"read
  // from" and "will write to"—used to go through show(): the same value
  // masked in one place and whole in another. Only by making --dir and
  // --magpie point at different folders do those two lines get reached.
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
  // a --dir value of a single space was accepted as legal, and the error line came out as "✗ <space> has no…", reading like a bug.
  for (const argv of [["--dir", " ", "--status"], ["--from", "  "], ["--dir=  ", "--status"]]) {
    await assert.rejects(main({ argv, log: () => {} }), /缺少值/, argv.join(" "))
  }
})

test("a child's echo of a key that is not the one this run holds is still masked", async () => {
  // The show() at the end of scrub only knows the ms- shape: when a magpie
  // error echoed another vendor's token (ghp_…), it reached the terminal
  // verbatim. Per-segment masking covers long runs outside the known shapes
  // too. From round 35, when one word is a whole key it is masked as a whole
  // word, revealing its own two ends (ghp_…8B4a) instead of the two ends of
  // that long run—four fewer characters of the middle are exposed.
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
  // Round 31 changed maskEchoes to "skip invisible characters position by
  // position", which degenerates to O(n²) on runs of control characters:
  // 20,000 \x01s took 79 seconds, and one dirty line from a child process can
  // stall the whole run. The two-pass form (collect visible characters, scan
  // once over the visible sequence, then map back to the original string) is
  // linear.
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

// ── Round 33: another vendor's key pasted into the id field ──────────────

test("a provider id that is another vendor's key is masked wherever it is named", async () => {
  // Ids and account names also come from local files and are echoed too, but
  // they used to pass only through show(): show knows just the ms- shape, so
  // a ghp_/AWS/xoxb-shaped key pasted into the id field was printed whole
  // (--status's "built-in ModelScope:" line, the plan lines, and the provider
  // key command echo).
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
  // ids and paths of normal shape stay readable
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
  // Three other exits of the same defect: the ambiguity hint (two candidates
  // sharing one id), the hint for a provider of ours that has no key yet, and
  // the line listing account names when the read-back finds several accounts.
  // Ids and account names both come from local files, and a pasted foreign key
  // must be masked here too.
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
      // --magpie /nonexistent makes runnable false and skips the "--dir and
      // --magpie folders differ" guard; without it the run first hits the real
      // magpie folder on this machine (measured: that line was where it died)
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

// ── Round 34: secrets with separators (the AWS secret shape) ─────────────

// The longest contiguous substring that "appears in the output as-is".
// The criterion uses 12, from the same source as mask/min's floor: an overlap
// shorter than 12 is accidental and not a leak; 12 or more is real material
// someone could get.
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
  // The criterion masks only by "contiguous alphanumeric run", so in an AWS
  // secret (wJalr…/K7MDENG/bPxRfi…) only the 18-character run was masked and
  // the first 26 characters reached the terminal verbatim—and its segments are
  // only 13/7/18 long, so the whole "16+ character segment" assertion could
  // not see it. Any value that splits into words and is not path-shaped is
  // masked whole.
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
  // The reverse: separators do not mean a secret. A value starting with / ~ .
  // a drive letter or UNC is a path; keep its shape and mask only the key-like
  // segment inside—otherwise an echo like --dir turns into "Docu…oject".
  const dir = fixture("msmoli-tilde-")
  try {
    // the path itself stays readable (all components under 16 characters, no mixed case); the key-like segment inside is still masked
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
    // the PATHY arm itself: even with two 12+ mixed-case components, a value
    // starting with / is a path, not a key (remove !PATHY and these two become
    // "(N characters)")
    for (const p of ["/Documents/NewProject", "/SomeLongDirectoryName/AnotherLongName"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => o.push(s) })
      const text = o.join("\n")
      // the path structure survives: the last component stays readable whole,
      // and only the long camelCase component before it is masked by the
      // existing rule. When the whole string is taken for a key, the entire
      // value shrinks to "/Som…Name" and neither component is visible.
      assert.ok(text.includes("/" + p.split("/").at(-1)), `${p} 以 / 起头，后一个组件该可读：\n${text}`)
    }
    // a relative path of ordinary words: both segments are long (12+), but not mixed case, so it must not be taken for a key
    for (const p of ["documents/mynewprojectfolder", "photographs/vacationphotos", "microservices/documentation"]) {
      const o = []
      await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => o.push(s) })
      assert.ok(o.join("\n").includes(p), `${p} 是小写路径组件，不该被掩：\n${o.join("\n")}`)
    }
    // a token embedded in a path: the path stays, the token segment is masked
    const withToken = "/tmp/ghp_16C7e42F292c6912E7710c838347Ae178B4a"
    const o = []
    await main({ argv: ["--dir", dir, "--status", "--from", withToken], log: (s) => o.push(s) })
    assert.match(o.join("\n"), /\/tmp\/ghp_16C7…8B4a/, `路径里的令牌该只掩那一段：\n${o.join("\n")}`)
    // Known boundary (a trade-off already present in round 32): a single
    // 16+ character mixed-case path component cannot be told apart from "one
    // segment" of a key, and is masked. This pins it down so it is not
    // mistaken for a new defect later.
    const camel = "/Users/mison/Documents/SomeLongDirectoryName"
    const c = []
    await main({ argv: ["--dir", dir, "--status", "--from", camel], log: (s) => c.push(s) })
    assert.match(c.join("\n"), /Some…Name/, `camеlCase 组件按既有规则被掩：\n${c.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Round 35: values with whitespace and keys split by separators into short pieces ──

test("a key pasted with a trailing space, or quoted inside a line, is masked whole", async () => {
  // The criterion runs over the whole value, and isKey returns false as soon
  // as it sees whitespace: "a key with a trailing space" (the most common
  // shape when copying from a terminal or chat window) then falls into
  // per-segment masking, only the long enough segment gets masked, and the
  // leading 28 characters sk-ant-api03-Eyai1pkJrF reach the terminal verbatim.
  // The child's "no key … for provider" line is the same. Word-level
  // criterion: that word is the key, mask the whole word.
  const dir = fixture("msmoli-wordkey-")
  const keys = [
    "sk-ant-api03-Eyai1pkJrF_KbwtQm3Zx8Vd2Nc7Rt5Hs9Lg4Pf6Ba1Ue0YjXLkIhGwSnTvMoDrQpCsAzBxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    // split and concatenated: GitHub's push protection would take the whole string for a real credential and block the push.
    "xoxb-" + "435186639673-1944724303225-OQaLmNbVcXzAsDwErTyUiOp",
    "github_pat_11ABCDEFG0123456789_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrSt",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    // split and concatenated: GitHub's push protection would take the whole string for a real credential and block the push.
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
    // when the child echoes the key inside a sentence, it goes through the same door (arg, word by word)
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
  // The criterion masks by "contiguous alphanumeric run": a key split by
  // - _ . into pieces, none of them 16 characters long (nUJqxrpd9Bc7-GvG7J--o…,
  // AbCdEfGh.IjKlMnOp.…, 9f8e7d6c5b4a3928-1706…) has no qualifying segment and
  // reaches the terminal whole (measured at the bare-argument position:
  // 42/42, 35/35, 33/33).
  const dir = fixture("msmoli-fragkey-")
  const keys = [
    "nUJqxrpd9Bc7-GvG7J--onUJqxrpd9Bc7-GvG7J--o",
    "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
    "deadbeef-cafebabe-0123456789abcdef",
    "9f8e7d6c5b4a3928-1706f5e4d3c2b1a0",
    // one 16-character pure-hex run (letters and digits both): a digest, a
    // session id. Unlike the provider id's date shape (modelscope20261031),
    // it lies entirely within 0-9a-f
    "56b3f97586dedd63",
    // 32+ characters, lowercase letters plus digits, split by separators, with
    // no segment reaching 32—looked at per segment none qualifies (not hex, no
    // uppercase), but together they form one key
    "a1b2c3d4e5f6g7h8i9j0k1l2-o3p4q5r6s7t8u9v0w1",
  ]
  // A 16-character run of mixed lowercase letters and digits that is not all
  // hex is not included: it cannot be told apart character-wise from the
  // provider id's date shape (modelscope20261031), and below the floor it is
  // a name—a trade-off settled in round 32, pinned by the reverse test. What
  // is tested here is the kind split by separators where no segment qualifies
  // on its own, and the kind whose whole run falls inside the hex alphabet
  try {
    for (const key of keys) {
      for (const value of [key, `${key} `, `no key ${key} refused`, `"${key}"`]) {
        const out = []
        await main({ argv: ["--dir", dir, "--status", "--from", value], log: (s) => out.push(s) })
        const kept = longestKept(out.join("\n"), key)
        assert.ok(kept.length < 12, `${JSON.stringify(value.slice(0, 30))}…：原样保留了 ${kept.length} 个字符 ${JSON.stringify(kept)}\n${out.join("\n")}`)
      }
      // the bare-argument position (the unknown-argument branch)
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
  // The reverse: switching the criterion from "one segment" to "whole word
  // with separators removed" may drag ordinary words in. These are shapes that
  // really occur in provider ids / folder names / server wording, and not one
  // character of them should be masked.
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
    // long components inside a path are still masked only in that segment: the path shape survives
    const p = "/Users/mison/Documents/SomeLongDirectoryName"
    const out = []
    await main({ argv: ["--dir", dir, "--status", "--from", p], log: (s) => out.push(s) })
    assert.match(out.join("\n"), /Some…Name/, `路径组件该按段掩：\n${out.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a child's plain key=value words are not masked, and a base64 body still is", async () => {
  // When "contains +/= means key" stands alone, the child's word
  // host=https://… gets masked whole as "(10 characters)", and --from's
  // v1.2.3+sha.abc likewise. The base64 body itself is not let through: it
  // carries a 16+ character alphanumeric run, that segment qualifies on its
  // own, and the whole word is still masked by shape.
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
    // and a base64 body carrying +/= is still key-shaped
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
  // Round 35 removed the old [+=] arm (it masked the child's retry=true and
  // id=12345 whole as "(10 characters)"), and removed too much: short keys
  // below the 16-character floor that only show up because of a + or =
  // (AbCdEfGh+IjKlMnOp, dGhpc2lzYQ==) leaked along with it. The new arm only
  // accepts "the whole word in the key alphabet, >= 12 characters, and either
  // containing + or ending in =": retry=true and id=1234567890 in a query
  // carry a bare =, code=ENOENT has neither, and the dots in v1.2.3+sha.abc
  // are not in the alphabet, so none are masked.
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
  // The glued arm used to be "after removing separators >= 20 characters and
  // mixed case": the provider id MyProvider-Prod-Edition-2026 has both after
  // the hyphens are removed, so it was masked as "MyPr…2026";
  // Qwen3-Coder-480B-A35B-Instruct was masked as "Qwen…ruct". Changed to
  // judge by case alternation: at first it counted "segments with >= 2
  // alternations", which missed sk-ant-api03-Eyai1pkJrF_Kbwt—it has only one
  // in-segment alternation, at Ey (in the other segments the k is preceded by
  // a separator or is already lowercase), so the whole string stayed readable.
  // That was a regression I introduced in 9aa0bcd; r35 (5f38d60) used to mask
  // it. Changed to count the total occurrences of [a-z][A-Z] in the whole
  // word: sk-ant-api03-Eyai1pkJrF_Kbwt has two, at Ey and Kw, and is judged a
  // key; a name's segment starts with a capital and never flips inside, so
  // DeepSeek-V3-2-Chat-Preview has no lowercase-to-uppercase after "Preview"
  // and MyProvider-… none after "MyPr", each counting only one.
  const dir = fixture("msmoli-glueword-")
  try {
    const keys = [
      "AbCdEfGh.IjKlMnOp.QrStUvWx.Yz012345",
      "nUJqxrpd9Bc7-GvG7J--onUJqxrpd9Bc7-GvG7J--o",
      "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY",
      // a vendor key with a single in-segment alternation: this is the 9aa0bcd regression; without it, that change would not go red
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
  // maskKeys used to find trailing punctuation with
  // `word.slice(lead).match(/[^…]*$/)`: anchored at the tail, the star-style
  // backtracking retried from every starting position until exhaustion on a
  // word that starts with a letter, ends with a letter, and is all punctuation
  // in between; one match over 200,000 characters measured 117 seconds, and a
  // server can put such a string in a name. After the change it is 0.3ms with
  // one linear move inward from each end. A word of nothing but punctuation
  // does not do it—it matches at the first starting position, and the old
  // implementation got through in 0.6ms, so it would not test anything
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
  // Round 31 only made the ms- shape "cross invisible characters"
  // (tokenShaped's INV*). Other shapes did not: a 27-character ghp_ token cut
  // by a zero-width space into 13+14 leaves both halves below the 16-character
  // floor, the word-level criterion recognises neither, and the trailing 14
  // characters reach the terminal verbatim (measured "92c6912E7710c8"); sk-ant
  // itself likewise leaves 12. GLUE runs before show() and strips invisible
  // characters that have "key-alphabet characters on both sides"—a space,
  // newline or comma that really should separate is not on both sides and is
  // unaffected.
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
    // places that really should separate are not glued: an invisible character between two ordinary words still makes two words
    const o = []
    await main({ argv: ["--dir", dir, "--status", "--from", "alpha​beta"], log: (s) => o.push(s) })
    assert.ok(o.join("\n").includes("alpha"), "普通词不受影响")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ── Final whole-project review: the CLI's masking shares the card's rule ──

test("a secret split by its own hyphen every 11 characters is still scrubbed", async () => {
  // maskEchoes used to collect "the characters the secret is made of"; the
  // hyphen is one of them on every ms- token, and a child that echoed the key
  // with one inserted every 11 characters printed it whole. Punctuation has to
  // be a separator whether the key itself holds it or not.
  const echo = "aaaa1111-bb-bb-2222-ccc-c-333344445-555"
  const dir = mkdtempSync(join(tmpdir(), "msmoli-dashstdout-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    const code = await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        // the login lands, so the read-back finds the account
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: `magpie said: ${echo}`, stderr: "" }
      },
    })
    assert.equal(code, 0)
    const text = out.join("\n")
    assert.ok(!text.includes(echo), `the dash-cut secret reached the terminal: ${text}`)
    assert.ok(!text.includes("aaaa1111"), `a piece of the secret reached the terminal: ${text}`)
    assert.match(text, /ms-a…5555/, "the whole echo is one masked key")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the CLI masks a 10-character piece of the secret and leaves 9 alone", async () => {
  // MIN_ECHO is the boundary both sides of the tool share; the floor is 10
  // (lowered from 12 so an 11-character run opening a chunked echo is caught),
  // and a mutation that drops it further would mask an ordinary short word
  // that happens to sit in the token.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-min-echo-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    for (const [piece, masked] of [
      ["aaaa1111-b", false], // 9 alphanumeric characters
      ["aaaa1111-bb", true], // 10, the shared floor
    ]) {
      const out = []
      await main({
        argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
          return { status: 0, stdout: `magpie said: ${piece}`, stderr: "" }
        },
      })
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
      const text = out.join("\n")
      assert.equal(!text.includes(piece), masked, `${piece}: ${text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--to-preset refuses the same unusable key on both sides", () => {
  // Two sides holding the same key with a space in it is not a healthy state:
  // reporting "already the same, nothing to do" was the one status line that
  // never checked whether the key could be sent at all.
  const BAD = "ms-bad key 0000-0000-0000-000000000000"
  const p = planToPreset({ preset: presetOf(BAD), accounts: [{ name: "msmoli", token: BAD }], force: false })
  assert.equal(p.action, "refuse")
  assert.match(p.lines.join("\n"), /发不出去/)
})

test("an upper-cased ms- shape from a child is masked without knowing the key", async () => {
  // tokenShaped is the only rule that recognises a ModelScope key by its
  // prefix; a child that upper-cases its output printed "MS-…" past a
  // case-sensitive pattern, and no other arm of arg()/show() covers a run of
  // capitals with no digits in it.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-uppshape-"))
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s) => out.push(s),
      spawn: () => {
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: "saw MS-ABCDEFGHIJKLMNOP here", stderr: "" }
      },
    })
    const text = out.join("\n")
    assert.ok(!text.includes("MS-ABCDEFGHIJKLMNOP"), `the upper-cased shape survived: ${text}`)
    // and a full-width echo of the key itself: NFKC folds the look-alikes
    const wide = A.replace(/[0-9a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/-/g, "－")
    // The first run left the key in plugin-auth.json; with both sides equal the
    // second run would be a no-op and never spawn, so the echo would never be
    // printed and the assertion below would hold vacuously. Empty the file so
    // this run really sends the key.
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({}))
    const out2 = []
    await main({
      argv: ["--dir", dir, "--to-plugin", "--magpie", "/nonexistent"],
      log: (s2) => out2.push(s2),
      spawn: () => {
        writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
        return { status: 0, stdout: `saw ${wide} here`, stderr: "" }
      },
    })
    assert.ok(!out2.join("\n").includes(wide), `the full-width echo survived: ${out2.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Round eleven: a vendor front cut inside itself, a middot cut, a full-width hyphen ──

test("a vendor key cut into fours by spaces or middots is masked whole", () => {
  // Round-ten sweeps: "xoxb -123 4567 …" went out whole — the head was the
  // front itself, cut in two, and no floor kept "xoxb" or "xox" as a word.
  // The run is read from a piece-starting front and masks from the front on.
  const tokens = [
    "xoxb-12345678901",
    "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    "ghp_1234AbCd5678EfGh9012IjKl3456MnOp7890",
  ]
  const cuts = [
    (x) => x.match(/.{1,3}/g).join(" "),
    (x) => x.match(/.{1,4}/g).join(" "),
    (x) => x.match(/.{1,4}/g).join("\n"),
    (x) => x.match(/.{1,4}/g).join("·"),
    (x) => x.match(/.{1,4}/g).join("　"),
  ]
  for (const t of tokens) {
    for (const cut of cuts) {
      const shown = arg(cut(t))
      assert.ok(!shown.replace(/[^A-Za-z0-9]/g, "").includes(t.replace(/[^A-Za-z0-9]/g, "")), `the key reached the terminal: ${shown}`)
    }
  }
  // "Run 3 4 5 …" (a count of numbers) is masked as a key by the round-ten
  // code and by this one alike; the caps reading takes any run of capitals and
  // digits, and a word with no lower-case in it is how a key written without
  // its spaces looks. The words that must survive are the ones with prose.
  for (const t of ["the xox box has 3 items", "Release xoxb 2026", "xox b-1 234"]) {
    const shown = arg(t)
    assert.ok(shown === t || !shown.includes("…"), `ordinary text was masked: ${JSON.stringify(t)} → ${JSON.stringify(shown)}`)
  }
})

test("a key written with a full-width hyphen-months is masked", () => {
  // U+FF0D is not folded by NFKC. A key pasted from a web page or a Chinese
  // IME was read as one word, its ASCII runs all under the floors, and printed
  // whole; the mask judges it on the folded copy and prints the value as typed.
  const wide = "ms－foreign－0123456789abcdef0123456789abcdef"
  const shown = arg(wide)
  assert.ok(!shown.replace(/[^A-Za-z0-9]/g, "").includes("msforeign0123456789abcdef0123456789abcdef"), `the key reached the terminal: ${shown}`)
  assert.ok(shown.includes("－"), `the mask should keep the value's own spelling: ${shown}`)
})

// ── Round twelve: framed middot pieces, long shaped heads, and the CLI's cost ──
test("a middot-cut key behind a frame's punctuation is masked in arg() too", () => {
  // The review's card matrix found the CLI's run reading started at the frame
  // word ("(AK·IA·…", "key=123e·…") and read a long head piece as prose
  // ("AKIAIOS·FODNN7E·XAMPLE"). Both now start at the material behind the frame.
  const cases = [
    "(AK·IA·IO·SF·OD·NN·7E·XA·MP·LE)",
    "key=AKIAIOS·FODNN7E·XAMPLE.",
    "(9f8e7d6·c5b4a39·281706f·5e4d3c2·b1a0)",
    "key=123e4567-e·89b-12d3-a·456-426614·174000",
    "(sk-a·nt-a·pi03·-Eya·i1pk·JrF_·Kbwt )",
  ]
  for (const v of cases) {
    const out = arg(v)
    assert.ok(out.includes("…"), `a framed middot cut was not masked: ${v} → ${out}`)
    const lead = v.match(/^[^A-Za-z0-9]*[A-Za-z]+=[^A-Za-z0-9]*|^[^A-Za-z0-9]+/)[0]
    assert.ok(out.startsWith(lead), `the frame is kept: ${JSON.stringify(lead)} → ${out}`)
  }
  // and the frames' words stay, as before
  assert.equal(arg("key=AKIAIOS·FODNN7E·XAMPLE."), "key=AKIA…PLE.")
})

test("the CLI's 32 KiB worst case stays fast", () => {
  // Before this round the CLI took 9 s on "1A1 " × 8192 and 1.8 s on 32 KiB of
  // one-character words. A run that finds nothing now hands the scan on to its
  // last word. The bound is loose on purpose: it guards a regression to
  // quadratic reading, not a machine's speed.
  for (const v of ["1A1 ".repeat(8192), "A ".repeat(16384)]) {
    const t = performance.now()
    arg(v)
    const ms = performance.now() - t
    assert.ok(ms < 1000, `${JSON.stringify(v.slice(0, 6))}… took ${ms.toFixed(0)} ms`)
  }
  // and a real cut of the same sizes is still read
  assert.ok(arg("9f8e7d6c5b4a39281706f5e4d3c2b1a0".split("").join(" ")).includes("9f8e…b1a0"))
})

test("a middot cut keeps only the mask's four characters at each end", () => {
  // The review's CLI repros: a cut key showed "ghp_1234…7890" (eight of the
  // front's characters) and a UUID cut into pieces came out "123e123e…4000"
  // — the frame kept a copy of the band the mask had read. Both are the mask's
  // own four at each end plus the frame as printed, now.
  assert.equal(arg("ghp_12·34AbCd·5678Ef·Gh9012·IjKl34·56MnOp·7890"), "ghp_…7890")
  assert.equal(arg("123e4567-e89·b-12d3-a456-·426614174000"), "123e…4000")
  const key = "ghp_1234AbCd5678EfGh9012IjKl3456MnOp7890"
  for (const w of [1, 2, 4, 6, 9, 12]) {
    const cut = key.match(new RegExp(`.{1,${w}}`, "g")).join("·")
    assert.equal(arg(cut), "ghp_…7890", `cut ${w}: the mask showed more than its four characters`)
    assert.equal(arg(`key=${cut}`), "key=ghp_…7890", `cut ${w} behind a frame: the mask showed more`)
    assert.equal(arg(`(${cut} )`), "(ghp_…7890)", `cut ${w} in brackets: the frame's punctuation went inside the mask`)
  }
})

// ── The closeout review's findings (2026-11-10) ──
test("a bare front with a repeated four-letter piece is still masked", () => {
  assert.equal(arg("ghp_1·abcd·2345·efgh·6789"), "ghp_…6789")
})

// ── The third review's CLI side (2026-11-10) ──
test("a middot cut after a key's own front is the key's from its front", () => {
  // The mask started at the first piece that read as a key ("Ghp_Abcd"), and
  // the cut's remaining pieces were read as text.
  assert.equal(arg("Ghp_Abcd1234·Efgh5678·Ijkl9012·Mnop3456·Qrst"), "Ghp_…Qrst")
  // and an ordinary list of words with numerals is not a key
  for (const t of ["file1 · file2 · file3 · file4", "NickName=[" + Array(16).fill(1).join(", ") + "]"]) {
    assert.equal(arg(t), t, `ordinary text was masked: ${arg(t)}`)
  }
})

// ── The leak probe's CLI side (2026-11-10) ──
test("a lower-case key cut by spaces is masked, and ordinary text beside it is not", () => {
  // no head reading took an all-lower-case piece ("abcd1234efgh"), so every
  // word of the run was the per-word pass's and the key stayed whole
  const key = "abcd1234efgh5678ijkl9012mnop3456"
  const pieces = [key.slice(0, 12), key.slice(12, 24), key.slice(24)]
  for (const sep of [" ", "  ", " · ", " ", "　"]) {
    const cut = pieces.join(sep)
    assert.equal(arg(cut), "abcd…3456", `cut by ${JSON.stringify(sep)}: ${arg(cut)}`)
    assert.equal(arg(`no key ${cut} for provider`), "no key abcd…3456 for provider", `cut by ${JSON.stringify(sep)} behind a frame: ${arg(`no key ${cut} for provider`)}`)
  }
  // the pieces of a sentence are not a key however they are joined
  for (const t of ["the log said", "hello world 2026", "release notes 2026-11-10", "build 1234 done 5678"]) {
    assert.equal(arg(t), t, `ordinary text was masked: ${arg(t)}`)
  }
})

test("an ms key cut by the card's own separator is masked from its front", () => {
  // "ms-abcd1234e · fgh5678ijkl9 · 012mnop3456" is one key cut by the
  // separator a display draws with spaces around it — three characters, wider
  // than the bare cut — and spacedKey's walk stopped at the gap.
  const key = "ms-abcd1234efgh5678ijkl9012mnop3456"
  for (const sep of [" · ", " • "]) {
    const cut = [key.slice(0, 12), key.slice(12, 24), key.slice(24)].join(sep)
    assert.equal(arg(cut), "ms-a…3456", `cut by ${JSON.stringify(sep)}: ${arg(cut)}`)
  }
})

test("a key followed by a short word of the text's keeps the word", () => {
  // "for" is three letters: the run read it in and the mask ended "Qrst for"
  // ("ghp_…tfor provider"). The key's own trailing comma stays outside the
  // mask, and the space behind it stays with the frame word (the gap was
  // dropped: "ghp_…,for provider")
  const key = "ghp_Abcd1234Efgh5678Ijkl9012Mnop3456Qrst"
  assert.equal(arg(`no key ${key} for provider`), "no key ghp_…Qrst for provider")
  const withComma = arg(`no key ${key}, for provider`)
  assert.ok(!withComma.includes("tfor"), `the short word went into the mask: ${withComma}`)
  assert.ok(withComma.includes("for provider"), `the frame word was lost: ${withComma}`)
  // the key's own trailing punctuation stays outside the mask
  assert.equal(arg(`${key}.`), "ghp_…Qrst.")
})

test("a key quoted in a frame shows its own four characters, not the frame's", () => {
  // The word is judged whole (isKey sees the key's run inside it), so the mask
  // took the frame's punctuation for the first and last characters of the
  // four: "(ghp_…Qrst)" printed "(ghp…rst)".
  const key = "ghp_Abcd1234Efgh5678Ijkl9012Mnop3456Qrst"
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ['"', '"']]) {
    const shown = arg(open + key + close)
    assert.equal(shown, open + "ghp_…Qrst" + close, `${open}${close} frame: ${shown}`)
  }
  // a letter in front of the bracket is the text's: the word's own reading
  // masks the key it carries, and the mask spends its four on the word's own
  // ends there (the word is the frame then, not the key)
  const prefixed = arg("x(" + key + ")")
  assert.ok(prefixed.includes("…") && !prefixed.includes(key.slice(4, 20)), `a key behind a letter went out whole: ${prefixed}`)
  // and the frame alone is never enough to make a word key-shaped
  assert.equal(arg("(" + "hello" + ")"), "(hello)")
})

test("a key cut by a space is masked in the CLI, whatever its shape", () => {
  // arg()/scrub() join the pieces of a cut only when the value carries an ms-
  // or sk- front; a UUID, a GitHub token or a digest cut by a space went out
  // whole. Measured before this test: "123e4567-e89b-12d3-a45 6-426614174000"
  // and "ghp_Abcd1234Efgh 5678Ijkl9012Mnop 3456Qrst" were printed as written.
  const cases = [
    ["123e4567-e89b-12d3-a45 6-426614174000", "123e…4000"],
    ["123e4567-e89b-12d3-a456- 426614174000", "123e…4000"],
    ["ghp_Abcd1234Efgh5678Ijkl9012Mnop345 6Qrst", "ghp_…Qrst"],
    ["9f8e7d6c5b4a3928170 6f5e4d3c2b1a0", "9f8e…b1a0"],
  ]
  for (const [cut, want] of cases) {
    assert.equal(arg(`no key ${cut} for provider`), `no key ${want} for provider`, `arg kept the cut: ${cut}`)
    assert.equal(scrub(`no key ${cut} for provider`), `no key ${want} for provider`, `scrub kept the cut: ${cut}`)
  }
})

test("an ordinary word after the front is not a key in the CLI either", () => {
  // The card keeps "The ms-interviewing feature is unavailable"; the CLI masked
  // it, because show()'s ms- shape has no guard for a body that does not read
  // as key material.
  for (const v of ["The ms-interviewing feature is unavailable", "ms-dos and ms-word", "ms-cli 2026.11.9"]) {
    assert.equal(arg(v), v, `ordinary text was masked: ${arg(v)}`)
  }
})

test("a list of model captions is not one key in the CLI", () => {
  // The card keeps "Qwen3-Max · Qwen3-Coder"; the CLI collapsed the list into
  // one mask and dropped the middles of it.
  for (const v of ["Qwen3-Max · Qwen3-Coder", "Qwen3-Max · Qwen3-Coder · Qwen3-VL", "release · notes"]) {
    assert.equal(arg(v), v, `a list was masked: ${arg(v)}`)
  }
})

test("a vendor key in capitals cut by a middot is masked in the CLI too", () => {
  // splitKey's piece test read an all-capitals piece as a word ("AKIAIOSF" is
  // seven letters), so an AKIA key cut in two went out as written.
  assert.equal(arg("no key AKIAIOSF · ODNN7EXAMPLE for provider"), "no key AKIA…MPLE for provider")
  assert.equal(scrub("no key AKIAIOSF · ODNN7EXAMPLE for provider"), "no key AKIA…MPLE for provider")
})

test("a key the child wrapped at a line break is masked across the lines", () => {
  // scrub split the child's output into lines and judged each one, so a key
  // wrapped by the terminal was printed whole: each line held a piece under
  // every word floor.
  for (const [cut, want] of [
    ["123e4567-e89b-12\nd3-a456-426614174000", "123e…4000"],
    ["ghp_Abcd1234Efgh\n5678Ijkl9012Mnop3456Qrst", "ghp_…Qrst"],
  ]) {
    assert.equal(scrub(`no key ${cut} for provider`), `no key ${want} for provider`, `wrapped at a line break: ${cut}`)
  }
})

test("a key cut in the middle is masked as one, not as two masks", () => {
  // A 40-character ghp_ token cut at its midpoint made two masks —
  // "ghp_…ijkl MNOP…ZZZZ" — and the four characters either side of the cut
  // ("ijkl", "MNOP") are the token's middle, which one mask would have hidden.
  // The back half ("MNOPqrstUVWXZZZZ") carries one lower-to-upper transition,
  // under keyedBody's floor, but it is a 16+ mixed-case run — the same shape
  // keyRun masks when the half stands alone — so it is key material as a piece
  // too, and the join reads as one key.
  const token = "ghp_AbCdEf1234567890ijklMNOPqrstUVWXZZZZ"
  for (let at = 8; at < token.length - 8; at += 1) {
    const out = arg(`no key ${token.slice(0, at)} ${token.slice(at)} for provider`)
    assert.equal((out.match(/…/g) ?? []).length, 1, `cut at ${at} made two masks: ${out}`)
    assert.ok(!out.includes(token), `the token survived cut at ${at}: ${out}`)
  }
})

test("a secret with slashes in it, cut by a space, is masked whole", () => {
  // splitKey's PIECE splits on "/", and its GAP did not accept "/", so the
  // walk broke at the first slash and the front of an AWS secret cut by a
  // space reached the terminal: "wJalr…/K7MDENG/bPxRfi CYEXAMPLEKEY" kept its
  // first 28 characters ("wJalrXUtnFEMI/K7MDENG/bPxRfi") verbatim. The slash
  // is one of the key's own separators, and isKey already judges the whole.
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  const longest = (text) => {
    let best = ""
    for (let i = 0; i < aws.length; i++)
      for (let j = i + 1; j <= aws.length; j++) {
        const piece = aws.slice(i, j)
        if (text.includes(piece) && piece.length > best.length) best = piece
      }
    return best
  }
  for (const cut of ["wJalrXUtnFEMI/K7MDENG/bPxRfi CYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI K7MDENG/bPxRfiCYEXAMPLEKEY"]) {
    for (const text of [arg(`--dir ${cut}`), scrub(`child said ${cut} done`)]) {
      const kept = longest(text)
      assert.ok(kept.length < 12, `切在空格处漏了 ${kept.length} 个字符 ${JSON.stringify(kept)}：${JSON.stringify(text)}`)
    }
  }
})

test("a path is not joined across its slashes into a secret", () => {
  // The reverse of the fix above: adding "/" to splitKey's GAP must not glue a
  // real path's words into a mask. A path's components are lowercase words with
  // no digit, so isKey(joined) stays false and the walk does not take it.
  for (const p of ["/Users/mison/Documents/NewProject", "Users/mison/Documents/work", "src/lib/utils/helpers"]) {
    assert.equal(arg(`--dir ${p}`), `--dir ${p}`, `a path was masked: ${arg(`--dir ${p}`)}`)
  }
})

test("two ms- keys side by side are each masked in the CLI", () => {
  // splitKey joined the two bodies into one, and one mask hid both ends.
  const t1 = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  const t2 = "ms-zzzz9999-yyyy-8888-xxxx-777766665555"
  assert.equal(arg(`${t1} ${t2}`), "ms-a…5555 ms-z…5555")
})

test("--to-preset refuses an international-site token", () => {
  // The plugin records an international account's site in its sign-in
  // ("https://modelscope.ai"), and an ms- token authenticates only on the site
  // it came from. The built-in preset points at api-inference.modelscope.cn,
  // so writing such a token there breaks chat requests while the tool reports
  // success. Measured: planToPreset planned `provider key` and main() answered
  // ✓ with rc=0.
  const intl = { name: "msmoli", token: B, site: "https://modelscope.ai" }
  for (const force of [false, true]) {
    const p = planToPreset({ preset: presetOf(A), accounts: [intl], force })
    assert.equal(p.action, "refuse", `force=${force}: ${p.action}`)
    assert.equal(p.cmds.length, 0, `force=${force}: a write was still planned`)
    assert.ok(p.lines.join("\n").includes("国际站"), `force=${force}: the plan does not name the site`)
  }
  // a domestic account is unaffected, and a site left off is not evidence of
  // the international one: only a probe-confirmed .ai account refuses
  const cn = { name: "msmoli", token: B, site: "https://modelscope.cn" }
  assert.equal(planToPreset({ preset: presetOf(A), accounts: [cn], force: true }).action, "run")
  assert.equal(planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: B }], force: true }).action, "run")
})

test("pluginAccounts reads the site the plugin recorded", () => {
  // The reader dropped every field but the token, so the plan above had no way
  // to know which site the account belongs to.
  assert.deepEqual(
    pluginAccounts({ msmoli: { type: "api", key: B, site: "https://modelscope.ai" } }),
    [{ name: "msmoli", token: B, site: "https://modelscope.ai" }],
  )
  assert.equal(pluginAccounts({ msmoli: { type: "api", key: B } })[0].site, "")
})

test("--to-preset refuses the international token end to end, and writes nothing", async () => {
  // The plan-level check has to hold through main() too: a refuse must exit 1
  // and never spawn, whatever --force says. Measured before the check: rc=0,
  // a `provider key` command, and providers.json rewritten with the .ai token.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-intl-site-"))
  const before = JSON.stringify({ providers: [presetOf(A)] })
  try {
    writeFileSync(join(dir, "providers.json"), before)
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B, site: "https://modelscope.ai" } }))
    for (const extra of [[], ["--force"]]) {
      const out = []
      const code = await main({
        argv: ["--dir", dir, "--to-preset", ...extra, "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          throw new Error("a refused plan must not spawn")
        },
      })
      const text = out.join("\n")
      assert.equal(code, 1, `${extra.join(" ") || "no flag"}: rc ${code}\n${text}`)
      assert.ok(text.includes("国际站"), `${extra.join(" ") || "no flag"}: the refusal does not name the site:\n${text}`)
      assert.ok(!text.includes(B), `the international token is printed:\n${text}`)
      assert.equal(readFileSync(join(dir, "providers.json"), "utf8"), before, "providers.json was rewritten")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--to-preset tells an unreadable entry from a missing login", () => {
  // The reverse direction answered "插件主账号（msmoli）没有登录" for an entry
  // that is there but cannot be read, and sent the user to `--to-plugin`, which
  // refuses the very same file. The forward direction has the right wording;
  // this one had none.
  const p = planToPreset({ preset: presetOf(A), accounts: [{ name: "msmoli", token: "" }], force: true })
  const text = p.lines.join("\n")
  assert.equal(p.action, "refuse")
  assert.ok(/读不出令牌/.test(text), `the plan calls it a missing login:\n${text}`)
  assert.ok(!/没有登录/.test(text), `the plan still says signed out:\n${text}`)
  // and a real missing login still reads as one
  const none = planToPreset({ preset: presetOf(A), accounts: [], force: true })
  assert.ok(/没有登录/.test(none.lines.join("\n")), none.lines.join("\n"))
})

test("a preset key that is not a string is not an empty preset", () => {
  // keyedOf answers "no key" for a key that is any other type, so --to-preset
  // treated a providers.json entry carrying {"key": 12345} (or a null) as a
  // slot with nothing to lose: it planned the write without --force, and the
  // "现在没有 key，会被填上" line claimed the entry was empty when it was not.
  // magpie itself would refuse or replace whatever is there — either way the
  // user's --force decision was skipped.
  for (const key of [12345, null, { token: A }, ["ms-x"], true]) {
    const preset = { ...presetOf(A), key }
    const p = planToPreset({ preset, accounts: [{ name: "msmoli", token: B }], force: false })
    assert.equal(p.action, "refuse", `key=${JSON.stringify(key)} was written without --force: ${p.action}`)
    assert.equal(p.cmds.length, 0, `key=${JSON.stringify(key)}: a write was planned`)
    assert.ok(/读不出|不是字符串/.test(p.lines.join("\n")), `key=${JSON.stringify(key)}: ${p.lines.join(" | ")}`)
  }
  // the controls: a slot with nothing in it is still a destination — no key
  // field at all, and the empty string
  for (const preset of [{ id: "modelscope", preset: "modelscope" }, { ...presetOf(A), key: "" }]) {
    assert.equal(planToPreset({ preset, accounts: [{ name: "msmoli", token: B }], force: false }).action, "run", JSON.stringify(preset))
  }
})

test("--status says it did not execute on a noop or refuse plan too", async () => {
  // --status promises "report only": the annotation is what makes that visible.
  // It was printed only when the plan was going to run, so a noop ("✓ 无需操作")
  // and a refuse ("✗ …") came back with no sign that --status had been honoured
  // — and a reader scripting the output could not tell a report from a run.
  const dir = mkdtempSync(join(tmpdir(), "msmoli-status-anno-"))
  try {
    // a noop: both sides hold the same key
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
    const noop = []
    const codeNoop = await main({ argv: ["--dir", dir, "--status", "--magpie", "/nonexistent"], log: (s) => noop.push(s) })
    assert.equal(codeNoop, 0)
    assert.ok(noop.join("\n").includes("未执行"), `a noop under --status carries no annotation:\n${noop.join("\n")}`)
    // and without --status there is no annotation to give: a bare run's noop is
    // the answer itself, and printing "以上是计划" over it would say the user
    // asked for a report they did not
    const bare = []
    const codeBare = await main({ argv: ["--dir", dir, "--magpie", "/nonexistent"], log: (s) => bare.push(s) })
    assert.equal(codeBare, 0)
    assert.ok(!bare.join("\n").includes("未执行"), `a noop without --status carries the annotation:\n${bare.join("\n")}`)

    // a refuse: the two sides differ and --force is not given
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: B } }))
    const refuse = []
    const codeRefuse = await main({ argv: ["--dir", dir, "--status", "--to-preset", "--magpie", "/nonexistent"], log: (s) => refuse.push(s) })
    assert.equal(codeRefuse, 1, "a refusal still exits 1")
    assert.ok(refuse.join("\n").includes("未执行"), `a refusal under --status carries no annotation:\n${refuse.join("\n")}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an argument named after something on Object is still an unknown argument", () => {
  // The value flags live in a plain object literal, and `VALUE[a]` reads the
  // prototype chain: `constructor`, `toString`, `valueOf`, `__proto__` and
  // friends were all truthy, so they were taken as value flags and silently
  // accepted — the opposite of every other unknown argument. `hasOwn` asks
  // about the table itself.
  for (const bad of ["constructor=value", "constructor", "toString=value", "toString", "__proto__=value", "valueOf=value", "hasOwnProperty=x"]) {
    const r = run(["--status", bad])
    assert.equal(r.status, 1, `${bad} must be refused: ${r.stdout}`)
    assert.match(r.stderr, /不认识的参数/, `${bad}: ${r.stderr}`)
  }
  // the real value flags still work, in both spellings
  for (const ok of [["--dir=/tmp", "--status"], ["--dir", "/tmp", "--status"]]) {
    const r = run(ok)
    assert.doesNotMatch(r.stdout + r.stderr, /不认识的参数/, ok.join(" "))
  }
})

test("a preset key that is not a string is refused by main, not only by the planner", async () => {
  // planToPreset refuses {"key": 12345} — the key is there but its type is not
  // one this tool can read, so "no key to lose" is the wrong answer. But
  // presetCandidates handed it on as "", and main's every check downstream
  // reads that (keyedOf, `!preset.key`, `preset.key !== undefined`) — so the
  // refusal was unreachable from the command line: a forced write went ahead
  // over a key nobody had looked at. The type is kept as it was written now.
  for (const key of [12345, null, [A], { v: A }, true]) {
    const dir = mkdtempSync(join(tmpdir(), "msmoli-nonstr-"))
    try {
      writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: [{ id: "modelscope", preset: "modelscope", key }] }))
      writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
      const out = []
      let spawned = false
      const code = await main({
        argv: ["--dir", dir, "--to-preset", "--force", "--magpie", "/nonexistent"],
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      const text = out.join("\n")
      assert.equal(code, 1, `${JSON.stringify(key)}: ${text}`)
      assert.equal(spawned, false, `${JSON.stringify(key)}: nothing may be written over a key nobody read`)
      assert.match(text, /不是字符串/, JSON.stringify(key))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a launcher whose target is another interpreter, or that prints usage first, is followed", async () => {
  // Two shapes the text read used to give up on. A shebang that names another
  // program (#!/usr/bin/env node) is the bottom of the chain, and its source is
  // that program's — a shift in it ("1 << 16") is not a here-document, and
  // reading it as one refused a launcher that resolves perfectly well. And a
  // script that prints usage from a here-document before it starts is an
  // ordinary shape: the body is text, the exec line after it is the target.
  const shim = mkdtempSync(join(tmpdir(), "msmoli-interp-"))
  const real = mkdtempSync(join(tmpdir(), "msmoli-interp-real-"))
  try {
    for (const folder of [shim, real]) {
      mkdirSync(join(folder, "data"), { recursive: true })
      writeFileSync(join(folder, ".portable"), "")
    }
    writeFileSync(join(real, "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    // the target is a node entry point whose source carries a shift
    const app = join(real, "magpie.js")
    writeFileSync(app, "#!/usr/bin/env node\nconst P = 1 << 16\n", { mode: 0o755 })
    writeFileSync(join(real, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(real, "data", "plugin-auth.json"), JSON.stringify({}))
    // a usage here-document in front of the real exec
    const usage = join(shim, "usage")
    writeFileSync(usage, `#!/bin/sh\ncat <<EOF\nmagpie - the agent runner.\nRun: exec magpie <command>\nEOF\nexec ${join(real, "magpie")} "$@"\n`, { mode: 0o755 })
    // ...and one that execs the node entry point through that launcher
    const viaNode = join(shim, "via-node")
    writeFileSync(viaNode, `#!/bin/sh\nexec ${join(real, "magpie")} "$@"\n`, { mode: 0o755 })
    for (const bin of [usage, viaNode]) {
      // each launcher is judged on its own: the first one signs in, and the
      // second would find nothing to do
      writeFileSync(join(real, "data", "plugin-auth.json"), JSON.stringify({}))
      const out = []
      let spawned = false
      await main({
        argv: ["--dir", join(real, "data"), "--to-plugin", "--force", "--magpie", bin],
        env: {},
        home: shim,
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          writeFileSync(join(real, "data", "plugin-auth.json"), JSON.stringify({ msmoli: { type: "api", key: A } }))
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      const text = out.join("\n")
      assert.equal(spawned, true, `${bin}: the launcher resolves, so the sync runs:\n${text}`)
      assert.doesNotMatch(text, /包装脚本/, `${bin}: a followable launcher needs no wrapper note:\n${text}`)
    }
  } finally {
    rmSync(shim, { recursive: true, force: true })
    rmSync(real, { recursive: true, force: true })
  }
})

test("a launcher whose target the text cannot settle is refused, not guessed", async () => {
  // Three shapes a text read cannot decide: a relative exec (the shell
  // resolves it against the working folder, not the script's), two different
  // exec lines (an if/else, a fallback chain — which one runs is not in the
  // text), and an exec that appears inside a here-document or echoed text.
  // The guard used to fall back to the script's own folder and run anyway,
  // which is a write aimed at a guess.
  const shapes = [
    ["relative", `#!/bin/sh\nexec ./target "$@"\n`],
    ["two branches", `#!/bin/sh\nif false; then\n  exec __DIR__/one "$@"\nfi\nexec __DIR__/two "$@"\n`],
    ["heredoc text", `#!/bin/sh\ncat <<EOF\nusage: exec /usr/bin/false\nEOF\nexit 1\n`],
  ]
  const dirs = []
  try {
    for (const [tag, script] of shapes) {
      const dir = mkdtempSync(join(tmpdir(), `msmoli-settle-${tag.replace(/ /g, "-")}-`))
      dirs.push(dir)
      mkdirSync(join(dir, "data"), { recursive: true })
      writeFileSync(join(dir, ".portable"), "")
      writeFileSync(join(dir, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
      writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({}))
      // two real targets so the "two branches" shape is genuinely ambiguous
      writeFileSync(join(dir, "target"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(join(dir, "one"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(join(dir, "two"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(join(dir, "magpie"), script.replaceAll("__DIR__", dir), { mode: 0o755 })
      const out = []
      let spawned = false
      const code = await main({
        argv: ["--dir", join(dir, "data"), "--to-plugin", "--force", "--magpie", join(dir, "magpie")],
        env: {},
        home: dir,
        log: (s) => out.push(s),
        spawn: () => {
          spawned = true
          return { status: 0, stdout: "", stderr: "" }
        },
      })
      assert.equal(code, 1, `${tag}: ${out.join("\n")}`)
      assert.equal(spawned, false, `${tag}: nothing may be written on a guess`)
      assert.match(out.join("\n"), /包装脚本/, `${tag}: ${out.join("\n")}`)
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  }
})

test("a vendor key cut by a space is masked whole when a frame touches it", () => {
  // spacedKey judged the rest of the *line* as key material, and the piece walk
  // stopped at the first character that was not: a key with a bracket, a comma
  // or a Chinese character abutting it read as "not a key" and only its first
  // piece was masked — "sk-ant-api03-E" (14 characters of the body) went out
  // beside the masked tail. The reading measures the key's own span now.
  const body = "sk-ant-api03-Eyai1pkJrF_KbwtX9ZqLmNeR2vTuH"
  const cut = `${body.slice(0, 14)} ${body.slice(14)}`
  for (const [tag, s, want] of [
    ["frame ()", `(${cut})`, "(sk-a…vTuH)"],
    ["comma", `${cut},`, "sk-a…vTuH,"],
    ["CJK", `${cut}无效`, "sk-a…vTuH无效"],
  ]) {
    const out = arg(s)
    assert.equal(out, want, `${tag}: ${out}`)
    assert.doesNotMatch(out, /sk-ant-api03-E/, `${tag} leaked the body's front`)
  }
})

test("a lowercase word with no vowels is a key to the CLI too", () => {
  // The card has an arm for a run with no vowels and plenty of digits ("a
  // generated key with no separator at all"); the CLI's isKey did not, so such
  // a key printed as a bare argument went out as written. A word followed by
  // its numeral ("file1file2file3") is a list and stays — that exclusion is the
  // card's own.
  assert.equal(arg("no key 5gli9zadx8zg9jez for provider"), "no key 5gli…9jez for provider")
  for (const word of ["ms-dos", "Qwen3-Max", "hello1234567890", "file1file2file3", "20261031"]) {
    assert.equal(arg(`the list names ${word}`), `the list names ${word}`, `${word} is not a key`)
  }
})

test("a numeral read as a word is not a key, and the word after a key is not eaten", () => {
  // The vowel-less arm (for keys like 5gli9zadx8zg9jez) was asked of every
  // joined run, and a run of plain numerals reads as one: "no 42 20261031"
  // went out as "no42…1031" with the "no" inside the mask. The run arm reads
  // each piece as it was written; a join is masked only when one of its pieces
  // is a key on its own.
  for (const [s, want] of [
    ["no 42 20261031", "no 42 20261031"],
    ["ok 42 1234 2026", "ok 42 1234 2026"],
    ["v202610310001", "v202610310001"],
    ["abc123def456ghi789 now", "abc123def456ghi789 now"],
    // a letter lead and then digits is a build number, even between a word
    // and its number: the join is asked without the vowel-less arm either
    ["build v20261111 grpc", "build v20261111 grpc"],
  ]) {
    assert.equal(arg(s), want, s)
  }
  // and the key an invisible character was cut out of is still masked whole:
  // neither half is a key on its own, and the piece that reads as one
  // ("5gli" is not; "123456789012" is a numeral, not) is judged by the run arm
  assert.equal(arg("5gli9zadx8zg9​jez for provider"), "5gli…9jez for provider")
})

test("a full-width vendor key is masked as typed, not printed whole", () => {
  // The CLI folds to NFKC + lower case before judging a word, and the fold
  // took the capitals out of a key that is defined by them: a full-width
  // "ＡＫＩＡ…" had no ASCII run, no front and no lower-case shape, so every
  // route declined and the key printed whole. The NFKC copy with its case kept
  // — the one the card judges — is read now, and the value as typed is masked
  // whole when that copy is a key.
  const fw = "ＡＫＩＡＩＯＳＦＯＤＮＮ７ＥＸＡＭＰＬＥ"
  const out = arg(`${fw.slice(0, 8)} ${fw.slice(8)}`)
  assert.doesNotMatch(out, /ＡＫＩＡＩＯＳＦ/, `the key printed whole: ${out}`)
  assert.match(out, /…/, `it is masked: ${out}`)
  // and one word of it, uncut
  const whole = arg(fw)
  assert.doesNotMatch(whole, /ＯＤＮＮ７ＥＸＡＭＰＬＥ/, `the key printed whole: ${whole}`)
})

test("a short vendor key with its tail cut off is masked, alone and behind a name", () => {
  // Every run floor is 16 characters, and a token copied with its tail missing
  // sits under all of them: "ghp_Abcd1234Ef" went out whole, and so did the
  // half of a longer key that a frame or a space left on the terminal
  // ("(ghp_Abcd1234Ef gh56…Qrst)"). A vendor front names the vendor — no word
  // of prose carries one — so a front whose body mixes case and holds a digit
  // is a key, and the part after "=" or ":" is judged the same way.
  for (const [s, want] of [
    ["ghp_Abcd1234Ef", "ghp_…34Ef"],
    ["token=ghp_Abcd1234Ef", "token=ghp_…34Ef"],
    ["Authorization: ghp_Abcd1234Ef", "Authorization: ghp_…34Ef"],
    ["(ghp_Abcd1234Ef gh5678Ijkl9012Mnop3456Qrst)", "(ghp_…34Ef gh56…Qrst)"],
  ]) assert.equal(arg(s), want, s)
  // a provider id behind the same front keeps its name: its pieces are a word
  // and a number, and neither mixes case
  for (const s of ["sk-preset-20261031 is a provider id", "token=abc", "Authorization: Bearer xyz", "retry=true", "time=12:30:45"]) {
    assert.equal(arg(s), s, `ordinary text was masked: ${JSON.stringify(s)} -> ${JSON.stringify(arg(s))}`)
  }
})

test("a page of full-width words is not folded into one mask", () => {
  // The fold reading was bounded by the whole value: every word of a page
  // written in full width folds, they joined into one span, and the page was
  // handed back as a single mask — the text unreadable, and the reading
  // quadratic in the page (measured: 25 KB took seconds). A span is bounded
  // like a key is, so the page keeps its shape.
  const page = "字ＡＢＣ12 ".repeat(2750)
  const out = arg(page)
  assert.ok(out.trim().split(/\s+/).length > 100, `the page collapsed into ${out.trim().split(/\s+/).length} mask(s)`)
})

test("a key cut by a space with a frame in the cut is still one key", () => {
  // The walk judged its first gap before the body had been read as a key, so
  // every reading that steps over a frame was skipped on that first step: a
  // key whose two halves sit either side of a bracket or a comma
  // ("…KbwtX9( ZqLmNeR2vTuH") kept its second half on the terminal. The body is
  // asked before the gap is judged now.
  const head = "sk-ant-api03-Eyai1pkJrF_KbwtX9"
  const tail = "ZqLmNeR2vTuH"
  for (const glue of ["( ", " (", ", ", "; ", "[ ", " ["]) {
    const out = arg(head + glue + tail + ")")
    assert.doesNotMatch(out, /ZqLmNeR2vTuH/, `the second half printed: ${glue} -> ${out}`)
    assert.doesNotMatch(out, /KbwtX9/, `the first half printed: ${glue} -> ${out}`)
  }
  // and a sentence's bracket is not a cut: the words around it are kept
  for (const s of ["see (the manual) for details", "两个（括号）里的话", "value = (1 + 2) * 3"]) {
    assert.equal(arg(s), s, `ordinary text was masked: ${JSON.stringify(s)} -> ${JSON.stringify(arg(s))}`)
  }
})

test("a full-width key inside a sentence is masked, and the words around it are not", () => {
  // The whole-value NFKC reading masked the value it was handed: "Key
  // ＡＫＩＡ…ＰＬＥ is invalid, please retry." went out as "KeyＡ…try.", the
  // sentence folded into the mask. What the tool read has to stay readable
  // around what it hid, so only the words that fold are read and only the span
  // they form is masked.
  const fw = "ＡＫＩＡＩＯＳＦＯＤＮＮ７ＥＸＡＭＰＬＥ"
  for (const gap of [" ", "\u3000"]) {
    const out = arg(`Key ${fw.slice(0, 8)}${gap}${fw.slice(8)} is invalid, please retry.`)
    assert.doesNotMatch(out, /ＯＤＮＮ７ＥＸＡＭＰＬＥ/, `the key printed whole: ${out}`)
    assert.match(out, /^Key Ａ/, `the word before the key is the text's: ${out}`)
    assert.match(out, / is invalid, please retry\.$/, `the words after it are the text's: ${out}`)
  }
})

test("a full-width key front with an ASCII body across a space is masked too", () => {
  // The fold reading only joined words that each fold: "ＡＫＩＡＩＯＳＦ" folds
  // but its ASCII body "ODNN7EXAMPLE" does not, so the span stopped at the
  // front and the body — a real AWS key-id shape — reached the terminal. The
  // span must read on over the key-material words that follow, like a cut.
  const cases = ["ＡＫＩＡＩＯＳＦ ODNN7EXAMPLE", "ＡＫＩＡＩＯＳＦ ODNN7EXAMPL"]
  for (const v of cases) {
    const out = arg(v)
    assert.doesNotMatch(out, /ODNN7EXAMPL/, `the ASCII body printed whole: ${out}`)
    const s = scrub(`child: ${v}`)
    assert.doesNotMatch(s, /ODNN7EXAMPL/, `the ASCII body printed whole in scrub: ${s}`)
  }
  // the prose around it still stays readable: only the key span is masked
  const sentence = arg("Key ＡＫＩＡＩＯＳＦ ODNN7EXAMPLE is invalid, please retry.")
  assert.match(sentence, /^Key Ａ/, `the word before the key is the text's: ${sentence}`)
  assert.match(sentence, / is invalid, please retry\.$/, `the words after it are the text's: ${sentence}`)
})

test("a key with an ASCII front and a full-width body is masked too", () => {
  // The mirror of the case above: a key front written in ASCII ("ms-a") with a
  // body the copy left in full width. The front does not fold, so the fold-only
  // span started at the body and left the front beside it — the span reads back
  // over a vendor front as well as forward over an ASCII body.
  const fw = (s) => Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("")
  const ms = "ms-aaaa1111-bbbb-2222-cccc-333344445555"
  for (const v of [`ms-a ${fw(ms.slice(4))}`, `ms-aa ${fw(ms.slice(5))}`, fw(ms)]) {
    const out = arg(v)
    assert.match(out, /…/, `the key printed whole: ${JSON.stringify(out)}`)
    // the mask keeps the first and last four characters by design; the middle
    // must not survive
    assert.doesNotMatch(out, /１１１１－ｂｂｂｂ|1111-bbbb/, `the key's middle printed: ${JSON.stringify(out)}`)
  }
  // a following sentence word is not taken: "is" and "invalid" are lower case
  const s = arg(`ms-a ${fw(ms.slice(4))} is invalid`)
  assert.match(s, / is invalid$/, `the sentence after the key is the text's: ${s}`)
})

test("a launcher that cannot be followed is refused even without --dir, and one bad branch spoils the launcher", async () => {
  // Two holes in the fail-safe: the refusal sat inside the `--dir` guard, so
  // a run that let the folder be inferred never reached it; and the exec walk
  // kept only absolute targets, so a script with one absolute exec and one
  // relative dropped the relative one and looked settled.
  const mk = (dir, line) => {
    mkdirSync(join(dir, "data"), { recursive: true })
    writeFileSync(join(dir, ".portable"), "")
    writeFileSync(join(dir, "data", "providers.json"), JSON.stringify({ providers: [presetOf(A)] }))
    writeFileSync(join(dir, "data", "plugin-auth.json"), JSON.stringify({}))
    writeFileSync(join(dir, "target"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(dir, "other"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(dir, "magpie"), line, { mode: 0o755 })
    return join(dir, "magpie")
  }
  const noDir = mkdtempSync(join(tmpdir(), "msmoli-nodir-"))
  const mixed = mkdtempSync(join(tmpdir(), "msmoli-mixed-"))
  try {
    // no --dir: the folder would be inferred from the script itself, and the
    // script's target is unnameable — so nothing may be written at all
    const binA = mk(noDir, `#!/bin/sh\nexec ./target "$@"\n`)
    const outA = []
    let spawnedA = false
    const codeA = await main({
      argv: ["--to-plugin", "--force", "--magpie", binA],
      env: {},
      home: noDir,
      log: (s) => outA.push(s),
      spawn: () => {
        spawnedA = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(codeA, 1, outA.join("\n"))
    assert.equal(spawnedA, false, "an unfollowable launcher must not write even when --dir is inferred")
    assert.match(outA.join("\n"), /包装脚本/)

    // one absolute branch and one relative: the launcher is not settled
    // just because the absolute one happens to exist
    const binB = mk(mixed, `#!/bin/sh\nif [ -x /nonexistent ]; then\n  exec ${join(mixed, "other")} "$@"\nfi\nexec ./target "$@"\n`)
    const outB = []
    let spawnedB = false
    const codeB = await main({
      argv: ["--dir", join(mixed, "data"), "--to-plugin", "--force", "--magpie", binB],
      env: {},
      home: mixed,
      log: (s) => outB.push(s),
      spawn: () => {
        spawnedB = true
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(codeB, 1, outB.join("\n"))
    assert.equal(spawnedB, false, "a launcher with an unresolvable branch is not settled")
    assert.match(outB.join("\n"), /包装脚本/)
  } finally {
    rmSync(noDir, { recursive: true, force: true })
    rmSync(mixed, { recursive: true, force: true })
  }
})
