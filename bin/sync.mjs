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
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, isAbsolute, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ID = "msmoli"
const PRESET = "modelscope"
const HOST = "api-inference.modelscope.cn"
// the only site the built-in preset and the vendors this tool recognises serve
const CN_SITE = "https://modelscope.cn"

// VERSION is what --version answers. Read from the package's own manifest so
// the two can never drift — a published tarball carries package.json beside
// bin/, and so does a clone. An unreadable manifest is not a reason to fail a
// version question: the answer is just unknown.
//
// The entry itself is resolved first: npm installs .bin entries as links, and a
// launcher that keeps the link (node --preserve-symlinks-main, which npx's
// shims do not always avoid) made the relative lookup resolve against the link
// rather than the package, and a package that declares its version answered
// "unknown". isMain already resolves the same way.
const VERSION = (() => {
  const here = fileURLToPath(import.meta.url)
  let manifest = new URL("../package.json", import.meta.url)
  try {
    manifest = pathToFileURL(join(dirname(realpathSync(here)), "..", "package.json"))
  } catch {
    // a path realpath cannot resolve is still a path the relative URL names
  }
  try {
    return JSON.parse(readFileSync(fileURLToPath(manifest), "utf8")).version ?? "unknown"
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
  // hasOwn, not `VALUE[a]`: a plain object literal answers for "constructor",
  // "toString", "__proto__" and the rest of Object's own names, so those were
  // taken as value flags and silently accepted while every other unknown
  // argument was refused.
  const isValue = (k) => Object.hasOwn(VALUE, k)
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
    if (flag && isValue(flag)) {
      const v = a.slice(eq + 1)
      if (v.trim() === "" || v.startsWith("-")) throw new Error(`缺少值：${flag}= 后面要跟一个参数`)
      set(flag, v)
    } else if (isValue(a)) set(a, take(++i, a))
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
//
// A mask read back in is not a key: a masked value copied into a second run
// was masked again ("ms-1…5c6d" became "（9 字符）") and lost its ends. The
// two shapes this function prints are answered unchanged. Neither can be a
// key's own text — SENDABLE keys are printable ASCII, and "…" and the
// full-width brackets are not — so the shapes cannot stand for one.
const MASKED_SHAPE = /^[\s\S]{4}…[\s\S]{4}$/
const MASKED_SHORT = /^（\d+ 字符）$/
export const mask = (t) => {
  if (typeof t !== "string" || !t) return "（不可用）"
  // a value that already reads as a mask is handed back as written — and a
  // stored key can be anything a file holds, an ESC sequence included: "abcd…"
  // followed by "\u001b[2J" went to the terminal whole and cleared the screen
  // over the output. Nothing a mask prints may carry a control character.
  if (MASKED_SHAPE.test(t) || MASKED_SHORT.test(t)) return show(t)
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
  // keyRaw keeps the type as written. key is the string the rest of the tool
  // compares with, but normalizing a non-string to "" here made every
  // downstream type check read "an empty slot with nothing to lose" — the
  // refusal in planToPreset could not be reached from the command line, and
  // --to-plugin's own check was skipped too.
  const out = (ps) =>
    ps.map((p) => ({
      ...p,
      key: typeof p.key === "string" ? p.key.trim() : "",
      // only a key of another type carries its raw value: a string's own
      // spelling is `key`, trimmed
      ...(typeof p.key === "string" ? {} : { keyRaw: p.key }),
    }))
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
// Cc/Cf is not the whole of "invisible": a variation selector (U+FE0F) and a
// combining mark are Mn, and a figure space (U+2007) is Zs. A key with one of
// those inside it was cut in two by tokenShaped's ASCII body and its tail went
// out whole. The space-like characters are the Zs block minus U+0020 and
// U+0009 (a real space is a word break, not part of a key).
const INV = String.raw`(?:(?![\n\r\t \u00A0\u3000])[\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Zs}])`
// {11,} with a quantifier inside its loop put one frame on V8's regexp stack
// per character: a single line of 4.2M characters threw RangeError. A real
// ModelScope key is under 200 characters; 512 is an upper bound on the shape,
// not on the text being read. (A key longer than 512 characters is not a key.)
const tokenShaped = new RegExp(String.raw`m${INV}*s${INV}*-(?:${INV}*[\x21-\x7e]){11,512}`, "giu")
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
// a value the spaced reading could join: an ms-/sk- front, its own characters
// allowed to sit behind any run of the separators PIECE splits on (a space, a
// wide space, a middot, a slash) — the front is found in the pieces, so this is
// the same front seen before the pieces are cut. \s is a superset of those
// separators, which only ever means a front found here is not one after the
// join: the reading then does what it always did.
const FRONT_SEP = "[\\s·•∙‧・/]*"
const MS_FRONT = new RegExp(`m${FRONT_SEP}s${FRONT_SEP}-`, "i")
const SK_FRONT = new RegExp(`s${FRONT_SEP}k${FRONT_SEP}-`, "i")
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
// a lower-case piece of a key cut into groups, and no word of the text (the
// card's `piecey`): no vowel in it ("bcd", "gh"), or only hex characters
// ("cdef", "ef" — where a word and a piece can be the same string, "face",
// "cafe", a run that reads a key already keeps them, the safe direction). A key
// cut after its own front — "ms-0123 4567 89ab cdef" — has pieces of this
// shape, and the run goes on across them once its body reads as a key; the
// frame after a key ("for", "provider", "here") carries a vowel and is no hex,
// so it stays the text's.
const keyPiecey = (w) => /^[a-z]{2,6}$/.test(w) && (!/[aeiouy]/.test(w) || /^[0-9a-f]+$/.test(w))
// the next piece of a cut goes on where this one's own letters carry a vowel
// ("mno" of "… 012 mno p34"): a piece a key-shaped piece follows is the key's,
// as the card's run reading has it
const nextPiecey = (t) => {
  const n = String(t ?? "").replace(/^[^A-Za-z0-9]{1,2}/, "")
  return /[0-9A-Z]/.test(n) || keyPiecey(n)
}
const FRONT_PIECE = /^(?:m|s|k|ms|sk|s-|g|h|p|u|r|o|x|ox|a|i|l|ali|as|akia|aida|ghp|gho|ghu|ghs|ghr|xox|asia)$/i
// a mark a copy or a table put where a cut was, which no cut the readings join
// is: a full-width comma or full stop, a bracket, a dash, a bar between cells
// ("…0101、e6f7…", "…-bbbb | -2222-…"). It is no letter, digit or key character
const MARK1 = /[^\p{L}\p{N}A-Za-z0-9+/=_.\-\s]/u
// and unmark reads it as the cut it stands for ("…bbbb、-2222…", "…bbbb | -2222…"): one mark becomes as many
// spaces as it has UTF-16 units, so the result keeps every index of the value
// and what is printed around a mask is what the user typed. The walk then
// judges the pieces on both sides by its own rules, which is what keeps a
// sentence's mark from being a cut ("no key ms-…、for provider" ends at "for" as
// it ends there after a space). An ellipsis is read only where key material
// of eight characters or more follows it: "ms-a…5555" is a mask already
// written, and a person's elision is shorter than any key's second half.
const unmark = (s) => {
  // the indices are the value's own: a mark of two units keeps two here and a
  // pair keeps one, so the walk's offsets land on the user's characters
  const cps = []
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i))
    cps.push(c, ..." ".repeat(c.length - 1))
    i += c.length
  }
  const M = (c) => c !== undefined && MARK1.test(c)
  // an ellipsis is a cut only where eight key characters follow it, and the
  // scan stops at the eighth: joining the whole tail to ask the same question
  // read a line of masks to its square (4,000 copies spent 22 s)
  const KEY_CH = /^[A-Za-z0-9+/=_.-]$/
  const keyAhead = (i) => {
    let seen = 0
    for (let j = i + 1; j < cps.length && seen < 8; j += 1) {
      if (!KEY_CH.test(cps[j])) return false
      seen += 1
    }
    return seen >= 8
  }
  const out = []
  for (let i = 0; i < cps.length; i += 1) {
    if (!M(cps[i])) {
      out.push(cps[i])
      continue
    }
    let j = i
    if (cps[i] === "…" && !keyAhead(i)) {
      out.push(cps[i])
      continue
    }
    while (j < cps.length && M(cps[j])) j += 1
    for (let k = i; k < j; k += 1) out.push(" ")
    i = j - 1
  }
  return out.join("")
}

function spacedKey(s) {
  // the reading only ever joins a value that carries an ms- or sk- front, even
  // when the front itself was cut ("m s - 0 1"): the front is looked for in the
  // pieces with the separators taken out, so it is the same front, allowed to
  // sit behind any run of separators here. A value with no such front is no key
  // this reading makes, and the pieces are not built at all — most of a child's
  // prose. The separator class is a superset of the one PIECE splits on, so a
  // front found here that the join does not make only costs the old path.
  if (!MS_FRONT.test(s) && !SK_FRONT.test(s)) return null
  // a control or format character is not a cut's spelling (a key with one in
  // it is one word); a line break is, and is read like a space. A combining
  // mark (Mn/Me — a variation selector, a base letter and its accent) and a
  // space-like character that PIECE does not cut on (U+2007 and its block) are
  // the same: the walk cannot step over them (KEYCHARS is ASCII), so it stopped
  // mid-key and the tail came out as written. Handing the value to the per-word
  // pass lets GLUE take the mark out and read the key whole. NBSP and the
  // ideographic space stay out of this list: they are cuts the join is meant to
  // read across.
  // (a tab is a cut CUT_RUN already reads, so it is no such character: a
  // value cut by a mark and a tab is joined here like any other)
  if (/(?:(?![\n\r\t])[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u2000-\u200A\u202F\u205F])/u.test(s)) return null
  // an ellipsis is a masked value's spelling, not a key's: a value carrying one
  // is not read as a key cut by it ("ms-… …" is mask output, and joining across
  // the "…" would put a key's halves back together from a digest's leftovers).
  // unmark draws that line for a copy's ellipsis: only one with a long second
  // half after it is a cut's
  // the pieces, and where each starts in what the walk reads: a mark read as
  // the cut it stands for keeps every index of the value, so "v" maps straight
  // back to what the user typed ("s"), and what is printed around a mask is
  // what they wrote
  const v = unmark(s)
  const pieces = []
  for (const m of v.matchAll(PIECE)) pieces.push({ text: m[0], at: m.index })
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
  // (a full-width colon a display cut the key with is a cut, not part of the
  // body: left in, the joined body failed isKey and the walk was never made to
  // answer. Only non-ASCII punctuation goes: an ASCII mark can be a key's own
  // body under VENDOR_SPAN's reading, and taking it would split that key.)
  const FRAME_PUNCT = /[^\x00-\x7f\p{L}\p{N}]/gu
  const bodyFrom = (i) => v.slice(start, i).replace(CUT_RUN, "").replace(FRAME_PUNCT, "")
  // the key's own span, not the rest of the line: a bracket, a comma or a
  // Chinese character abutting the key's end is the text's, and judging the
  // whole remainder as key material refused a valid key ("(sk-ant-…vTuH)")
  // A key cut early — before its body reaches the floor — still gets the walk:
  // the pieces after the cut are read into it, and each join is judged by
  // isKey below. "ms-1a2b3c4d5: e6f7…" is 9 characters before its cut, short
  // of the floor, and dropping the whole reading here printed both halves.
  // What stays refused is a front with no digit anywhere near it ("ms-dos",
  // "ms-cli"), which is the prose guard this floor also served.
  const headSpan = /^[A-Za-z0-9+/=_.-]*/.exec(joined.slice(frontAt + 3))[0]
  const nearDigit = joined.slice(frontAt + 3, frontAt + 3 + headSpan.length + 96)
  if (!/\d/.test(nearDigit)) return null
  // walk forward: a piece is part of the key while it is key characters and
  // not prose; a gap joins them only when it is a cut (one or two characters).
  // The walk starts at the end of the piece the front's own characters sit in:
  // the rest of that piece ("--ms-01234567") is the key's first body, not a
  // gap
  // the front's own characters, then whatever of its piece follows them with
  // no gap ("ms-aaaa1111", "--ms-01234"): the key begins right after its
  // front, so the rest of that piece is key material, not filler
  let end = start + 3
  while (end < v.length && !CUT_ONE.test(v[end]) && KEYCHARS.test(v[end])) end += 1
  // how long the front is ("ms-", "sk-", "ghp_"), for the walk's prose rule
  const frontLen = (joined.slice(frontAt).match(/^(?:ms-|sk-|gh[pousr]_|xox[abposr]-|akia|asia|aida)/i)?.[0] ?? "").length
  let bare = false
  let strong = false
  for (let guard = 0; guard < 512 && idx < pieces.length - 1; guard += 1) {
    // whether the body read so far already reads as a key. Asked before the gap
    // is judged, not after: the readings that step over a frame (a bracket in
    // the cut, a punctuation-marked cut) are worth taking only once it does, and
    // asking at the end of the loop meant the first cut was judged with the
    // answer still false — "…KbwtX9( ZqLmNeR2vTuH" lost its second half there
    strong = strong || isKey(bodyFrom(end))
    // the body with the next piece's key span: a key cut before its cut piece
    // reads as one only once the second half is in. Asked before the bridge so
    // a cut just after the front ("ms-aaaa1111: bbbb…") is still spanned
    // the next piece without its leading frame: ASCII punctuation (at most two,
    // as the piece walk strips) or a full-width mark ("："), so the span starts
    // on key material. Only non-ASCII punctuation beyond that goes — an ASCII
    // letter is the key's own.
    const spanNext = /^[A-Za-z0-9+/=_.-]*/.exec((pieces[idx + 1]?.text ?? "").replace(/^[^\sA-Za-z0-9]{1,2}/, "").replace(/^[^\x00-\x7f\p{L}\p{N}]+/u, ""))?.[0] ?? ""
    const strongNext = strong || (spanNext.length >= 8 && isKey(bodyFrom(end) + spanNext))
    // the gap before the next piece: one cut joins, a short run of cuts joins
    // too (the card's own separator is a middot with a space either side,
    // " · ", three characters, and a key cut by one is still one key), and a
    // long run is a frame; any other character ("--ms-", "#ms-", "/tmp/ms-",
    // a path segment) is the same filler, once the body reads as a key
    // a gap longer than three joins only after the body reads as a key, and
    // then only a middot's spelling ("a····b"): a run of cuts that is no
    // separator ("a---b") is the frame a display draws instead of a hidden
    // piece, and the pieces after it are printed as written
    let gap = CUT_ONE.exec(v.slice(end))
    // a key cut by a space with a closing frame in the cut ("…KbwtX9( ZqLmNeR2vTuH")
    // is still one key: the bracket is the cut's, and stopping at it left the
    // second half on the terminal. Read across only once the body already reads
    // as a key, so a sentence's bracket is not a cut
    if (!gap && strongNext) {
      const bridged = /^[^\sA-Za-z0-9\p{L}\p{N}]{1,2}[ \t\r\n\u00a0\u3000]+/u.exec(v.slice(end))
      if (bridged) gap = bridged
    }
    if (!gap) break
    if (gap[0].length > 3 && (!strongNext || gap[0].length > 5)) break
    idx += 1
    // the piece's own key span: what follows it inside the piece ("vTuH)" ,
    // "abc," , "…无效") is the text's frame, not the key
    // a bracket opened inside the cut ("…Kbwt (X9ZqLmNeR2vTuH") is the cut's
    // too, once the body reads as a key; the piece's key span starts after it
    // the next piece's own frame: the pause in the cut ("…KbwtX9( ", "a ; ")
    // and a bracket the next half opens with ("… (e6f7…") are both the text's,
    // and the key starts at the first key character after them
    const framed = /^[^\sA-Za-z0-9]{1,2}(?:[ \t\r\n\u00a0\u3000]+)?/.exec(pieces[idx].text)?.[0] ?? ""
    const lead = strongNext || (strong && /^[^\sA-Za-z0-9\p{L}\p{N}]{1,2}[ \t\r\n\u00a0\u3000]+/u.test(v.slice(end))) ? framed.length : 0
    const piece = /^[A-Za-z0-9+/=_.-]*/.exec(pieces[idx].text.slice(lead))[0]
    if (!piece) break
    if (VERNUM.test(piece) && !/\d/.test(bodyFrom(end)) && !/[A-Z]/.test(bodyFrom(end))) break
    // a piece of three or more letters is prose and ends the run ("no key
    // ms-… for provider" keeps its frame), unless it is the piece a bare
    // front was cut into ("sk" then "ant" is a cut, not a word)
    // prose ends the run even after a bare front: "sk-preset-20261031 is a
    // provider id" is a sentence, and a key whose pieces are letters is read
    // by the reading that masks the whole body ("sk-a nt-a pi03", below)
    // a front's own letters ("ant", "sk", "ghp") are not prose: the walk
    // reads past them while the front has not been completed yet
    // a slash is a key's own separator (an AWS secret is written
    // wJalr…/K7MDENG/…), and its pieces are key material even when a lower-case
    // word sits in them ("RgjNpwI" has "gj"): at a slash the run goes on while
    // the body so far reads as a key, and the prose rule is the space's
    // a piece of a key cut into groups goes on over a space too, once the body
    // reads as a key: "ms-0123 4567 89ab cdef" stopped at "cde" and left
    // twenty-four characters of the body on the terminal (measured). The body
    // is judged as this reading's own acceptance judges it — an ms- run of key
    // length, or the shape isKey reads — since a 13-character ms- body is a key
    // to msKey and not to isKey.
    const keySoFar = bodyFrom(end)
    const soFarKey = keySoFar.length >= 12 && (/^ms-/i.test(keySoFar) ? msKey(keySoFar, false) : isKey(keySoFar))
    if (
      PROSE.test(piece) &&
      (frontLen === 0 || keySoFar.length >= frontLen) &&
      !(/^\/+$/.test(v.slice(end, pieces[idx].at)) && keySoFar.length >= 12 && isKey(keySoFar)) &&
      !((soFarKey || frontLen > 0) && (keyPiecey(piece) || nextPiecey(pieces[idx + 1]?.text)))
    ) break
    end = pieces[idx].at + lead + piece.length
    bare = bare || FRONT_PIECE.test(piece)
  }
  // a body that stops at our own mask's ellipsis is a mask's front half, not
  // a key. Masking it again printed a length where the first mask's ends were:
  // "(ysUUqH=lMS-5…w+6N)" went out as "lMS-（4 字符）…w+6N" on the second pass
  const body = bodyFrom(end)
  if (v[end] === MASKED) return null
  if (body.length <= 3 || !/\d/.test(body)) return null
  // a vendor front that carries more than a front ("sk-preset-20261031") is a
  // provider id, not a key cut up: the per-word and cut readings judge it
  if (!/^ms-/i.test(body) && !isKey(body)) return null
  return { pre: s.slice(0, start), body, post: s.slice(end) }
}
// msBody is whether what follows an ms- front reads as key material, the same
// question the card's keyBody asks: an ordinary word after the front ("The
// ms-interviewing feature is unavailable") is not a key, and the CLI masked it
// while the card kept it. A ModelScope key is hex or base64 with a digit in it.
// Read this as one forward pass, not a regexp with a greedy tail: the old
// (?!\w)[\x21-\x7e]*\d restarted its scan at every punctuation character, so
// a long line of "=" behind an ms- front was quadratic (64 KiB took 22s, and a
// child's output can carry that line). A regexp cannot promise a linear scan
// here; the two arms below ask the same question over the same characters:
//   - an 11+ character hex run that ends before a lower-case letter or digit
//   - a printable run starting on punctuation, 11+ long, with a digit in it
// Both are answered by walking the string once and remembering where a run
// started. Invisible characters are taken out of the run by the caller's match
// (tokenShaped keeps them in its match), so they cannot split a body here.
const msBody = (m) => {
  const s = String(m)
  const HEX = /[0-9a-f]/i
  const PRINT = /[\x21-\x7e]/
  // arm 1: an 11+ hex run that does not end in a lower-case letter or digit
  let hexAt = -1
  for (let i = 0; i <= s.length; i += 1) {
    const c = i < s.length ? s[i] : ""
    if (c !== "" && HEX.test(c)) { if (hexAt < 0) hexAt = i; continue }
    if (hexAt >= 0 && i - hexAt >= 11 && (c === "" || !/[0-9a-z]/.test(c))) return true
    hexAt = -1
  }
  // arm 2: from EACH punctuation character, an 11+ printable run with a digit
  // in it. The old regexp checked (?!\w) at every starting position; checking
  // it only once at the string's start missed "ms-foreign_key-1234-…" (the
  // match begins with "m", a word character). Walking from each punct keeps
  // the same answer in one pass per run, without a greedy tail that backtracks
  // at every position.
  for (let i = 0; i < s.length; i += 1) {
    if (/\w/.test(s[i]) || !PRINT.test(s[i])) continue
    let j = i, digit = false
    while (j < s.length && PRINT.test(s[j])) {
      if (/[0-9]/.test(s[j])) digit = true
      j += 1
    }
    if (j - i >= 11 && digit) return true
    i = j - 1   // the while loop already read everything up to j
  }
  return false
}
// msKey is whether an ms- run is a key, and the two shapes that are one
// whatever their body says: a run in capitals (a child that upper-cases its
// output) and a value that is nothing but the run (a token pasted into a
// provider id — "ms-abcdefghijklmnop" is a credential there, not a word).
// Everything else is asked of its body, as the card asks.
// a version's dotted groups are not key material ("ms-cli 2026.11.9" is a
// program and its version, as the card reads it)
const msKey = (m, whole) => whole || m === m.toUpperCase() || (!m.includes(".") && msBody(m))
const show = (s) =>
  String(s ?? "")
    .replace(tokenShaped, (m) => {
      // the shape's body runs over printable ASCII, so it takes the frame's
      // punctuation after the key with it (a quote, a comma, a closing
      // bracket). The mask spends four characters at each end on the key's
      // own, so the frame has to stay outside it — "ms-1…c6d\"" was a quote
      // spending one of the four. The key alphabet's own trailing characters
      // ("=", "-", "_", ".") stay: they are the key's.
      const core = m.replace(/[^A-Za-z0-9+/=_.-]+$/, "")
      if (!core || !msKey(core, String(s).trim() === m)) return m
      return mask(core.replace(/[\p{Cc}\p{Cf}]/gu, "")) + m.slice(core.length)
    })
    // an upper-cased vendor key is the same key, and its pieces are too short
    // for the per-word floors ("SK-ANT-API03-EYAI1PKJRF_KBWT")
    // a word carrying our ellipsis is one of the masks this tool wrote, not a
    // key: read back as an upper-cased vendor word (a mask's tail can carry a
    // digit) it was masked again into a length ("AKIA…H98." became
    // "（8 字符）"), losing the ends the first mask kept
    .replace(/[^\s]+/g, (w) => (!w.includes("…") && ((isKey(w) && VENDOR.test(w) && w === w.toUpperCase()) || (w.startsWith("--") && w.includes("=") && isKey(w.slice(w.indexOf("=") + 1))))) ? mask(w) : w)
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
  // (a product name with its build number — "ModelScope20261031" — is a name
  // here as it is on the card: its words are capitalised and its tail is a
  // number, which is no key's rhythm)
  !/^[A-Z][a-z]{2,}(?:[A-Z][a-z]{2,})+\d{4,8}$/.test(r) &&
  ((r.length >= 16 && /[a-z]/.test(r) && /[A-Z]/.test(r)) ||
  (r.length >= 32 && /\d/.test(r) && /[A-Za-z]/.test(r)) ||
  (r.length >= 16 && /\d/.test(r) && /[A-Z]/.test(r)) ||
  // 16+ of hex with both a letter and a digit in it: a digest, a session id, a
  // fragment of a key. Not a word (abcdefgh… carries letters that are not hex,
  // modelscope20261031 carries more than hex), and not a number
  (r.length >= 16 && /^[0-9a-fA-F]+$/.test(r) && /\d/.test(r) && /[a-fA-F]/.test(r)))
// a field that names a credential: a value of capitalised words behind it is
// still the secret (a passphrase), and keeps the mask. The test is a substring
// one on purpose — "providerKey", "clientSecret", "apiToken" all name one, and
// a field this reading does not know ("monkey") errs toward the mask
const CRED_NAME = /(?:token|key|secret|pass|auth|credential|session|sig)/i
// a run of capitalised words ("calculateMonthlyInvoiceTotal") is a method or a
// class name, not key material: every hump is a word of three letters or more
// with a vowel in it, the run carries no digit, and nothing but lower-case
// words stands between the humps (a key's case flips inside short groups)
const wordyCamel = (r) => {
  if (!/^[A-Za-z]+$/.test(r) || !/[A-Z]/.test(r)) return false
  const humps = r.match(/[A-Z][a-z]{2,}/g) ?? []
  if (humps.length < 2 || !humps.every((h) => /[aeiouy]/i.test(h))) return false
  return /^[a-z]*$/.test(r.replace(/[A-Z][a-z]{2,}/g, ""))
}
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
// a run with no vowels and plenty of digits is a generated key with no
// separator at all ("5gli9zadx8zg9jez"): the card judges this shape and the
// CLI did not. A word followed by its numeral ("file1file2file3") is a list,
// the card's own exclusion.
const VOWELS = /[aeiouy]/g
const randomish = (r) => {
  if (r.length < 12 || r.length > 40 || !/[a-z]/.test(r)) return false
  // a short letter lead and then nothing but digits is a build number or a
  // serial ("v202610310001"): the vowels a letter has are all in that lead,
  // and the share below is kind to a long run of digits. A generated key
  // spreads its letters through the run ("5gli9zadx8zg9jez"), which is what
  // the transitions below are for
  if (/^[a-z]{1,3}\d{8,}$/.test(r)) return false
  if ((r.match(VOWELS) ?? []).length / r.length >= 0.2) return false
  const digits = (r.match(/\d/g) ?? []).length
  const transitions = (r.match(/[a-z][0-9]|[0-9][a-z]/g) ?? []).length
  return transitions >= 2 || digits >= 4
}
const LISTY = /^(?:[A-Za-z]+\d+)+$/
// isKey judges one word as it was written. A word the readings cut and join
// back together is asked with runs = false: it was never one word, and the
// vowel-less arm below reads a run of numerals as a key ("no 42 20261031"
// joined to "no4220261031"). Its own pieces were each judged where they were
// written, so a join that masks nothing on its own loses nothing that a piece
// already masked; a join holding one key-shaped piece (a key an invisible
// character cut) is still a key by its run arm.
const isKey = (word, runs = true) => {
  // a word under the shortest floor that carries no digit and no capital is no
  // key under any arm below: the shortest floor is the 12-character base64
  // reading, and every other arm needs a digit, a capital or a separator (a
  // separator alone, with neither, still fails every arm — "a-b-c" is prose).
  // This is most of a child's prose, and the guard keeps the dozen regexes
  // below off it.
  if (word.length < 12 && !/[0-9A-Z]/.test(word)) return false
  // a product or a path segment with its build number ("ModelScope20261031",
  // "SomeFolderName2024") is a name, not a key: two or more capitalised words
  // and then a four-to-eight digit number. Keys alternate case inside a few
  // characters and do not spell words. Measured: both were masked to
  // "Mode…1031" and "Some…2024" on the card and in the CLI while ordinary
  // names beside them stayed.
  if (/^[A-Z][a-z]{2,}(?:[A-Z][a-z]{2,})+\d{4,8}$/.test(word)) return false
  // an upper-cased vendor key is the same key, and its pieces are too short
  // for the run floors ("SK-ANT-API03-EYAI1PKJRF_KBWT"); the rhythm a key has
  // (a capital beside a digit) tells it from a sentence in capitals
  // (a word carrying our ellipsis is a mask this tool wrote, and a mask's
  // head is a front like "AKIA": read as an upper-cased key it was masked
  // again into a length, and its own ends were lost — "AKIA…XDKO/L3," went out
  // "AKIA…/L3," on the second pass)
  if (VENDOR.test(word) && !word.includes("…") && word === word.toUpperCase() && /[0-9]/.test(word) && !/[A-Z]{6,}/.test(word.replace(/^[A-Z]+_[A-Z]+_/, ""))) return true
  // a vendor front and a body whose piece mixes case and carries a digit is a
  // key even when every piece is short of the run floors: "ghp_Abcd1234Ef" (a
  // token copied with its tail cut off) went out whole, and no word of prose
  // carries a vendor front. A provider id behind the same front keeps its name
  // ("sk-preset-20261031"): its pieces are a word and a number, and neither
  // mixes case
  if (
    runs &&
    !word.includes("…") &&
    VENDOR.test(word) &&
    /[0-9]/.test(word) &&
    word.split(/[-_.]/).some((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p))
  ) return true
  if (runs && /^[a-z0-9]+$/.test(word) && !(LISTY.test(word) && /[A-Za-z]{3,}/.test(word)) && randomish(word)) return true
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
    // a mask we wrote is not a separator a key's pieces were cut by: joining
    // across it rebuilds key-shaped material out of the mask and the text
    // around it, and arg stopped being idempotent on its own output
    // ("…6789、abcdefABCDEF" read back as one key and took the name in front
    // of it with it)
    if (word.includes("…")) return false
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
  // /Users/someone/Documents/SomeLongDirectoryName a path
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
// INV+ and not INV: two invisible characters in a row (two zero-width spaces,
// a base letter and its combining mark) are one interruption, and the old
// single-character form left both in place because neither was between two key
// characters on its own.
const GLUE = new RegExp(String.raw`(?<=[A-Za-z0-9+\/=_.-])${INV}+(?=[A-Za-z0-9+\/=_.-])`, "gu")
// VENDOR and MASKED are index.mjs's, to the letter: a key's front that is no
// key on its own, and the ellipsis a mask carries.
const VENDOR = /^(?:sk-|sk_(?:live|test)_|gh[pousr]_|xox[abposr]-|akia|asia|aida|aliyun|ssh-rsa|-----begin|sg\.|xapp-)/i
// the same fronts, unanchored, with the key characters that follow: the span
// of a vendor key inside a larger word (a URL, a path, a header)
// the body may carry a character the ASCII pass cannot read — a Cyrillic
// look-alike, a full-width letter — and stopping there left the tail as
// written. The span runs over letters, numbers and marks of any script; what
// it stops at is whitespace, a quote and the ASCII punctuation that frames a
// value.
const VENDOR_SPAN = /(?:sk_(?:live|test)_|sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|xox[abposr]-|akia|asia|aida|ms-|aiza|(?:glpat-|gr1348id-|rtg-yr25fp-|ya29\.|atlassian[-_]|dop_v1_|figd-|glsa[-_]|tfpat[-_]|shpat[-_]|rc_token_|sonar_|pypi-)|sg\.|xapp-)(?:[\p{L}\p{N}\p{M}_+\/=.-]|[\u00b7\u2022\u2219\u2027\u30fb\u22c5](?=[\p{L}\p{N}]))*/giu
const MASKED = "…"
// the fronts the join walk reads as a key's own start behind a frame, and the
// ones VENDOR_SPAN gained on 11-22: a head that is one of these alone
// ("token=glpat-" TAB "AbCd…") is a truncated key, not a value's name, and the
// words after it are the same key's body whatever their length — unless one of
// them opens a front of its own (the walk checks that first)
const FRONTED = /^(?:sk-|sk_(?:live|test)_|gh[pousr]_|github_pat_|xox[abposr]-|ms-|akia|asia|aida|aliyun|sg\.|xapp-|glpat-|gr1348id-|rtg-yr25fp-|ya29\.|atlassian[-_]|dop_v1_|figd-|glsa[-_]|tfpat[-_]|shpat[-_]|rc_token_|sonar_|pypi-)/i
const fronted = (t) => VENDOR.test(t) || /^ms-/i.test(t) || FRONTED.test(t)

// A key the terminal coloured, a private key block, a JWT: each is one value
// whose parts are cut by characters the word readings stop at (an escape
// sequence, a line break, a dot). Asked piece by piece, the seam keeps eight
// contiguous body characters, so these shapes are read whole before any
// per-word pass writes a partial mask that hides them.
const ANSI_ESCAPE = String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\))`
// taken out only between two key characters: a coloured path's own word break
// and a trailing sequence after "ENOENT" are the text's, and joining what they
// separate read "…1234 ENOENT" as one key
const ANSI_IN_KEY = new RegExp(String.raw`(?<=[A-Za-z0-9+/=_.-])(?:${ANSI_ESCAPE})+(?=[A-Za-z0-9+/=_.-])`, "gu")
// an OSC that is never closed is a cut too when key material sits right in
// front of it: the rest of the line is the sequence's payload, and a payload
// carrying a key's body did reach the terminal whole. The guard asks for key
// material in front, so an ordinary coloured log line keeps its payload
const ANSI_OPEN_KEY = /([A-Za-z0-9+/=_.-]{8,})\u001b\](?:[^\u0007\u009c\u001b\n\r;]*;)?([^\u0007\u009c\u001b\n\r]*)/gu
// one side of a cut by an unterminated sequence: key characters, and a digit
// or both cases in them
const keyishSide = (x) => x.length >= 8 && /^[A-Za-z0-9+/=_.-]+$/.test(x) && (/[0-9]/.test(x) || (/[a-z]/.test(x) && /[A-Z]/.test(x)))
// the block is delimited by its BEGIN and END lines, and its interior may
// carry the standard header fields, a comment line, or a blank line
const PRIVATE_BLOCK = /-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY)-----([\s\S]{0,65536}?)-----END \1-----/g
const DOTTED = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+[ \t]{0,2}\.)[A-Za-z0-9_-]+(?:[ \t]{0,2}\.[ \t]{0,2}[A-Za-z0-9_-]+)+/g
const ESC = "\u001b"
const PRIVATE_LEAD = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const maskStructured = (s) => {
  // each shape is asked only when the text carries a sign of it: a page with
  // no escape character, no dot and no BEGIN line has nothing these readings
  // can take, and scanning it over spent the budget
  if (!s.includes(".") && !s.includes(ESC) && !PRIVATE_LEAD.test(s)) return s
  let x = s.replace(ANSI_IN_KEY, "")
  if (x.includes(ESC + "]")) {
    x = x.replace(ANSI_OPEN_KEY, (m, run, payload) => {
      // a cut is the key's only when the two sides of it both read as key
      // material; an identifier beside a title is the text's, not the key's
      const cut = keyishSide(payload) && (keyishSide(run) || /^[A-Z0-9]{8,}$/.test(run))
      return cut ? mask(run) : m
    })
  }
  return x
    .replace(
      PRIVATE_BLOCK,
      (_, kind, body) => `-----BEGIN ${kind}-----${mask(body.replace(/\s/g, ""))}-----END ${kind}-----`
    )
    .replace(DOTTED, (word) => {
      // the bodies sit at the even indexes and the written separators between
      // them at the odd ones, so a value the reading does not take rebuilds
      // with the text's own spelling
      const parts = word.split(/([ \t]{0,2}\.[ \t]{0,2})/)
      const out = []
      let i = 0
      while (i < parts.length) {
        if (
          i % 2 === 0 &&
          /^eyJ[A-Za-z0-9_-]{8,}$/.test(parts[i]) &&
          /^eyJ[A-Za-z0-9_-]{8,}$/.test(parts[i + 2] ?? "") &&
          (parts[i + 4]?.length ?? 0) >= 8
        ) {
          let j = i + 4
          while (parts[j + 2] !== undefined && /^[A-Za-z0-9_-]{4,}$/.test(parts[j + 2])) j += 2
          const bodies = []
          for (let k = i; k <= j; k += 2) bodies.push(parts[k])
          out.push(mask(bodies.join(".")))
          i = j + 1
        } else {
          out.push(parts[i])
          i += 1
        }
      }
      return out.join("")
    })
}
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
// splitKey is spacedKey's reading for the keys that carry no front: a UUID, a
// ghp_ token, a digest, an ms- key cut where the front's own walk does not
// reach. spacedKey begins at an ms-/sk- front and reads on from there; a value
// with no such front was printed piece by piece, each under every floor on its
// own — measured: "123e4567-e89b-12d3-a45 6-426614174000" and
// "ghp_Abcd1234Efgh 5678Ijkl9012Mnop 3456Qrst" both went out as written.
//
// The reading is the same walk: pieces joined across a cut, and the moment the
// join reads as a key the run has found it. A piece that is a word ends the
// search, so a sentence's words are never glued into a key that is not there,
// and the join is only taken when it carries a digit — a key does, and the
// lists and prose a message carries do not.
function splitKey(s) {
  // a page of one- and two-character pieces is the worst case for a walk that
  // starts at every piece, and no value this long is one key cut up (a 32 KiB
  // command line is the widest the reader lists): past this the other
  // readings still run. The walk is linear — a head reads at most 48 pieces
  // on — and the piece scans below are one pass each
  if (s.length > 32 * 1024) return null
  // a tab is a cut's spelling here — the gap grammar below reads across one —
  // and refusing the text for it left a key cut by a tab to the per-word pass,
  // which kept the seam ("AbCd1" TAB "234E…" printed "abcd1234")
  if (/(?:(?![\n\r\t])[\p{Cc}\p{Cf}])/u.test(s)) return null
  const pieces = [...s.matchAll(PIECE)].map((m) => ({ text: m[0], at: m.index }))
  if (pieces.length < 2) return null
  // a piece the cut left: key characters, under the width a cut's piece has
  // (a whole key is one piece, and spacedKey's business), and not a word
  // a piece of capitals is key material, not a word ("AKIAIOSF · ODNN7EXAMPLE"
  // is one key cut in two): the run reading exempts capitals for the same reason
  // a piece of letters that alternates case is key material too ("wJalrXUtnFEMI"
  // is the front of an AWS secret cut by its slashes and a space): a word
  // capitalises once ("McDonald"), and the run is only taken when the join
  // reads as a key, so a sentence's words are still never glued. A 16+
  // mixed-case run is key material whatever its transitions ("MNOPqrstUVWXZZZZ"
  // is a token's back half cut at the middle, one l-to-M capitalisation and
  // nothing more) — the same shape keyRun masks when the half stands alone
  const piece = (t) =>
    t.length <= 48 &&
    KEYCHARS.test(t) &&
    !(PROSE.test(t) && !/^[A-Z]+$/.test(t) && !keyedBody(t) && !((t.match(RUN) ?? []).some(keyRun)))
  // a frame's punctuation ("key=…", "(…)") is read by maskCut, whose head
  // begins after it; joining from the piece's own first character would take
  // the frame for key material ("key=AKIA…" masked from the "k")
  const framed = (t) => !/^[A-Za-z0-9]/.test(t) || /[=:([{,"']/.test(t)
  const MID = /[·•∙‧・]/
  const GAP = /^[ \t\r\n 　·•∙‧・]{1,3}$/
  // the slash is a key's own separator (an AWS secret: wJalr…/K7MDENG/…), so a
  // slash gap reads on like a space does — but only when the value does not
  // start like a path. "/var/folders/hq/q19jry…/T/…" joins into one key-ish
  // read (the segment carries digits and case), and a path must keep its shape.
  const SLASH = /^\/{1,3}$/
  const pathLed = PATHY.test(s) || /^[\\/]/.test(s)
  // the walk is skipped where it cannot find a key: a key needs a digit and a
  // letter within the pieces a head reads on, and both scans are one pass — a
  // page of "x x x …" or "1 1 1 …" has none in reach, and reading it piece by
  // piece was minutes of the hook's budget
  const nearest = (re) => {
    const next = new Int32Array(pieces.length + 1).fill(1e9)
    for (let i = pieces.length - 1; i >= 0; i -= 1) next[i] = re.test(pieces[i].text) ? i : next[i + 1]
    return next
  }
  const nextDigit = nearest(/[0-9]/)
  const nextLetter = nearest(/[A-Za-z]/)
  for (let from = 0; from < pieces.length - 1; from += 1) {
    // (continue, not break: a page of prose has no key in reach at its first
    // piece and one at its last, and the scan has to reach it. The skip is
    // what keeps the walk linear — the page reads each piece once)
    if (nextDigit[from] > from + 48 || nextLetter[from] > from + 48) continue
    // a single-character piece is skipped: the character pass reads a run of
    // them whole ("9f8e 7d6c … b a 1 0"), and joining one to a key's tail took
    // the road's own prose with it ("… Y3z9 x x x x" read "Y3z9x" into the
    // key, and the next window read on from there). A slash after the letter
    // is the key's own cut, not the text's ("token: O/F46xsMfa-…",
    // "key=K9ymj/xp9-…": the letter and the segment after it are one value),
    // and a letter of that shape is one word in a walk of nine — the skip
    // still holds for a run of them
    if (pieces[from].text.length === 1 && !SLASH.test(s.slice(pieces[from].at + 1, pieces[from + 1].at))) continue
    if (!piece(pieces[from].text) || framed(pieces[from].text)) continue
    // a middot before the piece is a cut the other readings own: their walk
    // starts at the key's front, and starting a second one here took the
    // front's pieces for the text ("key=g·hp_1·23·…" came out
    // "key=g·hp_1…7890")
    if (from > 0 && MID.test(s.slice(pieces[from - 1].at + pieces[from - 1].text.length, pieces[from].at))) continue
    let joined = pieces[from].text
    let best = -1
    // a capitalised word either side of a middot is the card's own separator
    // between two captions ("Qwen3-Max · Qwen3-Coder"), not one key's cut. A
    // key's front is exempt ("Ghp_Abcd1234" is capitalised like a caption)
    const caption = (t) => /^[A-Z][a-z]{2,}/.test(t) && !VENDOR.test(t)
    for (let k = from + 1; k < pieces.length && k - from <= 48 && joined.length < 96; k += 1) {
      const gapHere = s.slice(pieces[k - 1].at + pieces[k - 1].text.length, pieces[k].at)
      if (!GAP.test(gapHere) && !(SLASH.test(gapHere) && !pathLed)) break
      if (MID.test(gapHere) && !VENDOR.test(pieces[from].text) && caption(pieces[k - 1].text) && caption(pieces[k].text)) break
      // a piece that opens its own front is a second key, not the first one's body:
      // joining them hid both ends behind one mask ("ms-a…5555")
      if (/^(?:ms-|sk-)/i.test(pieces[k].text)) break
      if (!piece(pieces[k].text)) {
        // a display cuts a key one piece at a time, and its last piece can be a
        // short word of capitals ("Ghp_…·Qrst", "…·789·0"): once the join reads
        // as a key, a piece of at most four letters behind a middot is its end.
        // A space is the text's ("no key ms-… for provider").
        if (best === k - 1 && MID.test(gapHere) && pieces[k].text.length <= 4 && /^[A-Za-z]+$/.test(pieces[k].text)) best = k
        break
      }
      // a long numeral after the key is a count or a year, not the key's own
      if (VERNUM.test(pieces[k].text) && !/\d/.test(joined)) break
      // the rule maskCut applies once a cut is found: a word of one to three
      // lower-case letters after it is the text's ("no key ghp_… for
      // provider" keeps its "for", and "… Y3z9 x x x" keeps its x's)
      // (a piece of a key cut after its own front goes on where a piece of it
      // sits: "ms-foreign-…" cut into threes has "cde" and "f" for its last
      // pieces, and the run stopped at "9ab" — measured, twenty-four
      // characters of the body stayed on the terminal)
      if (
        best > 0 &&
        /^[a-z]{1,3}$/.test(pieces[k].text) &&
        !(
          keyPiecey(pieces[k].text) ||
          nextPiecey(pieces[k + 1]?.text) ||
          // a one-character piece is a piece of a cut once the run so far
          // reads as a key and the character is hex ("…9ab cde f": the card's
          // own piece rule, and the narrow spelling keeps a sentence's "a"
          // out of it)
          (pieces[k].text.length === 1 && /^[0-9a-f]$/i.test(pieces[k].text) && isKey(joined, false))
        )
      ) break
      joined += pieces[k].text
      if (joined.length < 12) continue
      if (/\d/.test(joined) && isKey(joined, false)) best = k
    }
    // the run's longest reading is the key: a key cut into three pieces reads
    // as one at the second of them too, and masking there left the last piece
    // to the per-word pass ("ghp_…9012·IjKl…7890")
    if (best > 0) {
      const last = pieces[best]
      // (the body is the pieces the walk took, not the running join: the
      // short word behind a middot is the key's end and is only moved into
      // `best`, never added to the running string)
      const body = pieces.slice(from, best + 1).map((p) => p.text).join("")
      return { pre: s.slice(0, pieces[from].at), body, post: s.slice(last.at + last.text.length) }
    }
  }
  return null
}

// a run of capitals and digits is a key written without its spaces
// ("AKIAIOSF", "AKIAIOSFODNN7EXA")
const capsPiece = (w) => /^[A-Z0-9]{4,}$/.test(w) && /[A-Z]/.test(w)
// tokenShaped is a /g pattern (used with replace); test() on it would carry
// lastIndex from one call to the next and answer false on the second look
const tokenShaped1 = new RegExp(tokenShaped.source, "iu")
const keyedBody = (body) => (body.match(/[a-z][A-Z]/g) ?? []).length >= 2 && /[A-Z]/.test(body) && /[a-z]/.test(body)
const maskCut = (s) => {
  // a body of many KiB of one-character words costs far more reading than a
  // card ever shows: past 32 KiB the pass is skipped, and the other readings
  // (linear in the text) still run
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
  // (the join's own reading is asked once a body of key length is on the
  // table: asking it at every middot re-read the run to its square)
  // a capitalised word is a caption, not a piece of a key, and two of them
  // either side of a middot are a list the card keeps ("Qwen3-Max ·
  // Qwen3-Coder"). A key's own front is exempt: "Ghp_Abcd1234" is capitalised
  // like a caption and is still the key's first piece
  const caption = (w) => /^[A-Z][a-z]{2,}/.test(w)
  const middotGap = (k, w0, i) => MIDDOT_GAP.test(gap(k)) && !(caption(words[i][0]) && caption(words[k][0]) && !VENDOR.test(words[i][0]) && !VENDOR.test(words[k][0])) && (w0.length <= 2 || VENDOR.test(w0) || /^ms-/i.test(w0) || frontSplit(i) || !wordLike(words[i][0]) || !wordLike(words[k][0]) || (end(k) - at(i) >= 20 && isKey(run(i, k - 1))))
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
    // (a word with a middot in it is the cut's: its material is the word, so
    // the frame keeps no copy of key text — "123e4567-e89·b-" used to leave
    // "123e4567" in the frame and again in the mask)
    const cutMid = /[·•∙‧・]/.test(tail)
    // the word's trailing letters and digits are its material ("key=AK",
    // "NickName=[ghp_…"). A bare short numeral is not: "字ＡＢＣ12" ends in
    // "12", and taking that for a head made every word of a page one, each
    // with a 48-word scan behind it (measured: 25 KB took 19 s before this
    // floor). A key behind a frame is never two digits long
    const trailing = tail.match(/[A-Za-z0-9]+$/)?.[0] ?? ""
    // (the word's own tail is key material only when the word frames it —
    // "key=AK", "NickName=[ghp_…" — or when it is a vendor/ms- front or a
    // digest piece. A word's last letters are the word's: "check-in" ended in
    // "in" and "failed:" in "failed", and either read as a head with a scan
    // behind it, the sentence's own words joining into one "key")
    const framedSep = sep >= 0 || /^[^A-Za-z0-9]/.test(w)
    // a piece of a digest is four characters at least, or carries a letter
    // (a hex run of "12" is no key's front, and reading it as one made every
    // word of a page a head)
    const digestTail = /^[0-9a-f-]+$/i.test(tail) && (tail.length >= 4 || /[A-Za-z]/.test(tail))
    // a frame's fragment is key material when it carries a digit or a capital,
    // is too short to be a word ("key=g", "(AK"), or is long enough to be a
    // body; a word behind a frame ("failed:", "Session") is the text's
    return { mat: fronted(tail) || digestTail || cutMid ? tail : framedSep && (/\d/.test(trailing) || /[A-Z]/.test(trailing) || trailing.length <= 3 || trailing.length >= 16) ? trailing : "" }
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
      if (!pair.includes(MASKED) && isKey(pair, false)) {
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
    const mixedHead = w0.length <= 16 && /[a-z]/.test(w0) && /[A-Z]/.test(w0) && !/^[A-Z][a-z]+$/.test(w0)
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
    // a key written in one lower-case alphabet ("abcd1234efgh 5678ijkl9012
    // mnop3456"): the card takes the same run, and no head reading above does
    // — a piece of it is no vendor front, carries no capital, is no digest and
    // is longer than a front's. The run still has to read as one key joined
    // below, so a page of words with numerals is not taken
    const lcHead = w0.length >= 4 && /^[a-z0-9]+$/.test(w0) && /[0-9]/.test(w0) && /[a-z]/.test(w0)
    // a head behind a frame's punctuation ("key=AK IA…", a JSON quote, a
    // bracket): the key material is what follows the frame, and the frame
    // itself is kept as printed. Two characters of it at least — a single
    // letter behind a frame is the per-word pass's ("NickName=[A") — and the
    // run still has to read as a key below
    const { mat } = frameAt(w0)
    // a word with no frame may carry the key's head inside it ("no key
    // ms-aaaa…"): its part that reads as a digest. A path is not read that
    // way ("/tmp/ms-ZZZZ…" is masked as the token it is, by the per-word pass)
    // (a bare short numeral is no key's band either: "字ＡＢＣ12" carries a
    // "12", and reading that as a head made every word of a page one. A key
    // behind a frame is four characters at least, or carries a letter)
    const band = /[\\/]/.test(w0) || fronted(w0) ? undefined : (w0.match(/[A-Za-z0-9]+/g) ?? []).find((b) => digestPiece(b) && (b.length >= 4 || /[A-Za-z]/.test(b)))
    // (a word that opens with a vendor front is the key's from its first
    // character: a digest band inside it — the "12" of "ghp_12" — is not a
    // frame, and the four characters the mask shows would be that band)
    const t0 = mat !== w0 && mat.length >= 2 ? mat : band && band.length >= 2 && !VENDOR.test(w0) && !/^ms-/i.test(w0) ? band : w0
    // the head's key material with its frame kept outside the mask
    const tailHead = t0 !== w0
    // (a frame whose material is one character is no head's: "NickName=[1,"
    // read the name into the key and masked a list of ones. The word's own
    // shape can still start a run — a whole key-shaped word is the key
    // whatever stands in front of it — but being a mixed-case word behind a
    // frame is not enough)
    const framedOne = mat !== w0 && mat.length < 2
    if (!VENDOR.test(w0) && !capsPiece(w0) && !msHead && !tiny && !mixedHead && !frontish && !hexHead && !tailHead && !lcHead) continue
    if (framedOne && !VENDOR.test(w0) && !capsPiece(w0) && !msHead && !frontish && !hexHead && !lcHead) continue
    // two key-shaped words are two keys when a front shows on one of them:
    // one mask for both would hide the second's front ("ms-aaaa… ms-zzzz…"
    // is not one key). Two bare halves ("AbCd1234EfGh5678 AbCd1234EfGh5678")
    // are read on instead — a cut key's halves have no front, and masking
    // them apart kept eight characters at the seam
    const pairOfKeys =
      i + 1 < words.length &&
      /^[ \t\u00a0\u3000]+$/.test(gap(i + 1)) &&
      keyAt(words[i][0]) &&
      keyAt(words[i + 1][0]) &&
      (fronted(words[i][0]) || fronted(words[i + 1][0]))
    let j = i
    let head = i
    // the last word a run read, and whether anything in it was key material:
    // a start that found neither hands the scan on to there ("A A A …" is one
    // pass, not one run per word), while a run that saw a digit or a front may
    // still hold a key's head further on and is read word by word
    let last = i
    let sawKey = false
    let body = t0
    let sawHard = /[A-Z]/.test(t0) || /\d/.test(t0)
    // the pieces read so far, kept as they are read: slicing them out of the
    // word list at every piece is what made a page of tiny words take seconds
    const pieces = [t0]
    // the questions below asked of the pieces, kept as they are read (asking
    // each of them again at every piece read a page of tiny words to the square)
    // A run of pieces of nothing but digits is no key whatever follows it
    // (the cut test says so), and a page of short words with digits in them
    // made every word a head with a 48-word scan behind it: asked per piece,
    // that was quadratic (measured: 25 KB of them took 1.1 s). Kept as they
    // are read, and the scan below leaves the run as soon as it cannot be a
    // key.
    let allNumeric = /^[0-9]*$/.test(t0)
    let proseCount = 0
    const notePiece = (w) => {
      if (!/^[0-9]*$/.test(w)) allNumeric = false
      if (w.length >= 4 && /^[a-z]{4,}$/.test(w) && !VENDOR.test(w)) proseCount += 1
    }
    if (!/^[0-9]*$/.test(t0)) allNumeric = false
    let anyDigit = /[0-9]/.test(t0)
    let anyCap = /[A-Z]/.test(t0)
    // (a key is shorter than 128 characters, and every reading below is asked
    // of the body joined so far: a page of short words that each looked like a
    // head read bodies of 300 characters 48 times apiece, which was quadratic
    // in the page — measured, 25 KB took 5 s. The bound is not reached by a
    // key, and it stops the walk instead of reading a body that cannot be one)
    for (let k = i + 1; !pairOfKeys && k < words.length && k - i <= 48 && body.length < 128 && (/^[ \t\u00a0\u3000\r\n]+$/.test(gap(k)) || middotGap(k, w0, i)); k += 1) {
      const x = words[k][0]
      // a short word of the text's ends the run once a cut has been read
      // ("no key abcd… mnop3456 for provider" keeps its "for"): the pieces of
      // a key that are one to three letters are read before the cut is found
      // (the "a" of "sk-a nt-a pi03"), and a word after it is the text's.
      // (a run whose body already reads as a key is complete: the word after
      // it is the frame's — "ghp_…Qrst, for provider" read "for" into the
      // mask, and the mask ended ",for")
      // (a piece of a key cut after its own front is read on where a piece of
      // it sits — the same reading the cut walk above takes: "ms-foreign-…"
      // cut into threes ends at "9ab" without it, and twenty-four characters
      // of the body stay on the terminal)
      if (
        /^[a-z]{1,3}$/.test(x) &&
        !VENDOR.test(x) &&
        (j > i || isKey(body)) &&
        !(keyPiecey(x) || nextPiecey(words[k + 1]?.[0]) || (x.length === 1 && /^[0-9a-f]$/i.test(x) && isKey(body)))
      ) break
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
      pieces.push(x)
      notePiece(x)
      if (!sawHard && (/[A-Z]/.test(x) || /\d/.test(x))) sawHard = true
      if (!anyDigit && /[0-9]/.test(x)) anyDigit = true
      if (!anyCap && /[A-Z]/.test(x)) anyCap = true
      // the head is not a word of the run's own: "xoxb -123 4567 …" begins at
      // a front cut in two, and reading the front as prose ended the run
      // a piece joined by a middot or a bullet is key material whether or not
      // it reads as a word ("ms-f·orei·gn-0·…"): the card's separators are the
      // ones with a word on both sides, and those a run started at a key's
      // front can still be checked against the key below
      const mid = MIDDOT_GAP.test(gap(k))
      const prose = !mid && proseCount > 0
      // (the head's own material counts: "abcd1234efgh 5678ijkl9012 mnop3456"
      // read its first piece as prose and ended the run there, and the key
      // stayed on the terminal whole)
      if (prose && !(/^ms-/i.test(w0) && tokenShaped1.test(body) && msKey(body, false)) && !(keyAt(x) && sawHard)) continue
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
      // a lower-case run of four or more letters after the head is prose, or
      // a path's word ("/tmp/ms-ZZZZ…"): a key's pieces carry capitals or
      // digits
      const plain = x.length > 4 && /^[a-z]{4,}$/.test(x) && !VENDOR.test(x)
      // a bare front (ghp_, sk-, xoxb-) is a word no key floor keeps, and the
      // pieces after it are the key; a vendor-like word that carries more than
      // the front ("sk-preset-20261031") is a provider id, and its run only
      // counts when the join is a key of its own
      const bareFront = VENDOR.test(pieces[0]) && pieces[0].length <= 8
      // a front cut in two leaves a shorter body than the floor reads: the
      // front itself is half of it ("xoxb-12345678901" is 16 characters), and
      // the front's own evidence stands in for the missing four
      const capMixed = anyDigit && anyCap
      const capFront = /^[a-z]{1,5}$/.test(pieces[0]) && /[0-9]/.test(pieces[1]) && /[A-Za-z]/.test(pieces[1])
      const shortFront = frontish && pieces.length >= 3 && anyDigit
      // a body of digits only is no key's: the run cannot become one by
      // reading on, and every reading below would be asked at every piece
      if (allNumeric) continue
      const cut =
        /\d/.test(body) &&
        body.length >= (frontish ? 16 : 20) &&
        !body.includes(MASKED) &&
        // a middot or a bullet is a cut's spelling too, and the key it writes
        // is the characters joined without them
        // (a body of nothing but digits is no key's, and some of the readings
        // below re-read it at every piece: asked once, at the floor)
        (anyCap || !/^\d+$/.test(body)) &&
        !/^\d+$/.test(body.replace(/[^A-Za-z0-9]/g, "")) &&
        // (a body whose letters are one word — "NickName=[1, 1, …]" — is a
        // frame, not a key's front: a key carries other marks with its letters)
        (/[\d]/.test(body.replace(/[^A-Za-z0-9]/g, "").replace(/^[A-Za-z]+/, "")) || !isKey(body.replace(/[^A-Za-z]/g, ""), false)) &&
          (isKey(body, false) ||
          // the key the pieces write when the card's own separators — the
          // middots and the hyphens a UUID is drawn with — are left out
          (mid && isKey(body.replace(/[·•∙‧・]/g, ""), false)) ||
          (mid && isKey(body.replace(/[·•∙‧・-]/g, ""), false)) ||
          (msHead && tokenShaped1.test(body) && msKey(body, false) && !pieces.some((w) => /^[A-Za-z]{2,}$/.test(w) && !VENDOR.test(w) && w !== w0)) ||
          (bareFront && !plain && (pieces[0] + pieces[1]).match(/[A-Za-z0-9]+/g) ? (pieces[0] + pieces[1]).match(/[A-Za-z0-9]+/g).some((r) => keyRun(r) || r.length >= 4 || keyedBody(body)) : false) ||
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
    // a word read whole starts its key material where its material does: the
    // frame in front of it ("(ghp_…") is kept, and the four characters the
    // mask shows are the key's, not the frame's leftovers
    const keep = s.slice(at(i), at(i) + w0.length).indexOf(t0)
    const parts = [t0, ...words.slice(i + 1, j + 1).map((w) => w[0])]
    // a word of nothing but punctuation is the frame's ("(… )"), not the
    // key's: the mask's last four characters are the key's own
    let tailP = ""
    if (parts.length > 1 && !/[A-Za-z0-9]/.test(parts[parts.length - 1])) tailP = parts.pop().replace(/^[A-Za-z0-9]+/, "")
    const keyText = parts.join("").replace(MASKED, "")
    out.push(s.slice(from, at(i) + keep), mask(keyText.replaceAll(MASKED, "")), tailP)
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
    if (k > i && got.length >= 20 && isKey(got, false)) {
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
    // a frame glued to the key's front is one word to this reading
    // ("_AKIA …", "key=AKIA …"): the front starts where it starts. A word that
    // read only whole masked the pieces after it and left "AKIA IOSF" as
    // written ("_AKIA IOSF ODNN 7EXA MPLE" printed its first eight body
    // characters and the card and the host's log line did the same)
    const at0 = VENDOR_SPAN.exec(words[i][0])
    VENDOR_SPAN.lastIndex = 0
    const lead = at0 && at0.index > 0 && !/[A-Za-z0-9]/.test(words[i][0][at0.index - 1]) ? at0.index : 0
    const head = words[i][0].slice(lead)
    // the piece's own trailing mark is the text's ("…MPLE\"", "…MPLE)"):
    // the join is judged on the key's characters and the mark stays
    const TAIL = /[^A-Za-z0-9]+$/
    // three characters is a key's piece too ("AKI AIO SFO …" is a key cut
    // into threes); the join still has to be long enough to be one, so a
    // sentence of two capitals is not read
    if (!/^[A-Z0-9]{3,}$/.test(head.replace(TAIL, "")) || !/[A-Z0-9]/.test(head)) continue
    let j = i
    let body = head.replace(TAIL, "")
    // a piece carries the card's own separator on its end ("AKIAIO· SFODNN·…")
    const piece = (w) => w.replace(/[·•∙‧・]+$/, "").replace(TAIL, "")
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
    // the word the front sits in keeps its own text in front of the mask, and
    // the last word keeps the mark after it
    out.push(s.slice(from, words[i].index + lead), mask(body))
    from = words[j].index + piece(words[j][0]).length
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

// the longest body the whole-text readings take. Past it each reading skips
// the body, which is right for a page of one-character words and wrong for a
// key in the tail of a long echo: arg() cuts at this size first.
const CHUNK = 32 * 1024
// chunked cuts text too long for one reading into pieces under CHUNK.
//
// The cut is at a WORD boundary and the straddling word goes with the piece
// after it: a key cut between its own words ("AKIAAAAA AAAA1AAA AAAA") is two
// pieces too short to read, and both printed — that was a leak the first
// version of this fix had. A line break is preferred, then a space or tab.
// One unbroken run with no boundary at all is cut at the size; a key is never
// that long, and a piece must stay under CHUNK or arg() recurses into itself.
const OVERLAP = 256
function chunked(text) {
  if (text.length <= CHUNK) return [{ text, carry: 0 }]
  const pieces = []
  let at = 0
  while (at < text.length) {
    const back = Math.min(OVERLAP, at)
    const limit = at + CHUNK - back
    let end = Math.min(limit, text.length)
    if (end < text.length) {
      const window = text.slice(at, end)
      const nl = window.lastIndexOf("\n")
      if (nl > 0) {
        end = at + nl + 1
      } else {
        // the last space or tab in the window, then back over the word it
        // ends so that word is not split; if that would give up more than a
        // quarter of the window, the run has no usable boundary and the cut
        // stays at the size
        let k = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"))
        if (k > 0) {
          let start = k
          while (start > 0 && /[A-Za-z0-9+/=_.-]/.test(window[start - 1])) start -= 1
          if (start > 0 && limit - (at + start) < (CHUNK * 3) / 4) end = at + start
        }
      }
    }
    if (end <= at) end = Math.min(limit, text.length)
    // the carry is a copy of the tail of the PREVIOUS piece, read again so a
    // key the cut split is still whole for this one. It is counted back from
    // the start of this piece's own text, which is `at` — so it is taken
    // before anything moves that start.
    const skip = Math.min(back, at)
    // a cut made at the size can leave the next piece starting inside a run
    // of key characters: 32 700 "y"s then the rest of the run read as one
    // long key of their own, and the run was masked away. A piece starts at a
    // word boundary, or (when the run has none) after the run has ended.
    // Moving `at` forward here used to leave the span it skipped over read by
    // neither piece: 32 768 "x"s reached the terminal where the input had
    // 33 000. The span is this piece's now — it starts where the old one did.
    let start = at - skip
    if (at > 0 && end < text.length && /[A-Za-z0-9+/=_.-]/.test(text[at]) && /[A-Za-z0-9+/=_.-]/.test(text[at - 1])) {
      // the walk stops at the bound the rule itself uses: a move of CHUNK/2
      // or more is not taken, so nothing past that point can change the
      // answer — and without the bound a 4 MB run was scanned to its far end
      // once per piece, 268 million characters for a body of one character
      const stop = Math.min(text.length, at + CHUNK / 2)
      let k = at
      while (k < stop && /[A-Za-z0-9+/=_.-]/.test(text[k])) k += 1
      if (k - at < CHUNK / 2) at = k
    }
    // The carry is a copy of the previous piece's tail, read again so a key the
    // cut split is whole for this one. It has to begin where the run it sits in
    // begins: a carry that opened two characters into a key gave this piece a
    // body with its front cut off — no front, no key — and it printed that body
    // beside the mask the previous piece had already written for the whole run.
    // The piece's own start moves back with it, so the run is read to the same
    // end either way and the piece stays under CHUNK (widening the carry alone
    // is what recursed: the piece grew past the chunk and arg() cut it again).
    pieces.push({ text: text.slice(start, end), carry: skip })
    at = end
  }
  return pieces
}

const CELL_GRIDGAP = /[ \t\u00a0\u3000|\u00b7\u2022\u2219\u2027\u30fb\u2223\u00a6\u2758\r\n]/
// cellGrid is maskCellCut's walk on the CLI side: a grid of three or more
// equal cells of key characters, joined by whitespace, a bar or a middle dot,
// whose joined body reads as a key. The first cell may be a front-led one of
// another width ("ms-abcd efgh …").
//
// It reports absolute indices, so a caller masks the body in place and keeps
// the text around it without copying the suffix at every match.
const CELL_GRIDNAME = /^([A-Za-z_][A-Za-z0-9_]{0,23})=(\S.*)$/
const cellGridNamed = (cell) => {
  const m = CELL_GRIDNAME.exec(cell)
  return m && /[a-z_]/.test(m[1]) && /[A-Za-z0-9]/.test(m[2]) ? m[2] : ""
}
const cellGridProse = (w) => /^[a-z]+$/.test(w) && /[aeiouy]/.test(w) && !/^[0-9a-f]+$/i.test(w)
const cellGridWide = (c) => c !== undefined && c.charCodeAt(0) > 0x7f
const cellGridWideKey = (c) => {
  if (!cellGridWide(c)) return false
  const n = c.normalize("NFKC")
  // a punctuation-only fold is a break (the card's cellWideKey)
  return n !== "." && (n.length === 1 ? /[A-Za-z0-9+/=_.-]/.test(n) : /[A-Za-z0-9]/.test(n) && /^[A-Za-z0-9+/=_.-]+$/.test(n))
}
const cellGridCh = (c) => c !== undefined && (CELLCH.test(c) || cellGridWideKey(c))
// the character at i as one code point (the card's cellAt)
const cellGridAt = (s, i) => { const cp = s.codePointAt(i); return cp >0xffff ? String.fromCodePoint(cp) : s[i] }
// a cell body as the key test reads it: full-width characters fold to the
// ASCII key characters they stand for, and cells' gaps are dropped (the
// cards cellFold, kept in step with it)
// a fold to several key characters ("ﬀ" is "ff") is key material too (the
// card's cellFold)
const cellGridFold = (s) => /[^\x00-\x7f]/.test(s) ? Array.from(s, (c) => { const n = c.normalize("NFKC"); return /^[A-Za-z0-9+/=_.-]+$/.test(n) ? n : "" }).join("") : s.replace(/[^A-Za-z0-9+/=_.-]/g, "")
// the walk's start gate, folded: ASCII is decided without normalizing, the
// same cost reason as the card's cellAlnum
const cellGridAlnum = (c) => {
  if (c === undefined) return false
  if (c.charCodeAt(0) < 0x80) return /[A-Za-z0-9]/.test(c)
  const n = c.normalize("NFKC")
  return n.length === 1 && /[A-Za-z0-9]/.test(n)
}
// a gap in either spelling: a full-width bar or dot is the cut's separator
// too (measured: "Ａ｜Ｋ｜Ｉ｜…" printed whole)
const cellGridGap = (c) => {
  if (c === undefined) return false
  // the mask watermark is a break, not a separator: read as a gap it made a
  // page of already-masked values one grid and masked the page whole
  if (c === "…") return false
  if (CELL_GRIDGAP.test(c)) return true
  if (c.charCodeAt(0) <= 0x7f) return false
  const n = c.normalize("NFKC")
  return /^\.+$/.test(n) || CELL_GRIDGAP.test(n)
}
// and whether a body holds key material once folded (the card's cellHasAlnum)
const cellGridHasAlnum = (s) => /[A-Za-z0-9]/.test(s) || /[^\x00-\x7f]/.test(s) && /[A-Za-z0-9]/.test(cellGridFold(s))
const cellGridWideBeside = (s, from, dir) => {
  for (let n = 0, i = from + dir; n < 64 && i >= 0 && i < s.length; n += 1) {
    const c = cellGridAt(s, i)
    if (cellGridGap(c) || CELLCH.test(c)) { i += dir; continue }
    return cellGridWideKey(c)
  }
  return false
}
const cellGridFront = (cell) => {
  const m = CELL_FRONT.exec(cell) || VENDOR.exec(cell)
  if (!m) return null
  const tail = cell.slice(m[0].length)
  return /^[a-z]+$/.test(tail) && /[aeiouy]/.test(tail) && !/^[0-9a-f]+$/i.test(tail) ? null : m
}
const cellGrid = (s, from = 0) => {
  if (s.length < 20) return null
  let k = Math.max(0, from)
  while (k < s.length) {
    if (!cellGridAlnum(cellGridAt(s, k)) || (k > 0 && cellGridAlnum(cellGridAt(s, k - 1)))) {
      k += 1
      continue
    }
    const cells = []
    const ends = []
    let p = k
    let bodyAt = k
    // a run past the length bound is no key at any start inside it: the walk
    // stops collecting at the bound and skips what it read (a 4 KB run of
    // equal cells rescanned its own tail from every start: 20 s at 320 KB)
    let flatLen = 0
    let over = false
    // a head written entirely in full-width characters may be followed by
    // cells of another width (the card's wide0, kept in step with it)
    let wide0 = false
    // strength counted as the run is read (the card's strongRun)
    let strongRun = 0
    let runEnd = k
    for (;;) {
      // as on the card, the scan stops one character past the longest cap
      let q = p
      while (q < s.length && q - p <= 25 && cellGridCh(cellGridAt(s, q))) q += cellGridAt(s, q).length
      let body = s.slice(p, q)
      if (cells.length === 0 && q - p <= 26) {
        const named = cellGridNamed(body)
        if (named) { body = named; bodyAt = q - body.length }
      } else if (cells.length > 0 && cellGridNamed(body)) {
        // a second value behind its own name ("x=… y=…") ends the grid: its
        // "=" joined the cell and the widths no longer matched
        break
      }
      // as on the card, the first cell may carry the front plus one cell
      const fr = cells.length === 0 ? cellGridFront(body) : null
      if (cells.length === 0) wide0 = [...body].length > 0 && [...body].every((c) => cellGridWideKey(c))
      const cap = fr ? 24 : wide0 ? 26 : 8
      // a cut one character at a time is cells of one, and a lone mark of the
      // cut is a cell when an alnum cell follows it (the card's reading)
      let bridged = false
      if (!cellGridHasAlnum(body) && cells.length > 0 && body.length <= 2) {
        let e = q
        while (e < s.length && e - q <= 8 && cellGridGap(s[e])) e += 1
        let e2 = e
        while (e2 < s.length && e2 - e <= 25 && cellGridCh(cellGridAt(s, e2))) e2 += cellGridAt(s, e2).length
        bridged = cellGridHasAlnum(s.slice(e, e2))
      }
      if (body.length < 1 || body.length > cap || (!cellGridHasAlnum(body) && !bridged)) break
      const foldedCell = cellGridFold(body)
      if (/\d/.test(foldedCell) || CELL_CASEY(foldedCell) || (cells.length === 0 && CELL_FRONT.test(foldedCell))) strongRun += 1
      if (!over) {
        cells.push(body)
        ends.push(q)
      }
      flatLen += body.length
      runEnd = q
      if (!over && (cells.length >= 512 || flatLen > 4096)) over = true
      let g = q
      // a full stop standing in a cell of its own ("A | . | b") is the text's
      // punctuation, not material: the card's body holds it and the bridge
      // carries it; here it is stepped over when a non-cell follows
      while (g < s.length && g - q <= 8 && (cellGridGap(s[g]) || (s[g] === "." && (g + 1 >= s.length || !cellGridCh(s[g + 1]))))) g += 1
      if (g === q || g >= s.length || !cellGridCh(cellGridAt(s, g))) {
        // a run that goes on without a gap is one cut, not a grid's next cell
        // (the card's reading, kept in step with it, and read to the run's end)
        if (!wide0 || g !== q || g >= s.length || !cellGridCh(cellGridAt(s, g))) break
      }
      p = g
    }
    const readEnd = ends.length > 0 ? ends[ends.length - 1] : k
    if (over) {
      const flat = cellGridFold(s.slice(bodyAt, runEnd))
      if (strongRun >= 2 && (isKey(flat) || (/^ms-/i.test(flat) && msKey(flat)))) {
        return { preEnd: k, bodyAt, body: flat, bodyEnd: runEnd }
      }
      k = Math.max(k + 1, runEnd)
      continue
    }
    while (cells.length > 1 && cellGridProse(cells[cells.length - 1])) {
      cells.pop()
      ends.pop()
    }
    const stop = ends.length > 0 ? ends[ends.length - 1] : k
    // a continuation is the same cut going on only when it is key material of
    // its own: a mark, a word and another value behind its name are text
    let cont = stop
    while (cont < s.length && cont - stop <= 8 && cellGridGap(s[cont])) cont += 1
    let contEnd = cont
    while (contEnd < s.length && contEnd - cont <= 24 && cellGridCh(cellGridAt(s, contEnd))) contEnd += cellGridAt(s, contEnd).length
    const contCell = s.slice(cont, contEnd)
    let before = k - 1
    for (let n = 0; n < 8 && before >= 0 && cellGridGap(s[before]); n += 1) before -= 1
    const beforeGap = s.slice(before + 1, k)
    let beforeAt = before
    while (beforeAt >= 0 && before - beforeAt < 32 && cellGridCh(cellGridAt(s, beforeAt))) beforeAt -= beforeAt > 0 ? cellGridAt(s, beforeAt - 1).length : 1
    const beforeCell = before >= 0 ? s.slice(beforeAt + 1, before + 1) : ""
    const precedes = beforeGap.length > 0 && !/\s/.test(beforeGap) && beforeCell.length >= 4 && cellGridHasAlnum(beforeCell) && !cellGridProse(beforeCell)
    const continues = cells.length < 512 && contCell.length >= 2 && cellGridHasAlnum(contCell) && !cellGridProse(contCell) && !contCell.includes("=")
    if (continues || precedes) {
      k = Math.max(k + 1, readEnd)
      continue
    }
    // the grid's width is its cells' (the second one: the first may be a
    // front-led one of another width), and a key's last group may be short
    // ("… MnOp3456 | QrSt")
    const width = cells.length > 1 ? cellGridFold(cells[1]).length : 0
    const fr0 = cells.length > 0 ? cellGridFront(cells[0]) : null
    const fronted = fr0 !== null
    const grid = cells.length > 0 && cells.every((c, i) => cellGridFold(c).length === width || (i === 0 && fronted) || (i === cells.length - 1 && cellGridFold(c).length < width))
    // an uneven cut (the card's uneven): short and long cells beside each other
    // are still one cut when short groups and a long piece are both there
    const uneven = !grid && cells.filter((c) => c.length <= 2).length >= 2 && cells.some((c) => c.length >= 6) && cells.every((c) => c.length <= 8) && cells.filter(cellGridProse).length < 2 && cells.filter((c) => c.length >= 4 && /\d/.test(cellGridFold(c))).length >= 2
    const flat = cells.join("")
    // the same body as the key test reads it (cellGridFold, as the card folds)
    const flatN = cellGridFold(flat)
    // every arm of the key test needs a letter (see the card's reading)
    if (!/[A-Za-z]/.test(flatN)) {
      k = Math.max(k + 1, readEnd)
      continue
    }
    // a front-led body is the shape spacedKey masks, and a lower-case one cut
    // in cells carries no case or digit for isKey ("ms-abcd efgh … yz01"): the
    // front and msKey are the same judgement its own body reading makes. Only
    // the ms- front gets it: sk- is a flag's prefix too ("sk-preset linux
    // macos amd64" was masked as a key)
    if (((grid && cells.length >= 3) || (wide0 && cells.length >= 2) || uneven) && cells.length <= 512 && strongRun >= 2 && flat.length >= 20 && flat.length <= 4096 && !cellGridWideBeside(s, k, -1) && !cellGridWideBeside(s, stop, 1) && (isKey(flatN) || (/^ms-/i.test(flatN) && msKey(flatN)))) {
      // the gap before a closing bracket is the frame's, as in every other
      // reading: "(ghp_…7890)", not "(ghp_…7890 )"
      let end = stop
      let t = end
      while (t < s.length && /[ \t\u00a0\u3000]/.test(s[t])) t += 1
      if (t > end && /[)\]}"'`>]/.test(s[t] ?? "")) end = t
      return { preEnd: k, bodyAt, body: flatN, bodyEnd: end }
    }
    k = Math.max(k + 1, strongRun === 0 && !fronted ? readEnd : ends.length > 0 ? ends[0] : k)
  }
  return null
}

// the walk stops at a word, but a key's own groups after it are not words: a
// short group carrying a digit or a capital continues the cut ("… 3456 | QrSt"
// printed its last group beside the mask, eight characters of the body)
const CELL_TAIL = /^([ \t\u00a0\u3000|\u00b7\u2022\u2219\u2027]{1,8})([A-Za-z0-9+/=_.-]{2,8})(?![A-Za-z0-9+/=_.-])/
const extendCut = (body, post) => {
  let joined = body
  let rest = post
  for (let n = 0; n < 24; n += 1) {
    const m = CELL_TAIL.exec(rest)
    if (!m) break
    const cell = m[2]
    const keyish = /\d/.test(cell) || /[A-Z]/.test(cell) || (!/[aeiouy]/.test(cell) && !/^[0-9a-f]+$/.test(cell))
    if (!keyish) break
    joined += m[1] + cell
    rest = rest.slice(m[0].length)
  }
  return { body: joined, rest }
}
const keyJoin = (body) => body.replace(/[\s\u00a0\u3000|\u00b7\u2022\u2219\u2027]+/g, "")

export function arg(v) {
  return argInner(String(v ?? ""), true)
}
// allowGrid is off on the second pass: the text handed back already carries
// this reading's masks, and asking it again only re-read them
function argInner(v, allowGrid) {
  const orig = v
  // A value far longer than any value a person types — a child process's
  // verbose error, a page dumped to stderr — is cut into chunks and each
  // chunk read through this function. Every whole-text reading below skips a
  // body past 32 KiB (each is a scan over the whole text, and a page that
  // long is not one key cut up), so a key in the tail of one went out in the
  // clear: measured, a 32 841-character echo with an AWS secret printed it
  // whole while a 30 075-character one masked it. Cutting first means the
  // skip is never reached by a whole page — only by a chunk-sized body of
  // one-character words, which is what it was written for.
  if (orig.length > CHUNK) {
    const parts = chunked(orig)
    let out = ""
    for (const { text, carry } of parts) {
      if (carry === 0) {
        out += arg(text)
        continue
      }
      // The carry was read by the piece before it, and its result is already
      // in `out`. It is read AGAIN together with this piece — a key the cut
      // straddled is one key only when the two parts are seen together — and
      // then dropped from the front of the result. Dropping by CHARACTER
      // count was wrong: the mask of the carry is shorter than the carry
      // ("ghp_…1111" for a 40-character key), so the slice cut into the
      // piece's own text and took the rest of the error with it (measured:
      // 32798 characters in, 32768 out, 16 key characters in the clear).
      // the carry as `out` ends with it, not by character count: the mask
      // behind it is shorter than the carry it stands for
      const seen = arg(text)
      const carryText = arg(text.slice(0, carry))
      if (out.endsWith(carryText)) {
        out = out.slice(0, out.length - carryText.length) + seen
        continue
      }
      // The carry's own read did not come out the same as the previous piece's
      // tail — the carry began INSIDE a run, so this piece was handed the run's
      // body with its front cut off and read it as ordinary text. The previous
      // piece had the whole run and wrote a mask for it; repeating the run's
      // opening characters here prints them beside that mask. They are dropped:
      // a mask in `out` means the run before it was taken, and this piece's own
      // text starts where it starts, so nothing else is lost.
      let cut = 0
      while (cut < seen.length && cut < carry && /[A-Za-z0-9+/=_.-]/.test(seen[cut])) cut += 1
      if (cut > 0 && !out.includes(MASKED)) cut = 0
      out = out + seen.slice(cut)
    }
    return out
  }
  // the glue is one pass over the value, and all three readings below ask the
  // same question of the same characters: it is removed once and handed to each
  // ("glue" is the value with an invisible character between two key characters
  // taken out, so a key cut by one is put back together)
  const raw0 = maskStructured(orig).replace(GLUE, "")
  // a key the text wrote as a grid of equal cells ("Ab | Cd | 12 | …",
  // "AKIA    IOSF    ODNN    …", a bullet-cut AWS secret) is read first: the
  // readings below look for the ms- front, a frame or a run of words, and a
  // two-character grid behind a bar met none of them and printed whole. The
  // grid's evidence is the sameness of its cells — a sentence's words have no
  // one width — and the joined run still has to read as a key.
  // (a value with full-width characters is foldedSpans' whole cut: a grid read
  // on its ASCII pieces split the span and left the full-width ones beside the
  // mask — "x=ｍｓ－ＬｍＮｏ ２４６８ ＬｍＮｏ 2468…2468 invalid")
  // every hit is masked in one pass over the value: recursing on the text
  // behind each hit copied the whole suffix again, and a page of grids was
  // read to its square (640 grids in 1 MiB took 15 s at 8× the copies)
  if (allowGrid) {
    const hits = []
    for (let k = 0; ; ) {
      const g = cellGrid(raw0, k)
      if (!g) break
      hits.push(g)
      k = g.bodyEnd
    }
    // a front-led cut that has begun before a grid owns that grid too: the
    // cells are the rest of the same cut ("x=m s - LmNo24 68LmNo … LmNo2468"
    // printed two masks with the cut's own characters between them). The
    // reading runs from the cut's front through the grid's end.
    const sp0 = spacedKey(raw0)
    const kept = []
    for (const g of hits) {
      if (!sp0) { kept.push(g); continue }
      const from = sp0.pre.length
      const to = from + sp0.body.length
      if (g.bodyEnd <= to) continue
      if (g.preEnd >= from && g.preEnd - to <= 32 && /^[^A-Za-z0-9]*$/.test(raw0.slice(to, g.preEnd))) {
        kept.push({ preEnd: g.preEnd, bodyAt: from, body: raw0.slice(from, g.bodyEnd).replace(/[^A-Za-z0-9+/=_.-]/g, ""), bodyEnd: g.bodyEnd })
        continue
      }
      kept.push(g)
    }
    if (kept.length > 0) {
      let out = ""
      let at = 0
      for (const g of kept) {
        out += raw0.slice(at, g.bodyAt) + mask(g.body)
        at = g.bodyEnd
      }
      out += raw0.slice(at)
      if (out !== raw0) return argInner(out, false)
    }
  }
  // the ms- front has its own joiner for pieces of any width (one to a
  // character), and it reads the value as it was typed. It runs before
  // joinFramed: the framed join masks a run up to the words it takes, and the
  // "…" it writes stops spacedKey's walk where the key went on — measured,
  // "x=m s - LmNo24 68Pq Rs1357Tu … Hi3597" came out "x=m s - LmNo24 68Pq
  // Rs13…3597", sixteen body characters beside the key's own mask
  const cut = spacedKey(raw0)
  // the body spans the gaps the pieces were cut with; the key is the
  // characters themselves, and mask() keeps its first and last four — a
  // three-character last piece ("… nop3 456") otherwise shows the gap in the
  // mask ("ms-a… 456")
  // (the join is only a key when the body reads as one: "ms-cli 2026.11.9"
  // is a program and its version, and the card keeps it)
  if (cut) {
    // a sentence's full stop is the text's, not the key's: the walk takes "."
    // as key material, and "…ABCDEF." failed msKey while the halves were left
    // to the per-word pass. A body that reads as a key once its trailing
    // punctuation is set aside is the key; the punctuation prints as typed
    const ext = extendCut(cut.body, cut.post)
    const body = ext.body
    const core = body.replace(/[._-]+$/, "")
    const keyBody = msKey(body, false) ? body : core !== body && msKey(core, false) ? core : ""
    if (keyBody) return argRun(cut.pre) + mask(keyJoin(keyBody)) + argRun(body.slice(keyBody.length) + ext.rest)
  }
  // full-width pieces fold to a key; an ellipsis folds to three dots and would
  // read as key material ("ms-a…5555" → "ms-a...5555"), so a value that
  // already carries a mask is not asked again. Read on the typed value, before
  // the framed join for the same reason spacedKey is: a mask the join writes
  // first puts an ellipsis inside the span the fold would have taken.
  // (before splitKey, which reads only ASCII: a full-width front with an ASCII
  // tail cut every four cells is one key, and splitKey found the tail alone —
  // the folded front went to argRun, masked to its own four ends, and the two
  // masks side by side printed eight contiguous characters of the body)
  if (!raw0.includes("…")) {
    const folded = foldedSpans(raw0)
    if (folded) return folded
  }
  // the framed join runs before splitKey: its walk starts at the frame and
  // takes the whole run, while splitKey's walk starts at the first piece that
  // is key material on its own — "x=5f3a 9c1e … 5a91" was masked from "9c1e"
  // and "5f3a" printed beside the mask
  const raw = joinFramed(raw0)
  // a key with no ms-/sk- front, cut the same way: the pieces are joined and
  // asked whether they read as one key (splitKey)
  const split = splitKey(raw)
  if (split) return arg(split.pre) + mask(split.body.replace(/\s+/g, "")) + arg(split.post)
  return argRun(raw)
}

// foldedSpans reads the words that fold (a full-width key, its spaces), and
// nothing else. The readings above have no ASCII to work on for one — it
// carries no path, no front, no lowercase run — so their NFKC copy (case kept,
// which is what the card judges) is read. Two things that reading must not do,
// and both were measured:
//  * it must not mask the value whole. "Key ＡＫＩＡ…ＰＬＥ is invalid, please
//    retry." went out as "KeyＡ…try.": the sentence around a bad key is the
//    user's, and what the tool read has to stay readable around what it hid.
//  * it must not read the whole value through the cut readings. Every word of
//    a page written in full width folds, each became a head with a scan behind
//    it, and 25 KB of them took seconds (the reading is quadratic in the
//    words); the cost has to be paid per span, not per page.
// A span is a run of words joined by spaces or wide spaces, none of them prose
// (a key is split by spaces, never by the words of a sentence), and it has to
// fold to something a key could be: a key's front and its body, or a run long
// enough and shaped like key material. The span as typed is masked, and the
// text around it goes through the ordinary readings.
const FOLDABLE = /[^\x00-\x7f]/
const foldedSpans = (raw) => {
  // the reading masks the words that fold, and only a character outside ASCII
  // (a full-width one) folds: a value with none has no span to read, and the
  // word walk below is not built for it (every ASCII value is this case).
  if (!FOLDABLE.test(raw)) return ""
  const parts = []
  let at = 0
  let hit = false
  const words = []
  for (const m of raw.matchAll(/[^\s]+/g)) words.push({ text: m[0], at: m.index })
  // a full-width word folds; the wide space between two of them is a cut, not
  // a sentence's space, and joins them ("ＡＫＩＡ… ＯＤＮＮ…" is one key)
  const folds = (w) => FOLDABLE.test(w) && w.normalize("NFKC") !== w
  // a key is shorter than 96 characters and a page of them is not a value a
  // person typed: the span stops there, and at 128 spans, so the whole reading
  // is linear in the value (a Chinese paragraph whose every word carries a
  // full-width comma folds word by word, and one span over all of it was the
  // quadratic reading this replaced)
  const MAX_SPAN = 96
  // a word of key material after the folded span continues the key: a
  // full-width front ("ＡＫＩＡＩＯＳＦ") with its ASCII body ("ODNN7EXAMPLE") is
  // one key cut by the copy, and the body does not fold, so the fold-only span
  // stopped at the front and the body reached the terminal. Joining is gated by
  // the same keyish test below, and a word that starts with a lowercase letter
  // is the sentence's ("… ODNN7EXAMPLE is invalid"), not the key's, so a
  // sentence's words are never taken.
  // a full-width copy cuts a key with a punctuation mark as often as with a
  // space ("ＬｍＮｏ、２４６８"), and the mark is the display's: a gap of one to
  // three of them joins as a space does. A CJK word never passes keyishW, so a
  // sentence's marks do not make a span (the marks are the cell readings' own
  // set plus the middot)
  const MARKGAP = /[\u00b7\u2022\u2219\u2027\u30fb\u22c5,\u3001\u3002\uff5c|;\uff1a\uff0c\uff1b\u2014\u2013\u200b\u200c\u2060\ufeff]/
  const isCutGap = (g) => /^[ \t\r\n\u00a0\u3000]+$/.test(g) || (g.length <= 3 && /^[\u00b7\u2022\u2219\u2027\u30fb\u22c5,\u3001\u3002\uff5c|;\uff1a\uff0c\uff1b\u2014\u2013\u200b\u200c\u2060\ufeff]+$/.test(g))
  const keyMat = (t) => KEYCHARS.test(t) && (/\d/.test(t) || /[A-Z]/.test(t)) && !(PROSE.test(t) && !/^[A-Z]+$/.test(t) && !keyedBody(t))
  // a word a display cut every few cells with a middot is the key's too (its
  // cells are key material and the marks are the display's), and the whole
  // span is masked as one: the folded front alone and the tail alone printed
  // "…ＩｊＫｌ 9012…" — eight contiguous body characters at the seam.
  const CELL_SPLIT = /[\u00b7\u2022\u2219\u2027\u30fb\u22c5,\u3001\u3002\uff5c|;\uff1a\uff0c\uff1b\u2014\u2013\u200b\u200c\u2060\ufeff]+/
  const cells = (t) => t.split(CELL_SPLIT).every((cell) => keyMat(cell))
  // a word cut by marks ends up in one word of the copy ("XyZa\u30014725\u3001BcDe"): its
  // cells are judged as the walk judges a word, digit or capital, since a cell
  // of four letters is a group of a cut key as often as a word
  const cellsW = (t) => t.split(CELL_SPLIT).every((cell) => KEYCHARS.test(cell) && (/\d/.test(cell) || /[A-Z]/.test(cell)))
  const contMat = (t) => keyMat(t) || ((/[\u00b7\u2022\u2219\u2027\u30fb\u22c5,\u3001\u3002\uff5c|;\uff1a\uff0c\uff1b\u2014\u2013]/.test(t)) && (cells(t) || cellsW(t)))
  // a word shaped like key material but prose to keyMat ("TuVw", "LmNo") is a
  // group of a cut key as often as a word: the walk below reads on over it
  // until a reading takes the span, and a word of plain prose ("is", "invalid")
  // does not clear the digit-or-capital floor at all
  const keyishW = (t) => KEYCHARS.test(t) && (/\d/.test(t) || /[A-Z]/.test(t))
  const endAt = (w) => w.at + w.text.length
  let spans = 0
  for (let i = 0; i < words.length && spans < 128; i += 1) {
    if (!folds(words[i].text)) continue
    let j = i
    while (j + 1 < words.length && folds(words[j + 1].text) && endAt(words[j + 1]) - words[i].at <= MAX_SPAN) j += 1
    const keyishOf = (k) => {
      const folded = raw.slice(words[i].at, endAt(words[k])).normalize("NFKC")
      return joinedKey(folded.toLowerCase()) || (folded.length >= 12 && /\d/.test(folded) && argRun(folded) !== folded)
    }
    // read on over the key-material words that follow the folded front (a cut
    // is a space or a wide space), and take the longest join that reads as a
    // key; the fold-only span is the floor. The cut readings need a whole key
    // to answer (argRun finds "…M s - LmNo 2468 PqRs 1357 TuVw…" only at the
    // ninth word), so until the join reads as a key the walk goes on over the
    // key material: stopping at the first word the readings do not take left
    // "x=ｍｓ－ＬｍＮｏ ２４６８ ＰｑＲｓ 1357 ＴｕＶｗ…" eight body characters in the clear
    let readsKey = false
    for (let k = j + 1; k < words.length && k - i <= 48 && endAt(words[k]) - words[i].at <= MAX_SPAN; k += 1) {
      if (!isCutGap(raw.slice(endAt(words[k - 1]), words[k].at))) break
      const w = words[k].text
      // a key-material word the join reads as a key through ("TuVw" after
      // "1357") is the key's even when it is prose on its own; a word of the
      // sentence is neither key material nor the key's, and ends the span
      if ((contMat(w) || keyishW(w)) && keyishOf(k)) {
        j = k
        readsKey = true
        continue
      }
      if (!(readsKey ? keyishW(w) : contMat(w))) break
    }
    // the same reading backward: an ASCII key front ("ms-a") with a full-width
    // body is one key too, and the front does not fold. A front of a vendor's
    // shape ("ms-", "sk-") is key material whatever its length.
    const keyFront = (t) => keyMat(t) || VENDOR.test(t) || /^ms-/i.test(t)
    let s0 = i
    for (let k = i - 1; k >= 0 && i - k <= 48 && endAt(words[j]) - words[k].at <= MAX_SPAN; k -= 1) {
      if (!isCutGap(raw.slice(endAt(words[k]), words[k + 1].at)) || !keyFront(words[k].text)) break
      const folded = raw.slice(words[k].at, endAt(words[j])).normalize("NFKC")
      if (!(joinedKey(folded.toLowerCase()) || (folded.length >= 12 && /\d/.test(folded) && argRun(folded) !== folded))) break
      s0 = k
    }
    const start = words[s0].at
    const stop = endAt(words[j])
    const text = raw.slice(start, stop)
    const folded = text.normalize("NFKC")
    // the joined copy is the key the fold makes: the whole-value judgement
    // (a front and its body across the pieces), or the cut readings on the
    // span alone (a full-width vendor key: sk-ant-… is a word of its own)
    const keyish = joinedKey(folded.toLowerCase()) || (folded.length >= 12 && /\d/.test(folded) && argRun(folded) !== folded)
    if (keyish) {
      parts.push(raw.slice(at, start), mask(text.replace(/\s+/g, "").trim()))
      at = stop
      hit = true
      spans += 1
    }
    i = j
  }
  if (!hit) return ""
  parts.push(raw.slice(at))
  return parts.map((p) => (p.includes("…") ? p : argRun(p))).join("")
}

// markCut reads a key cut by punctuation: a comma, an ideographic comma, a
// bar, a full-width stop or colon, a semicolon, a dash, or a joiner a copy
// left between the pieces. The card reads these (maskSep) and the terminal did
// not — splitKey's walk joins across spaces, middots and slashes only, so a
// digest or a UUID written one group per cell was one piece to it and each
// group a quarter of a key: measured, all 32 characters of
// "0123,4567,89ab,cdef,…" went out on the terminal while the card masked it.
//
// The stretch is the key's alphabet and the marks; its marks are taken out and
// the join is asked the card's own question — a body with no front has to read
// as a key on its own, and the 20-character floor keeps a sentence's comma
// from joining two ordinary words into one. runs = false: a join was never one
// word, and the vowel-less arm would read a list of numerals as a key.
// (the hyphen and the ASCII colon are the key alphabet, not a cell's
// separator: a mark's set holding them made "key=ms-aaaa-…" one stretch and
// took the variable's own name into the mask)
const MARK_CUT = /[,、。｜|;：，；—–​‍⁠﻿]+/
const MARK_CUT_ALL = new RegExp(MARK_CUT.source, "g")
const MARK_STRETCH = /[A-Za-z0-9+/=_.:-]|[,、。｜|;：，；—–​‍⁠﻿]/
function markCut(s) {
  if (!MARK_CUT.test(s)) return s
  const chars = [...s]
  let out = ""
  let at = 0
  let k = 0
  while (k < chars.length) {
    if (!/[A-Za-z0-9]/.test(chars[k])) {
      k += 1
      continue
    }
    let end = k
    while (end < chars.length && MARK_STRETCH.test(chars[end])) end += 1
    const piece = chars.slice(k, end).join("")
    // a stretch carrying no mark is the word passes' business
    if (!MARK_CUT.test(piece)) {
      k = end
      continue
    }
    const flat = piece.replace(MARK_CUT_ALL, "")
    const led = /^ms-/i.test(flat) && flat.length > 12 && /\d/.test(flat) && isKey(flat, false)
    const bare = flat.length >= 20 && isKey(flat, false)
    if (led || bare) out += s.slice(at, k) + mask(flat)
    else out += s.slice(at, end)
    at = end
    k = end
  }
  return out + s.slice(at)
}

// cellCut reads a key cut into short cells by plain whitespace or a bar: a
// digest or a UUID written one group per cell, with four spaces, a tab or
// " | " between them. splitKey's walk takes a gap of one to three characters
// and returns on any control character at all (a tab is one), and maskCut's
// run walk takes at most two — the same 32 characters went out whole on the
// terminal. The card reads this shape (maskCells); this is its copy here.
const CELLCH = /[A-Za-z0-9+/=_-]/
const CELL_GAP = /[ \t 　|]+/
// a cell of letters that capitalises more than once is a group of a key as
// often as a word ("EfGh", "LmNo", "AbCd"); a word capitalises once
// ("Qwen"), and an all-capitals piece is the caps reading's own
const CELL_CASEY = (c) => /^[A-Za-z+/=_.-]+$/.test(c) && /[a-z]/.test(c) && (c.match(/[A-Z]/g) ?? []).length >= 2 && (c.match(/[a-z]/g) ?? []).length >= 2
const CELL_FRONT = /^(?:ms-|sk-|sk_|gh[pousr]_|xox[abposr]-|akia|asia|aida|aliyun|ssh-rsa)/i
const CELL_OK = (c, first = false) => c.length <= 8 ? (/^[0-9a-fA-F]+$/.test(c) || (/\d/.test(c) && /^[A-Za-z0-9+/=_]+$/.test(c)) || CELL_CASEY(c) || (first && (CELL_FRONT.test(c) || VENDOR.test(c)))) : first && c.length <= 24 && (CELL_FRONT.test(c) || VENDOR.test(c)) && /^[A-Za-z0-9+/=_.-]+$/.test(c)
function cellCut(s) {
  if (s.length < 20 || !CELL_GAP.test(s)) return s
  const chars = [...s]
  let out = ""
  let at = 0
  let k = 0
  // the end of the key-material run a position sits in: a run end found
  // before is the end for every later position inside it, so the walk does not
  // rescan the rest of a long word at each of its characters
  let cellEnd = 0
  while (k < chars.length) {
    if (!CELLCH.test(chars[k])) {
      k += 1
      continue
    }
    // the run begins at a cell that is key material and ends at the first cell
    // that is not: the word in front of the cells ("error:") and the word
    // after them ("for") are stepped over, as maskCells steps over them
    // a run that began inside a key cut into words ("ms -f or ei gn -012 …")
    // masks a suffix of it, and a mask is opaque to the reading that owns the
    // whole cut. A cell the text glued to the run before it, or one that
    // follows a word with the key's own front cut off, is inside one; a cell
    // behind the text's own punctuation ("error: 5f3a…") or led by the key's
    // own front is not.
    // a key material run's cells are eight characters at most and its first
    // cell 24, so the head is read to 25 characters only: cutting the whole
    // run's slice once per character of a 40 KB one made the walk square (a
    // 40 KB body took 25-90 s against 0.3 s measured before the cells came)
    if (k > 0 && CELLCH.test(chars[k - 1]) && !/[=:([{"'`]/.test(chars[k - 1])) {
      k += 1
      continue
    }
    // the end of the run is the same from every position inside it: a count
    // in the loop keeps the walk linear
    let c0 = k < cellEnd ? cellEnd : k
    while (c0 < chars.length && CELLCH.test(chars[c0])) c0 += 1
    if (c0 > cellEnd) cellEnd = c0
    const head = chars.slice(k, Math.min(c0, k + 25)).join("")
    let b = k
    while (b > 0 && CELL_GAP.test(chars[b - 1])) b -= 1
    if (b > 0 && /[A-Za-z0-9]/.test(chars[b - 1]) && !CELL_FRONT.test(head)) {
      k += 1
      continue
    }
    if (!CELL_OK(head, true)) {
      k = c0
      continue
    }
    const cells = []
    let p = k
    for (;;) {
      let q = p
      while (q < chars.length && CELLCH.test(chars[q])) q += 1
      const cell = chars.slice(p, q).join("")
      // a key cut one character at a time ("x=ms-A bCd1234E f Gh5678Ij …")
      // has cells of one or two letters between the longer ones: inside a run
      // that already carries twelve characters of key material they are the
      // key's. A sentence's short word ("is a") needs no key in front of it
      // and the run began at a cell that had to be key material. The run
      // stops at the length a key can be, so a page of one-character words is
      // read once, not to its end (measured: 32 KiB of "0 " took 1.8 s when
      // the walk ran to the last cell)
      if (!cell || !CELL_OK(cell, cells.length === 0)) break
      cells.push(cell)
      let g = q
      while (g < chars.length && CELL_GAP.test(chars[g])) g += 1
      if (g === q) {
        p = q
        break
      }
      p = g
    }
    const stop = p
    const flat = cells.join("")
    if (cells.length >= 4 && cells.length <= 24 && flat.length >= 20 && flat.length <= 96 && isKey(flat, false)) {
      // the gap the cells were cut with stays outside the mask, as the card's
      // reading keeps it
      let e = stop
      while (e > k && CELL_GAP.test(chars[e - 1])) e -= 1
      out += s.slice(at, k) + mask(flat) + chars.slice(e, stop).join("")
      at = stop
    }
    k = stop > k ? stop : c0
  }
  return out + s.slice(at)
}

// argRun is the whitespace routes of one value, tried until none finds more
// ("ghp_ 1234 AbCd 5678…" is one body only from 1234 on, and the front is
// part of a key-shaped piece by then): a run of words; a line break (or a
// wide space a full-width copy left) between two words; then the per-word
// judgement. Each route masks strictly more, so the walk ends.
function argRun(text) {
  // a body of many KiB of one-character words (a pretty-printed page) costs
  // far more reading than the masking is worth here: past 32 KiB the cut
  // reading is skipped and the per-word pass (linear) still runs. arg() hands
  // this function at most one chunk (see CHUNK above), so the skip is reached
  // only by a chunk-sized body, never by a whole page.
  if (text.length > 32 * 1024) return argWords(text)
  let s = text
  // The readings the body has are applied together, until none finds
  // anything: the whitespace routes (maskCut, and capsRun for a vendor key
  // written without its spaces, "AKIAIOSF ODNN7EXA MPLE") each mask what they
  // join, markCut reads a key whose groups were cut by punctuation, cellCut a
  // key whose cells were cut by four spaces, a tab or a bar, and argWords then
  // judges every word the joins did not take. One pass of each per round, so a
  // round over ordinary text is a couple of scans, not a dozen.
  for (let n = 0; n < 4; n += 1) {
    const next = argWords(maskCut(capsRun(cellCut(markCut(s)))))
    if (next === s) break
    s = next
  }
  return s
}

// frameSpan is the key's own span of a word a frame was written round:
// "(ghp_…)" is the key and two brackets, not a key of the brackets' making.
// The mask spends four characters at each end on the key's own characters, so
// the frame has to stay outside it. Only punctuation is a frame here: a word
// in front of the bracket ("x(ghp_…") is the text's, and its own reading
// already masks the key it carries. A path is no frame either.
const frameSpan = (w) => {
  if (/[\\/]/.test(w)) return null
  let a = 0
  while (a < w.length && !/[A-Za-z0-9]/.test(w[a])) a += 1
  let b = w.length
  while (b > a && !/[A-Za-z0-9]/.test(w[b - 1])) b -= 1
  if (a === 0 && b === w.length) return null
  const body = w.slice(a, b)
  return body ? { lead: w.slice(0, a), body, tail: w.slice(b) } : null
}

// joinFramed reads a value cut by a space: "key=AKIAI OSFODNN7EXAMPLE",
// '{"token":"wJalr…/bPx RfiCY…"}', and the bare "wJalr…/bPx RfiCY…". Each
// half is under every floor on its own, and splitKey sets a framed piece aside
// whole (it is the frame's, not the key's), so both went out as written —
// measured: 15 characters of an AWS secret, 34 of a UUID. The run starts where
// the value does (after the frame's last punctuation, or at the word's first
// character when there is no frame), and each following word is joined while
// it is key material. The longest join that reads as a key is the one masked:
// masking the first prefix that read as a key left the rest of an AWS secret
// ("wJalr…K7MDENG") on the terminal. A head that already reads as a key on its
// own is left to the passes that own it, so a truncated key beside a separate
// word keeps the reading it had.
const FRAME_AT = /[=:([{,"'`<>]/
const KEYCH = /^[A-Za-z0-9+/=_.-]+$/
const STEM = /[^A-Za-z0-9+/=_.-]+$/
function joinFramed(s) {
  // the walk is linear (a head reads at most eight words on) and its only
  // allocation per word is the joined head, so the same 32 KiB bound the other
  // whole-text readings use applies here: an 8 KiB one left a cut key on a
  // 32 KiB line to the per-word pass, which has neither half's join.
  if (s.length > 32 * 1024) return s
  // (an ellipsis is one word's, not the line's: giving the whole value up
  // because it carried a mask anywhere left an AWS secret cut by a space on
  // the terminal — "token=wJalr…bPxRfi CYEXAMPLEKEY …" printed eight
  // characters of its front. A word carrying one is skipped below: its
  // ellipsis stands where key material was, and a join across it rebuilds a
  // "key" out of the mask and the text round it)
  const words = []
  for (const m of s.matchAll(PIECE)) words.push({ text: m[0], at: m.index })
  if (words.length < 2) return s
  for (let i = 0; i < words.length - 1; i += 1) {
    const t0 = words[i].text
    let cut = -1
    for (let j = 0; j < t0.length; j += 1) if (FRAME_AT.test(t0[j])) cut = j
    // a vendor front behind a plain mark is where the key starts ("_AKIA
    // IOSFODNN 7EXA MPLE"): the word's own leading mark is not a frame, and a
    // walk that began at the first word key material on its own began one word
    // late — the head printed as written beside the body's mask (measured,
    // eight body characters; the card and the host's log line did the same)
    // ...and the same for a front a letter or two into the word ("xAKIA
    // IOSFODNN7EXAMPLE", "ask-ant-…"): a word does not carry a front inside
    // it, and reading the body behind one alone kept the front's first
    // characters in the clear
    const lead = cut < 0 ? (() => {
      const m = VENDOR_SPAN.exec(t0)
      VENDOR_SPAN.lastIndex = 0
      return m && m.index > 0 && /^[A-Za-z_\-.]{1,3}$/.test(t0.slice(0, m.index)) ? m.index : 0
    })() : 0
    const head = t0.slice((cut >= 0 ? cut : lead - 1) + 1)
    if (!head || !KEYCH.test(head)) continue
    // a value a frame names is read from after the frame. With no frame the
    // head has to look like the start of a key and not like a folder or a word:
    // a vendor front ("AKIAI OSFODNN7EXAMPLE"), or a body that is neither
    // path-led nor a capitalised/lower-case word ("wJalrXUtnFEMI/K7MDENG/bPx
    // RfiCY…"). A head like "Users", "Documents", "report" or "/Users" is a
    // folder with a space in its name, which the README says must keep its
    // shape.
    // with no frame the head must read as the start of a key: a vendor front,
    // or a body of some length that carries a capital after its first letter
    // ("wJalrXUtnFEMI"). A path segment ("q19jry150l16…") and a word
    // ("Documents") do not, and a value starting like a path is a folder.
    if (cut < 0 && !fronted(head)) {
      if (PATHY.test(head) || /^[\\/]/.test(head)) continue
      if (head.length < 8 || !/[A-Z]/.test(head.slice(1))) continue
      // a segment inside a path is a folder's name, not a key's start: joining
      // it took /var/folders/…/msmoli-two-line-XXXX/ghs_… into one mask
      const before = words[i].at > 0 ? s[words[i].at - 1] : ""
      if (before === "/" || before === "\\") continue
    }
    // a head that is a key already is the passes' own business — unless the
    // words after it are pieces of itself. The walk below stops before a word
    // that is a key on its own, so a head that reads as one and is followed by
    // body material ("x=AKIAAbCd1234  EfGh5678  IjKl9012 …") is still joined,
    // and one followed by a separate key is left alone there. Measured, a head
    // this line skipped while the pieces after it were masked left eight
    // contiguous body characters in the clear ("x=ghp_LmNo24 68Pq Rs1357Tu…"
    // printed "68Pq" as written beside a mask); a short truncated key beside a
    // whole one was read as the whole one's first half
    // ("(ghp_Abcd1234Ef gh5678Ijkl…)" lost the first key's own four ends).
    // the same for the whole piece: a "=" inside a key's body is the key's own
    // ("--token=F5cYjKRtCxkl=K9m1+/lBV8ZjCPs6the", "NickName=[AKIAiXYDw=v/…"),
    // and reading from behind it masked the tail only and then left the front
    // as written — the per-word pass owns the word whole. Only a word with a
    // frame inside it is that case: with no frame the head IS the word, and
    // the walk below decides whether the words after it are the same key
    // ...but a front-led head goes to the walk below even when it reads as key
    // material already: a key cut right after its frame's front
    // ("token=ghp_AbCd1234  EfGh…") is one key, and skipping it here left the
    // seam's eight characters in the clear.
    if (cut >= 0 && isKey(t0) && !fronted(head)) continue
    // and a frame with key material in front of it is not that value's frame:
    // eight characters of it is longer than any word a name is, and a short
    // head behind it is the key's own next character, not a new value's start.
    // The key runs from behind the frame's punctuation, which may itself sit
    // between the key's halves ("NickName=[AKIAiXYDw=v/tSw…"), through its own
    // "=" — so the per-word pass gets the word whole, and a join from here
    // would cut the key in two
    // ...and the "=" has to be a frame's, not a value's: key material in front
    // of it alone is a variable's name too ("SESSIONID=AKIAI OSFODNN7EXAMPLE",
    // "MY_AWS_KEY_ID=…"), and reading that as one value stopped a cut key from
    // being joined — the whole id went out as written. A frame character
    // somewhere in front of the "=" ("--token=", "NickName=[") is what makes it
    // a value's own.
    if (cut >= 0 && head.length < 8) {
      const front = t0.slice(0, cut)
      const tail = (front.match(/[A-Za-z0-9+/=_.-]+$/) ?? [""])[0]
      if (tail.length >= 8 && /[=:([{"'`<>]/.test(front)) {
        const q = Math.max(front.lastIndexOf("["), front.lastIndexOf("("), front.lastIndexOf("{"))
        const from = q >= 0 ? q + 1 : front.length - tail.length
        const whole = t0.slice(from).replace(/[^A-Za-z0-9]+$/, "")
        if (from < cut && /[A-Za-z0-9]/.test(t0[from]) && whole.length >= 12 && /\d/.test(whole) && isKey(whole, false)) {
          return s.slice(0, words[i].at + from) + mask(whole) + s.slice(words[i].at + from + whole.length)
        }
        continue
      }
    }
    let joined = head
    let best = ""
    let bestEnd = 0
    // the cells a key is cut into can be ten ("5f3a 9c1e … 5a91"), and a head
    // that read eight of them masked the first eight and left the ninth as
    // written: "x=5f3a…c7d3 5a91" is eight contiguous body characters across
    // the mask's own tail. The cap is the length a key can be, as the other
    // readings have it, and the word count is only a second bound — a word a
    // cut leaves is one character, so a key cut one character at a time is as
    // many words as it is long ("x=ghp_A b C d 1 2 3 4 …" stopped at the
    // twenty-fourth and printed the rest as written, measured)
    for (let k = i + 1; k < words.length && k - i <= 96 && joined.length <= 96; k += 1) {
      const gap = s.slice(words[k - 1].at + words[k - 1].text.length, words[k].at)
      if (!/^[ \t\r\n\u00a0\u3000/]{1,3}$/.test(gap)) break
      const stem = words[k].text.replace(STEM, "")
      if (!stem || !KEYCH.test(stem)) break
      // a word that opens its own front, or that is a key on its own, is a
      // second key and not the first one's body: joining them hid both ends
      // behind one mask ("ms-aaaa…5555 ms-zzzz…5555" became one), and a
      // truncated key beside a whole one lost its own four ends (splitKey's
      // walk breaks at a front for the same reason)
      // (a whole key behind a frame is 40 characters for the ghp_/sk_/ms-
      // shapes and 20 for an AKIA id, but the length was a guess at where one
      // value ends: "token=<28-char ghp_ head> AbCd12+EfGh3" came out as two
      // masks with eight contiguous characters at the seam. A front-led head
      // is a key's own beginning at any length, and a key-shaped word after it
      // is its body; only a word that opens a front of its own is a second
      // value)
      // ...and a key-shaped word after a bare head is joined too: two
      // key-shaped halves of one cut key ("AbCd1234EfGh5678 IjKl9012MnOp3456")
      // were masked apart, and the seam kept "5678ijkl"; joining is the safe
      // direction, and a word with a front of its own is still the break that
      // keeps "ms-a…5555 ms-z…5555" two masks
      if (fronted(stem)) break
      // a word of prose ends the run: a value's body carries a digit or a
      // capital, a sentence's next word does not — unless the word is a piece
      // of a key cut into groups and the join so far already reads as one
      // ("ms-0123456 789abcd ef01234 56789ab cdef" stopped at "cdef" and left
      // the key's last four on the terminal, measured)
      // (the piece rule holds before the join reads as a key too: "x=ghp_A
      // bCd1234E f Gh5678Ij …" stopped at "f" while the join was under the
      // floor, and the masked tail printed beside the head was fourteen
      // contiguous body characters. A word that opens a phrase and no key
      // ("for provider", "is a") has no key-shaped word after it either)
      if (!/[0-9]/.test(stem) && !/[A-Z]/.test(stem) && stem.length < 12 && !(keyPiecey(stem) || nextPiecey(words[k + 1]?.text))) break
      joined += stem
      if (joined.length >= 12 && /[0-9]/.test(joined) && isKey(joined, false)) {
        best = joined
        bestEnd = words[k].at + stem.length
      }
    }
    if (best) {
      const startAt = words[i].at + (cut >= 0 ? cut : lead - 1) + 1
      return s.slice(0, startAt) + mask(best) + s.slice(bestEnd)
    }
  }
  return s
}

// argWords is the per-word judgement: one word key-shaped is masked whole,
// and inside a word that is not, its key-like runs and UUIDs are masked. The
// word in the other spellings a key is printed in — full-width characters,
// mostly — is judged by its folded copy and masked as written.
// a word that is one of this tool's own masks — four characters, the
// ellipsis, one to four more, and the frame's punctuation around them — is
// not a word to judge: its tail can read as a numeral beside capitals
// ("AKIA…H98" is an upper-cased vendor word to isKey), and masking it again
// printed a length instead of the ends the first mask kept
const OUR_MASK = /^[^A-Za-z0-9]*[A-Za-z0-9]{4}…[A-Za-z0-9]{1,4}[^A-Za-z0-9]*$/
const argWords = (x) =>
  show(x).replace(/[^\s]+/g, (w) => {
    if (OUR_MASK.test(w)) return w
    const f = w.normalize("NFKC").toLowerCase()
    // the word as written and its fold. The capitals need no third call: a
    // word that is already all capitals is judged whole by isKey (its slashed
    // arm), and upper-casing a lower-case word to ask the question would read
    // every long provider id with a date in it as a key (modelscope20261031)
    // (what is masked is the key's own span: a word quoted in a frame —
    // "(ghp_…)", "[ghp_…]", '"ghp_…"' — is judged whole, and masking the whole
    // word gave the frame's punctuation the two characters the mask spends on
    // the key's own ends: "(ghp_…Qrst)" printed "(ghp…rst)")
    const inFrame = frameSpan(w)
    // NAME=value: an identifier on the left of "=" or ":" and a key on the
    // right is the variable and its value, and only the value is the secret.
    // Judged before the whole word, because isKey reads "token=ghp_…" as one
    // key (its compact is 20+ and alternates) and masked the variable's name
    // too: a short "token=ghp_Abcd1234Ef" kept its name and a long one did
    // not, so the same shape went out two ways. The left side has to read as a
    // name (letters, digits, underscores, two or more letters) so "retry=true"
    // and "code=ENOENT" are left alone, and the value is still a key on its own.
    const eq = Math.max(w.indexOf("="), w.indexOf(":"))
    // the left of the "=" has to be a name, not the key's own first half: a
    // generated body is letters and digits too ("ghp_BjG8b9JVqbhuYqvQ=…",
    // "t9u5Rf7OkgBfsAWbncAefz0n1zsOHrH=…"), and masking only what follows
    // left the front of the key on the terminal
    const left = eq > 0 ? w.slice(0, eq) : ""
    // ...and a half of a key is key material, not a name: the ":" has to have
    // two pieces of the key alphabet on both sides of it — the left one is
    // where the key's run began, and the right one is key material long enough
    // to be a key's own — and the value may carry no frame in it. A generated
    // key written "head:body" ("ZlibmV9ovZJYMm:pT3b7KKnQw2glZ443XcrFnhPYi")
    // is one key, and masking the right half alone left 14 characters as
    // written. A variable's name is a word, and its value is the key; a name in
    // front keeps its name ("token=ghp_…", "key=ms-…"), and a name or a frame
    // in the value ("Authorization: Bearer xoxb-…", "token: xoxb-…") is the
    // value's own business, not a half of anything.
    const valueAt = eq + 1
    // a doubled "=" ("key==<body>") is the frame's too
    const rawValue = w.slice(valueAt).replace(/^=+/, "")
    const value = rawValue
    // a value of capitalised words behind a field that names no credential is
    // a method or a class name, and the run reading below would mask it
    if (eq > 0 && !CRED_NAME.test(left) && wordyCamel(value)) return w
    if (
      eq > 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(left) &&
      (left.match(/[A-Za-z]/g) ?? []).length >= 2 &&
      !VENDOR.test(left) &&
      !keyRun(left) &&
      !isKey(left, false) &&
      !(w[eq] === ":" && (/^[A-Za-z0-9]{12,}$/.test(value) || /^[A-Za-z]+\s+[A-Za-z]+[-_]/.test(value)))
    ) {
      if (!value.includes("…") && isKey(value)) {
        const at = w.indexOf(value, valueAt)
        return `${w.slice(0, at)}${mask(value)}${w.slice(at + value.length)}`
      }
      // a bracketed value frames its key and isKey cannot read through the
      // brackets: "NickName=[<key>]" went out whole while a bare "[<key>]" was
      // masked. Only the inner span is masked, and only when the value as
      // written is not itself a key (an "=" inside the key is the key's own,
      // "NickName=[AKIAiXYDw=v/tSw…]", and the vendor span below owns that).
      const inner = value.replace(/^[\[(\{"'`]+/, "").replace(/[\])}»”’]+$/, "")
      if (!value.includes("…") && inner !== value && !isKey(value) && !inner.includes("…") && isKey(inner)) {
        const at = w.indexOf(inner, valueAt)
        return `${w.slice(0, at)}${mask(inner)}${w.slice(at + inner.length)}`
      }
      // a quote or a full stop round the value is the text's, and isKey saw it:
      // "key=\"<body>\"" and "key=<body>." went out whole while the same body
      // behind "=" with nothing after it was masked. The key is the value's
      // leading key-alphabet run, and only that run is masked — the quote or
      // the full stop stays. (The bracket arm above is not enough: its tail set
      // has no quote in it, and a trailing "." is not a bracket at all.)
      const bounded = rawValue.replace(/^[\[(\{"'`]+/, "").match(/^[A-Za-z0-9_+\/=.-]*/)[0].replace(/[^A-Za-z0-9]+$/, "")
      if (!rawValue.includes("…") && bounded !== value && bounded.length >= 12 && !isKey(rawValue) && isKey(bounded)) {
        const at = w.indexOf(bounded, valueAt)
        return `${w.slice(0, at)}${mask(bounded)}${w.slice(at + bounded.length)}`
      }
    }
    // the word as written and its lowercase fold; a full-width key with no
    // ASCII at all is the whole-value NFKC reading's business (above), which
    // sees it as one value rather than word by word
    if (isKey(w) || isKey(f)) return inFrame ? inFrame.lead + mask(inFrame.body) + inFrame.tail : mask(w)
    // the frame's own punctuation is not key material, and judging the word
    // with it still on failed a key quoted in brackets: "(5gli9zadx8zg9jez)"
    // went out whole — the parentheses are characters isKey's run never reads,
    // and the word without them is a key
    if (inFrame && isKey(inFrame.body)) return inFrame.lead + mask(inFrame.body) + inFrame.tail
    // a value behind a flag or a frame ("--bad=SK-ANT-…", "NickName=[ghp_…")
    // is judged by what the frame encloses
    const kAt = w.search(/[A-Za-z]/)
    if (kAt > 0 && !/[\\/]/.test(w.slice(0, kAt)) && isKey(w.slice(kAt))) return inFrame ? inFrame.lead + mask(inFrame.body) + inFrame.tail : mask(w)
    // a key behind a flag or a header ("token=ghp_…", "Authorization: ghp_…")
    // is judged by what follows the separator: it names a vendor, and a value
    // that short is under every run floor, so nothing else here would read it
    const sep = Math.max(w.lastIndexOf("="), w.lastIndexOf(":"))
    if (sep > 0 && sep < w.length - 1) {
      const value = w.slice(sep + 1)
      if (!value.includes("…") && VENDOR.test(value) && isKey(value)) return `${w.slice(0, sep + 1)}${mask(value)}`
    }
    // a vendor key sits in a word that also carries a URL or a path: "the
    // token at https://h/v1?token=xoxb-…&x=1" is one word to this pass, and
    // marking only the 16+ runs left the front and the 12-13 digit id groups
    // as written (36 characters of an xoxb token reached the terminal). The
    // key's own span starts at the vendor front and runs over key characters:
    // it is masked whole when it is long enough to be a key, and the word keeps
    // its shape around it, as a path keeps the folder.
    // a path keeps its shape (README, and the /tmp/ghp_16C7… case): a value
    // that starts like a path, or whose slashes cut it into path segments, is
    // left to the run reading. Only a word that is not path-shaped reaches here
    // a URL is not a folder: "https://h/v1?token=xoxb-…" and
    // "https://h/keys/xoxb-…/info" carry a scheme, a query or a fragment, and
    // their key segment is a value, not a folder the user meant to see
    const urlShaped = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(w) || /[?#]/.test(w)
    const pathShaped = !urlShaped && /[\\/]/.test(w) && (PATHY.test(w) || w.split(/[\\/]/).filter((seg) => seg.length >= 4).length >= 3)
    // a path keeps its shape (README, and the /tmp/ghp_16C7… case): only a
    // vendor front that starts its own path segment and carries four letters
    // of its own is read there — its own letters plus the four the mask keeps
    // already make eight after folding ("glpat-AbCd…" folds to "glpatabcd"),
    // so the folder reading the README promises stays for the short fronts
    // ("ghp_16C7…"); a segment at the end of a longer path is still a value
    const shortFront = (span) => span.split(/[-_.\/]/)[0].replace(/[^\p{L}\p{N}]/gu, "").length < 4
    const vendorSpans = [...w.matchAll(VENDOR_SPAN)].filter((m) => {
      if (pathShaped) {
        const atSeg = m.index === 0 || /[\\/]/.test(w[m.index - 1])
        if (!atSeg || shortFront(m[0])) return false
      }
      const span = m[0]
      const c = span.replace(/[^\p{L}\p{N}]/gu, "")
      // a vendor key's body is long enough to be a key, not a word. It used to
      // also ask for a digit or a capital, which left an all-lower-case token
      // ("ghp_abc…") as written. Length alone would mask a hyphenated name
      // ("sk-anti-fraud-review-team"), so at least one piece of the body has
      // to be a single unbroken run of 16+ — a key's length is in one piece,
      // a name's is in words.
      if (c.length < 12) return false
      const body = span.slice(span.search(/[-_]/) + 1)
      // a piece of 16+ is the plain case ("ghp_abcdefghijklmnopqrstuvwx");
      // a key whose body is several pieces of 8+ ("sk-ant-api03-…_kbwt") is
      // still no name if the pieces are all key material and the whole body
      // is 20+. A name's pieces are words of prose ("anti-fraud-review-team").
      const pieces = body.split(/[-_.\/\u00b7\u2022\u2219\u2027\u30fb\u22c5]/).filter(Boolean)
      // a single piece of 12+ that carries a digit and both cases is a key's
      // head cut by a space ("ghp_Abcd1234Efgh567 8Ijk…"): a word of prose has
      // no digit, or is all one case.
      // a body cut by its own slashes is one key once they are out
      // ("AKIAABCDEFGH/RgjNpwI" is 19 characters without the slash, and a
      // key): a name carries no slash inside it, so the reading is only taken
      // for a span that has one, and only when the whole reads as a key
      const slashed = span.includes("/") && pieces.join("").length >= 16 && isKey(pieces.join(""), false)
      return slashed || pieces.some((piece) => piece.length >= 16) ||
        (body.length >= 20 && pieces.length >= 3 && pieces.every((piece) => /^[A-Za-z0-9]+$/.test(piece)) && pieces.some((piece) => /[0-9]/.test(piece))) ||
        (pieces.length === 1 && body.length >= 12 && /[0-9]/.test(body) && /[a-z]/.test(body) && /[A-Z]/.test(body))
    })
    if (vendorSpans.length) {
      let out = ""
      let last = 0
      for (const m of vendorSpans) {
        out += w.slice(last, m.index) + mask(m[0])
        last = m.index + m[0].length
      }
      return out + w.slice(last)
    }
    // no run under keyRun's shortest floor (16) can be a key, and a UUID is 36
    // characters: a word shorter than 16 is returned as it is, and the two
    // replaces are not run over it (most of a child's prose is here).
    const marks = (y) => (y.length < 16 ? y : y.replace(RUN, (r) => (keyRun(r) ? mask(r) : r)).replace(UUID_ANY, (m) => mask(m)))
    const out = marks(w)
    // the folded copy can be key-shaped where the original is not — a token
    // written in full width has no ASCII runs and no ASCII path prefix, so the
    // passes above saw a word of ordinary text. When the folded copy would be
    // masked, the word is masked whole: mapping the mask back onto the
    // original spelling is not something NFKC can promise, and the whole word
    // is what the user typed anyway. A key already masked ("ms-a…5555") is left
    // as it is: it is a short string of letters now, and the token shape no
    // longer matches it — but its mask is not a word to be judged again.
    // a word with no character that folds has f === w, and marks(f) is then
    // marks(w), which is the answer already in hand (out === w): only a word
    // with a fold of its own is asked a second time. tokenShaped needs a
    // literal "-" in the value (m…s…-), which most words carry none of, so the
    // regex and the array it returns are skipped for them. Both are read in
    // the order the question was asked in before: marks(f) first, and the
    // token shape only when it did not answer.
    if (out === w && !w.includes("…") && ((f !== w && marks(f) !== f) || (f.includes("-") && (f.match(tokenShaped) ?? []).some((m) => msKey(m, x.trim() === w))))) return mask(w)
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
// a key that is present but of another type is a hand-edited file or a tool
// that wrote a number: "还没有 key" sends the user to add the key the file
// already has, so the two cases are told apart. The advice is the same.
const keyNote = (p) => {
  if (keyedOf(p)) return mask(p.key)
  return p?.key === undefined || p?.key === null || (typeof p.key === "string" && !p.key.trim()) ? "还没有 key" : "key 不是文本"
}

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
// site is the origin the plugin recorded for the account after its own probe
// ("https://modelscope.ai" for an international one, cleared for a domestic
// one). It is empty when the account has never been probed, and an empty site
// is not evidence of either.
export function pluginAccounts(auth) {
  const obj = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {}
  return Object.entries(obj)
    .filter(([k]) => k === ID || k.startsWith(`${ID}#`))
    .map(([name, v]) => ({
      name,
      token: v?.type === "api" && typeof v.key === "string" ? v.key.trim() : "",
      site: typeof v?.site === "string" ? v.site : "",
    }))
}

// { action: "noop" | "run" | "refuse", lines: string[], cmds: [{ argv, stdin? }] }
export function planToPlugin({ preset, accounts, force }) {
  const lines = []
  // A key field of the wrong type is a source this tool cannot read, not an
  // empty one: SENDABLE.test() would coerce 12345 to "12345" and plan a login
  // with it. Refused here for the same reason planToPreset refuses it.
  // keyRaw is what presetCandidates kept for a non-string field; a caller
  // that hands the raw entry over directly has none, and its `key` still
  // holds the original value.
  const rawKey = "keyRaw" in preset ? preset.keyRaw : preset.key
  if (rawKey !== undefined && typeof rawKey !== "string") {
    lines.push(`✗ 内置预设 ${arg(preset.id)} 的 key 不是字符串（${rawKey === null ? "null" : typeof rawKey}），读不出它现在是什么。`)
    lines.push(`  先修好 providers.json 里那一项（或删掉它），再重跑：magpie provider key ${arg(preset.id)} <key>。`)
    return { action: "refuse", lines, cmds: [] }
  }
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
  // An entry that is there but carries no token the plugin would read (a
  // msmoli entry of the wrong type, or a key that is not a string) is not a
  // missing login: telling the user to log in sends them nowhere, and the
  // `--to-plugin` advice the message below carries refuses the same file. The
  // forward direction already says it this way.
  if (main && !main.token) {
    lines.push(`✗ 插件里 ${arg(main.name)} 的条目读不出令牌（type 不是 api，或 key 不是字符串）。`)
    lines.push(`  magpie 也不会把它算作登录。请先删掉这个条目或重新登录（magpie plugin login ${ID}），再重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
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
  // A key field that is there but is not a string is not an empty slot. keyedOf
  // answers "no key" for any other type, and this direction treats that as a
  // preset with nothing to lose — so {"key": null} was written over without
  // --force, and {"key": 12345} was announced as "现有 key（（不可用））会被整条
  // 替换". Either way the user's replacement decision was skipped or unreadable.
  // Absent and "" are the two spellings of a slot with nothing to lose, and
  // both have a type of "string" (or undefined): the test is the type alone.
  const rawKey = "keyRaw" in preset ? preset.keyRaw : preset.key
  if (rawKey !== undefined && typeof rawKey !== "string") {
    lines.push(`✗ 内置预设 ${arg(preset.id)} 的 key 不是字符串（${rawKey === null ? "null" : typeof rawKey}），读不出它现在是什么。`)
    lines.push(`  请先修好 providers.json 里那一项（或删掉它），再重跑：magpie provider key ${arg(preset.id)} <key>。`)
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
  // An ms- token answers 401 on the site it did not come from, and the plugin
  // records which site an account belongs to after its own probe. The preset
  // this direction writes into chats with api-inference.modelscope.cn only, so
  // an international token there would 401 on every request while this tool
  // said ✓. Measured before the check: `--to-preset --force` wrote it and
  // answered rc=0.
  if (main.site && main.site !== CN_SITE) {
    lines.push(`✗ 插件主账号是国际站（${arg(main.site)}）的令牌，内置预设只对国内站有效，写进去聊天会 401。`)
    lines.push(`  国际站账号请在 magpie 里单独加一个 provider（chat 指向 api-inference.modelscope.ai）。`)
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
export function scrub(out, ...secrets) {
  // the known secrets first: maskEchoes finds a piece of one whatever cut it
  // into and prints it as that key's own mask ("ms-a…5555"), which says more
  // than the shape pass can. Run the other way round, a key echo cut by
  // spaces was already masked as an anonymous run ("aaaa…5555") and the
  // better reading never saw it.
  let s = maskStructured(String(out ?? ""))
  for (const secret of secrets) {
    if (secret) s = maskEchoes(s.split(secret).join(mask(secret)), secret)
  }
  // arg() over the whole text first: its run reading covers a key cut by a
  // line break or by spaces across the child's lines (a wrapped page, a
  // pretty-printed error), which a line at a time cannot see. Then per line,
  // as before: the control-character pass turns "\n" into a space, and both
  // callers split on the line breaks to echo (or quote) the child's answer.
  // a key the child wrapped is one key across the line break: the join is
  // read over the whole text here, before the lines are split. Measured: a UUID
  // cut at a line break went out whole, because each line held a piece under
  // every floor.
  // the folded and framed readings run before splitKey and before maskCut:
  // each reads a key whole up to its own end, and a partial mask written first
  // puts an ellipsis where they would have crossed. Measured, maskCut first:
  // "x=5f3a 9c1e … 5a91" came out "x=5f3a 9c1e…5a91" (eight body characters
  // beside the key's own mask); splitKey first: the same, its walk started at
  // the second cell.
  // (maskCut runs after the join readings only: it masks a key up to the
  // cells it can read, and a mask it writes first is opaque to the joined
  // whole. It runs before arg, which reads the cells again)
  // spacedKey runs first here as it does in arg(): its walk starts at the
  // front, and the framed join masks a run from the middle on, so the "…" it
  // writes first stopped spacedKey where the key went on — measured, "x=m s -
  // LmNo24 68Pq … Hi3597" went out "x=m s - LmNo24 68Pq Rs13…3597", the key's
  // opening eight characters beside its own mask.
  // a grid of cells runs before the joins: spacedKey stops at the first word
  // of the grid and masks a piece ("x=ms-aaaa1111bbbb    qrst …" left 24
  // characters beside the mask), and a mask written first is opaque here
  {
    const hits = []
    for (let k = 0; ; ) {
      const g = cellGrid(s, k)
      if (!g) break
      hits.push(g)
      k = g.bodyEnd
    }
    const sp0 = spacedKey(s)
    const kept = []
    for (const g of hits) {
      if (!sp0) { kept.push(g); continue }
      const from = sp0.pre.length
      const to = from + sp0.body.length
      if (g.bodyEnd <= to) continue
      if (g.preEnd >= from && g.preEnd - to <= 32 && /^[^A-Za-z0-9]*$/.test(s.slice(to, g.preEnd))) {
        kept.push({ preEnd: g.preEnd, bodyAt: from, body: s.slice(from, g.bodyEnd).replace(/[^A-Za-z0-9+/=_.-]/g, ""), bodyEnd: g.bodyEnd })
        continue
      }
      kept.push(g)
    }
    if (kept.length > 0) {
      let out = ""
      let at = 0
      for (const g of kept) {
        out += s.slice(at, g.bodyAt) + mask(g.body)
        at = g.bodyEnd
      }
      s = out + s.slice(at)
    }
  }
  const sp = spacedKey(s)
  if (sp) {
    const ext = extendCut(sp.body, sp.post)
    const core = ext.body.replace(/[._-]+$/, "")
    const keyBody = msKey(ext.body, false) ? ext.body : core !== ext.body && msKey(core, false) ? core : ""
    if (keyBody) s = sp.pre + mask(keyJoin(keyBody)) + (ext.body.slice(keyBody.length) + ext.rest)
  }
  if (s.length <= 32 * 1024) {
    // (an ellipsis folds to three dots and would read as key material — a mask
    // this tool wrote is opaque here, as it is inside arg)
    if (!s.includes("…")) {
      const folded = foldedSpans(s)
      if (folded) s = folded
    }
    s = joinFramed(s)
  }
  const split = splitKey(s)
  if (split && msKey(split.body, false)) {
    s = split.pre + mask(split.body.replace(/\s+/g, "")) + split.post
  }

  // maskCut runs here, on the whole text: it reads a key cut by spaces or
  // middots across a line break, which arg's per-line pass cannot see (a key
  // the child wrapped). The cell reading is left to arg — its mask covers a
  // share of a cut and is opaque to arg's readings, which read the same cut to
  // its end
  if (s.length <= 32 * 1024) s = maskCut(s)
  // a value a frame names is read across a line break too: the lines are split
  // for echoing, and a key cut by the break is one key ("{\"key\":\"123e" and
  // "4567-e89b-…" on the next line). joinFramed runs on the whole text for the
  // same reason the join above does.
  return joinFramed(s).replace(/\r\n?/g, "\n").split("\n").map(arg).join("\n")
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

// wrapperTarget follows a launcher script to the binary it finally runs.
// appdir.Resolve judges the executable as the process really is — what
// os.Executable() answers after an exec chain is the final binary, not the
// shim — so the folder magpie keeps its config in is the exec target's, and a
// shim with a data/ folder beside it must not win the --dir guard: the guard
// passed while the write landed in the wrapped binary's own config, and the
// read-back then blamed "magpie 是否在正常运行". "" means "not a launcher, or
// a launcher whose target we cannot name"; a caller that needs to tell the two
// apart asks isWrapper as well. A chain is followed hop by hop while each
// target is itself a script, bounded and cycle-checked: eight is well past any
// launcher chain a real install builds. The bound is what the result depends
// on — a cycle also ends on it, so removing the cycle check changes nothing a
// caller can see (pinned by the chain test; the check is here to keep a
// longer bound from walking one file forever). Two shapes are deliberately
// left unresolved rather than guessed: a target preceded by a flag
// (`exec -a name /path`), and a target that is not a literal path
// (`exec "$(command -v magpie)"`). A line that only looks like an exec — a
// usage string, a heredoc body — is followed as if it were one; the guard
// still refuses a mismatch and the read-back still says a wrapper was
// involved, so the mistake lands on the side of asking.
const wrapperTarget = (bin) => {
  let path = bin
  const seen = new Set()
  for (let hop = 0; hop < 8; hop++) {
    if (seen.has(path)) return ""
    seen.add(path)
    let fd
    try {
      fd = openSync(path, "r")
      const head = Buffer.alloc(4096)
      const n = readSync(fd, head, 0, head.length, 0)
      const text = head.subarray(0, n).toString("utf8")
      if (!text.startsWith("#!")) return hop === 0 ? "" : path
      // an `exec` line a launcher writes: "exec /path/magpie \"$@\"", with an
      // optional env assignment in front and an optional quote round the path.
      // The first one whose target exists is taken; a target that is not a
      // plain path ("$(command -v magpie)") never exists as one and is passed
      // over, which is what leaves a dynamic launcher unresolved.
      // A shebang that names another program (#!/usr/bin/env node, #!/usr/bin/python3)
      // is not a shell launcher: the file is what runs, and its body is that
      // program's source — a source with a shift ("1 << 16") is not a
      // here-document, and reading it as one refused a launcher whose target is
      // a node entry point.
      if (!/^#![^\n]*\b(?:sh|bash|zsh|dash|ksh|ash)\b/.test(text)) return hop === 0 ? "" : path
      // A here-document is text, not the script: its body is skipped and the
      // exec line after it is the target (a script that prints usage before it
      // starts is an ordinary shape). The word "exec" inside a body only matters
      // when the body is the only place one appears — a script whose sole exec
      // is inside a usage block starts something the text does not name, and
      // that is unresolved rather than guessed.
      const lines = text.split("\n")
      const live = []
      let heredocExec = false
      for (let li = 0; li < lines.length; li += 1) {
        live.push(lines[li])
        const open = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(lines[li])
        if (!open) continue
        const word = open[1] ?? open[2] ?? open[3]
        const stripTabs = /^<<-/.test(open[0])
        for (li += 1; li < lines.length; li += 1) {
          const body = stripTabs ? lines[li].replace(/^\t+/, "") : lines[li]
          if (body === word) break
          // the word may sit anywhere in the body ("usage: exec /usr/bin/x")
          if (/\bexec\s+\S/.test(lines[li])) heredocExec = true
        }
      }

      let next = ""
      let sawExec = false
      let unsettled = false
      const targets = new Set()
      for (const line of live) {
        const m = /^\s*exec\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line)
        if (!m) continue
        sawExec = true
        const target = m[1] ?? m[2] ?? m[3] ?? ""
        if (!target || target.startsWith("-")) continue
        // a relative target is resolved against the shell's working folder,
        // not the script's: what lies beside the script is a guess, and this
        // program has no business writing a credential into a guess. It also
        // spoils the whole launcher: a script with one absolute exec and one
        // relative is two branches, and the branch that runs is not in the
        // text — dropping the one we could not read and calling the rest
        // settled was the same mistake as following the wrong branch.
        if (!isAbsolute(target)) {
          unsettled = true
          continue
        }
        targets.add(target)
        if (existsSync(target)) next = target
      }
      if (!sawExec && heredocExec) return ""
      if (unsettled) return ""
      // Two different exec lines are two possible targets — an if/else, a
      // fallback chain — and which one runs is not something a text read can
      // settle. Unresolved beats following the wrong branch.
      if (targets.size > 1) return ""
      // no exec line at all: this file is the bottom of the chain, the binary
      // the chain finally runs. One that execs a target which exists nowhere
      // claims to run something we cannot find — that launcher stays
      // unresolved, and a write is refused rather than guessed.
      if (!next) return sawExec ? "" : path
      path = next
    } catch {
      return ""
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }
  return ""
}

// isWrapper is a path that is really a launcher — a file that begins with "#!".
// Two bytes are enough, and a binary that cannot be read is not a wrapper.
const isWrapper = (bin) => {
  let fd
  try {
    fd = openSync(bin, "r")
    const head = Buffer.alloc(2)
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x23 && head[1] === 0x21
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

// wrapperNote is the read-back suffix for a launcher we could not follow: the
// guard asked about the script's own folder, so a write that went to the
// wrapped binary's folder instead shows up exactly here, as a token that is
// missing.
const wrapperNote = (bin) =>
  isWrapper(bin) && !wrapperTarget(bin) ? "；--magpie 是包装脚本，它最终启动的 magpie 定位不到，写入可能落在别的目录里" : ""

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
  // every way out of a --status report says so, the early give-ups included:
  // a report that ended in "add a provider" read like a half-run command
  const statusNote = () => {
    if (args.status) log(`(--status：以上是计划，未执行)`)
  }
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
  // The folder is the one the binary that actually runs keeps its config in:
  // for a launcher script that is the exec target, not the script's own folder.
  const dir = args.dir || findConfigDir({ env, home, os, exists, binPath: wrapperTarget(bin) || bin })
  if (!dir) {
    log(`✗ 没找到 magpie 的配置目录。`)
    log(`  试过 $XDG_CONFIG_HOME/magpie 和 ~/.config/magpie。便携版请用 --dir 指定它的 data 目录。`)
    statusNote()
    return 1
  }
  if (!looksLikeMagpie(dir, exists)) {
    log(`✗ ${arg(dir)} 里没有 magpie 的配置文件（providers.json / plugins.json / plugin-auth.json）。`)
    statusNote()
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
    statusNote()
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
    statusNote()
    return 1
  }
  if (providersRaw !== undefined && !shaped(providersRaw)) {
    log(`✗ ${showPath(dir, "providers.json")} 存在但不是 magpie 写的形状。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    statusNote()
    return 1
  }
  // `providers` present but not a list is the same unreadable state one level in
  if (providers !== undefined && providers !== null && !Array.isArray(providers)) {
    log(`✗ ${showPath(dir, "providers.json")} 的 providers 不是列表。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    statusNote()
    return 1
  }
  const accounts = pluginAccounts(authRaw)
  // --to-preset writes into the provider, so one that is there but has no key
  // is a destination, not "unconfigured"; --to-plugin needs a key to read.
  const cands = presetCandidates(providers, args.from, args.to !== "preset")

  const shownPreset = (p) => `${arg(p.id)}（${keyNote(p)}）`
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
    statusNote()
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
        log(`✗ "${arg(args.from)}" 在，但${keyNote(bare[0]) === "key 不是文本" ? " key 不是文本（providers.json 里的值类型不对）" : "还没有 key"}，没有可同步的令牌。`)
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
        log(`✗ 内置侧的 ${arg(bare[0].id)} 在，但${keyNote(bare[0]) === "key 不是文本" ? " key 不是文本（providers.json 里的值类型不对）" : "还没有 key"}，没有可同步的令牌。`)
        log(`  用 magpie provider key ${arg(bare[0].id)} <key> 写入，或在 magpie 的「供应商」页填上。`)
      } else {
        log(`✗ 内置侧没有带 key 的 ModelScope 预设。`)
        log(`  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add ${PRESET} <key>。`)
      }
    }
    statusNote()
    return 1
  }

  const plan = args.to === "preset" ? planToPreset({ preset, accounts, force: args.force }) : planToPlugin({ preset, accounts, force: args.force })
  for (const line of plan.lines) log(line)
  // --status promises "report only", and the annotation is what says so. It has
  // to cover the noop and refuse answers too: they are conclusions, not plans,
  // and a reader scripting the output could not otherwise tell a report from a
  // run that had happened. The exit code still carries the verdict.
  if (plan.action !== "run") {
    statusNote()
    return plan.action === "noop" ? 0 : 1
  }

  // --status means "report only", and it comes before the direction check: with
  // only --status it should say "this is the plan", not tell the user to pick
  // a direction — a report is exactly what they asked for. Its exit code is the
  // report's verdict, the same one the noop/non-noop branch above carries: 0
  // when the two sides already agree, 1 when there is something to run, so a
  // script does not have to parse the text.
  if (args.status) {
    log(`(--status：以上是计划，未执行)`)
    return 1
  }
  // Without --to-* it only reports the plan: a bare npx run must not silently
  // write a credential
  if (!args.to) {
    log(`(要执行请显式指定方向：--to-plugin 或 --to-preset)`)
    if (args.dryRun) log(`(--dry-run：未执行)`)
    // A bare run is a report, and the README says so: 0 here means the tool
    // did what it was asked (show the plan), not that the sync happened. Only
    // --status carries "there is work" as a verdict, and that is what --status
    // is for — a script that wants the verdict asks for it.
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
  // The refusal comes first, outside the --dir guard: a run that lets the
  // folder be inferred writes just the same, and an unnameable launcher may
  // write anywhere — the folder it was inferred from is the script's, and the
  // script is not what runs.
  if (!args.dryRun && bin && runnable(bin, os, exists) && isWrapper(bin) && !wrapperTarget(bin)) {
    log(`✗ --magpie 是包装脚本（${arg(bin)}），但看不出它最终启动哪个 magpie，写入会落在它自己的目录里——那可能不是这里读的目录。`)
    log(`  读的是：${arg(dir)}`)
    log(`  请把 --magpie 指到真正的 magpie 二进制（不是启动脚本），或去掉 --magpie 让它自动探测。`)
    return 1
  }
  if (!args.dryRun && args.dir && bin && runnable(bin, os, exists)) {
    // A launcher script writes wherever the binary it execs keeps its config,
    // and that folder is not the one this path implies: a shim beside a data/
    // folder passed this guard while the write landed in the wrapped binary's
    // own config, and the read-back then blamed "magpie 是否在正常运行". The
    // exec target is read out of the script when it names one; a script that
    // names none has no folder of its own either way, and the guard still asks
    // about the path as before.
    const wrapped = wrapperTarget(bin)
    const binDir = findConfigDir({ env, home, os, exists, binPath: wrapped || bin })
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
        log(`✗ 写入后回读没找到目标 key（${mask(want)}）——检查 magpie 是否在正常运行${wrapperNote(bin)}。`)
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
        log(`✗ 写入后回读没找到目标令牌（${mask(want)}）——检查 magpie 是否正在正常运行${wrapperNote(bin)}。`)
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
  // The verdict still has to reach the shell. `--status` with work left to do
  // exits 1, and a closed pipe used to turn that into 0 — a script that piped
  // the status through anything read a pending sync as done. The handler takes
  // the run down at once (further writes would only raise again), and the code
  // it uses is the run's own: the verdict is written to exitCode before the
  // remaining lines go out, so by the time the pipe closes it is already
  // decided. `head` still gets its lines, and the shell still sees the verdict.
  process.stdout.on("error", (e) => {
    if (!e || e.code !== "EPIPE") throw e
    // a closed pipe stops the writing, not the verdict: the run finishes and
    // its own exit code is what the shell sees. (`process.exit(0)` here made a
    // pending sync read as done to anything that piped --status.)
    process.stdout.write = () => true
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
