#!/usr/bin/env node
// magpie-plugin-msmoli — sync the ModelScope token magpie already has to the
// check-in plugin, or the other way round.
//
// Why this tool exists: magpie's built-in ModelScope preset (providers.json)
// and this plugin's login state (plugin-auth.json) are two separate stores, so
// one ms- token has to be configured twice. This tool reads once, writes once,
// and never leaves the token in its output.
//
// Security boundaries (think these through before changing anything here):
// - It only reads magpie's two files; every write goes through magpie's own
//   CLI (provider key / plugin login), never by writing magpie's files
//   directly — locks, backups, .bak rollback and event notifications are all
//   magpie's business.
// - The token only travels over stdin and process arguments (that is the
//   provider key interface), and the log only shows a mask (first 4 + … + last
//   4, matching magpie's own display).
// - The host keys accounts by token: logging in again with the same token is
//   idempotent; a different token adds a second account; logout signs out
//   every account of that provider. So when the two sides differ, it refuses
//   to change anything by default, and only replaces with an explicit --force
//   and only one account in the plugin.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, isAbsolute, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ID = "msmoli"
const PRESET = "modelscope"
const HOST = "api-inference.modelscope.cn"

// VERSION is what --version answers. Read from the package's own manifest so
// the two can never drift — a published tarball carries package.json beside
// bin/, and so does a clone. An unreadable manifest is not a reason to fail a
// version question: the answer is just unknown.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

const USAGE = `magpie-plugin-msmoli — 把 magpie 里已有的 ModelScope 令牌同步给签到插件

用法：node bin/sync.mjs [选项]（发布到 npm 后也可 npx magpie-plugin-msmoli）

不带参数：显示两边状态，并把将要执行的动作写清楚；不改动任何东西。
  --to-plugin   把内置 ModelScope 预设的 key 登录给签到插件
  --to-preset   反向：把签到插件主账号的 key 写进内置预设
  --force       两边令牌不同时也执行（会替换 / 先登出现有登录）
  --from <id>   内置侧只认 id 恰好为它的 provider（不给时先找 id/preset 为 modelscope 的，
                再找 chat 指向 api-inference.modelscope.cn 的自建 vendor）
  --dir <路径>  magpie 的配置目录（安装版是 ~/.config/magpie，便携版是它 data 目录）
  --magpie <路径>  magpie 可执行文件（默认找各平台的常见安装位置，不经 PATH）
  --status      只报告，不执行
  --dry-run     打印将要执行的命令，不执行
  -h, --help    这一页
  -v, --version 打印版本号

令牌不会出现在输出里。写入一律走 magpie 自己的 CLI。`

function parseArgs(argv) {
  const out = { dir: "", magpie: "", from: "", to: "", force: false, dryRun: false, status: false, help: false, version: false }
  // help wins over everything else on the line: `--help --nope` and
  // `--nope --help` should show the page, not an error about --nope. Version
  // is the same courtesy one step down: it is how a packaged CLI answers
  // "which one am I running", and a stray argument beside it should not turn
  // that into an error.
  if (argv.includes("-h") || argv.includes("--help")) return { ...out, help: true }
  if (argv.includes("-v") || argv.includes("--version")) return { ...out, version: true }
  // A flag is not a value. `--dir --dry-run` would otherwise take "--dry-run"
  // as the folder and then fail somewhere far from the mistake, and
  // `--dir ""` would read as "not given" and silently fall back to the
  // machine's own magpie — writing a credential to a target nobody named.
  const take = (i, flag) => {
    const v = argv[i]
    // A single "-h" or "-x" is a flag too: `--dir -h` must not put "-h" in
    // the folder position and silently look there.
    if (v === undefined || v.trim() === "" || v.startsWith("-")) throw new Error(`缺少值：${flag} 后面要跟一个参数`)
    return v
  }
  // A value flag given twice is refused, as the two directions are: the
  // second silently winning dropped the first, and `--magpie A --magpie B`
  // wrote through B with nothing said. `--dir=x` is read as `--dir x`.
  const VALUE = { "--dir": "dir", "--magpie": "magpie", "--from": "from" }
  const seen = new Set()
  const set = (flag, v) => {
    if (seen.has(flag)) throw new Error(`${flag} 只能给一次`)
    seen.add(flag)
    out[VALUE[flag]] = v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.indexOf("=")
    const flag = eq > 0 ? a.slice(0, eq) : ""
    if (flag && VALUE[flag]) {
      const v = a.slice(eq + 1)
      if (v.trim() === "" || v.startsWith("-")) throw new Error(`缺少值：${flag}= 后面要跟一个参数`)
      set(flag, v)
    } else if (VALUE[a]) set(a, take(++i, a))
    else if (a === "--to-plugin" || a === "--to-preset") {
      // When both directions are given, the later one silently wins and the
      // earlier is quietly dropped: saying so is better than picking one
      const want = a === "--to-plugin" ? "plugin" : "preset"
      if (out.to && out.to !== want) throw new Error("--to-plugin 与 --to-preset 只能给一个")
      out.to = want
    }
    else if (a === "--force") out.force = true
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--status") out.status = true
    else throw new Error(`不认识的参数：${arg(a)}（--help 看用法）`)
  }
  return out
}

// ---- discovery: aligned with magpie's appdir. The portable build accepts a
// data/ folder or a .portable file beside the executable; the installed build
// accepts $XDG_CONFIG_HOME/magpie, otherwise ~/.config/magpie.

export function findMagpieBin({ env = process.env, os = platform(), exists = existsSync, home = homedir() } = {}) {
  const cands = []
  if (os === "darwin") {
    cands.push(
      "/Applications/magpie.app/Contents/MacOS/magpie",
      "/Applications/Magpie.app/Contents/MacOS/magpie",
      "/opt/homebrew/bin/magpie",
      "/usr/local/bin/magpie",
      "/opt/local/bin/magpie",
      join(home, ".local", "bin", "magpie"),
    )
  } else if (os === "win32") {
    if (env.LOCALAPPDATA) cands.push(join(env.LOCALAPPDATA, "Programs", "magpie", "magpie.exe"))
    if (env.ProgramFiles) cands.push(join(env.ProgramFiles, "magpie", "magpie.exe"))
  } else {
    cands.push("/usr/local/bin/magpie", "/usr/bin/magpie", join(home, ".local", "bin", "magpie"))
  }
  return cands.find((c) => exists(c)) ?? ""
}

export function looksLikeMagpie(dir, exists = existsSync) {
  return ["providers.json", "plugins.json", "plugin-auth.json"].some((f) => exists(join(dir, f)))
}

// sameFolder says whether two spellings name one folder. Comparing the strings
// refuses what a user really types: a shell completes a directory with its
// trailing slash, "/private/tmp" and "/tmp" are the same folder on a Mac, and
// "data/." is "data". Refusing those told a user their two arguments disagreed
// when they did not.
//
// Resolved first (realpath follows symlinks and drops "." and ".."), then by
// inode: the identity of a folder, which spelling cannot change. A volume that
// reports ino 0 (exFAT, some SMB shares) has no identity to compare, so the
// resolved strings decide there. A folder that does not exist resolves to ""
// and is only equal to another such path by its resolved spelling — two
// nonexistent folders are never taken for one another.
export function sameFolder(a, b, real = realpathSync, stat = statSync) {
  const norm = (p) => {
    const s = String(p ?? "")
    if (!s) return ""
    try {
      return real(s)
    } catch {
      return ""
    }
  }
  const ra = norm(a)
  const rb = norm(b)
  if (ra && rb && ra === rb) return true
  if (!ra || !rb) return false
  try {
    const sa = stat(ra)
    const sb = stat(rb)
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

// rooted is magpie's own test (appdir/env.go): a set-but-relative
// XDG_CONFIG_HOME is not honoured, it is ignored. A drive-letter path counts
// as rooted on every host: on Windows isAbsolute already takes it, and on a
// POSIX host a "C:\…" argument is still a path someone named, not a name to
// look up on PATH (the tests drive the Windows cases from any platform).
const rooted = (p, os) =>
  Boolean(p) &&
  (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || (os === "win32" && (p.startsWith("\\") || p.startsWith("/"))))

// ownFiles is what appdir.go's hasFiles() looks for: the files magpie writes
// on its own. The portable and shared-folder decisions are made with this
// set, not with looksLikeMagpie's: magpie must agree with the tool about
// which folder it is running from, or one reads what the other does not use.
const OWN_FILES = ["providers.json", "logins.json", "settings.json"]
// appdir's hasFiles stats each name and refuses a directory: a folder called
// providers.json is not magpie's file, and counting it as one moves the
// portable decision — and with it the folder this tool reads — off what
// magpie itself decides. The injected `exists` is the fallback for a path
// this process cannot stat, where the two agree on a real machine.
const hasFiles = (dir, stat, exists) =>
  OWN_FILES.some((f) => {
    try {
      return !stat(join(dir, f)).isDirectory()
    } catch {
      return exists(join(dir, f))
    }
  })

// within says whether path lies in the absolute folder dir (appdir.go's own).
const within = (path, dir) => {
  if (!isAbsolute(dir)) return false
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

// beside is appdir.go's Beside(): the folder a portable magpie keeps its
// data folder in — the executable's own, the one holding the .app on a Mac,
// the one holding the .AppImage on Linux.
function beside(exe, env, os) {
  if (os === "linux" && env.APPIMAGE && within(exe, env.APPDIR ?? "")) return dirname(env.APPIMAGE)
  const dir = dirname(exe)
  // …/Magpie.app/Contents/MacOS/magpie. The .app ending is part of the test:
  // a folder merely shaped X/Contents/MacOS is not a bundle.
  if (/[\\/]Contents[\\/]MacOS$/.test(dir)) {
    const app = dirname(dirname(dir))
    if (/\.app$/i.test(app)) return dirname(app)
  }
  return dir
}

// sharedFolders are the folders every app or download shares (appdir.go's
// sharedFolder): a data folder there is as likely another app's or the
// user's own (#989), so it is magpie's only when the installed folder holds
// none of magpie's files — the folder a user's archiver empties is not the
// one a magpie that never asked for portable should run from.
function sharedFolders(home, os) {
  const dirs = []
  if (os === "darwin") dirs.push("/Applications")
  if (home) {
    dirs.push(home, join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents"))
    if (os === "darwin") dirs.push(join(home, "Applications"))
  }
  return dirs
}

// installedDir is appdir.go's installed(): where an installed magpie keeps
// its files, whether or not it has written them yet.
const installedDir = (env, home, os) =>
  rooted(env.XDG_CONFIG_HOME, os) ? join(env.XDG_CONFIG_HOME, "magpie") : home ? join(home, ".config", "magpie") : ""

function shared(base, data, { env, home, os, exists, stat }) {
  const fold = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase()
  if (!sharedFolders(home, os).some((d) => fold(d) === fold(base))) return false
  if (!hasFiles(data, stat, exists)) return true
  const installed = installedDir(env, home, os)
  return Boolean(installed) && hasFiles(installed, stat, exists)
}

// dirExists is "there is a folder here". appdir.Resolve asks os.Stat for a
// directory (a FILE named data is not a portable magpie); the injected
// `exists` is the fallback for a path this process cannot stat, where the
// two agree on a real machine (a stat that throws ENOENT is an exists that
// answers false).
const dirExists = (p, stat, exists) => {
  try {
    return stat(p).isDirectory()
  } catch {
    return exists(p)
  }
}

export function findConfigDir({
  env = process.env,
  home = homedir(),
  os = platform(),
  exists = existsSync,
  binPath = "",
  real = realpathSync,
  stat = statSync,
} = {}) {
  if (binPath) {
    // appdir.Resolve judges the executable as it really is (EvalSymlinks
    // first): a symlink in /usr/local/bin or /opt/homebrew/bin — both of
    // which findMagpieBin itself names — must not move the data folder
    // beside the link, where magpie never looks.
    let exe = binPath
    try {
      exe = real(binPath)
    } catch {}
    const base = beside(exe, env, os)
    const data = join(base, "data")
    // a FILE named .portable decides first, whatever folder it is in
    let marker = false
    try {
      marker = stat(join(base, ".portable")).isFile()
    } catch {}
    if (marker) return data
    // a data folder there is magpie's unless the shared-folder rule says it
    // is someone else's; an empty one counts, as it does in Resolve
    if (dirExists(data, stat, exists) && !shared(base, data, { env, home, os, exists, stat })) return data
  }
  // A rooted XDG_CONFIG_HOME *is* where magpie keeps its files (appdir's
  // installed()), whether or not it has written them yet: falling through to
  // ~/.config there would read a folder magpie is not using — an old install
  // left behind when XDG was set — and "read A, write B" is exactly what the
  // --dir guard above exists to stop.
  if (rooted(env.XDG_CONFIG_HOME, os)) {
    const d = join(env.XDG_CONFIG_HOME, "magpie")
    return looksLikeMagpie(d, exists) ? d : ""
  }
  const d = join(home, ".config", "magpie")
  return looksLikeMagpie(d, exists) ? d : ""
}

// ---- reading: read-only, strips the BOM (magpie does the same), and treats
// an unreadable file as absent

// readJson returns undefined for "not there", null for "there but unreadable".
// The two are not the same decision: a file that exists and doesn't parse may
// be mid-write or briefly locked, and reading it as "nobody is signed in"
// would let a run create a second account over one it could not see.
export function readJson(file, exists = existsSync) {
  if (!exists(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

// ---- domain logic (pure functions, exported for the tests)

// mask reveals only the ends. Under 12 characters there is no middle worth
// hiding and no tail worth showing: 8 characters would print the whole thing
// ("1234…5678" is 8/8), so it says how long it is instead.
//
// The ends go through show(): a key read out of providers.json is a string
// from a file, and a token pasted with a trailing newline (or a poisoned file)
// would otherwise print that control character to the terminal — the ends are
// the only part of it this tool ever displays, so they are where it matters.
export const mask = (t) => {
  if (typeof t !== "string" || !t) return "（不可用）"
  if (t.length < 12) return `（${t.length} 字符）`
  return `${show(t.slice(0, 4))}…${show(t.slice(-4))}`
}

// The preset-side candidates: by default it accepts id/preset=modelscope first
// (magpie's proper preset path), and otherwise recognises a user-built vendor
// by its inference hostname. --from disambiguates and must match by id only —
// the default search matching by preset is what creates the ambiguity, and a
// disambiguation that also matched by preset could never resolve it (a bug the
// rehearsal caught). With more than one candidate the tool does not guess.
//
// The hostname is compared exactly, not as a substring: includes() is also
// true for "api-inference.modelscope.cn.evil.tld", and that would write the
// real token into a provider whose chat points at a third party (--to-preset)
// or send a third party's key as a cookie to modelscope.cn (--to-plugin).
//
// --from picks one **inside** that check: it is a "preset-side" candidate
// first, and only then a disambiguation. It used to short-circuit before the
// hostname check, so `--from openai` would log OpenAI's key into the plugin,
// or overwrite that third-party provider with an ms token — both directions
// silently writing the wrong credential.
// The key is a source-side requirement (--to-plugin needs a token to hand
// over), not a destination-side one: a provider that is ours but has an empty
// key is exactly what --to-preset is meant to fill. `keyed` is that switch;
// main passes false for the reverse direction. With --from the same rule
// holds — an id the user named that is ours is a destination even without a
// key, while --to-plugin must still refuse one that has no token.
export function presetCandidates(providers, from = "", keyed = true) {
  const list = Array.isArray(providers) ? providers : []
  // the key is trimmed where it is read: a token pasted with a trailing
  // newline is the same token, and every comparison and every stdin below
  // must see that one — the check-in plugin trims it too (tokenOf), so the
  // two halves of the tool otherwise disagree about the same credential
  const out = (ps) => ps.map((p) => ({ ...p, key: typeof p.key === "string" ? p.key.trim() : "" }))
  // An entry that is not an object (a null in the list, a string) is not a
  // provider: it is dropped before anything reads p.id, and dropping it
  // filters it here the way keyedOf does for --to-plugin, rather than leaving
  // --to-preset (keyed=false) to dereference the null and crash with a raw
  // TypeError the refusal that stands over every other malformed file never
  // gets to say
  const entry = (p) => p !== null && typeof p === "object" && !Array.isArray(p)
  const usable = (p) => entry(p) && (!keyed || keyedOf(p))
  if (from) return out(list.filter((p) => usable(p) && p.id === from && oursOf(p)))
  const byId = list.filter((p) => usable(p) && (p.id === PRESET || p.preset === PRESET))
  if (byId.length) return out(byId)
  return out(list.filter((p) => usable(p) && hostOf(p.chat) === HOST))
}

// show is what goes to the terminal: a provider id or a file's path comes
// from a file on this machine, but a poisoned providers.json could put an
// escape sequence there and clear the screen, retitle the window or forge a
// line of output. Control characters are shown as spaces. A token-shaped run
// is masked: --from and an unknown flag are printed back verbatim, so a token
// pasted into the wrong position (`--from ms-…`, or as a bare argument) would
// otherwise be printed whole, against the one promise this tool makes about a
// token. It is the same mask a planned command line uses.
//
// The shape is matched before control characters become spaces, and steps
// over them: a zero-width space or a \x01 inside a token (a chat client
// pasting one, or a child's echo) turned into a space first cut the token in
// two, each piece under the floor, and both were printed whole. A line break
// still ends a run — a token never spans one.
const INV = String.raw`(?:(?![\n\r])[\p{Cc}\p{Cf}])`
const tokenShaped = new RegExp(String.raw`m${INV}*s${INV}*-(?:${INV}*[\x21-\x7e]){11,}`, "giu")
// A key cut into pieces by whitespace is still one key, and the key starts
// where the ms- front does. The value may carry anything before it: the flag
// it was pasted behind ("--token=ms-01234 56789abc …"), a path (--dir
// "/tmp/ms-01234 56789abc …"), an account id ("msmoli#ms-…"), or a sentence a
// child printed around it ("no key ms-… for provider"). Masking the whole
// value hid the flag or the folder the user meant to see; not joining across
// the cut left the tail in pieces each under every floor, and the longest of
// them (15 characters) was printed whole. So the key is everything from its
// front to the end of the value, and what came before it keeps its shape.
// how a cut arrives: a space, tab or line break, a no-break or ideographic
// space, a middot or a bullet, or a slash. One or two in a row is a cut;
// three or more ("a   b") is a frame, and ends the run. A piece is a stretch
// between cuts; control and format characters are not a cut's spelling, and a
// value carrying one is left to the per-word pass.
const CUT_RUN = /[ \t\r\n\u00a0\u3000·•∙‧・/]+/g
const CUT_ONE = /^[ \t\r\n\u00a0\u3000·•∙‧・/]+/
const PIECE = /[^ \t\r\n\u00a0\u3000·•∙‧・/]+/g
const KEYCHARS = /^[A-Za-z0-9+/=_.-]+$/
// RUNCUT is the length at which a run is long enough to be a key: the floor
// every reading asks for, and all a mask needs to show
const RUNCUT = 20

// spacedKey reads one value as a key cut into pieces by whitespace (or a
// middot, a slash): from the key's front to the first piece that is not key
// material. The front is found in the value with its cuts taken out, so it is
// found cut anywhere ("m s - 0 1 …", "ghp·_12…"), and what came before it and
// after the key keeps its shape. Exactly one front: a value carrying two is
// two keys already, and the per-word pass masks each.
//
// A piece of four or more letters is prose and ends the run, unless it is a
// bare piece of a front ("ghp" then "_12" is a cut, and "sk-a nt-a pi03" is a
// key whose body is all its pieces) or the body so far already reads as a key.
// A piece of three or more digits with no digit before it is a version
// ("ms-access 2019"), not key material. A run already RUNCUT long is not
// extended by prose: the mask covers 20 characters as well as 40.
const VERNUM = /^\d{3,}$/
const PROSE = /^[A-Za-z]{3,}$/
const FRONT_PIECE = /^(?:m|s|k|ms|sk|s-|g|h|p|u|r|o|x|ox|a|i|l|ali|as|akia|aida|ghp|gho|ghu|ghs|ghr|xox|asia)$/i

function spacedKey(s) {
  // a control or format character is not a cut's spelling (a key with one in
  // it is one word); a line break is, and is read like a space
  if (/(?:(?![\n\r])[\p{Cc}\p{Cf}])/u.test(s)) return null
  // the pieces, and where each starts in the value
  const pieces = []
  for (const m of s.matchAll(PIECE)) pieces.push({ text: m[0], at: m.index })
  if (pieces.length < 2) return null
  const joined = pieces.map((p) => p.text).join("")
  const at = joined.search(/ms-/i)
  const sk = joined.search(/sk-/i)
  const frontAt = at >= 0 ? at : sk
  if (frontAt < 0) return null
  // exactly one front of its kind: two is two keys already
  const mine = at >= 0 ? /ms-/gi : /sk-/gi
  if ([...joined.matchAll(mine)].length !== 1) return null
  // where in the value the front starts (the index in the joined string, not
  // an index in the value: the pieces keep the gaps between them)
  let cum = 0
  let start = -1
  let idx = -1
  for (let k = 0; k < pieces.length; k += 1) {
    if (frontAt >= cum && frontAt < cum + pieces[k].text.length) {
      start = pieces[k].at + (frontAt - cum)
      idx = k
      break
    }
    cum += pieces[k].text.length
  }
  if (start < 0) return null
  // the key's own characters from the front; a digit is what separates a key
  // cut into pieces from a name with a version after it
  const bodyFrom = (i) => s.slice(start, i).replace(CUT_RUN, "")
  if (!/^[A-Za-z0-9+/=_.-]+$/.test(joined.slice(frontAt + 3))) return null
  if (joined.length - frontAt - 3 < 11 || !/\d/.test(joined.slice(frontAt + 3))) return null
  // walk forward: a piece is part of the key while it is key characters and
  // not prose; a gap joins them only when it is a cut (one or two characters).
  // The walk starts at the end of the piece the front's own characters sit in:
  // the rest of that piece ("--ms-01234567") is the key's first body, not a
  // gap
  if (idx < 0) return null
  // the front's own characters, then whatever of its piece follows them with
  // no gap ("ms-aaaa1111", "--ms-01234"): the key begins right after its
  // front, so the rest of that piece is key material, not filler
  let end = start + 3
  while (end < s.length && !CUT_ONE.test(s[end]) && KEYCHARS.test(s[end])) end += 1
  // how long the front is ("ms-", "sk-", "ghp_"), for the walk's prose rule
  const frontLen = (joined.slice(frontAt).match(/^(?:ms-|sk-|gh[pousr]_|xox[abposr]-|akia|asia|aida)/i)?.[0] ?? "").length
  let bare = false
  let strong = false
  for (let guard = 0; guard < 512 && idx < pieces.length - 1; guard += 1) {
    // the gap before the next piece: one cut joins, a run of three or more
    // cuts is a frame; any other character ("--ms-", "#ms-", "/tmp/ms-", a
    // path segment) is the same filler, once the body reads as a key
    // a gap of three or more joins only after the body reads as a key, and
    // then only the two-cut spelling ("a··b"): three or more ("a···b") is the
    // frame a display draws instead of a hidden piece, and the pieces after
    // it are printed as written
    const gap = CUT_ONE.exec(s.slice(end))
    if (!gap) break
    if (gap[0].length > 2 && (!strong || gap[0].length > 5)) break
    idx += 1
    const piece = pieces[idx].text
    if (VERNUM.test(piece) && !/\d/.test(bodyFrom(end))) break
    if (!KEYCHARS.test(piece)) break
    // a piece of three or more letters is prose and ends the run ("no key
    // ms-… for provider" keeps its frame), unless it is the piece a bare
    // front was cut into ("sk" then "ant" is a cut, not a word)
    // prose ends the run even after a bare front: "sk-preset-20261031 is a
    // provider id" is a sentence, and a key whose pieces are letters is read
    // by the reading that masks the whole body ("sk-a nt-a pi03", below)
    // a front's own letters ("ant", "sk", "ghp") are not prose: the walk
    // reads past them while the front has not been completed yet
    if (PROSE.test(piece) && (frontLen === 0 || bodyFrom(end).length >= frontLen)) break
    end = pieces[idx].at + piece.length
    bare = bare || FRONT_PIECE.test(piece)
    // a frame wider than a cut is read across only after the body already
    // reads as a key
    strong = strong || isKey(bodyFrom(end))
  }
  const body = bodyFrom(end)
  if (body.length <= 3 || !/\d/.test(body)) return null
  // a vendor front that carries more than a front ("sk-preset-20261031") is a
  // provider id, not a key cut up: the per-word and cut readings judge it
  if (!/^ms-/i.test(body) && !isKey(body)) return null
  return { pre: s.slice(0, start), body, post: s.slice(end) }
}
const keyish = (x) => isKey(x) || /^(?:ms-|sk-)/i.test(x)

const show = (s) =>
  String(s ?? "")
    .replace(tokenShaped, (m) => mask(m.replace(/[\p{Cc}\p{Cf}]/gu, "")))
    // an upper-cased vendor key is the same key, and its pieces are too short
    // for the per-word floors ("SK-ANT-API03-EYAI1PKJRF_KBWT")
    .replace(/[^\s]+/g, (w) => (isKey(w) && VENDOR.test(w) && w === w.toUpperCase()) || (w.startsWith("--") && w.includes("=") && isKey(w.slice(w.indexOf("=") + 1))) ? mask(w) : w)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")

// arg is show() for a value the user typed: --from, a stray argument, a bare
// --magpie, --dir. A key pasted into one of those positions is printed back,
// and a key that is not ms-shaped (a custom vendor's, a GitHub token, an AWS
// secret) was printed whole — show() only knows the ms- shape, and a value
// with a path separator in it was skipped outright, which let an AWS secret
// and a token standing inside a path through.
//
// A value that is one word and one key is masked whole. Anything else — a
// path, a sentence — keeps its shape and only the key-like runs inside it are
// masked, so /tmp/ghp_16C7… shows the folder that was read: a key-like run is
// 16+ characters mixing cases (a generated key does; a word does not), 32+
// mixing letters and digits, 16+ carrying digits and capitals, or 16+ of hex
// holding both a letter and a digit (a digest, a session id); a UUID is its own
// shape. Under 16, a provider id with a date in it (modelscope20261031) reads
// as an id, not as a key.
//
// The judgement runs per word, not on the value as a whole. Measured before
// this was written, with the judgement only on the whole value: a hyphenated
// token (nUJqxrpd9Bc7-GvG7J--o…) kept all 42 of its characters,
// AbCdEfGh.IjKlMnOp… all 35, 9f8e7d6c5b4a3928-1706f5e4d3c2b1a0 all 33, and a
// key pasted with a trailing space (the shape a copy out of a terminal or a
// chat window leaves) kept 28 of its 121 — the value had whitespace in it, so
// the whole-value judgement answered "not a key" and the runs did the rest,
// leaving the literal prefix sk-ant-api03-Eyai1pkJrF_Kbwt. Per word, that
// word is the key and is masked whole.
//
// A key placed *inside* a path (~/keys/sk-ant-…) still shows there: the path
// keeps its shape (see PATHY below), and taking a component away to mask one
// part would be the wrong trade for a folder the user typed.
const RUN = /[A-Za-z0-9]+/g
const keyRun = (r) =>
  (r.length >= 16 && /[a-z]/.test(r) && /[A-Z]/.test(r)) ||
  (r.length >= 32 && /\d/.test(r) && /[A-Za-z]/.test(r)) ||
  (r.length >= 16 && /\d/.test(r) && /[A-Z]/.test(r)) ||
  // 16+ of hex with both a letter and a digit in it: a digest, a session id, a
  // fragment of a key. Not a word (abcdefgh… carries letters that are not hex,
  // modelscope20261031 carries more than hex), and not a number
  (r.length >= 16 && /^[0-9a-fA-F]+$/.test(r) && /\d/.test(r) && /[a-fA-F]/.test(r))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// one word, and something in it looks like a key
const PATHY = /^(?:[~/.]|[A-Za-z]:[\\/]|\\\\)/
// a word's letters and digits, its separators and the punctuation around it
// taken out: a value typed at a shell can arrive quoted, and a child's line
// can carry the word with a full stop after it
const compact = (w) => w.replace(/[^A-Za-z0-9]/g, "")
// a hex digest written with separators (a1b2c3d4-e5f6-7890-abcd-ef1234567890):
// its pieces are each under the 32-character floor on their own, one of them
// 12+, and none of them is a long word — a run of 32+ letters is a word that
// happens to sit next to a number, not a key cut up
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
// (AbCdEfGh+IjKlMnOp, dGhpc2lzYQ==). Removing the old [+=] arm — it masked a
// query's retry=true, an id=12345 — left those short keys unmasked: under the
// 16-character run floor, their + or = was the only sign. This arm keeps the
// symbols but demands one of them in a whole word that is at least 12
// characters of the key alphabet: retry=true and id=1234567890 carry a bare =,
// code=ENOENT neither, v1.2.3+sha.abc a + but its dots are not the key
// alphabet, and none of them is masked. A trailing = is padding on its own; a +
// is not, because a phrase of lowercase words carries one too (foo+bar+baz,
// key=value+with+plus), so a + must sit beside a case mix or a digit. The ends
// are stripped by that same alphabet first — a word can arrive quoted
// ("AbCdEfGh+IjKlMnOp"), with a comma after it, or (on a card) with a full stop
// — and a dot is not part of a base64 body even though a path or a version
// keeps it
const B64CH = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-")
const base64y = (w) => {
  let a = 0
  while (a < w.length && !B64CH.has(w[a])) a += 1
  let b = w.length
  while (b > a && !B64CH.has(w[b - 1])) b -= 1
  const c = w.slice(a, b)
  if (c.length < 12 || !/^[A-Za-z0-9+/=_-]+$/.test(c)) return false
  // a trailing = is base64 padding on its own. A + inside is the other sign,
  // but only beside a case mix: a phrase of lowercase words carries one too
  // (foo+bar+baz+qux, key=value+with+plus), and so does arithmetic and a phone
  // number (+1-555-123-4567, 1+2+3+4+5). A generated key mixes cases; digits
  // alone do not make it one, and demanding them alongside the + masked the
  // phone numbers. The five shapes this arm exists for — AbCdEfGh+IjKlMnOp,
  // AbCdEf+GhIjKl=, AbCdEf-GhIjKl+MnOpQr, abcdefghij0123456789=, dGhpc2lzYQ==
  // — are each covered by the case mix or the trailing =
  if (c.endsWith("=")) return true
  return c.includes("+") && /[a-z]/.test(c) && /[A-Z]/.test(c)
}
// a word cut up by - _ . into pieces each under the run floor is one key when
// it flips case inside itself at least twice. A generated key does
// (AbCdEfGh.IjKlMnOp…, nUJqxrpd9Bc7-GvG7J--o…, wJalrXUtnFEMI-K7MDENG-…), and
// so does a vendor key whose front is lowercase words — sk-ant-api03-
// Eyai1pkJrF_Kbwt flips at Ey and at Kw, and counting flips rather than pieces
// is what keeps it. A name capitalises each piece and stops: MyProvider-Prod-
// Edition-2026, DeepSeek-V3-2-Chat-Preview and some-long-file-name-WithCaps
// each flip exactly once. Counting per piece was the first cut and it lost
// sk-ant-api03-Eyai1pkJrF_Kbwt — one flipping piece — with no test to catch it;
// measured, counting the flips in the word keeps every key and no name.
// 32+ with digits and one 12+ piece is a hex digest, splitDigest's to take
const alternates = (word) => (word.match(/[a-z][A-Z]/g) ?? []).length >= 2
// the judgement takes one word — arg() hands it the whitespace-delimited piece,
// so there is no whitespace in it and no value of nothing but spaces to answer
// for. It was written for a whole value once, and a value with a trailing space
// in it answered "not a key": that is the frame this round closed
const isKey = (word) => {
  // an upper-cased vendor key is the same key, and its pieces are too short
  // for the run floors ("SK-ANT-API03-EYAI1PKJRF_KBWT"); the rhythm a key has
  // (a capital beside a digit) tells it from a sentence in capitals
  if (VENDOR.test(word) && word === word.toUpperCase() && /[0-9]/.test(word) && !/[A-Z]{6,}/.test(word.replace(/^[A-Z]+_[A-Z]+_/, ""))) return true
  if (!/[\\/]/.test(word)) {
    // no separator: the whole word is one key, and one key-like run in it is
    // enough (a generated key has no separator at all). PATHY's leading "." is
    // for paths (./x, ../x): a key never begins with one
    if (UUID.test(word) || base64y(word) || (word.match(RUN) ?? []).some(keyRun)) return true
    // A word cut up by - _ . into pieces none of which clears the floor is
    // still one key when the pieces together clear it AND at least two of them
    // alternate case inside themselves. A key does (AbCdEfGh, nUJqxrpd9Bc7); a
    // name capitalises each piece and stops — measured before the second half
    // of that test existed: Qwen3-Coder-480B-A35B-Instruct came back as
    // "Qwen…ruct" and a provider id the user named, MyProvider-Prod-Edition-2026,
    // as "MyPr…2026". 32+ with digits and one 12+ piece is a hex digest written
    // with separators (a version or a date has no such piece). A word with no
    // separator is not judged here: the run test above has already seen all of
    // it
    const c = compact(word)
    if (c === word) return false
    if (c.length >= 20 && alternates(word)) return true
    return splitDigest(word, c)
  }
  // with a separator it is a key only when it does not *start* like a path: an
  // AWS secret (wJalr…/K7MDENG/…) carries slashes but begins with a word, and
  // the shape mask reached only the one long run inside it, leaving 26 of its
  // 40 characters on the terminal. A value that starts like a path (a leading
  // / ~ . , a drive letter, a UNC root) is one — /tmp/ghp_16C7… keeps its
  // shape with the key-like run inside it masked, and a key appended behind
  // such a prefix (…/keys/sk-ant-api03-…) is read as part of that path. It is
  // the one place a key can still show: a path's name is the user's, and a
  // component that is only piecewise key-like cannot be told from a folder
  // without taking the folder away. Two segments of 12+ characters mixing
  // cases is the whole of this arm, and it is what keeps
  // /Users/mison/Documents/SomeLongDirectoryName a path
  const pieces = word.split(/[\\/]/)
  const segs = pieces.filter((seg) => seg.length >= 12 && /[a-z]/.test(seg) && /[A-Z]/.test(seg))
  if (!PATHY.test(word) && segs.length >= 2) return true
  // an AWS secret written in capitals is the same secret: a word with no
  // lower-case letter at all whose slashes cut it into two or more pieces of
  // 12+ capitals ("WJALRXUTNFEMI/K7MDENG/BPXRFICYEXAMPLEKEY" — measured, all
  // 40 characters reached the terminal, and the README says upper-cased keys
  // are masked). A path in capitals is not: /USERS/MISON/DOCUMENTS is a path
  // (PATHY) and its pieces are short anyway, and a word with a lower-case
  // letter in it is the case-mix arm's business, not this one
  // a key cut into pieces by slashes ("ghp_1234Ab/Cd5678EfGh/9012IjKl34/…"):
  // many parts, each key material rather than a word, and the whole reads as a
  // key with the slashes taken out. A path's parts carry lower-case words
  // ("SomeLongDirName" is a name). A key behind a frame starts at its front
  const frontAt = word.search(/ms-|sk-|gh[pousr]_|xox[abposr]-|akia|asia|aida/i)
  const sub = frontAt > 0 ? word.slice(frontAt) : word
  if (!PATHY.test(sub) && !/^[\\/]/.test(sub)) {
    const core = sub.replace(/[^A-Za-z0-9]+$/, "")
    const coreSegs = core.split(/[\\/]/).filter((seg) => seg !== "")
    const frontLen = (core.match(/^(?:ms-|sk-|gh[pousr]_|xox[abposr]-|akia|asia|aida)/i)?.[0] ?? "").length
    const wordy = (seg, i) => /[a-z]{2,}/.test(i === 0 ? seg.slice(frontLen) : seg)
    if (
      coreSegs.length >= 3 &&
      coreSegs.every((seg) => /^[A-Za-z0-9_+=.-]+$/.test(seg)) &&
      !coreSegs.some((seg, i) => wordy(seg, i)) &&
      isKey(compact(core))
    )
      return true
  }
  if (/[a-z]/.test(word)) return false
  const caps = pieces.filter((seg) => seg.length >= 12 && /^[A-Z0-9]+$/.test(seg) && /[A-Z]/.test(seg))
  return !PATHY.test(word) && caps.length >= 2
}
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// A key of another shape pasted with an invisible character inside it — a
// zero-width space from a chat client, a \x01 from a child's echo — reaches
// arg() as two words once show() has turned that character into a space, and
// neither half clears the floor on its own: measured before this was written, a
// 27-character ghp_ token cut in two kept its 14-character back half, an sk-ant
// body its 12. tokenShaped steps over an invisible character only for the ms-
// shape; every other shape was split. This removes such a character before
// show() sees the text, but only where it sits between two key-alphabet
// characters — a real space, a line break or a comma is not glued, so a key is
// put back together and ordinary words are left alone. One character wide at
// each lookaround, so it is a linear pass, not the kind of scan that backtracked
// to minutes on a body of control characters.
const GLUE = new RegExp(String.raw`(?<=[A-Za-z0-9+\/=_.-])${INV}(?=[A-Za-z0-9+\/=_.-])`, "gu")
// VENDOR and MASKED are index.mjs's, to the letter: a key's front that is no
// key on its own, and the ellipsis a mask carries.
const VENDOR = /^(?:sk-|sk_(?:live|test)_|gh[pousr]_|xox[abposr]-|akia|asia|aida|aliyun|ssh-rsa|-----begin)/i
const MASKED = "…"
// keyAt: a word is the front of a key when it is key-shaped on its own or
// carries a vendor's front. A front like "ghp_" or "sk-" is under every word
// floor, and a key cut by whitespace leaves it as a word of its own.
// keyAt: a word is the front of a key when it carries a vendor's front
// ("ghp_", "sk-", "ms-") or is key-shaped on its own
const keyAt = (w) => VENDOR.test(w) || /^ms-/i.test(w) || isKey(w)
// a body of a vendor key cut by whitespace keeps its prefix together — "ghp_"
// on one line and 1234 on the next is ghp_ 1234 — and nothing else is joined:
// a key-shaped word next to a prose word is a key's end (its own pass masks
// it by its own ends), and joining the prose would move the ends
const PREFIX = /^(?:sk_(?:live|test)_|sk-|gh[pousr]_|github_pat_|xox[abposr]-|akia|asia|aida)/i
// a word after the front continues it when it is key material the floors miss
// on its own: a digit in it, or a short piece with a capital
const continues = (w) => (/[0-9]/.test(w) || /[A-Z]/.test(w)) && !VENDOR.test(w)
const glued = (ws) => ws.map((w) => w[0]).join("")
// startProse: a run's first word is a word of prose — all lower-case letters,
// two or more of them — and a run that starts with one is no key's head.
const startProse = (w) => /^[a-z]{4,}$/.test(w) && !VENDOR.test(w) && !/^ms-/.test(w)
// a word of English written in capitals, three or more letters
const WORDS = /^[A-Z]{3,}$/
// a run of capitals and digits is a key written without its spaces
// ("AKIAIOSF", "AKIAIOSFODNN7EXA")
const capsPiece = (w) => /^[A-Z0-9]{4,}$/.test(w) && /[A-Z]/.test(w)
// tokenShaped is a /g pattern (used with replace); test() on it would carry
// lastIndex from one call to the next and answer false on the second look
const tokenShaped1 = new RegExp(tokenShaped.source, "iu")
const keyedBody = (body) => (body.match(/[a-z][A-Z]/g) ?? []).length >= 2 && /[A-Z]/.test(body) && /[a-z]/.test(body)
const maskCut = (s) => {
  if (s.length > 32 * 1024) return s
  // a middot or a bullet splits words here: it is one of the spellings a cut
  // arrives in ("ms-a·b·c"), and one word with middots inside it is a shape no
  // reading below can take apart
  const words = [...s.matchAll(/[^\s·•∙‧・]+/g)]
  if (words.length < 2) return s
  const at = (i) => words[i].index
  const end = (i) => words[i].index + words[i][0].length
  const gap = (i) => s.slice(end(i - 1), at(i))
  // a middot or a bullet between pieces is a cut's other spelling
  // ("ms-a·b·c") when the run starts at a key's front or at one-character
  // pieces, or the join already reads as a key; a card's or a log's own
  // separators do not start at either
  const run = (i, k) => glued(words.slice(i, k + 1)).replace(MASKED, "")
  // a vendor front may itself be cut ("xox b-1 234 …"): the head's leading
  // letters and the next word's together carry it
  const frontSplit = (i) => i + 1 < words.length && /^[A-Za-z]+$/.test(words[i][0]) && words[i][0].length <= 5 && VENDOR.test(words[i][0] + words[i + 1][0])
  const MIDDOT_GAP = /^(?:[ \t\u00a0\u3000]?[·•∙‧・]){1,2}[ \t\u00a0\u3000]?$/
  const wordLike = (w) => /^[A-Za-z]+$/.test(w) && /[a-z]/.test(w) && /[aeiouy]/i.test(w)
  const middotGap = (k, w0, i) => MIDDOT_GAP.test(gap(k)) && (w0.length <= 2 || VENDOR.test(w0) || /^ms-/i.test(w0) || frontSplit(i) || !wordLike(words[i][0]) || !wordLike(words[k][0]) || isKey(run(i, k - 1)))
  // a character cut: every piece one character ("A· K· I· A· …"), or a
  // vendor front cut in two and then one character at a time ("G· H· P· _· 1· 2· …")
  // — a shape the run below cannot read, because its prose test ends a run at
  // the first lower-case piece. Read here, on the pieces' own alphabet
  const cutGap = (k) => /^[ \t\u00a0\u3000\r\n]+$/.test(gap(k)) || MIDDOT_GAP.test(gap(k))
  // the key material of a word: what follows a frame's punctuation ("key=AK",
  // "(AK"), the word itself when it carries none. The frame stays as printed
  const frameAt = (w) => {
    // a path is not a frame: its words are the per-word pass's
    if (/[\\/]/.test(w)) return { mat: w }
    const lead = w.replace(/^[^A-Za-z0-9]+/, "")
    // a vendor's front carries its own hyphens ("sk-ant-"), so it is kept
    // whole; anything else is the letters and digits it ends with ("key=123e")
    const sep = Math.max(...'=:([{,"\''.split("").map((c) => lead.lastIndexOf(c)))
    const tail = sep >= 0 ? lead.slice(sep + 1) : lead
    // a piece of a digest is hex and its hyphens ("…=[123e4567-")
    return { mat: VENDOR.test(tail) || /^ms-/i.test(tail) || /^[0-9a-f-]+$/i.test(tail) ? tail : (tail.match(/[A-Za-z0-9]+$/)?.[0] ?? "") }
  }
  // a piece's own spelling may carry the text's punctuation ("0.", "1,")
  // a single hyphen a key was cut at ("… 7·-·e …") is a piece too
  const one = (w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").length === 1 || /^[^A-Za-z0-9]$/.test(w)
  // a key written one character per word is at most a few hundred pieces; a
  // page of them is not a key typed out, and reading every start of it is
  // quadratic (measured: 32 KiB of "A A A …" took 2 s)
  const out = []
  let from = 0
  for (let i = 0; i < words.length; i += 1) {
    // a pair either side of a line break — the break of a wrapped copy, where
    // nothing in between is prose — read joined: the second half of a key
    // behind its front ("ghp_\n1234AbCd…", "no key ghp_\n1234…"). The front
    // is a bare prefix ("ghp_", "sk-", "AKIA"), a word no key floor keeps.
    const brk = i > 0 && /^\r?\n$/.test(gap(i))
    const bare = i > 0 && (PREFIX.test(words[i - 1][0]) || (!keyAt(words[i - 1][0]) && words[i - 1][0].length < 12))
    if (brk && bare && continues(words[i][0]) && end(i) - at(i - 1) >= 20) {
      const pair = glued([words[i - 1], words[i]])
      if (!pair.includes(MASKED) && isKey(pair)) {
        out.push(s.slice(from, at(i - 1)), mask(pair))
        from = end(i)
        i += 1
        continue
      }
    }
    // a run is read from a head: a word carrying a vendor's front or the ms-
    // shape written with its body cut off ("ms-f"), or a run of capitals and
    // digits (a key written without its spaces), or a piece of a key written
    // one character per word. Anything else is the per-word pass's
    // ("spawnSync /tmp/…" is a sentence, not a cut).
    const w0 = words[i][0]
    // a key written one character per word runs five or more such pieces
    // together ("s k - a n t") — a single short word beside a long one is not
    // a head, and asking after it at every position is what made a body of
    // them quadratic
    const tiny = w0.length <= 2 && words[i + 4] !== undefined && words.slice(i, i + 5).every((x) => x[0].length <= 2)
    const msHead = /^ms-/i.test(w0) && !isKey(w0) && !/^ms-[\x21-\x7e]{11,}$/i.test(w0)
    // a key cut inside a mixed-case word ("wJal rXUt nFEM …" is an AWS
    // secret): the join has to be a key of its own, which a sentence's first
    // word after a path is not
    const mixedHead = w0.length <= 16 && /[a-z]/.test(w0) && /[A-Z]/.test(w0)
    // a vendor front itself cut in two ("xox b-1 234 …", "ghp _1234 …"): the
    // front is not a word any floor keeps, and the cut falls inside it
    const frontish =
      w0.length <= 5 &&
      /^[A-Za-z]+$/.test(w0) &&
      i + 1 < words.length &&
      (VENDOR.test(w0 + words[i + 1][0]) || VENDOR.test(w0 + words[i + 1][0].slice(0, 2)))
    // a piece of a digest ("9f8e 7d6c …", "9f8e·7d6c·…", "123e4567-e"): hex
    // with a digit in it, which no word of prose is, and the hyphens a UUID's
    // pieces carry. The card reads the same run
    const digestPiece = (w) => /[0-9]/.test(w) && /^[0-9a-f-]+$/i.test(w) && !/^-+$/.test(w)
    const hexHead = digestPiece(w0)
    // a head behind a frame's punctuation ("key=AK IA…", a JSON quote, a
    // bracket): the key material is what follows the frame, and the frame
    // itself is kept as printed. Two characters of it at least — a single
    // letter behind a frame is the per-word pass's ("NickName=[A") — and the
    // run still has to read as a key below
    const { mat } = frameAt(w0)
    // a word with no frame may carry the key's head inside it ("no key
    // ms-aaaa…"): its part that reads as a digest. A path is not read that
    // way ("/tmp/ms-ZZZZ…" is masked as the token it is, by the per-word pass)
    const band = /[\\/]/.test(w0) ? undefined : (w0.match(/[A-Za-z0-9]+/g) ?? []).find((b) => b.length >= 2 && digestPiece(b))
    const t0 = mat !== w0 && mat.length >= 2 ? mat : band && band.length >= 2 ? band : w0
    // the head's key material with its frame kept outside the mask
    const tailHead = t0 !== w0
    if (!VENDOR.test(w0) && !capsPiece(w0) && !msHead && !tiny && !mixedHead && !frontish && !hexHead && !tailHead) continue
    // two key-shaped words are two keys: one mask for both would hide the
    // second's front ("ms-aaaa… ms-zzzz…" is not one key)
    const pairOfKeys = i + 1 < words.length && /^[ \t\u00a0\u3000]+$/.test(gap(i + 1)) && keyAt(words[i][0]) && keyAt(words[i + 1][0])
    let j = i
    let head = i
    // the last word a run read, and whether anything in it was key material:
    // a start that found neither hands the scan on to there ("A A A …" is one
    // pass, not one run per word), while a run that saw a digit or a front may
    // still hold a key's head further on and is read word by word
    let last = i
    let sawKey = false
    let body = t0
    for (let k = i + 1; !pairOfKeys && k < words.length && k - i <= 48 && (/^[ \t\u00a0\u3000\r\n]+$/.test(gap(k)) || middotGap(k, w0, i)); k += 1) {
      const x = words[k][0]
      last = k
      if (/[0-9]/.test(x) || VENDOR.test(x)) sawKey = true
      // every piece is short enough or a vendor front; a word of a sentence in
      // between ("the log said") goes on only when what follows is key-shaped
      // again and the body has a capital or a digit — an echo's own words
      // ("aaabbb… x aaaccc… 1234", one piece between two of the key's)
      if (x.length > 16 && !VENDOR.test(x) && !(/^[0-9a-f-]+$/i.test(x) && /[0-9]/.test(x))) break
      // a piece of capitals and digits is key material ("xox b-1 234 567 890
      // 12- …" is one key cut into threes): a key is written in capitals and
      // digits more often than a word of prose is
      // the cut of a vendor front into capitals and digits ("xox b-1 234 567
      // 890 12- …"): the piece after the front starts with a digit, the pieces
      // are short, and none is a capitalised word ("Release", "Notes")
      const capsy = i + 1 < words.length && /^-?[0-9]/.test(words[i + 1][0]) && x.length <= 16 && /[A-Z0-9]/.test(x)
      body += x
      const pieces = [t0, ...words.slice(i + 1, k + 1).map((w) => w[0])]
      // the head is not a word of the run's own: "xoxb -123 4567 …" begins at
      // a front cut in two, and reading the front as prose ended the run
      // a piece joined by a middot or a bullet is key material whether or not
      // it reads as a word ("ms-f·orei·gn-0·…"): the card's separators are the
      // ones with a word on both sides, and those a run started at a key's
      // front can still be checked against the key below
      const mid = MIDDOT_GAP.test(gap(k))
      const prose = !mid && pieces.slice(1).some((w) => w.length >= 4 && /^[a-z]{4,}$/.test(w) && !VENDOR.test(w))
      if (prose && !(/^ms-/i.test(w0) && tokenShaped1.test(body)) && !(keyAt(x) && pieces.some((w) => /[A-Z]/.test(w) || /\d/.test(w)))) continue
      // the body of a key cut by spaces: 20+, a key-shaped run in the head —
      // the front, or the word after it ("ghp_ 1234 AbCd…"; "sk-a nt-a pi03…"
      // is a vendor key whose body is all its pieces, and the head's run is
      // no key on its own: sk / ant / a are all short)
      // the body is a key when it reads as one written: joined it reads as the
      // ms- shape with its body intact ("ms-f orei gn-0 1234 …"), or the key it
      // writes joined is one word ("sk-a nt-a pi03…" is
      // sk-ant-api03-Eyai1pkJrF_Kbwt), or — from a vendor front — the head
      // flips case inside itself. A word after the first piece is prose
      // ("sk-preset-20261031 is a provider id")
      // ("sk-a" is not a vendor front, and the vendor front of "sk-preset" is
      // the whole word; either way the words after the first piece are prose)
      // a piece of exactly four lower-case letters is a piece while the run is
      // on the key's own alphabet from its front
      const allKey = pieces.slice(1).every((w) => /^[A-Za-z0-9+/=_.-]*$/.test(w)) || pieces.length >= 3
      // a lower-case run of four or more letters after the head is prose, or
      // a path's word ("/tmp/ms-ZZZZ…"): a key's pieces carry capitals or
      // digits
      const plain = pieces.slice(1).some((w) => w.length >= 4 && /^[a-z]{4,}$/.test(w) && (w.length > 4 || !allKey || !/[A-Z0-9]/.test(body.replace(w0, "").replace(w, ""))))
      // a bare front (ghp_, sk-, xoxb-) is a word no key floor keeps, and the
      // pieces after it are the key; a vendor-like word that carries more than
      // the front ("sk-preset-20261031") is a provider id, and its run only
      // counts when the join is a key of its own
      const bareFront = VENDOR.test(pieces[0]) && pieces[0].length <= 8
      // a front cut in two leaves a shorter body than the floor reads: the
      // front itself is half of it ("xoxb-12345678901" is 16 characters), and
      // the front's own evidence stands in for the missing four
      const capMixed = pieces.slice(1).some((w) => /[0-9]/.test(w)) && pieces.slice(1).some((w) => /[A-Z]/.test(w))
      const capFront = /^[a-z]{1,5}$/.test(pieces[0]) && /[0-9]/.test(pieces[1]) && /[A-Za-z]/.test(pieces[1])
      const shortFront = frontish && pieces.length >= 3 && pieces.slice(1).some((w) => /[0-9]/.test(w))
      const cut =
        /\d/.test(body) &&
        body.length >= (frontish ? 16 : 20) &&
        !body.includes(MASKED) &&
        // a middot or a bullet is a cut's spelling too, and the key it writes
        // is the characters joined without them
        (isKey(body) ||
          // the key the pieces write when the card's own separators — the
          // middots and the hyphens a UUID is drawn with — are left out
          (mid && isKey(body.replace(/[·•∙‧・]/g, ""))) ||
          (mid && isKey(body.replace(/[·•∙‧・-]/g, ""))) ||
          (msHead && tokenShaped1.test(body) && !pieces.some((w) => /^[A-Za-z]{2,}$/.test(w) && !VENDOR.test(w) && w !== w0)) ||
          (bareFront && !plain && (pieces.slice(0, 2).join("").match(/[A-Za-z0-9]+/g) ?? []).some((r) => keyRun(r) || r.length >= 4 || keyedBody(body))) ||
          (capsy && (capMixed || capFront) && !pieces.some((w) => /^[A-Z][a-z]{3,}$/.test(w))) ||
          (shortFront && !pieces.some((w) => /^[A-Z][a-z]{3,}$/.test(w)))) &&
        (k - i >= 2 || !bareFront)
      if (!cut) continue
      j = k
    }
    if (j === i) {
      if (!sawKey && last > i) i = last
      continue
    }
    // the head's frame is kept as printed and only its key material goes into
    // the mask ("key=AK IA…", "no key ms-aaaa…" loses none of its "no key")
    const keep = w0.length - t0.length
    const keyText = [t0, ...words.slice(i + 1, j + 1).map((w) => w[0])].join("").replace(MASKED, "")
    out.push(s.slice(from, at(i) + keep), mask(keyText.replaceAll(MASKED, "")))
    from = end(j)
    i = j
  }
  // the character runs are read after the runs above, on the text they left:
  // a key typed one character at a time is the last shape to look for, and a
  // page of such pieces is not a key typed out

  const singles = words.reduce((n, w) => n + (w[0].length === 1 ? 1 : 0), 0)
  const chars = []
  let cfrom = 0
  for (let i = 0; i < words.length && singles <= 512; i += 1) {
    // a piece inside a run already read is not a head
    if (words[i][0].length === 1 && i > 0 && MIDDOT_GAP.test(gap(i)) && words[i - 1][0].length === 1) continue
    // a piece that stands behind a frame's punctuation ("key=1·2·3·…") is
    // the first of the run: the frame is kept as printed
    const piece = words[i][0]
    const { mat } = frameAt(piece)
    const pieceOk = piece.length === 1 || (mat.length === 1 && piece.endsWith(mat))
    if (!(pieceOk || (/^[A-Za-z]{1,3}$/.test(piece) && i + 1 < words.length && one(words[i + 1][0]) && cutGap(i + 1)))) continue
    let k = i
    while (k + 1 < words.length && k - i <= 96 && cutGap(k + 1) && one(words[k + 1][0])) k += 1
    // the last piece's trailing punctuation is the text's own ("… 0."), not
    // key material: the mask stops before it
    const last = words[k][0].replace(/[^A-Za-z0-9]+$/, "")
    const got = (piece.length === 1 ? piece : mat) + glued(words.slice(i + 1, k)) + last
    if (k > i && got.length >= 20 && isKey(got)) {
      const keep = piece.length - (piece.length === 1 ? 1 : mat.length)
      chars.push(s.slice(cfrom, at(i) + keep), mask(got))
      cfrom = at(k) + last.length
      i = k
    }
  }
  // what the character runs left is read by the same pass again, on the
  // text it produced (a second pass finds no character runs to read)
  if (chars.length) return maskCut(chars.join("") + s.slice(cfrom))
  return out.join("") + s.slice(from)
}

// maskCaps is the vendor key written without its spaces, a run of capitals and
// digits ("AKIAIOSF ODNN7EXA MPLE"): a whole word is the general pass's, and
// this reading joins a run of pieces of capitals and digits when they add up
// to an AWS key id or a long run of capitals.
const capsRun = (s) => {
  if (s.length > 32 * 1024 || !/[A-Z]/.test(s)) return s
  const words = [...s.matchAll(/[\x21-\x7e]+/g)]
  const out = []
  let from = 0
  for (let i = 0; i < words.length; i += 1) {
    // three characters is a key's piece too ("AKI AIO SFO …" is a key cut
    // into threes); the join still has to be long enough to be one, so a
    // sentence of two capitals is not read
    if (!/^[A-Z0-9]{3,}$/.test(words[i][0]) || !/[A-Z0-9]/.test(words[i][0])) continue
    let j = i
    let body = words[i][0]
    // a piece carries the card's own separator on its end ("AKIAIO· SFODNN·…")
    const piece = (w) => w.replace(/[·•∙‧・]+$/, "")
    // the join stops at four times RUNCUT: a key is never longer, and a body
    // of tiny words ("1A1 1A1 …") is otherwise re-read from every start
    while (j + 1 < words.length && body.length < 4 * RUNCUT && s.slice(words[j].index + words[j][0].length, words[j + 1].index).length <= 2 && /^[A-Z0-9]{2,}$/.test(piece(words[j + 1][0]))) {
      j += 1
      body += piece(words[j][0])
    }
    if (j === i) continue
    const aws = /^AKIA[0-9A-Z]{16}$/.test(body)
    const long = body.length >= 16 && !/[a-z]/.test(body)
    if (!aws && !long) continue
    // a run of English words in capitals ("SEE ALSO THE DOCUMENTATION")
    // joins to one: a sentence is longer than any key this reads, and its
    // words are three letters or more
    if (!aws && body.length > 40) {
      // a sentence of capitals: no key starts inside it (a key's suffix
      // inside a long run would have been a body over the limit too), and the
      // next start is the end of what was read, less the length a key can be
      i = Math.max(i, j - 13)
      continue
    }
    // the same rhythm rule as the card's capitals reading: an all-capitals
    // run needs a capital beside a digit ("AKIA…7"), or it is prose in caps
    if (!aws && !/[A-Z][0-9]/.test(body) && !/[0-9][A-Z]/.test(body)) {
      if (j > i) i = Math.max(i, j - 13)
      continue
    }
    out.push(s.slice(from, words[i].index), mask(body))
    from = words[j].index + words[j][0].length
    i = j
  }
  return out.join("") + s.slice(from)
}

// joinedKey is the whole-value judgement the full-width reading needs: every
// word joined back up begins at one ms- front and the rest reads as key
// material. Unlike spacedKey's walk it does not stop at a word of letters: a
// key cut into four-character groups has such pieces ("qmjh") in it, and the
// walk was the full-width reading's only path to a mask — a full-width space
// between the groups then went out with every piece printed. The mask covers
// the whole value, so a trailing frame is hidden with it, which is what the
// full-width reading has always done (the same value with ASCII spaces keeps
// its frame: spacedKey finds the span there).
const joinedKey = (s) => {
  const words = s.trim().split(/\s+/)
  if (words.length < 2) return false
  const joined = words.join("")
  const at = joined.search(/ms-/i)
  // only punctuation may precede the front: a letter or digit before it means
  // the "ms-" is part of a word ("Microsoftms-access…" is not a key)
  if (at < 0 || /[A-Za-z0-9]/.test(joined.slice(0, at))) return false
  if (joined.slice(at + 3).search(/ms-/i) >= 0) return false
  const rest = joined.slice(at + 3)
  return rest.length >= 11 && /\d/.test(rest) && /^[A-Za-z0-9+/=_.-]+$/.test(rest)
}

export function arg(v) {
  const orig = String(v ?? "")
  // the ms- front has its own joiner for pieces of any width (one to a
  // character), and it reads the value as it was typed
  const cut = spacedKey(orig.replace(GLUE, ""))
  // the body spans the gaps the pieces were cut with; the key is the
  // characters themselves, and mask() keeps its first and last four — a
  // three-character last piece ("… nop3 456") otherwise shows the gap in the
  // mask ("ms-a… 456")
  if (cut) return argRun(cut.pre) + mask(cut.body.replace(/\s+/g, "")) + argRun(cut.post)
  // full-width pieces fold to a key; an ellipsis folds to three dots and would
  // read as key material ("ms-a…5555" → "ms-a...5555"), so a value that
  // already carries a mask is not asked again
  const foldedRaw = orig.normalize("NFKC").toLowerCase()
  const raw = orig.replace(GLUE, "")
  // the mask keeps the value's first and last four: those are the key's own
  // characters, not the no-break or ideographic spaces it was cut with
  if (foldedRaw !== raw && !raw.includes("…") && joinedKey(foldedRaw)) return mask(raw.replace(/\s+/g, "").trim())
  return argRun(raw)
}

// argRun is the whitespace routes of one value, tried until none finds more
// ("ghp_ 1234 AbCd 5678…" is one body only from 1234 on, and the front is
// part of a key-shaped piece by then): a run of words; a line break (or a
// wide space a full-width copy left) between two words; then the per-word
// judgement. Each route masks strictly more, so the walk ends.
function argRun(text) {
  // a body of many KiB of one-character words (a pretty-printed page) costs
  // far more reading than the masking is worth here: past 32 KiB the cut
  // reading is skipped and the per-word pass (linear) still runs
  if (text.length > 32 * 1024) return argWords(text)
  // The two readings the body has are applied together, until neither finds
  // anything: the whitespace routes (maskCut, and capsRun for a vendor key
  // written without its spaces, "AKIAIOSF ODNN7EXA MPLE") each mask what they
  // join, and argWords then judges every word the join did not take. One
  // pass of each per round, so a round over ordinary text is a couple of
  // scans, not a dozen.
  let s = text
  for (let n = 0; n < 4; n += 1) {
    const next = argWords(maskCut(capsRun(s)))
    if (next === s) break
    s = next
  }
  return s
}

// argWords is the per-word judgement: one word key-shaped is masked whole,
// and inside a word that is not, its key-like runs and UUIDs are masked. The
// word in the other spellings a key is printed in — full-width characters,
// mostly — is judged by its folded copy and masked as written.
const argWords = (x) =>
  show(x).replace(/[^\s]+/g, (w) => {
    const f = w.normalize("NFKC").toLowerCase()
    // the word as written and its fold. The capitals need no third call: a
    // word that is already all capitals is judged whole by isKey (its slashed
    // arm), and upper-casing a lower-case word to ask the question would read
    // every long provider id with a date in it as a key (modelscope20261031)
    if (isKey(w) || isKey(f)) return mask(w)
    // a value behind a flag or a frame ("--bad=SK-ANT-…", "NickName=[ghp_…")
    // is judged by what the frame encloses
    const kAt = w.search(/[A-Za-z]/)
    if (kAt > 0 && !/[\\/]/.test(w.slice(0, kAt)) && isKey(w.slice(kAt))) return mask(w)
    const marks = (y) => y.replace(RUN, (r) => (keyRun(r) ? mask(r) : r)).replace(UUID_ANY, (m) => mask(m))
    const out = marks(w)
    // the folded copy can be key-shaped where the original is not — a token
    // written in full width has no ASCII runs and no ASCII path prefix, so the
    // passes above saw a word of ordinary text. When the folded copy would be
    // masked, the word is masked whole: mapping the mask back onto the
    // original spelling is not something NFKC can promise, and the whole word
    // is what the user typed anyway. A key already masked ("ms-a…5555") is left
    // as it is: it is a short string of letters now, and the token shape no
    // longer matches it — but its mask is not a word to be judged again.
    if (out === w && (marks(f) !== f || f.match(tokenShaped)) && !w.includes("…")) return mask(w)
    return out
  })

// SENDABLE is the plugin's own test (index.mjs's tokenOf): a key with
// anything but visible ASCII in it goes out in a Cookie/Authorization header
// and the runtime rejects it. Both directions of this tool write a key the
// plugin will later send, so both refuse it here — a success this tool
// reports for a key that cannot work is worse than the refusal.
const SENDABLE = /^[\x21-\x7e]+$/

function hostOf(chat) {
  if (typeof chat !== "string") return ""
  try {
    return new URL(chat).hostname.toLowerCase()
  } catch {
    return ""
  }
}

// oursOf and keyedOf are the two tests "a provider we could sync" is made of,
// and they are asked in two places: presetCandidates' search, and main's
// no-preset advice (which names the provider the user already has instead of
// telling them to add one). Two copies of the rule would drift — the advice
// naming a provider the search does not consider is exactly the bug that
// pair was written to fix — so there is one copy.
const oursOf = (p) => p?.id === PRESET || p?.preset === PRESET || hostOf(p?.chat) === HOST
const keyedOf = (p) => typeof p?.key === "string" && Boolean(p.key.trim())

// The plugin-side accounts: the primary key msmoli plus msmoli#xxxxxx, told
// apart by token.
//
// The token is only read from entries with type === "api" — the same rule the
// plugin itself uses (rawKey in index.mjs). Without that rule, a
// plugin-auth.json that puts the key in the wrong place or writes the wrong
// type would make this tool say the plugin already uses the same token and
// nothing needs doing, while the plugin cannot read the token and the card
// always shows signed out: a silent wrong state is harder to notice than an
// error.
export function pluginAccounts(auth) {
  const obj = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {}
  return Object.entries(obj)
    .filter(([k]) => k === ID || k.startsWith(`${ID}#`))
    .map(([name, v]) => ({ name, token: v?.type === "api" && typeof v.key === "string" ? v.key.trim() : "" }))
}

// { action: "noop" | "run" | "refuse", lines: string[], cmds: [{ argv, stdin? }] }
export function planToPlugin({ preset, accounts, force }) {
  const lines = []
  // The SENDABLE guard runs before the "already the same" check: two files
  // holding the same key with a space in it are "the same" and unusable, and
  // reporting noop would tell the user everything is fine while every
  // check-in reports a token it cannot recognise.
  if (!SENDABLE.test(preset.key)) {
    lines.push(`✗ 内置预设的 key 含空格、换行或非 ASCII 字符，插件发不出去，不登录。`)
    // the provider the user actually has, not the preset's default id: a
    // vendor found by --from or by its chat host is named "my-ms", and
    // telling them to fix "modelscope" sends them to a provider that isn't
    // there — or, on a machine that has both, to the wrong one.
    lines.push(`  先修好内置那边的 key（magpie provider key ${arg(preset.id)} <key>）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  const same = accounts.find((a) => a.token === preset.key)
  if (same) {
    lines.push(`✓ 插件已用同一把令牌（${mask(preset.key)}），无需操作。`)
    return { action: "noop", lines, cmds: [] }
  }
  if (accounts.length === 0) {
    lines.push(`→ 将把内置预设（${arg(preset.id)}）的令牌登录给插件：magpie plugin login ${ID}（令牌走 stdin）`)
    return { action: "run", lines, cmds: [{ argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key }] }
  }
  // Every entry is there but none carries a token the plugin itself would read
  // (a msmoli entry of the wrong type, or a key that is not a string). "The
  // tokens differ on the two sides" is a claim we cannot make here — we never
  // read the plugin's side — and --force would not help: the file is the
  // problem, not the choice.
  if (accounts.every((a) => !a.token)) {
    lines.push(`✗ 插件里 ${ID} 的条目读不出令牌（type 不是 api，或 key 不是字符串）。`)
    lines.push(`  magpie 也不会把它算作登录。${arg(accounts[0].name)} 那个条目请先删掉或重新登录，再重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
  lines.push(`  插件现有：${accounts.map((a) => `${arg(a.name)}（${mask(a.token)}）`).join("、")}`)
  lines.push(`  内置预设：${arg(preset.id)}（${mask(preset.key)}）`)
  if (!force) {
    lines.push(`✗ 两边令牌不同，未做改动。`)
    lines.push(`  直接 login 会新增第二个账号（宿主按令牌分账号），logout 会登出该 provider 的全部账号，`)
    lines.push(`  两个默认动作都不是你要的。确认要换成内置那把，加 --force 重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (accounts.length > 1) {
    lines.push(`✗ 插件有 ${accounts.length} 个账号，--force 不适用：替换要先 logout，那会一次登出全部账号。`)
    lines.push(`  请先在 magpie 里删掉多余账号，或手动执行。`)
    return { action: "refuse", lines, cmds: [] }
  }
  lines.push(`→ 将先 logout（登出 ${arg(accounts[0].name)}）再 login 内置那把。当天已签到的记录会重来，昵称下次签到时写回。`)
  return {
    action: "run",
    lines,
    cmds: [
      // logout carries the secret too: the key being replaced is a real
      // credential, and a magpie error that echoes the account ("no key ms-…
      // for provider") must not put the whole string on the terminal
      { argv: ["plugin", "logout", ID], stdin: "", secret: accounts[0].token },
      { argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key },
    ],
  }
}

// provider key replaces the whole main key and chat requests are using it — so
// this direction demands --force by default too.
export function planToPreset({ preset, accounts, force }) {
  const lines = []
  const main = accounts.find((a) => a.name === ID)
  if (!main?.token) {
    // A second account holding the token the preset already has is the state
    // a forced replace leaves behind (or a re-login after a nickname write).
    // There is nothing to sync, and "the main account is not signed in" would
    // read as "your plugin is signed out" while --to-plugin answers "nothing
    // to do" for the very same pair of files.
    const same = preset && accounts.find((a) => a.token && a.token === preset.key)
    // SENDABLE runs before the noop, here as in planToPlugin: two sides that
    // hold the same unusable key are "the same", and noop would call that
    // healthy. A key with a space in it cannot be sent at all, whichever side
    // it came from — this is the reverse direction's only early exit, and the
    // main-account and forward paths refuse it.
    if (same && preset && !SENDABLE.test(preset.key)) {
      lines.push(`✗ 两边是同一把令牌，但它含空格、换行或非 ASCII 字符，发不出去。`)
      lines.push(`  先修好内置那边的 key（magpie provider key ${arg(preset.id)} <key>），或重新登录插件。`)
      return { action: "refuse", lines, cmds: [] }
    }
    if (same) {
      lines.push(`✓ 插件的 ${arg(same.name)} 已与内置预设用同一把令牌（${mask(same.token)}），无需操作。`)
      return { action: "noop", lines, cmds: [] }
    }
    lines.push(`✗ 插件主账号（${ID}）没有登录，没有可同步的令牌。`)
    lines.push(`  先用 magpie plugin login ${ID} 登录，或用 --to-plugin 从内置预设同步。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (!preset) {
    lines.push(`✗ 内置还没有 ModelScope 预设，没有可写的地方。`)
    lines.push(`  要加的话：magpie provider add ${PRESET} <key>（工具不代建 provider）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  // The plugin refuses a key with anything but visible ASCII in it (tokenOf,
  // it would go out in an Authorization header). Writing such a key into the
  // preset would break chat requests while this tool reported success — and
  // "both sides already hold this key" is not a healthy state to call done.
  if (!SENDABLE.test(main.token)) {
    lines.push(`✗ 插件里那把令牌含空格、换行或非 ASCII 字符，发不出去，不写进内置预设。`)
    lines.push(`  先修好插件那边的登录（magpie plugin login ${ID}）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (preset.key === main.token) {
    lines.push(`✓ 内置预设已用同一把令牌（${mask(main.token)}），无需操作。`)
    return { action: "noop", lines, cmds: [] }
  }
  lines.push(`  插件主账号：${ID}（${mask(main.token)}）`)
  // an empty key is a preset with nothing to lose: this is the write that
  // fills it, and the wording should not claim a key is being replaced
  lines.push(
    preset.key
      ? `  内置预设：${arg(preset.id)}，现有 key（${mask(preset.key)}）会被整条替换。`
      : `  内置预设：${arg(preset.id)}，现在没有 key，会被填上。`,
  )
  // The first argument of provider key is the id: an id starting with "-"
  // would be taken as a flag by magpie's CLI (`provider key --help <token>`
  // only prints help and writes no key).
  if (typeof preset.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preset.id)) {
    lines.push(`✗ 这个 provider id 不是 magpie 接受的形状（${arg(preset.id)}），不能用 provider key 写入。`)
    return { action: "refuse", lines, cmds: [] }
  }
  // --force is the permission to *replace* a key chat may be using. A preset
  // with no key has nothing to replace: filling it is the whole point, and
  // asking for --force there was a refusal the README never promised.
  if (!force && preset.key) {
    lines.push(`✗ 内置这把 key 是聊天请求正在用的，替换会让那边跟着换。确认的话加 --force 重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
  lines.push(`→ 将执行 magpie provider key ${arg(preset.id)}（令牌是该命令的参数，进程列表里短暂可见）。`)
  // Both keys are secrets here, not just the new one: the command replaces
  // the old key, and a host that says what it replaced ("cannot use key
  // ms-… for modelscope") echoes a real credential of the user's. The
  // --to-plugin logout step has kept the outgoing token for the same reason.
  return { action: "run", lines, cmds: [{ argv: ["provider", "key", preset.id, main.token], secret: main.token, also: preset.key }] }
}

// ---- execution

// A multi-step sequence (--force's logout→login) failing midway: the logout
// has already happened, so the user is signed out at this moment. Both a
// timeout (r.error) and a nonzero exit code (r.status) must say this.
const RECOVER = `注意：前面的步骤已经执行，现有登录已被登出。重新运行同一条命令即可继续（此时插件没有账号，会直接登录，无需 --force）。`

function hidden(argv, secret, log) {
  // show() and not the raw argument: an id read out of providers.json can be
  // token-shaped (a token pasted into the wrong field), and this line is the
  // one place a command's arguments are printed whole. The plan line above
  // already goes through show(); the echo must not be the leak.
  const shown = argv.map((a) => (secret && a === secret ? mask(secret) : arg(a)))
  log(`$ magpie ${shown.join(" ")}`)
}

// maskEchoes masks a piece of a secret wherever the text carries one. A split
// on the exact string catches a byte-for-byte echo; a child (or the vendor
// behind it) that printed only the front of a token, or framed it, is no
// longer equal to the secret and split() walked past it. A piece is a run of
// the text that is a contiguous substring of the secret, at least MIN_ECHO
// characters long — below that a coincidence is likelier than an echo. It is
// the same rule index.mjs's cardText carries, and the same reason.
// the same floor as index.mjs's card mask: a piece of the secret this long is
// an echo, and the scan starts one character past a shorter run
const MIN_ECHO = 10
// An echo is compared folded: NFKC (full-width look-alikes are the same
// credential) and lower case (upper-casing a log does not make it another
// key), letters and digits only. Comparing byte for byte let either change
// print the whole secret.
const fold = (s) => (typeof s === "string" ? s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "") : "")
function maskEchoes(s, secret) {
  if (typeof secret !== "string") return s
  // The secret's own alphanumeric run is what the scan compares against.
  // Collecting "the characters the secret is made of" instead let a character
  // the secret genuinely holds be used as a cutter: a hyphen every 11
  // characters (every ms- key carries hyphens) split the echo into runs each
  // under MIN_ECHO. Punctuation is a separator whether the secret holds it or
  // not; only its letters and digits say "this is the secret". Anything else —
  // a control character, a space, a comma, a piece of punctuation a child
  // wrapped the echo in — is stepped over and the pieces on either side joined
  // for the comparison. It is the same rule index.mjs's cardText carries (a
  // whitelist of separators cannot cover an open set), and here it is what
  // keeps a secret broken across a line, or printed under a prefix, whole.
  //
  // The matching runs over those characters alone, in one pass, and the spans
  // are put back afterwards. Stepping over a character as the scan went — and
  // restarting one position later when the run came up short — cost a run of
  // them its own length at every position it held: a child's output of 20 000
  // control characters took 79 seconds.
  const flat = fold(secret)
  if (flat.length < MIN_ECHO) return s
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
      // characters the secret does not hold here, between two pieces of it: a
      // child that prints "01234567x 89abcdefx …" writes pieces under MIN_ECHO
      // with one letter between them, and the pieces together are the key. Up
      // to as many as the run has already matched are stepped over — an echo
      // is mostly the secret — and the run resumes at the first that continues
      // it. Only inside a run: skipping a leading character before anything
      // matched swallows the word in front of the key. The same rule, and the
      // same reason, as index.mjs's card mask.
      if (piece.length === 0) break
      // one character is stepped over however little has matched; more than
      // one only when the run is already long enough to be an echo on its own
      // (MIN_ECHO, the same floor the mask applies). Without that second half,
      // "said: aaaa1111-b" matched the last s of "said" and then skipped "id"
      // to join the piece, and a 9-character slice that the floor is meant to
      // leave alone was masked as if it were longer. Here the source text
      // after the cut is "01234 56789…", and "234 56789" are not a piece to
      // bridge.
      if (piece.length < MIN_ECHO) break
      const stop = Math.min(vis.length, v + 1 + (piece.length - fillers))
      let hit = -1
      for (let j = v + 1; j < stop; j += 1) if (flat.includes(piece + vis[j])) { hit = j; break }
      if (hit < 0) break
      fillers += hit - v
      v = hit
    }
    // the floor counts the secret's own characters, not the punctuation the
    // echo wrote them in — the same rule, and the same reason, as index.mjs's
    // card mask
    if (piece.length >= MIN_ECHO) {
      // what sat between the last character written and the run's first one is
      // written out first, so masking does not swallow the words around it
      out += s.slice(from, at[k])
      out += mask(secret)
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

// scrub hides a token in text that came from a child process. Both paths use
// it: the answer printed on success, and the failure printed in the error —
// the failing path is the one most likely to carry the command back verbatim
// ("no key ms-… for provider"), and hiding it only on success was the gap.
//
// It ends in arg(), which is the same door the command line goes through:
// a split only hides the secrets this run knows about, and magpie's output
// can carry a token this tool never held (another provider's key in the
// message, a token the user pasted into the wrong field). show() alone was
// not enough — it masks only the ms- shape, so a child echoing a custom
// vendor's key (a ghp_… GitHub token, an AWS secret) printed it whole. arg()
// masks the shape and strips control characters, so a forged line or an
// escape sequence in the child's output cannot reach the terminal either.
// scrub() alone, with only the known secrets, was the leak the failing path
// had.
function scrub(out, ...secrets) {
  let s = out.length > 32 * 1024 ? out : maskCut(out)
  for (const secret of secrets) {
    if (secret) s = maskEchoes(s.split(secret).join(mask(secret)), secret)
  }
  // arg() over the whole text first: its run reading covers a key cut by a
  // line break or by spaces across the child's lines (a wrapped page, a
  // pretty-printed error), which a line at a time cannot see. Then per line,
  // as before: the control-character pass turns "\n" into a space, and both
  // callers split on the line breaks to echo (or quote) the child's answer.
  return s.replace(/\r\n?/g, "\n").split("\n").map(arg).join("\n")
}

function run(cmds, bin, { dryRun, log, spawn = spawnSync, timeout = 120_000 }) {
  for (let i = 0; i < cmds.length; i++) {
    const { argv, stdin, secret } = cmds[i]
    // `also` is a secret this step handles without it being an argument: the
    // preset key a `provider key` replaces, the token a `logout` signs out.
    const secrets = [...new Set(cmds.slice(0, i + 1).flatMap((c) => [c.secret, c.also]).filter(Boolean))]
    hidden(argv, secret, log)
    if (dryRun) continue
    // maxBuffer: magpie's own output is a few lines, but a verbose host must
    // not turn into an ENOBUFS that reads as "the binary would not run" —
    // the write may already have landed by then.
    const r = spawn(bin, argv, { input: stdin, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
    if (r.error) {
      const code = r.error.code ?? ""
      // A .cmd/.bat/.ps1 is a shell wrapper, not something spawnSync can hand
      // a stdin to (Windows answers EINVAL). Saying "use --magpie" to someone
      // who just used --magpie is no help: point at the .exe instead.
      const wrapper = /\.(cmd|bat|ps1)$/i.test(bin)
      const hint =
        code === "ENOBUFS"
          ? "（magpie 的输出过大，没能读完；它可能已经执行完，用 --status 看一眼）"
          : code === "ETIMEDOUT"
            ? `（magpie 超过 ${Math.round(timeout / 1000)} 秒没有结束）`
            : wrapper
              ? "（这是包装脚本，请指向同目录的 magpie.exe）"
              : "（用 --magpie 指定完整路径）"
      // the runtime's message names the path it ran ("spawnSync <path>
      // ENOENT"), so it goes through the same door as the child's output
      const e = new Error(`跑不动 ${arg(bin)}：${scrub(String(r.error.message ?? ""), ...secrets)}${hint}`)
      if (i > 0) e.recover = RECOVER
      throw e
    }
    if (r.status !== 0) {
      // a child killed by a signal has status null; "exit code null" tells nobody anything
      const why = r.status === null && r.signal ? `被信号 ${r.signal} 终止` : `退出码 ${r.status}`
      const said = scrub(out, secret, ...secrets).split("\n").filter(Boolean).slice(-3).join("\n")
      const e = new Error(`magpie 命令失败（${why}）${said ? `：\n${said}` : ""}`)
      // A multi-step sequence (--force's logout→login) failing midway: the
      // logout has already happened, so the user is signed out at this moment.
      // Say so, and tell them a rerun simply continues — with no account left
      // in the plugin, the rerun takes the fresh-login path and needs no --force.
      if (i > 0) e.recover = RECOVER
      throw e
    }
    // magpie itself already displays the token masked; should that ever change,
    // this filters it again as a backstop
    for (const line of scrub(out, secret, ...secrets).split("\n")) if (line.trim()) log(`  ${line}`)
  }
}

// unreadableAfter is the read-back's own failure: the file is there and does
// not parse, which is not the same as a write that did not land. Saying
// "check magpie is running" here sends the user after the wrong thing. The
// direction matters too: the preset side is checked on the providers page,
// the plugin side on the plugins page.
function unreadableAfter(name, dir, want, log, where = "插件列表") {
  log(`? 写入已执行，但回读时 ${showPath(dir, name)} 读不出来，无法确认（${mask(want)}）。`)
  log(`  先确认 magpie 正常，再看一眼${where}里那把 key 在不在。`)
  return 1
}

// runnable is whether spawnSync would start something at bin. Windows runs a
// path with no extension as that path plus .com or .exe (libuv's search, as
// CreateProcess does), which existsSync does not try.
const runnable = (bin, os, exists) =>
  exists(bin) || (os === "win32" && !/\.[^\\/.]+$/.test(bin) && [".com", ".exe"].some((x) => exists(bin + x)))

// showPath is a file inside the folder the user typed. The folder goes through
// arg() — a token pasted into --dir must not ride along inside the joined path
// — and the file's own name is ours, printed as is.
const showPath = (dir, name) => `${arg(String(dir ?? "").replace(/[\\/]+$/, ""))}${sep}${name}`

// shaped is a file magpie wrote: an object, or not there at all. One that parses
// to an array, a string or a bare null is state we cannot read — before a
// write, and in the read-back after one.
const shaped = (v) => v === undefined || (v !== null && typeof v === "object" && !Array.isArray(v))

// ---- main

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  home = homedir(),
  os = platform(),
  exists = existsSync,
  spawn = spawnSync,
  log = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    log(USAGE)
    return 0
  }
  if (args.version) {
    log(`magpie-plugin-msmoli ${VERSION}`)
    return 0
  }

  // No PATH fallback: `magpie` resolved through PATH can be a file the user
  // never installed — npx puts the project's node_modules/.bin first, so a
  // hostile dependency's `magpie` would receive the token on stdin. The
  // binary must come from a known install location or --magpie.
  //
  // A bare name was the same hole from the other side: spawnSync resolves it
  // through PATH, but exists("magpie") does not, so the write guard below saw
  // "no binary" and skipped itself — and the token went to whatever the PATH
  // answered. A name with a path separator in it is not looked up on PATH by
  // either (spawnSync resolves it against the working folder, as existsSync
  // does), so "./magpie" and "bin/magpie" are paths a user named, and the
  // portable magpie's own folder invites exactly that spelling.
  if (args.magpie && !/[\\/]/.test(args.magpie)) {
    log(`✗ --magpie 不接受裸名（${arg(args.magpie)}）：它会按 PATH 解析，PATH 上第一个 magpie 会拿到令牌。`)
    log(`  给一个路径，绝对或相对都行：/Applications/magpie.app/Contents/MacOS/magpie 或 ./magpie。`)
    return 1
  }
  const bin = args.magpie || findMagpieBin({ env, os, exists, home })
  const dir = args.dir || findConfigDir({ env, home, os, exists, binPath: bin })
  if (!dir) {
    log(`✗ 没找到 magpie 的配置目录。`)
    log(`  试过 $XDG_CONFIG_HOME/magpie 和 ~/.config/magpie。便携版请用 --dir 指定它的 data 目录。`)
    return 1
  }
  if (!looksLikeMagpie(dir, exists)) {
    log(`✗ ${arg(dir)} 里没有 magpie 的配置文件（providers.json / plugins.json / plugin-auth.json）。`)
    return 1
  }
  // arg(), not show(): a token pasted into --dir is echoed here
  log(`magpie 配置目录：${arg(dir)}`)

  const providersRaw = readJson(join(dir, "providers.json"), exists)
  // "there but unreadable" is not "not configured": telling the user to add a
  // provider that already exists invites overwriting a file that may be
  // recoverable. Same distinction the auth file below has had since the fix.
  if (providersRaw === null) {
    log(`✗ ${showPath(dir, "providers.json")} 存在但读不出来（可能正在被写或已损坏）。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  const providers = providersRaw?.providers
  const authRaw = readJson(join(dir, "plugin-auth.json"), exists)
  // A file that parses but is not the shape magpie writes (an array, a
  // string, a bare null) is state we cannot read, not "nobody is signed in":
  // a login over it would add a second account over one we could not see.
  if (authRaw === null || !shaped(authRaw)) {
    log(`✗ ${showPath(dir, "plugin-auth.json")} 存在但读不出来（可能正在被写或已损坏）。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  if (providersRaw !== undefined && !shaped(providersRaw)) {
    log(`✗ ${showPath(dir, "providers.json")} 存在但不是 magpie 写的形状。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  // `providers` present but not a list is the same unreadable state one level in
  if (providers !== undefined && providers !== null && !Array.isArray(providers)) {
    log(`✗ ${showPath(dir, "providers.json")} 的 providers 不是列表。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  const accounts = pluginAccounts(authRaw)
  // --to-preset writes into the provider, so one that is there but has no key
  // is a destination, not "unconfigured"; --to-plugin needs a key to read.
  const cands = presetCandidates(providers, args.from, args.to !== "preset")

  const shownPreset = (p) => `${arg(p.id)}（${keyedOf(p) ? mask(p.key) : "还没有 key"}）`
  log(`  内置 ModelScope：${cands.length === 1 ? shownPreset(cands[0]) : cands.length ? "多个候选" : "未配置"}`)
  log(`  签到插件 msmoli：${accounts.length ? accounts.map((a) => `${arg(a.name)}（${mask(a.token)}）`).join("、") : "未登录"}`)

  if (cands.length > 1) {
    // --from matches by id, so two providers sharing one id leave it no way
    // to pick: say that rather than telling the user to use --from again.
    const ids = new Set(cands.map((p) => p?.id))
    log(`✗ 内置侧有 ${cands.length} 个候选（${cands.map((p) => arg(p.id)).join("、")}），不确定用哪个。`)
    if (ids.size === 1) {
      log(`  它们用的是同一个 id（${arg(cands[0]?.id)}），--from 也分不开；请在 magpie 里删掉多余的那个 provider。`)
    } else {
      log(`  用 --from <id> 指定。`)
    }
    return 1
  }
  const preset = cands[0] ?? null
  // With no preset, both directions deserve guidance: --to-preset has its own
  // wording (in planToPreset), but it is stopped here first so a null does not
  // travel all the way into plan and blow the stack
  if (!preset) {
    const all = Array.isArray(providers) ? providers : []
    // A candidate needs a key, and a provider that is ours but has none is not
    // "not configured": telling the user to add it names one they already
    // have, and the --from message below used to say its chat does not point
    // at ModelScope — about a provider whose chat points at exactly that host.
    if (args.from) {
      // the provider may well exist and simply not be one of ours: saying
      // "there is no provider by that id" sends the user to re-add it
      const any = all.filter((p) => p?.id === args.from)
      const bare = any.filter((p) => oursOf(p) && !keyedOf(p))
      if (bare.length) {
        log(`✗ "${arg(args.from)}" 在，但还没有 key，没有可同步的令牌。`)
        log(`  用 magpie provider key ${arg(args.from)} <key> 写入。`)
      } else if (any.length) {
        log(`✗ "${arg(args.from)}" 在，但它不是 ModelScope：chat 不指向 ${HOST}，id/preset 也不是 ${PRESET}。`)
        log(`  这个工具只同步内置的 ModelScope 预设与插件登录态之间的令牌。`)
      } else {
        log(`✗ 内置侧没有 id 为 "${arg(args.from)}" 的 provider。`)
        log(`  用 --status 看现有的，或先 magpie provider add ${arg(args.from)} <key>。`)
      }
    } else {
      const bare = all.filter((p) => oursOf(p) && !keyedOf(p))
      if (bare.length) {
        log(`✗ 内置侧的 ${arg(bare[0].id)} 在，但还没有 key，没有可同步的令牌。`)
        log(`  用 magpie provider key ${arg(bare[0].id)} <key> 写入，或在 magpie 的「供应商」页填上。`)
      } else {
        log(`✗ 内置侧没有带 key 的 ModelScope 预设。`)
        log(`  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add ${PRESET} <key>。`)
      }
    }
    return 1
  }

  const plan = args.to === "preset" ? planToPreset({ preset, accounts, force: args.force }) : planToPlugin({ preset, accounts, force: args.force })
  for (const line of plan.lines) log(line)
  if (plan.action !== "run") return plan.action === "noop" ? 0 : 1

  // --status means "report only", and it comes before the direction check: with
  // only --status it should say "this is the plan", not tell the user to pick
  // a direction — a report is exactly what they asked for
  if (args.status) {
    log(`(--status：以上是计划，未执行)`)
    return 0
  }
  // Without --to-* it only reports the plan: a bare npx run must not silently
  // write a credential
  if (!args.to) {
    log(`(要执行请显式指定方向：--to-plugin 或 --to-preset)`)
    if (args.dryRun) log(`(--dry-run：未执行)`)
    return 0
  }
  // --dry-run spawns nothing, so it must not be gated on finding a binary:
  // the machine where magpie is not installed yet is exactly where a preview
  // is worth having, and the old order failed there before printing a command.
  if (!bin && !args.dryRun) {
    log(`✗ 没找到 magpie 可执行文件（找过各平台的安装位置）。`)
    log(`  用 --magpie <路径> 指定，例如 macOS 的 /Applications/magpie.app/Contents/MacOS/magpie。`)
    return 1
  }
  // --dir says where to read; the write goes wherever the binary's own config
  // is, and magpie's CLI takes no --dir. Given both, the two must be the same
  // folder: reading a fixture while writing the real config is how a rehearsal
  // came to sign a test token into the user's own magpie. Only a run that
  // writes is stopped here, and only a binary that can run can write —
  // --status and --dry-run are reads. "Can run" is what spawnSync finds, not
  // what existsSync sees: on Windows a "C:\\…\\magpie" with no extension runs
  // the magpie.exe beside it, and a check gated on exists(bin) alone skipped
  // itself there — a fixture's --dir was read while the real magpie wrote its
  // own folder.
  if (!args.dryRun && args.dir && bin && runnable(bin, os, exists)) {
    const binDir = findConfigDir({ env, home, os, exists, binPath: bin })
    // "" is a mismatch too: the binary has no magpie folder of ours to write
    // to, so it would make one — and that one is not the folder named. Compared
    // by folder identity, not by string: a shell completes a directory with a
    // trailing slash, and "/private/tmp/data" and "/tmp/data" are one folder.
    if (!sameFolder(binDir, args.dir)) {
      log(`✗ --dir 与 --magpie 指向不同的配置目录，而写入只会落在 magpie 自己的那个。`)
      log(`  读的是：${arg(args.dir)}`)
      log(`  magpie 会写到：${binDir ? arg(binDir) : "它自己的默认目录（这里找不到现成的）"}`)
      log(`  magpie 的命令行没有 --dir。两处用同一个目录，或去掉 --magpie 让它自动探测。`)
      return 1
    }
  }
  try {
    run(plan.cmds, bin, { dryRun: args.dryRun, log, spawn })
  } catch (e) {
    log(`✗ ${e.message}`)
    if (e.recover) log(e.recover)
    return 1
  }
  if (args.dryRun) {
    log(`(--dry-run：未执行)`)
    return 0
  }

  // Verify by reading back, do not trust only the exit code (the direction
  // check matches the plan line above). An unreadable read-back (null) is a
  // different matter: reporting it as "the token was not found" sends people
  // to check whether magpie is running, when the write actually succeeded —
  // the two failures must be told apart.
  const want = plan.cmds.at(-1).secret
  if (want) {
    if (args.to === "preset") {
      const raw = readJson(join(dir, "providers.json"), exists)
      if (raw === null || !shaped(raw)) return unreadableAfter("providers.json", dir, want, log, "供应商列表")
      const after = presetCandidates(raw?.providers, preset.id)
      if (!after.some((p) => p.key === want)) {
        log(`✗ 写入后回读没找到目标 key（${mask(want)}）——检查 magpie 是否在正常运行。`)
        return 1
      }
    } else {
      const raw = readJson(join(dir, "plugin-auth.json"), exists)
      if (raw === null || !shaped(raw)) return unreadableAfter("plugin-auth.json", dir, want, log)
      const after = pluginAccounts(raw)
      // The read-back must count accounts: when logout did not really delete
      // (exit code 0 but no action), login adds the new token as a second
      // account, and "one account holds the target token" still holds — exactly
      // the state planToPlugin says --force does not apply to and the tool
      // would have created itself.
      if (plan.cmds.length > 1 && after.length > 1) {
        log(`✗ 回读发现插件现在有 ${after.length} 个账号（${after.map((a) => arg(a.name)).join("、")}）。`)
        log(`  旧账号没被登出，login 追加了一个。请在 magpie 里删掉多余账号后重试。`)
        return 1
      }
      if (!after.some((a) => a.token === want)) {
        log(`✗ 写入后回读没找到目标令牌（${mask(want)}）——检查 magpie 是否在正常运行。`)
        return 1
      }
    }
  }
  log(`✓ 完成。签到开关在 magpie 的 设置 → 用量 → 插件 → msmoli。`)
  return 0
}

// npm and npx invoke bin through a symlink: argv[1] is the link's path while
// import.meta.url is the resolved real path, so comparing the strings directly
// misses the "run as a command" case (running `node bin/sync.mjs` directly in
// the tests happened to be equal and hid this bug). So realpath argv[1] too
// before comparing.
//
// href falls short in two places, neither about letter case:
// node --preserve-symlinks-main makes import.meta.url keep the link path while
// realpathSync still resolves it; Windows 8.3 short names
// (C:\Users\RUNNER~1\…) are not expanded by pathToFileURL but are by
// realpathSync. Both fall back to the inode — the file's identity, independent
// of spelling.
//
// A volume that reports ino=0 (exFAT/FAT USB sticks, some SMB shares and subst
// mappings) has no identity to compare, so it falls back to comparing the
// realpath-ed strings: that covers the two href mismatches above, and the only
// thing lost is a letter-case flip, where href matched anyway. Without this,
// isMain would always be false and the whole file would be skipped — printing
// nothing and exiting 0, so the user would think the sync succeeded.
//
// `stat` and `real` are injectable: an ino=0 volume cannot be conjured up on
// this machine, so the tests can only reach in here.
export function isMain(entry = process.argv[1], self = import.meta.url, stat = statSync, real = realpathSync) {
  if (!entry) return false
  try {
    const here = real(entry)
    if (pathToFileURL(here).href === self) return true
    const theirs = stat(entry)
    const mine = stat(fileURLToPath(self))
    if (theirs.ino !== 0 && theirs.ino === mine.ino && theirs.dev === mine.dev) return true
    return here === real(fileURLToPath(self))
  } catch {
    return false
  }
}

if (isMain()) {
  // `sync --status | head -1` closes the pipe after the first line: without a
  // handler the EPIPE arrives as an unhandled error event and the crash trace
  // — not the plan — is what the user sees. Exiting quietly is what a shell
  // pipeline means; head's own exit code carries the verdict.
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0)
    throw e
  })
  // A Ctrl-C or a TERM during a --force sequence can land between the logout
  // and the login: the logout has run and the account is signed out. The
  // child is left to finish on its own (spawnSync cannot be interrupted
  // mid-wait), but the run says so before it goes, so the shell is not left
  // showing a silent 130/143 and a signed-out account.
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(sig, () => {
      process.stderr.write(`\nmagpie-plugin-msmoli: 被 ${sig} 中断。如果正在 --force 的登出→登录之间，现有登录可能已被登出；\n${RECOVER}\n`)
      process.exit(code)
    })
  }
  // process.exit() while stdout is a pipe drops whatever is still buffered:
  // a long plan or a big `--status` list would lose its tail — including the
  // ✓ line — and still exit 0. Setting the exit code lets the loop drain the
  // writes first. Nothing here keeps the event loop alive on its own.
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      process.stderr.write(`magpie-plugin-msmoli: ${e?.message ?? e}\n`)
      process.exitCode = 1
    })
}
