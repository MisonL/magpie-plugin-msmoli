#!/usr/bin/env node
// msmoli-sync — 把 magpie 里已有的 ModelScope 令牌同步给签到插件，或反过来。
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
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const ID = "msmoli"
const PRESET = "modelscope"
const HOST = "api-inference.modelscope.cn"

const USAGE = `msmoli-sync — 把 magpie 里已有的 ModelScope 令牌同步给签到插件

用法：npx magpie-plugin-msmoli [选项]

不带参数：显示两边状态，并把将要执行的动作写清楚；不改动任何东西。
  --to-plugin   把内置 ModelScope 预设的 key 登录给签到插件
  --to-preset   反向：把签到插件主账号的 key 写进内置预设
  --force       两边令牌不同时也执行（会替换 / 先登出现有登录）
  --from <id>   内置侧的 provider id（默认 ${PRESET}）
  --dir <路径>  magpie 配置目录（便携版探测不到时用这个）
  --magpie <路径>  magpie 可执行文件（默认找 PATH 与常见安装位置）
  --status      只报告，不执行
  --dry-run     打印将要执行的命令，不执行
  -h, --help    这一页

令牌不会出现在输出里。写入一律走 magpie 自己的 CLI。`

function parseArgs(argv) {
  const out = { dir: "", magpie: "", from: "", to: "", force: false, dryRun: false, status: false, help: false }
  const take = (i) => argv[i] ?? ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") out.dir = take(++i)
    else if (a === "--magpie") out.magpie = take(++i)
    else if (a === "--from") out.from = take(++i)
    else if (a === "--to-plugin") out.to = "plugin"
    else if (a === "--to-preset") out.to = "preset"
    else if (a === "--force") out.force = true
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--status") out.status = true
    else if (a === "-h" || a === "--help") out.help = true
    else throw new Error(`不认识的参数：${a}（--help 看用法）`)
  }
  return out
}

// ---- 探测：与 magpie 的 appdir 对齐。便携版认可执行文件旁的 data/ 或
// .portable；安装版认 $XDG_CONFIG_HOME/magpie，否则 ~/.config/magpie。

export function findMagpieBin({ env = process.env, os = platform(), exists = existsSync, home = homedir() } = {}) {
  const cands = []
  if (os === "darwin") {
    cands.push("/Applications/magpie.app/Contents/MacOS/magpie", "/Applications/Magpie.app/Contents/MacOS/magpie")
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

export function findConfigDir({ env = process.env, home = homedir(), os = platform(), exists = existsSync, binPath = "" } = {}) {
  if (binPath) {
    let base = dirname(binPath)
    // 一个 Mac app 的「旁边」是 .app 所在的目录；可执行文件在 .app 里面
    if (os === "darwin" && base.endsWith(join("Contents", "MacOS"))) base = dirname(dirname(dirname(base)))
    const data = join(base, "data")
    if (exists(join(base, ".portable")) || looksLikeMagpie(data, exists)) return data
  }
  if (env.XDG_CONFIG_HOME) {
    const d = join(env.XDG_CONFIG_HOME, "magpie")
    if (looksLikeMagpie(d, exists)) return d
  }
  const d = join(home, ".config", "magpie")
  return looksLikeMagpie(d, exists) ? d : ""
}

// ---- 读：只读，剥 BOM（magpie 自己也这么做），读不动就当没有

function readJson(file, exists = existsSync) {
  if (!exists(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  } catch {
    return null
  }
}

// ---- 领域逻辑（纯函数，导出给测试）

export const mask = (t) => (typeof t === "string" && t.length >= 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "（不可用）")

// 内置侧的候选：默认先认 id/preset=modelscope（magpie 预设的正规路径），没有
// 再按推理域名认用户自建的 vendor。--from 是消歧手段，必须只认 id——默认搜索
// 按 preset 匹配才产生歧义，消歧若还按 preset 就永远解不开（演练抓出的 bug）。
// 多于一个候选时工具不猜。
export function presetCandidates(providers, from = "") {
  const list = Array.isArray(providers) ? providers : []
  const keyed = (p) => typeof p?.key === "string" && p.key
  if (from) return list.filter((p) => keyed(p) && p.id === from)
  const byId = list.filter((p) => keyed(p) && (p.id === PRESET || p.preset === PRESET))
  if (byId.length) return byId
  return list.filter((p) => keyed(p) && typeof p?.chat === "string" && p.chat.includes(HOST))
}

// 插件侧的账号：主键 msmoli 与 msmoli#xxxxxx，按令牌区分。
export function pluginAccounts(auth) {
  const obj = auth && typeof auth === "object" ? auth : {}
  return Object.entries(obj)
    .filter(([k]) => k === ID || k.startsWith(`${ID}#`))
    .map(([name, v]) => ({ name, token: typeof v?.key === "string" ? v.key : "" }))
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
    lines.push(`→ 将把内置预设置（${preset.id}）的令牌登录给插件：magpie plugin login ${ID}（令牌走 stdin）`)
    return { action: "run", lines, cmds: [{ argv: ["plugin", "login", ID], stdin: `${preset.key}\n`, secret: preset.key }] }
  }
  lines.push(`  插件现有：${accounts.map((a) => `${a.name}（${mask(a.token)}）`).join("、")}`)
  lines.push(`  内置预设：${preset.id}（${mask(preset.key)}）`)
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
  lines.push(`→ 将先 logout（登出 ${accounts[0].name}）再 login 内置那把。当天已签到的记录会重来，昵称下次签到时写回。`)
  return {
    action: "run",
    lines,
    cmds: [
      { argv: ["plugin", "logout", ID], stdin: "" },
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
  lines.push(`  内置预设：${preset.id}，现有 key（${mask(preset.key)}）会被整条替换。`)
  if (!force) {
    lines.push(`✗ 内置这把 key 是聊天请求正在用的，替换会让那边跟着换。确认的话加 --force 重跑。`)
    return { action: "refuse", lines, cmds: [] }
  }
  lines.push(`→ 将执行 magpie provider key ${preset.id}（令牌是该命令的参数，进程列表里短暂可见）。`)
  return { action: "run", lines, cmds: [{ argv: ["provider", "key", preset.id, main.token], secret: main.token }] }
}

// ---- 执行

function hidden(argv, secret, log) {
  const shown = secret ? argv.map((a) => (a === secret ? mask(secret) : a)) : argv
  log(`$ magpie ${shown.join(" ")}`)
}

function run(cmds, bin, { dryRun, log, spawn = spawnSync, timeout = 120_000 }) {
  for (let i = 0; i < cmds.length; i++) {
    const { argv, stdin, secret } = cmds[i]
    hidden(argv, secret, log)
    if (dryRun) continue
    const r = spawn(bin, argv, { input: stdin, encoding: "utf8", timeout })
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
    if (r.error) throw new Error(`跑不动 ${bin}：${r.error.message}（用 --magpie 指定完整路径）`)
    if (r.status !== 0) {
      const said = out.split("\n").filter(Boolean).slice(-3).join("\n")
      const e = new Error(`magpie 命令失败（退出码 ${r.status}）${said ? `：\n${said}` : ""}`)
      // 多步序列（--force 的 logout→login）中途失败：logout 已经发生了，
      // 用户此刻是被登出的状态。说清楚，并告诉他重跑即可续上——
      // 此时插件已无账号，重跑走的是全新登录那条路，不再需要 --force。
      if (i > 0) {
        e.recover = `注意：前面的步骤已经执行，现有登录已被登出。重新运行同一条命令即可继续（此时插件没有账号，会直接登录，无需 --force）。`
      }
      throw e
    }
    // magpie 自己就把令牌显示成掩码；将来若变，这里兜底再滤一遍
    const lines = secret ? out.split("\n").map((l) => l.split(secret).join(mask(secret))) : out.split("\n")
    for (const line of lines) if (line.trim()) log(`  ${line}`)
  }
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

  const bin = args.magpie || findMagpieBin({ env, os, exists, home }) || "magpie"
  const dir = args.dir || findConfigDir({ env, home, os, exists, binPath: bin === "magpie" ? "" : bin })
  if (!dir) {
    log(`✗ 没找到 magpie 的配置目录。`)
    log(`  试过 $XDG_CONFIG_HOME/magpie 和 ~/.config/magpie。便携版请用 --dir 指定它的 data 目录。`)
    return 1
  }
  if (!looksLikeMagpie(dir, exists)) {
    log(`✗ ${dir} 里没有 magpie 的配置文件（providers.json / plugins.json / plugin-auth.json）。`)
    return 1
  }
  log(`magpie 配置目录：${dir}`)

  const providers = readJson(join(dir, "providers.json"), exists)?.providers
  const accounts = pluginAccounts(readJson(join(dir, "plugin-auth.json"), exists))
  const cands = presetCandidates(providers, args.from)

  log(`  内置 ModelScope：${cands.length === 1 ? `${cands[0].id}（${mask(cands[0].key)}）` : cands.length ? "多个候选" : "未配置"}`)
  log(`  签到插件 msmoli：${accounts.length ? accounts.map((a) => `${a.name}（${mask(a.token)}）`).join("、") : "未登录"}`)

  if (cands.length > 1) {
    log(`✗ 内置侧有 ${cands.length} 个候选（${cands.map((p) => p.id).join("、")}），不确定用哪个。用 --from <id> 指定。`)
    return 1
  }
  const preset = cands[0] ?? null
  // 无预设时两条方向都该给指引：--to-preset 也有自己的话术（planToPreset 里），
  // 但这里先统一拦住，免得 null 一路传到 plan 里崩栈
  if (!preset) {
    if (args.from) {
      log(`✗ 内置侧没有 id 为 "${args.from}" 的 provider。`)
      log(`  用 --status 看现有的，或先 magpie provider add ${args.from} <key>。`)
    } else {
      log(`✗ 内置侧没有带 key 的 ModelScope 预设。`)
      log(`  先在 magpie 的「供应商」页添加 ModelScope，或 magpie provider add ${PRESET} <key>。`)
    }
    return 1
  }

  const plan = args.to === "preset" ? planToPreset({ preset, accounts, force: args.force }) : planToPlugin({ preset, accounts, force: args.force })
  for (const line of plan.lines) log(line)
  if (plan.action !== "run") return plan.action === "noop" ? 0 : 1

  // 不带 --to-* 时只报计划：裸跑 npx 不该静默写入一个凭据
  if (!args.to) {
    log(`(要执行请显式指定方向：--to-plugin 或 --to-preset)`)
    return 0
  }
  if (args.status) {
    log(`(--status：以上是计划，未执行)`)
    return 0
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

  // 回读验证，别只信退出码（方向判断与上面 plan 那行保持一致）
  const want = plan.cmds.at(-1).secret
  if (want) {
    if (args.to === "preset") {
      const after = presetCandidates(readJson(join(dir, "providers.json"), exists)?.providers, preset.id)
      if (!after.some((p) => p.key === want)) {
        log(`✗ 写入后回读没找到目标 key（${mask(want)}）——检查 magpie 是否在正常运行。`)
        return 1
      }
    } else {
      const after = pluginAccounts(readJson(join(dir, "plugin-auth.json"), exists))
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
function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMain()) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`msmoli-sync: ${e?.message ?? e}\n`)
      process.exit(1)
    })
}
