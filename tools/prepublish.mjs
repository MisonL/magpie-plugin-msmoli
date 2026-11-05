// Every test mode this repository runs, in the order CI runs them, so a
// publish from a machine that never saw CI cannot skip one. `npm test` alone
// leaves the ticking clock, the shifted clock and Bun unexercised; each has
// caught a real regression in this project's history.
//
// Bun is the runtime magpie actually runs plugins on. It is skipped only when
// the binary is missing, and the skip is printed loudly — never silently.

import { spawnSync } from "node:child_process"

const modes = [
  { name: "node --test", cmd: "node", args: ["--test"] },
  {
    name: "node --import ./tools/ticking-clock.mjs --test",
    cmd: "node",
    args: ["--import", "./tools/ticking-clock.mjs", "--test"],
  },
  {
    name: "node --test (shifted clock)",
    cmd: "node",
    args: ["--test"],
    env: { MSMOLI_FAKE_NOW: "1893456000000" },
  },
  { name: "bun test", cmd: "bun", args: ["test"], optional: true },
]

let failed = false
for (const m of modes) {
  process.stdout.write(`\n$ ${[m.cmd, ...m.args].join(" ")}${m.env ? "  (env " + Object.keys(m.env).join(",") + ")" : ""}\n`)
  const r = spawnSync(m.cmd, m.args, {
    stdio: "inherit",
    env: { ...process.env, ...(m.env ?? {}) },
  })
  if (r.error?.code === "ENOENT" && m.optional) {
    process.stdout.write(`SKIPPED: ${m.name}: ${m.cmd} is not installed; CI covers this mode.\n`)
    continue
  }
  if (r.error) {
    process.stdout.write(`FAILED: ${m.name}: ${r.error.message}\n`)
    failed = true
    continue
  }
  if (r.status !== 0) {
    process.stdout.write(`FAILED: ${m.name} exited ${r.status}\n`)
    failed = true
  }
}

if (failed) {
  process.stdout.write("\nprepublish: at least one mode failed; nothing was published.\n")
  process.exit(1)
}
process.stdout.write("\nprepublish: every mode passed.\n")
