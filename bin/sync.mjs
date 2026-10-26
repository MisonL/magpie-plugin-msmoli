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
import { dirname, isAbsolute, join } from "node:path"
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
    if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`缺少值：${argv[i - 1]} 后面要跟一个参数`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") out.dir = take(++i)
    else if (a === "--magpie") out.magpie = take(++i)
    else if (a === "--from") out.from = take(++i)
    else if (a === "--to-plugin" || a === "--to-preset") {
      // 两个方向同时给时后者静默获胜，等于悄悄丢掉前一个：说清楚比择一好
      const want = a === "--to-plugin" ? "plugin" : "preset"
      if (out.to && out.to !== want) throw new Error("--to-plugin 与 --to-preset 只能给一个")
      out.to = want
    }
    else if (a === "--force") out.force = true
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--status") out.status = true
    else throw new Error(`不认识的参数：${show(a)}（--help 看用法）`)
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

export function findConfigDir({ env = process.env, home = homedir(), os = platform(), exists = existsSync, binPath = "" } = {}) {
  if (binPath) {
    let base = dirname(binPath)
    // 一个 Mac app 的「旁边」是 .app 所在的目录；可执行文件在 .app 里面。
    // 两种分隔符都认：这行在非 Mac 上也能被测试驱动（darwin 路径由测试传入）
    if (os === "darwin" && /[\\/]Contents[\\/]MacOS$/.test(base)) base = dirname(dirname(dirname(base)))
    const data = join(base, "data")
    if (exists(join(base, ".portable")) || looksLikeMagpie(data, exists)) return data
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
  const keyed = (p) => typeof p?.key === "string" && p.key.trim()
  const ours = (p) => p?.id === PRESET || p?.preset === PRESET || hostOf(p?.chat) === HOST
  // the key is trimmed where it is read: a token pasted with a trailing
  // newline is the same token, and every comparison and every stdin below
  // must see that one — the check-in plugin trims it too (tokenOf), so the
  // two halves of the tool otherwise disagree about the same credential
  const out = (ps) => ps.map((p) => ({ ...p, key: p.key.trim() }))
  if (from) return out(list.filter((p) => keyed(p) && p.id === from && ours(p)))
  const byId = list.filter((p) => keyed(p) && (p.id === PRESET || p.preset === PRESET))
  if (byId.length) return out(byId)
  return out(list.filter((p) => keyed(p) && hostOf(p.chat) === HOST))
}

// show is what goes to the terminal: a provider id or a file's path comes
// from a file on this machine, but a poisoned providers.json could put an
// escape sequence there and clear the screen, retitle the window or forge a
// line of output. Control characters are shown as spaces. A token-shaped run
// is masked: --from and an unknown flag are printed back verbatim, so a token
// pasted into the wrong position (`--from ms-…`, or as a bare argument) would
// otherwise be printed whole, against the one promise this tool makes about a
// token. It is the same mask a planned command line uses.
const tokenShaped = /ms-[A-Za-z0-9][A-Za-z0-9-]{10,}/g
const show = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(tokenShaped, (m) => mask(m))

function hostOf(chat) {
  if (typeof chat !== "string") return ""
  try {
    return new URL(chat).hostname.toLowerCase()
  } catch {
    return ""
  }
}

// 插件侧的账号：主键 msmoli 与 msmoli#xxxxxx，按令牌区分。
export function pluginAccounts(auth) {
  const obj = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {}
  return Object.entries(obj)
    .filter(([k]) => k === ID || k.startsWith(`${ID}#`))
    .map(([name, v]) => ({ name, token: typeof v?.key === "string" ? v.key.trim() : "" }))
}

// { action: "noop" | "run" | "refuse", lines: string[], cmds: [{ argv, stdin? }] }
export function planToPlugin({ preset, accounts, force }) {
  const lines = []
  const same = accounts.find((a) => a.token === preset.key)
  if (same) {
    lines.push(`✓ 插件已用同一把令牌（${mask(preset.key)}），无需操作。`)
    return { action: "noop", lines, cmds: [] }
  }
  if (accounts.length === 0) {
    lines.push(`→ 将把内置预设（${show(preset.id)}）的令牌登录给插件：magpie plugin login ${ID}（令牌走 stdin）`)
    return { action: "run", lines, cmds: [{ argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key }] }
  }
  lines.push(`  插件现有：${accounts.map((a) => `${show(a.name)}（${mask(a.token)}）`).join("、")}`)
  lines.push(`  内置预设：${show(preset.id)}（${mask(preset.key)}）`)
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
  lines.push(`→ 将先 logout（登出 ${show(accounts[0].name)}）再 login 内置那把。当天已签到的记录会重来，昵称下次签到时写回。`)
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
  lines.push(`  内置预设：${show(preset.id)}，现有 key（${mask(preset.key)}）会被整条替换。`)
  // The plugin refuses a key with anything but visible ASCII in it (tokenOf,
  // it would go out in an Authorization header). Writing such a key into the
  // preset would break chat requests while this tool reported success.
  if (!/^[\x21-\x7e]+$/.test(main.token)) {
    lines.push(`✗ 插件里那把令牌含空格、换行或非 ASCII 字符，发不出去，不写进内置预设。`)
    lines.push(`  先修好插件那边的登录（magpie plugin login ${ID}）。`)
    return { action: "refuse", lines, cmds: [] }
  }
  // provider key 的第一个参数是 id：一个以 "-" 开头的 id 会被 magpie 的 CLI
  // 当成 flag（`provider key --help <token>` 只打印帮助、不写 key）。
  if (typeof preset.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preset.id)) {
    lines.push(`✗ 这个 provider id 不是 magpie 接受的形状（${show(preset.id)}），不能用 provider key 写入。`)
    return { action: "refuse", lines, cmds: [] }
  }
  if (!force) {
    lines.push(`✗ 内置这把 key 是聊天请求正在用的，替换会让那边跟着换。确认的话加 --force 重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
  lines.push(`→ 将执行 magpie provider key ${show(preset.id)}（令牌是该命令的参数，进程列表里短暂可见）。`)
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
  const shown = secret ? argv.map((a) => (a === secret ? mask(secret) : a)) : argv
  log(`$ magpie ${shown.join(" ")}`)
}

// scrub hides a token in text that came from a child process. Both paths use
// it: the answer printed on success, and the failure printed in the error —
// the failing path is the one most likely to carry the command back verbatim
// ("no key ms-… for provider"), and hiding it only on success was the gap.
function scrub(out, ...secrets) {
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(mask(secret))
  }
  return out
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
      const e = new Error(`跑不动 ${show(bin)}：${r.error.message}${hint}`)
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
  log(`? 写入已执行，但回读时 ${show(join(dir, name))} 读不出来，无法确认（${mask(want)}）。`)
  log(`  先确认 magpie 正常，再看一眼${where}里那把 key 在不在。`)
  return 1
}

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
  // A bare --magpie was the same hole from the other side: spawnSync resolves
  // it through PATH, but exists("magpie") does not, so the write guard below
  // saw "no binary" and skipped itself — and the token went to whatever the
  // PATH answered. The name has to be a path.
  if (args.magpie && !rooted(args.magpie, os)) {
    log(`✗ --magpie 需要一个完整路径，不接受裸名（${show(args.magpie)}）。`)
    log(`  裸名会按 PATH 解析：PATH 上第一个 magpie 会拿到令牌。用例如 macOS 的`)
    log(`  /Applications/magpie.app/Contents/MacOS/magpie。`)
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
    log(`✗ ${show(dir)} 里没有 magpie 的配置文件（providers.json / plugins.json / plugin-auth.json）。`)
    return 1
  }
  log(`magpie 配置目录：${show(dir)}`)

  const providersRaw = readJson(join(dir, "providers.json"), exists)
  // "there but unreadable" is not "not configured": telling the user to add a
  // provider that already exists invites overwriting a file that may be
  // recoverable. Same distinction the auth file below has had since the fix.
  if (providersRaw === null) {
    log(`✗ ${show(join(dir, "providers.json"))} 存在但读不出来（可能正在被写或已损坏）。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  const providers = providersRaw?.providers
  const authRaw = readJson(join(dir, "plugin-auth.json"), exists)
  // A file that parses but is not the shape magpie writes (an array, a
  // string, a bare null) is state we cannot read, not "nobody is signed in":
  // a login over it would add a second account over one we could not see.
  const shaped = (v) => v === undefined || (v !== null && typeof v === "object" && !Array.isArray(v))
  if (authRaw === null || !shaped(authRaw)) {
    log(`✗ ${show(join(dir, "plugin-auth.json"))} 存在但读不出来（可能正在被写或已损坏）。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  if (providersRaw !== undefined && !shaped(providersRaw)) {
    log(`✗ ${show(join(dir, "providers.json"))} 存在但不是 magpie 写的形状。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  // `providers` present but not a list is the same unreadable state one level in
  if (providers !== undefined && providers !== null && !Array.isArray(providers)) {
    log(`✗ ${show(join(dir, "providers.json"))} 的 providers 不是列表。`)
    log(`  不猜它的内容：先确认 magpie 正常，或备份后重试。`)
    return 1
  }
  const accounts = pluginAccounts(authRaw)
  const cands = presetCandidates(providers, args.from)

  log(`  内置 ModelScope：${cands.length === 1 ? `${show(cands[0].id)}（${mask(cands[0].key)}）` : cands.length ? "多个候选" : "未配置"}`)
  log(`  签到插件 msmoli：${accounts.length ? accounts.map((a) => `${show(a.name)}（${mask(a.token)}）`).join("、") : "未登录"}`)

  if (cands.length > 1) {
    // --from matches by id, so two providers sharing one id leave it no way
    // to pick: say that rather than telling the user to use --from again.
    const ids = new Set(cands.map((p) => p?.id))
    log(`✗ 内置侧有 ${cands.length} 个候选（${cands.map((p) => show(p.id)).join("、")}），不确定用哪个。`)
    if (ids.size === 1) {
      log(`  它们用的是同一个 id（${show(cands[0]?.id)}），--from 也分不开；请在 magpie 里删掉多余的那个 provider。`)
    } else {
      log(`  用 --from <id> 指定。`)
    }
    return 1
  }
  const preset = cands[0] ?? null
  // 无预设时两条方向都该给指引：--to-preset 也有自己的话术（planToPreset 里），
  // 但这里先统一拦住，免得 null 一路传到 plan 里崩栈
  if (!preset) {
    if (args.from) {
      // the provider may well exist and simply not be one of ours: saying
      // "there is no provider by that id" sends the user to re-add it
      const any = (Array.isArray(providers) ? providers : []).filter((p) => p?.id === args.from)
      if (any.length) {
        log(`✗ "${show(args.from)}" 在，但它不是 ModelScope：chat 不指向 ${HOST}，id/preset 也不是 ${PRESET}。`)
        log(`  这个工具只同步内置的 ModelScope 预设与插件登录态之间的令牌。`)
      } else {
        log(`✗ 内置侧没有 id 为 "${show(args.from)}" 的 provider。`)
        log(`  用 --status 看现有的，或先 magpie provider add ${show(args.from)} <key>。`)
      }
    } else {
      log(`✗ 内置侧没有带 key 的 ModelScope 预设。`)
      log(`  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add ${PRESET} <key>。`)
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
  // writes is stopped here, and only a binary that is there can write —
  // --status and --dry-run are reads.
  if (!args.dryRun && args.dir && bin && exists(bin)) {
    const binDir = findConfigDir({ env, home, os, exists, binPath: bin })
    // "" is a mismatch too: the binary has no magpie folder of ours to write
    // to, so it would make one — and that one is not the folder named. Compared
    // by folder identity, not by string: a shell completes a directory with a
    // trailing slash, and "/private/tmp/data" and "/tmp/data" are one folder.
    if (!sameFolder(binDir, args.dir)) {
      log(`✗ --dir 与 --magpie 指向不同的配置目录，而写入只会落在 magpie 自己的那个。`)
      log(`  读的是：${show(args.dir)}`)
      log(`  magpie 会写到：${binDir ? show(binDir) : "它自己的默认目录（这里找不到现成的）"}`)
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
      if (raw === null) return unreadableAfter("providers.json", dir, want, log, "供应商列表")
      const after = presetCandidates(raw?.providers, preset.id)
      if (!after.some((p) => p.key === want)) {
        log(`✗ 写入后回读没找到目标 key（${mask(want)}）——检查 magpie 是否在正常运行。`)
        return 1
      }
    } else {
      const raw = readJson(join(dir, "plugin-auth.json"), exists)
      if (raw === null) return unreadableAfter("plugin-auth.json", dir, want, log)
      const after = pluginAccounts(raw)
      // 回读要数账号：logout 没真删（退出码 0 却没动手）时，login 会把新
      // 令牌加成第二个账号，而「有一个账号拿着目标令牌」照样成立——那正是
      // planToPlugin 明说 --force 不适用、工具却亲手造出来的状态。
      if (plan.cmds.length > 1 && after.length > 1) {
        log(`✗ 回读发现插件现在有 ${after.length} 个账号（${after.map((a) => show(a.name)).join("、")}）。`)
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
