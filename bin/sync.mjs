#!/usr/bin/env node
// magpie-plugin-msmoli — 把 magpie 里已有的 ModelScope 令牌同步给签到插件，或反过来。
//
// 为什么有这个工具：magpie 的内置 ModelScope 预设（providers.json）和本插件
// 的登录态（plugin-auth.json）是两处独立存储，同一把 ms- 令牌要配两次。
// 这个工具读一次、写一次，输出里不留令牌。
//
// 安全边界（改这里之前先想清楚）：
// - 只读 magpie 的两个文件；写入一律交给 magpie 自己的 CLI
//   （provider key / plugin login），不裸写任何 magpie 的文件——锁、备份、
//   .bak 回退、事件通知都归 magpie 管。
// - 令牌只走 stdin 和进程参数（provider key 的接口如此），日志里只出现
//   掩码（前 4 + … + 后 4，与 magpie 自己的显示一致）。
// - 宿主按令牌分账号：同一把令牌重复 login 是幂等的；换一把会新增第二个
//   账号；logout 会登出该 provider 的全部账号。所以「两边不同」时默认
//   拒绝改动，只有显式 --force 且插件只有一个账号时才替换。

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, isAbsolute, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ID = "msmoli"
const PRESET = "modelscope"
const HOST = "api-inference.modelscope.cn"

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

令牌不会出现在输出里。写入一律走 magpie 自己的 CLI。`

function parseArgs(argv) {
  const out = { dir: "", magpie: "", from: "", to: "", force: false, dryRun: false, status: false, help: false }
  // help wins over everything else on the line: `--help --nope` and
  // `--nope --help` should show the page, not an error about --nope
  if (argv.includes("-h") || argv.includes("--help")) return { ...out, help: true }
  // A flag is not a value. `--dir --dry-run` would otherwise take "--dry-run"
  // as the folder and then fail somewhere far from the mistake, and
  // `--dir ""` would read as "not given" and silently fall back to the
  // machine's own magpie — writing a credential to a target nobody named.
  const take = (i) => {
    const v = argv[i]
    // A single "-h" or "-x" is a flag too: `--dir -h` must not put "-h" in
    // the folder position and silently look there.
    if (v === undefined || v.trim() === "" || v.startsWith("-")) throw new Error(`缺少值：${argv[i - 1]} 后面要跟一个参数`)
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
    } else if (VALUE[a]) set(a, take(++i))
    else if (a === "--to-plugin" || a === "--to-preset") {
      // 两个方向同时给时后者静默获胜，等于悄悄丢掉前一个：说清楚比择一好
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

// ---- 探测：与 magpie 的 appdir 对齐。便携版认可执行文件旁的 data/ 或
// .portable；安装版认 $XDG_CONFIG_HOME/magpie，否则 ~/.config/magpie。

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

// ---- 读：只读，剥 BOM（magpie 自己也这么做），读不动就当没有

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

// ---- 领域逻辑（纯函数，导出给测试）

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

// 内置侧的候选：默认先认 id/preset=modelscope（magpie 预设的正规路径），没有
// 再按推理域名认用户自建的 vendor。--from 是消歧手段，必须只认 id——默认搜索
// 按 preset 匹配才产生歧义，消歧若还按 preset 就永远解不开（演练抓出的 bug）。
// 多于一个候选时工具不猜。
//
// 域名按 hostname 精确比较，不是子串：includes() 对
// "api-inference.modelscope.cn.evil.tld" 也为真，而那会把真令牌写进一个
// chat 指向第三方的 provider（--to-preset）或把第三方的 key 当 cookie 发给
// modelscope.cn（--to-plugin）。
//
// --from 只在这道校验**之内**挑一个：它先是「内置侧」的候选，然后才是消歧。
// 早先它短路在域名校验之前，于是 `--from openai` 会把 OpenAI 的 key 登录给
// 插件、或用 ms 令牌覆盖掉那个第三方 provider —— 两个方向都静默写错凭据。
export function presetCandidates(providers, from = "") {
  const list = Array.isArray(providers) ? providers : []
  // the key is trimmed where it is read: a token pasted with a trailing
  // newline is the same token, and every comparison and every stdin below
  // must see that one — the check-in plugin trims it too (tokenOf), so the
  // two halves of the tool otherwise disagree about the same credential
  const out = (ps) => ps.map((p) => ({ ...p, key: p.key.trim() }))
  if (from) return out(list.filter((p) => keyedOf(p) && p.id === from && oursOf(p)))
  const byId = list.filter((p) => keyedOf(p) && (p.id === PRESET || p.preset === PRESET))
  if (byId.length) return out(byId)
  return out(list.filter((p) => keyedOf(p) && hostOf(p.chat) === HOST))
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
const invisible = (c) => /[\p{Cc}\p{Cf}]/u.test(c)
const tokenShaped = new RegExp(String.raw`m${INV}*s${INV}*-(?:${INV}*[\x21-\x7e]){11,}`, "gu")
const show = (s) =>
  String(s ?? "")
    .replace(tokenShaped, (m) => mask(m.replace(/[\p{Cc}\p{Cf}]/gu, "")))
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
// the judgement takes one word — arg() hands it the whitespace-delimited piece,
// so there is no whitespace in it and no value of nothing but spaces to answer
// for. It was written for a whole value once, and a value with a trailing space
// in it answered "not a key": that is the frame this round closed
const isKey = (word) => {
  if (!/[\\/]/.test(word)) {
    // no separator: the whole word is one key, and one key-like run in it is
    // enough (a generated key has no separator at all). PATHY's leading "." is
    // for paths (./x, ../x): a key never begins with one
    if (UUID.test(word) || (word.match(RUN) ?? []).some(keyRun)) return true
    // the base64 symbols are a key's own alphabet, but not on their own: a
    // query's retry=true, an id=12345 carried one, and the value went out as
    // "（10 字符）". One of them beside a long mixed run is what a key's body
    // carries, and that run is key-shaped already; a bare "ab=" is not.
    // A word cut up by - _ . into pieces none of which clears the floor is
    // still one key when the pieces together clear it. Mixing cases is the
    // shape of a generated key and of no name (documentsnewproject has none;
    // between separators a name is lowercase letters), and 32+ with digits and
    // one 12+ piece is a hex digest written with separators (a version or a
    // date has no such piece). A word with no separator is not judged here:
    // the run test above has already seen all of it
    const c = compact(word)
    if (c === word) return false
    if (c.length >= 20 && /[a-z]/.test(c) && /[A-Z]/.test(c)) return true
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
  const segs = word.split(/[\\/]/).filter((seg) => seg.length >= 12 && /[a-z]/.test(seg) && /[A-Z]/.test(seg))
  return !PATHY.test(word) && segs.length >= 2
}
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// arg is the door every echoed value goes through. It works word by word, in
// the visible characters: a control or format character has already become a
// space, so a zero-width space pasted into a token is a word edge, and a word
// that is a key is judged and masked as that word. One word that is a key goes
// whole — revealed at its own ends (mask), not at the ends of each run — and
// inside a word that is not, only the key-like runs and UUIDs go. show() masks
// an ms- token first, so its shape survives for the pass below even when it is
// one fragment among others.
const arg = (v) =>
  show(v).replace(/[^\s]+/g, (w) =>
    isKey(w) ? mask(w) : w.replace(RUN, (r) => (keyRun(r) ? mask(r) : r)).replace(UUID_ANY, (m) => mask(m)),
  )

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

// 插件侧的账号：主键 msmoli 与 msmoli#xxxxxx，按令牌区分。
//
// 令牌只从 type === "api" 的条目上读——和插件自己（index.mjs 的 rawKey）同一条
// 规则。少这一条时，一份把 key 放错位置或类型写歪的 plugin-auth.json，会让本
// 工具说「插件已用同一把令牌、无需操作」，而插件读不到令牌、卡片永远显示未登录：
// 一个静默的错误状态，比报错更难发现。
export function pluginAccounts(auth) {
  const obj = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {}
  return Object.entries(obj)
    .filter(([k]) => k === ID || k.startsWith(`${ID}#`))
    .map(([name, v]) => ({ name, token: v?.type === "api" && typeof v.key === "string" ? v.key.trim() : "" }))
}

// { action: "noop" | "run" | "refuse", lines: string[], cmds: [{ argv, stdin? }] }
export function planToPlugin({ preset, accounts, force }) {
  const lines = []
  const same = accounts.find((a) => a.token === preset.key)
  if (same) {
    lines.push(`✓ 插件已用同一把令牌（${mask(preset.key)}），无需操作。`)
    return { action: "noop", lines, cmds: [] }
  }
  // The plugin refuses a key with anything but visible ASCII in it (tokenOf:
  // it would go out in a Cookie header), so logging one in would report a
  // success that leaves every check-in saying "令牌内容无法识别".
  // planToPreset has the same guard for the same reason; this direction was
  // missing it, and a key with a zero-width character in it — invisible in
  // every terminal and in this tool's own mask — went through.
  if (!SENDABLE.test(preset.key)) {
    lines.push(`✗ 内置预设的 key 含空格、换行或非 ASCII 字符，插件发不出去，不登录。`)
    // the provider the user actually has, not the preset's default id: a
    // vendor found by --from or by its chat host is named "my-ms", and
    // telling them to fix "modelscope" sends them to a provider that isn't
    // there — or, on a machine that has both, to the wrong one.
    lines.push(`  先修好内置那边的 key（magpie provider key ${arg(preset.id)} <key>）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (accounts.length === 0) {
    lines.push(`→ 将把内置预设（${arg(preset.id)}）的令牌登录给插件：magpie plugin login ${ID}（令牌走 stdin）`)
    return { action: "run", lines, cmds: [{ argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key }] }
  }
  // Every entry is there but none carries a token the plugin itself would read
  // (a msmoli entry of the wrong type, or a key that is not a string). "两边
  // 令牌不同" is a claim we cannot make here — we never read the plugin's side —
  // and --force would not help: the file is the problem, not the choice.
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
      // logout 也带 secret：被换掉的那把是真实凭据，magpie 的报错若回显
      // 账号（"no key ms-… for provider"）不该把整串放上终端
      { argv: ["plugin", "logout", ID], stdin: "", secret: accounts[0].token },
      { argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key },
    ],
  }
}

// provider key 是整条替换主 key，聊天请求正在用它——所以默认也要求 --force。
export function planToPreset({ preset, accounts, force }) {
  const lines = []
  const main = accounts.find((a) => a.name === ID)
  if (!main?.token) {
    // A second account holding the token the preset already has is the state
    // a forced replace leaves behind (or a re-login after a nickname write).
    // There is nothing to sync, and "主账号没有登录" would read as "your
    // plugin is signed out" while --to-plugin answers "无需操作" for the very
    // same pair of files.
    const same = preset && accounts.find((a) => a.token && a.token === preset.key)
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
  if (preset.key === main.token) {
    lines.push(`✓ 内置预设已用同一把令牌（${mask(main.token)}），无需操作。`)
    return { action: "noop", lines, cmds: [] }
  }
  lines.push(`  插件主账号：${ID}（${mask(main.token)}）`)
  lines.push(`  内置预设：${arg(preset.id)}，现有 key（${mask(preset.key)}）会被整条替换。`)
  // The plugin refuses a key with anything but visible ASCII in it (tokenOf,
  // it would go out in an Authorization header). Writing such a key into the
  // preset would break chat requests while this tool reported success.
  if (!SENDABLE.test(main.token)) {
    lines.push(`✗ 插件里那把令牌含空格、换行或非 ASCII 字符，发不出去，不写进内置预设。`)
    lines.push(`  先修好插件那边的登录（magpie plugin login ${ID}）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  // provider key 的第一个参数是 id：一个以 "-" 开头的 id 会被 magpie 的 CLI
  // 当成 flag（`provider key --help <token>` 只打印帮助、不写 key）。
  if (typeof preset.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preset.id)) {
    lines.push(`✗ 这个 provider id 不是 magpie 接受的形状（${arg(preset.id)}），不能用 provider key 写入。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (!force) {
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

// ---- 执行

// 多步序列（--force 的 logout→login）中途失败：logout 已经发生了，用户此刻
// 是被登出的状态。超时（r.error）与退出码非零（r.status）都要说这句话。
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
const MIN_ECHO = 12
function maskEchoes(s, secret) {
  if (typeof secret !== "string" || secret.length < MIN_ECHO) return s
  // a control or format character inside the echo is stepped over, for the
  // reason show()'s shape steps over one — a line break too: this is a piece
  // of the real secret, and one broken across two lines is still the secret
  //
  // The matching runs over the visible characters alone, in one pass, and the
  // spans are put back afterwards. Stepping over a character as the scan went
  // — and restarting one position later when the run came up short — cost a
  // run of them its own length at every position it held: a child's output of
  // 20 000 control characters took 79 seconds.
  const vis = []
  const at = []
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i))
    if (!invisible(c)) {
      vis.push(c)
      at.push(i)
    }
    i += c.length
  }
  let out = ""
  let from = 0
  for (let k = 0; k < vis.length; ) {
    let piece = ""
    let v = k
    while (v < vis.length && secret.includes(piece + vis[v])) {
      piece += vis[v]
      v++
    }
    if (piece.length >= MIN_ECHO) {
      out += mask(secret)
      from = at[v - 1] + vis[v - 1].length
      k = v
    } else {
      out += s.slice(from, at[k] + vis[k].length)
      from = at[k] + vis[k].length
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
  let s = out
  for (const secret of secrets) {
    if (secret) s = maskEchoes(s.split(secret).join(mask(secret)), secret)
  }
  // arg() per line, not over the whole text: its control-character pass turns
  // "\n" into a space too, and both callers split on the line breaks to echo
  // (or quote) the child's answer. A token never spans a line, so the shape
  // pass loses nothing by running per line either.
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
      // a child killed by a signal has status null; "退出码 null" tells nobody anything
      const why = r.status === null && r.signal ? `被信号 ${r.signal} 终止` : `退出码 ${r.status}`
      const said = scrub(out, secret, ...secrets).split("\n").filter(Boolean).slice(-3).join("\n")
      const e = new Error(`magpie 命令失败（${why}）${said ? `：\n${said}` : ""}`)
      // 多步序列（--force 的 logout→login）中途失败：logout 已经发生了，
      // 用户此刻是被登出的状态。说清楚，并告诉他重跑即可续上——
      // 此时插件已无账号，重跑走的是全新登录那条路，不再需要 --force。
      if (i > 0) e.recover = RECOVER
      throw e
    }
    // magpie 自己就把令牌显示成掩码；将来若变，这里兜底再滤一遍
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
  const cands = presetCandidates(providers, args.from)

  log(`  内置 ModelScope：${cands.length === 1 ? `${arg(cands[0].id)}（${mask(cands[0].key)}）` : cands.length ? "多个候选" : "未配置"}`)
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
  // 无预设时两条方向都该给指引：--to-preset 也有自己的话术（planToPreset 里），
  // 但这里先统一拦住，免得 null 一路传到 plan 里崩栈
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

  // --status 是「只报告」，先于方向判断：只给 --status 时该说「这是计划」，
  // 而不是提示用户去指定方向——他要的就是报告
  if (args.status) {
    log(`(--status：以上是计划，未执行)`)
    return 0
  }
  // 不带 --to-* 时只报计划：裸跑 npx 不该静默写入一个凭据
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

  // 回读验证，别只信退出码（方向判断与上面 plan 那行保持一致）。
  // 回读读不动（null）是另一回事：把它报成「没找到令牌」会把人推去查
  // magpie 是否在运行，而写入其实成功了——两种失败要分开说。
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
      // 回读要数账号：logout 没真删（退出码 0 却没动手）时，login 会把新
      // 令牌加成第二个账号，而「有一个账号拿着目标令牌」照样成立——那正是
      // planToPlugin 明说 --force 不适用、工具却亲手造出来的状态。
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

// npm 和 npx 通过符号链接调用 bin：argv[1] 是链接的路径，而 import.meta.url
// 是解析后的真实路径，直接比较字符串会漏掉「作为命令运行」的场景（测试里用
// node bin/sync.mjs 直跑恰好相等，掩盖了这个 bug）。先把 argv[1] 也 realpath
// 成真实路径再比。
//
// href 还不够的地方有两处，都不涉及大小写：node --preserve-symlinks-main 让
// import.meta.url 保留链接路径，而 realpathSync 仍把它解开；Windows 的 8.3 短
// 名（C:\Users\RUNNER~1\…）在 pathToFileURL 里不展开、realpathSync 里展开。
// 这两种都靠 inode 兜——那是文件的身份，与拼写无关。
//
// 报 ino=0 的卷（exFAT/FAT 的 U 盘、部分 SMB 共享与 subst 映射）没有身份可比，
// 这时退回比 realpath 之后的字符串：它能覆盖上面两种 href 失配，唯一丢掉的
// 是大小写翻转，而那个场景 href 本来就命中。不这样做的话 isMain 恒 false，
// 整个文件被跳过——不打印任何东西、退出码 0，用户会以为同步成功了。
//
// `stat` 与 `real` 可注入：ino=0 的卷在本机造不出来，测试只能把手伸到这里。
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
