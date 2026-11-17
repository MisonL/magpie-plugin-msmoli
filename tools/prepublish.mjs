// Every test mode this repository runs, in the order CI runs them, so a
// publish from a machine that never saw CI cannot skip one. `npm test` alone
// leaves the ticking clock, the shifted clock and Bun unexercised; each has
// caught a real regression in this project's history.
//
// A mode's exit code is not the whole story. A runner that finds no tests (a
// test file deleted, a `test/` path renamed, a glob that stopped matching)
// exits 0 with a summary of zero, and this gate reported "every mode passed"
// for a suite that had not run: the release went out on nothing. So each
// mode's own summary is read and a floor is enforced, and the two clock modes
// have to report one more test than the plain run — the extra test is the
// mode's own proof that its shim is in effect (test/plugin.test.mjs adds it
// only under that mode). A shim that went inert leaves the counts equal and
// fails here instead of passing as a green mode that tested the plain clock.
//
// Bun is the runtime magpie actually runs plugins on. It is skipped only when
// the binary is missing, and the skip is printed loudly — never silently.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

// Today's suite is 726 tests (the plain run); the floor leaves room for a
// legitimate consolidation while still catching a whole file that vanished.
// (Keep this number current: a stale one reads as a suite that shrank.)
const MIN_TESTS = 600

// The count floor alone does not catch one file going missing: sync.test.mjs is
// ~300 tests and style.test.mjs is 7, so dropping either still clears 600, and
// the runner reports a green mode for what is left. (Measured: with
// test/style.test.mjs deleted the gate printed "every mode passed".) The three
// files are named here so a publish cannot go out with one of them gone.
const FILES = ["test/plugin.test.mjs", "test/sync.test.mjs", "test/style.test.mjs"]

const missing = FILES.filter((f) => !existsSync(f))
if (missing.length) {
  process.stdout.write(`FAILED: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing; the suite would run short and still pass its floor.\n`)
  process.exit(1)
}

const modes = [
  { name: "node --test", cmd: "node", args: ["--test"] },
  {
    name: "node --import ./tools/ticking-clock.mjs --test",
    cmd: "node",
    args: ["--import", "./tools/ticking-clock.mjs", "--test"],
    // the mode's own probe test must run: it is the only test that is not in
    // the plain run, and its absence is how an inert shim would hide
    expectsExtraTest: true,
  },
  {
    name: "node --test (shifted clock)",
    cmd: "node",
    args: ["--test"],
    env: { MSMOLI_FAKE_NOW: "1893456000000" },
    expectsExtraTest: true,
  },
  { name: "bun test", cmd: "bun", args: ["test"], optional: true },
]

// the runner's own summary, whichever one wrote it: Node 24's reporter prints
// "ℹ pass 676", Node 18 and 22 print the TAP form "# pass 676", and Bun prints
// " 676 pass". Node 18 is the engine floor in package.json, so a summary this
// could not read was a gate that passed on a count it never had.
const passedOf = (out) => {
  const node = /^ℹ pass (\d+)$/m.exec(out)
  const tap = /^# pass (\d+)$/m.exec(out)
  const bun = /^\s*(\d+) pass$/m.exec(out)
  return Number(node?.[1] ?? tap?.[1] ?? bun?.[1] ?? NaN)
}

let failed = false
let plain = null
for (const m of modes) {
  process.stdout.write(`\n$ ${[m.cmd, ...m.args].join(" ")}${m.env ? "  (env " + Object.keys(m.env).join(",") + ")" : ""}\n`)
  const r = spawnSync(m.cmd, m.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(m.env ?? {}) },
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  process.stdout.write(out)
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
    continue
  }
  // exit 0 is not enough: a run that found nothing is not a green suite
  const passed = passedOf(out)
  if (!Number.isFinite(passed) || passed < MIN_TESTS) {
    process.stdout.write(`FAILED: ${m.name}: the summary reports ${Number.isFinite(passed) ? `${passed} passing tests` : "no test count"}, below the ${MIN_TESTS} floor; the suite did not run.\n`)
    failed = true
    continue
  }
  if (plain === null) plain = passed
  if (m.expectsExtraTest && passed <= plain) {
    process.stdout.write(`FAILED: ${m.name}: ${passed} tests, no more than the plain run's ${plain}; the mode's own probe did not run, so its clock shim may be inert.\n`)
    failed = true
  }
}

if (failed) {
  process.stdout.write("\nprepublish: at least one mode failed; nothing was published.\n")
  process.exit(1)
}
process.stdout.write("\nprepublish: every mode passed.\n")
